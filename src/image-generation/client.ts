import { buildImageRequestHeaders } from "./codex-headers.js";
import {
  buildImageDebugRecord,
  describeImageFailure,
  ImageRequestTrace,
  type ImageDebugRecord,
  type ImageProgressEvent,
} from "./diagnostics.js";
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
  /**
   * True when the response ended before a terminal result arrived, which means an
   * intermediate hop cut the connection instead of the provider answering.
   */
  truncated?: boolean;
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
  /** Called for every partial preview frame so the caller can show progress. */
  onProgress?: (event: ImageProgressEvent) => void;
  /** Called once per request when the caller asked for a metadata-only debug record. */
  onDebug?: (record: ImageDebugRecord) => void;
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
 * already fulfilled (malformed payload, several images) is never retried either, and
 * neither is a truncated stream: the endpoint clearly answered, so an intermediate hop
 * cut the connection and the Images API would be billed for the same work again.
 */
export function shouldFallbackToImages(failure: ImageClientFailure): boolean {
  if (failure.truncated === true) return false;
  if (failure.status !== undefined && FALLBACK_STATUSES.has(failure.status)) return true;
  if (failure.reason === "no-image") return true;
  if (failure.reason !== "request-rejected") return false;
  if (failure.status !== undefined && failure.status >= 500) return false;
  return UNSUPPORTED_PATTERN.test(failure.errorMessage);
}

/**
 * A transport-level failure carries no provider verdict: the connection broke either
 * before any status arrived or while the response was still streaming. Only those are
 * retryable, and only when the caller opted in, because the gateway may already have
 * billed the upstream generation that produced the truncated stream.
 */
