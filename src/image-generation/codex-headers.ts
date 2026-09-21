import { arch, platform, release } from "node:os";
import type { ImageGenerationRuntime } from "./types.js";

/**
 * Hop-by-hop, transport-owned and credential headers are never copied from the host
 * provider configuration. `chatgpt-account-id` is allowed through: ChatGPT-backed
 * codex endpoints require it and the host resolves it from its own OAuth session.
 */
const FORBIDDEN = new Set([
  "host", "cookie", "set-cookie", "connection", "content-length", "content-type", "transfer-encoding",
  "proxy-authorization",
]);

/** Codex client identities the ChatGPT backend accepts as `originator`. */
const CODEX_CLIENT_NAMES = new Set([
  "codex_cli_rs", "codex-tui", "codex_vscode", "codex_vscode_copilot", "codex_app",
  "codex_chatgpt_desktop", "codex_atlas", "codex_exec", "codex_sdk_ts",
]);

function setHeader(headers: Record<string, string>, name: string, value: string): void {
  for (const existing of Object.keys(headers)) if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing];
  headers[name] = value;
}

function findHeader(headers: Record<string, string>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name) return value;
  return undefined;
}

/** Mirrors the host's own codex client user agent so an originator has a matching peer. */
function defaultPiUserAgent(): string {
  return `pi (${platform()} ${release()}; ${arch()})`;
}

/**
 * Derives a codex identity from a codex-style user agent. The ChatGPT backend pairs
 * `originator` with the user agent's first segment and rejects mismatches, so a client
 * announcing `codex_cli_rs/...` must not send `originator: pi`.
 */
export function codexIdentity(userAgent: string | undefined): { originator: string; version?: string } | undefined {
  const ua = userAgent?.trim();
  if (!ua) return undefined;
  const slash = ua.indexOf("/");
  const name = (slash < 0 ? ua.split(/\s/, 1)[0] ?? "" : ua.slice(0, slash)).trim();
  if (!name) return undefined;
  const lowered = name.toLowerCase();
  if (!CODEX_CLIENT_NAMES.has(lowered)) return undefined;
  const version = slash < 0 ? "" : ua.slice(slash + 1).split(/\s/, 1)[0]?.trim() ?? "";
  return { originator: lowered, ...(version ? { version } : {}) };
}

export type ImageRequestHeaderOptions = {
  contentType?: string;
  /** Event-stream accept header for streamed transports. */
  accept?: string;
  /** Transport actually used by this request; a fallback must not look like a Responses call. */
  transport?: "responses" | "images";
};

export function buildImageRequestHeaders(runtime: ImageGenerationRuntime, userAgent?: string, options: ImageRequestHeaderOptions = {}): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, raw] of Object.entries(runtime.headers ?? {})) {
    if (raw === null || typeof raw !== "string" || FORBIDDEN.has(key.toLowerCase()) || /[\r\n]/.test(raw)) continue;
    headers[key] = raw;
  }
  if (userAgent) setHeader(headers, "user-agent", userAgent);
  const identity = codexIdentity(findHeader(headers, "user-agent"));
  const codexBackend = runtime.api === "openai-codex-responses" || identity !== undefined;
  if (codexBackend) {
    if (!findHeader(headers, "user-agent")) setHeader(headers, "user-agent", defaultPiUserAgent());
    setHeader(headers, "originator", identity?.originator ?? "pi");
    // Only a version derived from the user agent is authoritative; a host-configured
    // version stays untouched so an upstream version gate keeps working.
    if (identity?.version) setHeader(headers, "version", identity.version);
    if ((options.transport ?? runtime.transport) === "responses") setHeader(headers, "openai-beta", "responses=experimental");
  }
  setHeader(headers, "accept", options.accept ?? "application/json");
  if (options.contentType) setHeader(headers, "content-type", options.contentType);
  if (runtime.apiKey) setHeader(headers, "authorization", `Bearer ${runtime.apiKey}`);
  if (codexBackend && runtime.sessionId) {
    setHeader(headers, "session-id", runtime.sessionId);
    setHeader(headers, "x-client-request-id", runtime.sessionId);
  }
  return headers;
}

export const _headersTest = { FORBIDDEN, CODEX_CLIENT_NAMES };
