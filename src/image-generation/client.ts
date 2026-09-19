import { buildImageRequestHeaders } from "./codex-headers.js";
import { buildImageEditRequest, buildImageGenerationRequest, parseImageGenerationResponse } from "./protocol.js";
import { IMAGE_TIMEOUT_MS, MAX_ERROR_BYTES, MAX_RESPONSE_BYTES, sanitizeDiagnostic, type ImageGenerationRuntime, type NormalizedImageParams, type ParsedGeneratedImage, type PreparedReferenceImage } from "./types.js";

export type ImageFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type ImageClientResult =
  | { ok: true; image: ParsedGeneratedImage; status: number }
  | { ok: false; reason: "aborted" | "timeout" | "authentication" | "rate-limit" | "request-rejected" | "backend-unavailable" | "network" | "oversized-response" | "malformed-response" | "no-image"; status?: number; errorMessage: string };

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

function failureReason(status: number): Exclude<ImageClientResult, { ok: true }>["reason"] {
  if (status === 401 || status === 403) return "authentication";
  if (status === 429) return "rate-limit";
  if (status >= 500) return "backend-unavailable";
  return "request-rejected";
}

function payloadMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const error = record.error && typeof record.error === "object" && !Array.isArray(record.error) ? record.error as Record<string, unknown> : record;
  return typeof error.message === "string" ? error.message : undefined;
}

export async function requestGeneratedImage(args: {
  runtime: ImageGenerationRuntime;
  imageModel: string;
  params: NormalizedImageParams;
  references: readonly PreparedReferenceImage[];
  userAgent?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchFn?: ImageFetch;
}): Promise<ImageClientResult> {
  const fetchFn = args.fetchFn ?? globalThis.fetch.bind(globalThis);
  const timeout = AbortSignal.timeout(args.timeoutMs ?? IMAGE_TIMEOUT_MS);
  const signal = args.signal ? AbortSignal.any([args.signal, timeout]) : timeout;
  const editing = args.params.action === "edit";
  const multipart = editing ? buildImageEditRequest(args.imageModel, args.params, args.references) : undefined;
  const body = multipart?.body ?? JSON.stringify(buildImageGenerationRequest(args.imageModel, args.params));
  const contentType = multipart?.contentType ?? "application/json";
  const url = editing ? args.runtime.editsUrl : args.runtime.generationUrl;
  let response: Response;
  try {
    try {
      response = await fetchFn(url, {
        method: "POST",
        headers: buildImageRequestHeaders(args.runtime, args.userAgent, { contentType }),
        body,
        redirect: "error",
        signal,
      });
    } finally {
      multipart?.clear();
    }
  } catch (error) {
    if (args.signal?.aborted) return { ok: false, reason: "aborted", errorMessage: "Image generation was cancelled." };
    if (timeout.aborted) return { ok: false, reason: "timeout", errorMessage: "Image generation timed out; it was not retried automatically." };
    return { ok: false, reason: "network", errorMessage: sanitizeDiagnostic(error, "Image generation network request failed.") };
  }
  let bytes: Uint8Array | undefined;
  try {
    bytes = await readBounded(response, response.ok ? MAX_RESPONSE_BYTES : MAX_ERROR_BYTES);
  } catch (error) {
    if (args.signal?.aborted) return { ok: false, reason: "aborted", status: response.status, errorMessage: "Image generation was cancelled." };
    if (timeout.aborted) return { ok: false, reason: "timeout", status: response.status, errorMessage: "Image generation timed out; it was not retried automatically." };
    return { ok: false, reason: "network", status: response.status, errorMessage: sanitizeDiagnostic(error, "Image provider response could not be read.") };
  }
  if (!bytes) return { ok: false, reason: "oversized-response", status: response.status, errorMessage: "Image provider response exceeded the size limit." };
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return { ok: false, reason: "malformed-response", status: response.status, errorMessage: response.ok ? "Image provider returned invalid JSON." : `Image provider rejected the request (HTTP ${response.status}).` };
  } finally {
    bytes.fill(0);
  }
  if (!response.ok) {
    const reason = failureReason(response.status);
    return { ok: false, reason, status: response.status, errorMessage: sanitizeDiagnostic(payloadMessage(payload), `Image provider rejected the request (HTTP ${response.status}).`) };
  }
  const parsed = parseImageGenerationResponse(payload);
  if (!parsed.ok) return { ok: false, reason: parsed.reason, status: response.status, errorMessage: sanitizeDiagnostic(parsed.errorMessage, "Image generation response was invalid.") };
  return { ok: true, image: parsed.image, status: response.status };
}

export const _clientTest = { readBounded, failureReason };