export function isRetryableTransportFailure(failure: ImageClientFailure): boolean {
  if (failure.truncated === true) return true;
  return failure.reason === "network";
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

/** Partial preview frames only exist to keep the stream alive and to show progress. */
function isPartialPreviewEvent(type: string): boolean {
  return /(?:^|\.)partial_image$/.test(type);
}

/** Keep-alive frames that carry no preview image but still prove the stream is alive. */
function isProgressEvent(type: string): boolean {
  return type === "response.in_progress" || type === "response.image_generation_call.in_progress";
}

type StreamState = {
  error?: ImageResultParse;
  /** A terminal provider event arrived, so the stream ended on purpose. */
  terminal: boolean;
};

type StreamOutcome =
  | { kind: "result"; result: ImageResultParse }
  /** `preview` separates a partial image frame from a bare keep-alive frame. */
  | { kind: "partial"; preview: boolean }
  | { kind: "ignored" };

/** Turns one SSE frame into an image result, a partial preview, or nothing at all. */
function interpretStreamEvent(transport: ActiveImageTransport, event: SseEvent, state: StreamState): StreamOutcome {
  let value: unknown;
  try {
    value = JSON.parse(event.data) as unknown;
  } catch {
    return { kind: "ignored" };
  }
  if (!isRecord(value)) return { kind: "ignored" };
  const type = typeof value.type === "string" ? value.type : "";
  // A provider can report a failure as an `error` event, a `response.failed` event, or a
  // bare `{"error": ...}` frame. Those are rejections and must never read as "no image",
  // which would trigger a second, billable attempt.
  if (type === "error" || type === "response.failed" || isRecord(value.error)) {
    state.terminal = true;
    const message = payloadMessage(value) ?? (isRecord(value.response) ? payloadMessage(value.response) : undefined);
    return { kind: "result", result: { ok: false, reason: "request-rejected", errorMessage: message ?? "Image provider reported an error." } };
  }
  if (isPartialPreviewEvent(type)) return { kind: "partial", preview: true };
  if (isProgressEvent(type)) return { kind: "partial", preview: false };
  if (transport === "responses") {
    if (type === "response.output_item.done") {
      const parsed = decodeImageGenerationCall(value.item);
      if (!parsed) return { kind: "ignored" };
      if (parsed.ok) return { kind: "result", result: parsed };
      // An item without a result is not yet a verdict: the terminal event decides.
      state.error = parsed;
      return { kind: "ignored" };
    }
    if (type === "response.incomplete") {
      // The provider stopped the turn on purpose (for example max_output_tokens), so this
      // is a rejection, not a cut connection: it must never be retried or billed twice.
      state.terminal = true;
      const details = isRecord(value.response) ? value.response.incomplete_details : undefined;
      const reason = isRecord(details) && typeof details.reason === "string" ? details.reason : "no reason given";
      state.error = { ok: false, reason: "request-rejected", errorMessage: `Responses API ended the turn before the image tool produced a result (${reason}).` };
      return { kind: "ignored" };
    }
    if (type === "response.completed" || type === "response.done") {
      state.terminal = true;
      if (!isRecord(value.response)) return { kind: "ignored" };
      const parsed = parseImageResponsesPayload(value.response);
      if (parsed.ok) return { kind: "result", result: parsed };
      state.error = parsed;
      return { kind: "ignored" };
    }
    return { kind: "ignored" };
  }
  if (type === "image_generation.completed" || type === "image_edit.completed") {
    state.terminal = true;
    if (typeof value.b64_json !== "string" || !value.b64_json.trim()) {
      state.error = { ok: false, reason: "no-image", errorMessage: "Images API stream completed without an inline base64 image." };
      return { kind: "ignored" };
    }
    return { kind: "result", result: decodeImagesStreamFrame(value.b64_json) };
  }
  return { kind: "ignored" };
}

function looksLikeSse(text: string): boolean {
  return /^\s*(?::|data:|event:)/.test(text);
}

/** Raw bytes kept from the head of a streamed body so a mislabeled body can be re-read. */
const MAX_PREFIX_BYTES = 64 * 1024;

type StreamPrefix = { chunks: Uint8Array[]; size: number };

/**
 * Counts bytes for the trace while the SSE parser consumes them and keeps a bounded
 * prefix, because a gateway may answer with JSON under a `text/event-stream` header.
 */
async function* countBytes(source: AsyncIterable<Uint8Array>, trace: ImageRequestTrace, prefix: StreamPrefix): AsyncGenerator<Uint8Array> {
  for await (const chunk of source) {
    trace.noteBytes(chunk.byteLength);
    if (prefix.size < MAX_PREFIX_BYTES) {
      const kept = chunk.subarray(0, MAX_PREFIX_BYTES - prefix.size);
      prefix.chunks.push(kept.slice());
      prefix.size += kept.byteLength;
    }
    yield chunk;
  }
}

function decodePrefix(prefix: StreamPrefix): string {
  if (prefix.chunks.length === 0) return "";
  return new TextDecoder().decode(Buffer.concat(prefix.chunks));
}

type StreamRead =
  | { kind: "result"; result: ImageResultParse; truncated?: boolean }
  | { kind: "empty"; truncated: boolean; readError?: string }
  | { kind: "limit" };

/** Interprets a fully buffered body as SSE frames or as one JSON document. */
function interpretBufferedBody(
  text: string,
  transport: ActiveImageTransport,
  state: StreamState,
  note: (outcome: StreamOutcome) => ImageResultParse | undefined,
): StreamRead {
  if (looksLikeSse(text)) {
    for (const event of parseSseText(text, MAX_RESPONSE_BYTES)) {
      const result = note(interpretStreamEvent(transport, event, state));
      if (result) return { kind: "result", result };
    }
    if (state.error) return { kind: "result", result: state.error };
    // The whole body arrived, so the provider itself ended the turn without an image.
    return { kind: "empty", truncated: false };
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return { kind: "result", result: { ok: false, reason: "malformed-response", errorMessage: "Image provider returned invalid JSON." } };
  }
  return { kind: "result", result: transport === "responses" ? parseImageResponsesPayload(value) : parseImageGenerationResponse(value) };
}

/**
 * Reads a response body. Gateways that ignore `stream: true` still answer with JSON, and
 * providers may mislabel the content type, so both shapes are accepted. Read failures and
 * size limits come back as values so the caller can classify them with the timeline.
 */
async function readResponseResult(
  response: Response,
  transport: ActiveImageTransport,
  trace: ImageRequestTrace,
  onProgress: ((event: ImageProgressEvent) => void) | undefined,
): Promise<StreamRead> {
  const state: StreamState = { terminal: false };
  let progressBroken = false;
  const note = (outcome: StreamOutcome): ImageResultParse | undefined => {
    trace.markEvent(outcome.kind === "partial" && outcome.preview);
    if (outcome.kind === "partial" && outcome.preview && onProgress && !progressBroken) {
      // Rendering progress is best effort: a throwing UI callback must never look like a
      // broken connection, which would be treated as retryable and billed twice.
      try {
        onProgress({ partials: trace.partials, elapsedMs: trace.elapsedMs() });
      } catch {
        progressBroken = true;
      }
    }
    return outcome.kind === "result" ? outcome.result : undefined;
  };
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("text/event-stream") && response.body) {
    const prefix: StreamPrefix = { chunks: [], size: 0 };
    let readError: string | undefined;
    try {
      for await (const event of readSseEvents(countBytes(response.body, trace, prefix), MAX_RESPONSE_BYTES)) {
        const result = note(interpretStreamEvent(transport, event, state));
        if (result) return { kind: "result", result };
      }
    } catch (error) {
      if (error instanceof SseLimitError) return { kind: "limit" };
      readError = sanitizeDiagnostic(error, "the response stream could not be read");
    }
    if (state.error) {
      // A verdict taken from an interrupted stream keeps the truncation fact: an endpoint
      // that already answered is not a capability failure, so it must not be billed twice.
      return state.terminal ? { kind: "result", result: state.error } : { kind: "result", result: state.error, truncated: true };
    }
    const bufferedText = decodePrefix(prefix);
    if (readError === undefined && trace.events === 0 && bufferedText.trim()) {
      const buffered = interpretBufferedBody(bufferedText, transport, state, note);
      // Only trust the buffered reading when it produced a verdict of its own; otherwise
      // the body really was a stream that ended before any complete frame arrived.
      if (buffered.kind !== "empty") return buffered;
    }
    return { kind: "empty", truncated: !state.terminal, ...(readError === undefined ? {} : { readError }) };
  }
  let bytes: Uint8Array | undefined;
  try {
    bytes = await readBounded(response, MAX_RESPONSE_BYTES);
  } catch (error) {
    return { kind: "empty", truncated: true, readError: sanitizeDiagnostic(error, "the response body could not be read") };
  }
  if (!bytes) return { kind: "limit" };
  trace.noteBytes(bytes.byteLength);
  const text = new TextDecoder().decode(bytes);
  bytes.fill(0);
  return interpretBufferedBody(text, transport, state, note);
}

