import { buildImageRequestHeaders } from "./codex-headers.js";
import {
  buildImageEditRequest,
  buildImageGenerationRequest,
  buildImageResponsesRequest,
  decodeGeneratedPng,
  decodeImageGenerationCall,
  isDallEModel,
  parseImageGenerationResponse,
  parseImageResponsesPayload,
  supportsResponsesTool,
  type ImageResultParse,
} from "./protocol.js";
import { SseLimitError, parseSseText, readSseEvents, type SseEvent } from "./sse.js";
import {
  IMAGE_TIMEOUT_MS,
  MAX_ERROR_BYTES,
  MAX_RESPONSE_BYTES,
  sanitizeDiagnostic,
  type ActiveImageTransport,
  type ImageGenerationRuntime,
  type NormalizedImageParams,
  type ParsedGeneratedImage,
  type PreparedReferenceImage,
} from "./types.js";

export type ImageFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ImageClientFailure = {
  ok: false;
  reason: "aborted" | "timeout" | "authentication" | "rate-limit" | "request-rejected" | "backend-unavailable" | "network" | "oversized-response" | "malformed-response" | "no-image";
  status?: number;
  errorMessage: string;
  transport: ActiveImageTransport;
};

export type ImageClientResult =
  | { ok: true; image: ParsedGeneratedImage; status: number; transport: ActiveImageTransport }
  | ImageClientFailure;

export type ImageClientArgs = {
  runtime: ImageGenerationRuntime;
  imageModel: string;
  params: NormalizedImageParams;
  references: readonly PreparedReferenceImage[];
  userAgent?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchFn?: ImageFetch;
};

/** Statuses that mean "this endpoint cannot serve the call", never "your parameters are wrong". */
const FALLBACK_STATUSES = new Set([404, 405, 501]);
/** Tool/endpoint-specific phrases. Parameter errors must not match, or a doomed retry is billed. */
const UNSUPPORTED_PATTERN = /\b(?:unknown (?:tool|url|endpoint|route)|unsupported tool|tool[^.]{0,24}not (?:found|supported)|not implemented|no such (?:tool|route|endpoint)|does not exist)\b/i;
const MAX_TRACKED_FALLBACKS = 32;
/** A provider that failed once is not probed forever: the mark expires and is retried. */
const FALLBACK_TTL_MS = 15 * 60 * 1000;

/**
 * Providers already observed to reject the Responses image tool. Keyed by provider and
 * endpoint because tool support is a property of the endpoint, not of one image model.
 */
const responsesUnsupported = new Map<string, number>();

export function responsesKey(runtime: ImageGenerationRuntime): string {
  return `${runtime.provider}|${runtime.responsesUrl}`;
}

export function markResponsesUnsupported(key: string): void {
  if (responsesUnsupported.size >= MAX_TRACKED_FALLBACKS) responsesUnsupported.clear();
  responsesUnsupported.set(key, Date.now() + FALLBACK_TTL_MS);
}

export function resetResponsesFallbackState(): void {
  responsesUnsupported.clear();
}

function isResponsesUnsupported(key: string): boolean {
  const expiresAt = responsesUnsupported.get(key);
  if (expiresAt === undefined) return false;
  if (expiresAt <= Date.now()) {
    responsesUnsupported.delete(key);
    return false;
  }
  return true;
}

/**
 * The Images API is the documented fallback, but only for capability failures. Auth,
 * rate-limit, abort and timeout failures are never retried: a second attempt would
 * duplicate cost and latency without changing the outcome. A response the provider
 * already fulfilled (malformed payload, several images) is never retried either.
 */
