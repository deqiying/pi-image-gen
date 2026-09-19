import { CODEX_CLIENT_VERSION } from "./headers-constants.js";
import type { ImageGenerationRuntime } from "./types.js";

const FORBIDDEN = new Set([
  "host", "cookie", "set-cookie", "connection", "content-length", "content-type", "transfer-encoding",
  "proxy-authorization", "chatgpt-account-id",
]);

function setHeader(headers: Record<string, string>, name: string, value: string): void {
  for (const existing of Object.keys(headers)) if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing];
  headers[name] = value;
}

export function buildImageRequestHeaders(runtime: ImageGenerationRuntime, userAgent?: string, options: { contentType?: string } = {}): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, raw] of Object.entries(runtime.headers ?? {})) {
    if (raw === null || typeof raw !== "string" || FORBIDDEN.has(key.toLowerCase()) || /[\r\n]/.test(raw)) continue;
    headers[key] = raw;
  }
  setHeader(headers, "accept", "application/json");
  if (options.contentType) setHeader(headers, "content-type", options.contentType);
  if (runtime.apiKey) setHeader(headers, "authorization", `Bearer ${runtime.apiKey}`);
  if (runtime.api === "openai-codex-responses") {
    setHeader(headers, "originator", "pi");
    setHeader(headers, "version", CODEX_CLIENT_VERSION);
    if (runtime.sessionId) {
      setHeader(headers, "session-id", runtime.sessionId);
      setHeader(headers, "x-client-request-id", runtime.sessionId);
    }
  }
  if (userAgent) setHeader(headers, "user-agent", userAgent);
  return headers;
}

export const _headersTest = { FORBIDDEN };