type PreparedRequest = {
  url: string;
  body: string | Uint8Array<ArrayBuffer>;
  contentType: string;
  accept: string;
  transport: ActiveImageTransport;
  /** Whether this prepared request asks the provider to stream SSE frames. */
  stream: boolean;
};

type SendOutcome = { ok: true; response: Response } | { ok: false; failure: ImageClientFailure };

async function sendRequest(args: ImageClientArgs, prepared: PreparedRequest, signal: AbortSignal, timeout: AbortSignal, trace: ImageRequestTrace): Promise<SendOutcome> {
  const fetchFn = args.fetchFn ?? globalThis.fetch.bind(globalThis);
  const fail = (reason: ImageClientFailure["reason"], errorMessage: string, status?: number): SendOutcome => ({
    ok: false,
    failure: { ok: false, reason, errorMessage, transport: prepared.transport, ...(status === undefined ? {} : { status }) },
  });
  let response: Response;
  trace.enterStage("sending");
  try {
    response = await fetchFn(prepared.url, {
      method: "POST",
      headers: buildImageRequestHeaders(args.runtime, args.userAgent, { contentType: prepared.contentType, accept: prepared.accept, transport: prepared.transport }),
      body: prepared.body,
      redirect: "error",
      signal,
    });
  } catch (error) {
    if (args.signal?.aborted) {
      trace.markAbort();
      return fail("aborted", describeImageFailure("Image generation was cancelled.", trace));
    }
    if (timeout.aborted) {
      trace.markTimeout();
      return fail("timeout", describeImageFailure("Image generation timed out and was not retried automatically.", trace));
    }
    return fail("network", describeImageFailure(`Image generation network request failed: ${sanitizeDiagnostic(error, "unknown transport error")}.`, trace));
  }
  trace.markHeaders();
  if (response.ok) return { ok: true, response };
  let bytes: Uint8Array | undefined;
  try {
    bytes = await readBounded(response, MAX_ERROR_BYTES);
  } catch (error) {
    if (args.signal?.aborted) {
      trace.markAbort();
      return fail("aborted", describeImageFailure("Image generation was cancelled.", trace), response.status);
    }
    if (timeout.aborted) {
      trace.markTimeout();
      return fail("timeout", describeImageFailure("Image generation timed out and was not retried automatically.", trace), response.status);
    }
    return fail("network", describeImageFailure(`Image provider response could not be read: ${sanitizeDiagnostic(error, "unknown read error")}.`, trace), response.status);
  }
  let message: string | undefined;
  if (bytes) {
    trace.noteBytes(bytes.byteLength);
    try {
      message = payloadMessage(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
    } catch {
      message = undefined;
    } finally {
      bytes.fill(0);
    }
  }
  const base = sanitizeDiagnostic(message, `Image provider rejected the request (HTTP ${response.status}).`);
  // A status is already a provider verdict, so only the timeline is appended here: the
  // idle-cut hint is reserved for connections that ended without any answer.
  return fail(failureReason(response.status), `${base} ${trace.format()}`, response.status);
}

async function attempt(args: ImageClientArgs, prepared: PreparedRequest, signal: AbortSignal, timeout: AbortSignal, trace: ImageRequestTrace): Promise<ImageClientResult> {
  const sent = await sendRequest(args, prepared, signal, timeout, trace);
  if (!sent.ok) return sent.failure;
  const status = sent.response.status;
  const fail = (reason: ImageClientFailure["reason"], errorMessage: string, truncated?: boolean): ImageClientResult => ({
    ok: false,
    reason,
    errorMessage,
    transport: prepared.transport,
    status,
    ...(truncated ? { truncated: true } : {}),
  });
  const read = await readResponseResult(sent.response, prepared.transport, trace, args.onProgress);
  if (read.kind === "result") {
    const parsed = read.result;
    if (parsed.ok) {
      trace.markDone();
      return { ok: true, image: parsed.image, status, transport: prepared.transport };
    }
    // The provider's own verdict wins, but a stream that also ended early keeps that fact
    // so the Images fallback is not billed for work this endpoint already answered.
    return fail(parsed.reason, describeImageFailure(sanitizeDiagnostic(parsed.errorMessage, "Image generation response was invalid."), trace), read.truncated);
  }
  if (args.signal?.aborted) {
    trace.markAbort();
    return fail("aborted", describeImageFailure("Image generation was cancelled.", trace));
  }
  if (timeout.aborted) {
    trace.markTimeout();
    return fail("timeout", describeImageFailure("Image generation timed out and was not retried automatically.", trace));
  }
  if (read.kind === "limit") return fail("oversized-response", describeImageFailure("Image provider response exceeded the size limit.", trace));
  const base = read.truncated
    ? `The provider connection ended before a complete image result${read.readError ? ` (${read.readError})` : ""}.`
    : "Image provider stream ended without an image result.";
  return fail("no-image", describeImageFailure(base, trace), read.truncated);
}

type RequestOutcome = { result: ImageClientResult; trace: ImageRequestTrace; endpoint: string };

/**
 * Runs one prepared request, optionally retrying it once. Enabling
 * `retryOnTransportFailure` can duplicate a charge the gateway already booked, so the
 * retry is opt-in and never happens after a cancellation or the plugin's own timeout.
 */
async function runPrepared(args: ImageClientArgs, prepared: PreparedRequest, signal: AbortSignal, timeout: AbortSignal): Promise<RequestOutcome> {
  let trace = new ImageRequestTrace(prepared.transport, prepared.stream);
  let result = await attempt(args, prepared, signal, timeout, trace);
  if (args.runtime.retryOnTransportFailure && !result.ok && isRetryableTransportFailure(result) && !args.signal?.aborted && !timeout.aborted) {
    trace = new ImageRequestTrace(prepared.transport, prepared.stream);
    result = await attempt(args, prepared, signal, timeout, trace);
  }
  return { result, trace, endpoint: prepared.url };
}

function clearReferences(references: readonly PreparedReferenceImage[]): void {
  for (const reference of references) reference.bytes.fill(0);
}

function prepareResponsesRequest(args: ImageClientArgs, stream: boolean): PreparedRequest {
  return {
    url: args.runtime.responsesUrl,
    body: buildImageResponsesRequest({
      imageModel: args.imageModel,
      textModel: args.runtime.textModel,
      params: args.params,
      references: args.references,
      partialImages: args.runtime.partialImages,
      stream,
    }),
    contentType: "application/json",
    accept: stream ? "text/event-stream" : "application/json",
    transport: "responses",
    stream,
  };
}

/** Images API preparation. Only generation is streamed; edits stay on the multipart contract. */
function prepareImagesRequest(args: ImageClientArgs, stream: boolean): { request: PreparedRequest; clear?: () => void } {
  if (args.params.action === "edit") {
    const multipart = buildImageEditRequest(args.imageModel, args.params, args.references);
    return {
      request: { url: args.runtime.editsUrl, body: multipart.body, contentType: multipart.contentType, accept: "application/json", transport: "images", stream: false },
      clear: multipart.clear,
    };
  }
  const streaming = stream && !isDallEModel(args.imageModel);
  // `partial_images` is the Images API's own keep-alive for streamed generations; DALL-E
  // models answer with one JSON body and must not receive it.
  const body = JSON.stringify({ ...buildImageGenerationRequest(args.imageModel, args.params, streaming ? args.runtime.partialImages : 0), ...(streaming ? { stream: true } : {}) });
  return {
    request: {
      url: args.runtime.generationUrl,
      body,
      contentType: "application/json",
      accept: streaming ? "text/event-stream" : "application/json",
      transport: "images",
      stream: streaming,
    },
  };
}

export async function requestGeneratedImage(args: ImageClientArgs): Promise<ImageClientResult> {
  const timeout = AbortSignal.timeout(args.timeoutMs ?? IMAGE_TIMEOUT_MS);
  const signal = args.signal ? AbortSignal.any([args.signal, timeout]) : timeout;
  const key = responsesKey(args.runtime);
  const stream = args.runtime.stream;
  let final: RequestOutcome | undefined;
  try {
    if (args.runtime.transport === "responses" && supportsResponsesTool(args.imageModel) && !isResponsesUnsupported(key)) {
      const primary = await runPrepared(args, prepareResponsesRequest(args, stream), signal, timeout);
      if (primary.result.ok || !shouldFallbackToImages(primary.result)) {
        final = primary;
        return final.result;
      }
      // The references stay live on purpose: the Images fallback rebuilds them as multipart.
      markResponsesUnsupported(key);
      const fallback = prepareImagesRequest(args, stream);
      try {
        final = await runPrepared(args, fallback.request, signal, timeout);
        return final.result;
      } finally {
        fallback.clear?.();
      }
    }
    const images = prepareImagesRequest(args, stream);
    try {
      final = await runPrepared(args, images.request, signal, timeout);
      return final.result;
    } finally {
      images.clear?.();
    }
  } finally {
    // Owns the reference lifetime on every path: the Responses body is a string by now,
    // and the multipart builder has already copied and cleared what it needed.
    clearReferences(args.references);
    if (args.onDebug && final) {
      args.onDebug(buildImageDebugRecord({
        trace: final.trace,
        endpoint: final.endpoint,
        provider: args.runtime.provider,
        api: args.runtime.api,
        textModel: args.runtime.textModel,
        imageModel: args.imageModel,
        bindingReason: args.runtime.bindingReason,
        params: args.params,
        referenceCount: args.references.length,
        partialImages: args.runtime.partialImages,
        result: final.result.ok
          ? { outcome: "ok", status: final.result.status }
          : { outcome: "failure", reason: final.result.reason, ...(final.result.status === undefined ? {} : { status: final.result.status }), ...(final.result.truncated ? { truncated: true } : {}), message: final.result.errorMessage },
      }));
    }
  }
}

export const _clientTest = { readBounded, failureReason, shouldFallbackToImages, isRetryableTransportFailure, responsesKey, resetResponsesFallbackState };