export function shouldFallbackToImages(failure: ImageClientFailure): boolean {
  if (failure.status !== undefined && FALLBACK_STATUSES.has(failure.status)) return true;
  if (failure.reason === "no-image") return true;
  if (failure.reason !== "request-rejected") return false;
  if (failure.status !== undefined && failure.status >= 500) return false;
  return UNSUPPORTED_PATTERN.test(failure.errorMessage);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array | undefined> {
  const length = response.headers.get("content-length");
  if (length && Number.isFinite(Number(length)) && Number(length) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength <= maxBytes) return bytes;
    bytes.fill(0);
    return undefined;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (!part.value) continue;
      total += part.value.byteLength;
      if (total > maxBytes) {
        part.value.fill(0);
        for (const chunk of chunks) chunk.fill(0);
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(part.value);
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
      chunk.fill(0);
    }
    return result;
  } catch (error) {
    for (const chunk of chunks) chunk.fill(0);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function failureReason(status: number): ImageClientFailure["reason"] {
  if (status === 401 || status === 403) return "authentication";
  if (status === 429) return "rate-limit";
  if (status >= 500) return "backend-unavailable";
  return "request-rejected";
}

function payloadMessage(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const error = isRecord(value.error) ? value.error : value;
  return typeof error.message === "string" ? error.message : undefined;
}

/** Decodes a base64 frame from the Images API stream into the shared parse shape. */
function decodeImagesStreamFrame(b64: string): ImageResultParse {
  const decoded = decodeGeneratedPng(b64);
  if (!decoded.ok) return decoded;
  return { ok: true, image: { bytes: decoded.bytes, width: decoded.width, height: decoded.height } };
}

type PreparedRequest = {
  url: string;
  body: string | Uint8Array<ArrayBuffer>;
  contentType: string;
  accept: string;
  transport: ActiveImageTransport;
};

type SendOutcome = { ok: true; response: Response } | { ok: false; failure: ImageClientFailure };

async function sendRequest(args: ImageClientArgs, prepared: PreparedRequest, signal: AbortSignal, timeout: AbortSignal): Promise<SendOutcome> {
  const fetchFn = args.fetchFn ?? globalThis.fetch.bind(globalThis);
  const fail = (reason: ImageClientFailure["reason"], errorMessage: string, status?: number): SendOutcome => ({
    ok: false,
    failure: { ok: false, reason, errorMessage, transport: prepared.transport, ...(status === undefined ? {} : { status }) },
  });
  let response: Response;
  try {
    response = await fetchFn(prepared.url, {
      method: "POST",
      headers: buildImageRequestHeaders(args.runtime, args.userAgent, { contentType: prepared.contentType, accept: prepared.accept, transport: prepared.transport }),
      body: prepared.body,
      redirect: "error",
      signal,
    });
  } catch (error) {
    if (args.signal?.aborted) return fail("aborted", "Image generation was cancelled.");
    if (timeout.aborted) return fail("timeout", "Image generation timed out; it was not retried automatically.");
    return fail("network", sanitizeDiagnostic(error, "Image generation network request failed."));
  }
  if (response.ok) return { ok: true, response };
  let bytes: Uint8Array | undefined;
  try {
    bytes = await readBounded(response, MAX_ERROR_BYTES);
  } catch (error) {
    if (args.signal?.aborted) return fail("aborted", "Image generation was cancelled.", response.status);
    if (timeout.aborted) return fail("timeout", "Image generation timed out; it was not retried automatically.", response.status);
    return fail("network", sanitizeDiagnostic(error, "Image provider response could not be read."), response.status);
  }
  let message: string | undefined;
  if (bytes) {
    try {
      message = payloadMessage(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
    } catch {
      message = undefined;
    } finally {
      bytes.fill(0);
    }
  }
  return fail(failureReason(response.status), sanitizeDiagnostic(message, `Image provider rejected the request (HTTP ${response.status}).`), response.status);
}

/** Turns one SSE frame into an image result, remembering non-fatal provider errors. */
function interpretStreamEvent(transport: ActiveImageTransport, event: SseEvent, state: { error?: ImageResultParse }): ImageResultParse | undefined {
  let value: unknown;
  try {
    value = JSON.parse(event.data) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const type = typeof value.type === "string" ? value.type : "";
  // A provider can report a failure as an `error` event, a `response.failed` event, or a
  // bare `{"error": ...}` frame. Those are rejections and must never read as "no image",
  // which would trigger a second, billable attempt.
  if (type === "error" || type === "response.failed" || isRecord(value.error)) {
    const message = payloadMessage(value) ?? (isRecord(value.response) ? payloadMessage(value.response) : undefined);
    return { ok: false, reason: "request-rejected", errorMessage: message ?? "Image provider reported an error." };
  }
  if (transport === "responses") {
    if (type === "response.output_item.done") {
      const parsed = decodeImageGenerationCall(value.item);
      if (!parsed) return undefined;
      if (parsed.ok) return parsed;
      state.error = parsed;
      return undefined;
    }
    if (type === "response.completed") {
      if (!isRecord(value.response)) return undefined;
      const parsed = parseImageResponsesPayload(value.response);
      if (parsed.ok) return parsed;
      state.error = parsed;
      return undefined;
    }
    return undefined;
  }
  if (type === "image_generation.partial_image" || type === "image_edit.partial_image") return undefined;
  if (type === "image_generation.completed" || type === "image_edit.completed") {
    if (typeof value.b64_json !== "string" || !value.b64_json.trim()) {
      state.error = { ok: false, reason: "no-image", errorMessage: "Images API stream completed without an inline base64 image." };
      return undefined;
    }
    return decodeImagesStreamFrame(value.b64_json);
  }
  return undefined;
}

function looksLikeSse(text: string): boolean {
  return /^\s*(?::|data:|event:)/.test(text);
}

/**
 * Reads a streamed result. Gateways that ignore `stream: true` still answer with JSON,
 * and providers may mislabel the content type, so both shapes are accepted.
 * Throws only for read/limit failures; callers classify those.
 */
async function readResponseResult(response: Response, transport: ActiveImageTransport): Promise<ImageResultParse | undefined> {
  const state: { error?: ImageResultParse } = {};
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("text/event-stream") && response.body) {
    for await (const event of readSseEvents(response.body, MAX_RESPONSE_BYTES)) {
      const result = interpretStreamEvent(transport, event, state);
      if (result) return result;
    }
    return state.error;
  }
  const bytes = await readBounded(response, MAX_RESPONSE_BYTES);
  if (!bytes) throw new SseLimitError("Image provider response exceeded the size limit.");
  const text = new TextDecoder().decode(bytes);
  bytes.fill(0);
  if (looksLikeSse(text)) {
    for (const event of parseSseText(text, MAX_RESPONSE_BYTES)) {
      const result = interpretStreamEvent(transport, event, state);
      if (result) return result;
    }
    return state.error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, reason: "malformed-response", errorMessage: "Image provider returned invalid JSON." };
  }
  return transport === "responses" ? parseImageResponsesPayload(value) : parseImageGenerationResponse(value);
}

async function attempt(args: ImageClientArgs, prepared: PreparedRequest, signal: AbortSignal, timeout: AbortSignal): Promise<ImageClientResult> {
  const sent = await sendRequest(args, prepared, signal, timeout);
  if (!sent.ok) return sent.failure;
  const fail = (reason: ImageClientFailure["reason"], errorMessage: string): ImageClientResult => ({
    ok: false, reason, errorMessage, transport: prepared.transport, status: sent.response.status,
  });
  let parsed: ImageResultParse | undefined;
  try {
    parsed = await readResponseResult(sent.response, prepared.transport);
  } catch (error) {
    if (error instanceof SseLimitError) return fail("oversized-response", "Image provider response exceeded the size limit.");
    if (args.signal?.aborted) return fail("aborted", "Image generation was cancelled.");
    if (timeout.aborted) return fail("timeout", "Image generation timed out; it was not retried automatically.");
    return fail("network", sanitizeDiagnostic(error, "Image provider response could not be read."));
  }
  if (!parsed) return fail("no-image", "Image provider stream ended without an image result.");
  if (!parsed.ok) return fail(parsed.reason, sanitizeDiagnostic(parsed.errorMessage, "Image generation response was invalid."));
  return { ok: true, image: parsed.image, status: sent.response.status, transport: prepared.transport };
}

function clearReferences(references: readonly PreparedReferenceImage[]): void {
  for (const reference of references) reference.bytes.fill(0);
}

/**
 * Image model declared by the Responses image_generation tool. A configured toolModel
 * wins; otherwise the Images-API model is reused so both transports agree by default.
 */
function responsesToolModel(args: ImageClientArgs): string {
  return args.runtime.toolModel ?? args.imageModel;
}

function prepareResponsesRequest(args: ImageClientArgs): PreparedRequest {
  return {
    url: args.runtime.responsesUrl,
    body: buildImageResponsesRequest({
      toolModel: responsesToolModel(args),
      textModel: args.runtime.textModel,
      params: args.params,
      references: args.references,
    }),
    contentType: "application/json",
    accept: "text/event-stream",
    transport: "responses",
  };
}

/** Images API preparation. Only generation is streamed; edits stay on the multipart contract. */
function prepareImagesRequest(args: ImageClientArgs): { request: PreparedRequest; clear?: () => void } {
  if (args.params.action === "edit") {
    const multipart = buildImageEditRequest(args.imageModel, args.params, args.references);
    return {
      request: { url: args.runtime.editsUrl, body: multipart.body, contentType: multipart.contentType, accept: "application/json", transport: "images" },
      clear: multipart.clear,
    };
  }
  const streaming = !isDallEModel(args.imageModel);
  const body = JSON.stringify({ ...buildImageGenerationRequest(args.imageModel, args.params), ...(streaming ? { stream: true } : {}) });
  return {
    request: {
      url: args.runtime.generationUrl,
      body,
      contentType: "application/json",
      accept: streaming ? "text/event-stream" : "application/json",
      transport: "images",
    },
  };
}

export async function requestGeneratedImage(args: ImageClientArgs): Promise<ImageClientResult> {
  const timeout = AbortSignal.timeout(args.timeoutMs ?? IMAGE_TIMEOUT_MS);
  const signal = args.signal ? AbortSignal.any([args.signal, timeout]) : timeout;
  const key = responsesKey(args.runtime);
  try {
    if (args.runtime.transport === "responses" && supportsResponsesTool(responsesToolModel(args)) && !isResponsesUnsupported(key)) {
      const primary = await attempt(args, prepareResponsesRequest(args), signal, timeout);
      if (primary.ok || !shouldFallbackToImages(primary)) return primary;
      // The references stay live on purpose: the Images fallback rebuilds them as multipart.
      markResponsesUnsupported(key);
      const fallback = prepareImagesRequest(args);
      try {
        return await attempt(args, fallback.request, signal, timeout);
      } finally {
        fallback.clear?.();
      }
    }
    const images = prepareImagesRequest(args);
    try {
      return await attempt(args, images.request, signal, timeout);
    } finally {
      images.clear?.();
    }
  } finally {
    // Owns the reference lifetime on every path: the Responses body is a string by now,
    // and the multipart builder has already copied and cleared what it needed.
    clearReferences(args.references);
  }
}

export const _clientTest = { readBounded, failureReason, shouldFallbackToImages, responsesKey, resetResponsesFallbackState };
