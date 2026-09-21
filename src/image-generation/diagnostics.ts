import { appendFileSync } from "node:fs";
import { join } from "node:path";
import {
  sanitizeDiagnostic,
  type ImageBindingReason,
  type ActiveImageTransport,
  type ImageAction,
  type ImageQuality,
  type ImageSize,
  type NormalizedImageParams,
} from "./types.js";

/**
 * Diagnostics for one image request. The plugin cannot see the HTTP hops between
 * itself and the provider, so every failure has to carry its own timeline: when the
 * response headers and the first stream event arrived, how long the connection stayed
 * silent before it ended, and whether the plugin's own timeout or the caller's
 * cancellation ended it. That is the only way to tell an idle-connection cut from a
 * total-duration limit.
 */

/** Coarse phase of one request. Only diagnostics read it. */
export type ImageTraceStage = "prepare" | "sending" | "headers" | "result" | "done";

/** Who ended the request, phrased for a reader who has to act on it. */
export type ImageTraceEnding = "provider" | "plugin timeout" | "caller cancellation";

export type ImageTraceSnapshot = {
  stage: ImageTraceStage;
  elapsedMs: number;
  bytes: number;
  events: number;
  partials: number;
  headersMs?: number;
  firstEventMs?: number;
  lastEventMs?: number;
  /** Milliseconds since the last bytes arrived, whatever stage they arrived in. */
  silentMs?: number;
  /** Longest gap with no downstream byte: how close the request came to an idle timeout. */
  maxSilentMs: number;
  timedOut: boolean;
  aborted: boolean;
};

/** Progress from partial previews; a stream that keeps delivering them cannot idle out. */
export type ImageProgressEvent = {
  /** Partial previews received so far. */
  partials: number;
  /** Milliseconds since the request started. */
  elapsedMs: number;
};

export type ImageDebugRecord = {
  event: "image_request";
  at: string;
  endpoint: string;
  provider: string;
  api: string;
  /** Why this provider binding was selected instead of the session one. */
  bindingReason: ImageBindingReason;
  transport: ActiveImageTransport;
  stream: boolean;
  /** Partial previews the request asked the Responses tool for. */
  partialImages: number;
  model: { text: string; image: string };
  request: { action: ImageAction; size: ImageSize; quality: ImageQuality; referenceCount: number };
  result: { outcome: "ok" | "failure"; reason?: string; status?: number; truncated?: boolean; message?: string };
  timing: {
    elapsedMs: number;
    headersMs?: number;
    firstEventMs?: number;
    lastEventMs?: number;
    silentMs?: number;
    /** Longest gap with no downstream byte: how close the request came to an idle timeout. */
    maxSilentMs: number;
  };
  traffic: { bytes: number; events: number; partials: number };
  flags: { timedOut: boolean; aborted: boolean };
};

export const DEBUG_LOG_FILENAME = "pi-image-gen-debug.jsonl";
/** Below this, a silence is ordinary provider latency rather than an idle cut. */
const SUSPECT_IDLE_MS = 25_000;

/** Records the observable timeline of one prepared request. No payloads are retained. */
export class ImageRequestTrace {
  readonly transport: ActiveImageTransport;
  readonly stream: boolean;
  readonly startedAt: number;
  stage: ImageTraceStage = "prepare";
  bytes = 0;
  events = 0;
  partials = 0;
  headersAt: number | undefined;
  firstEventAt: number | undefined;
  lastEventAt: number | undefined;
  /** Longest observed gap with no downstream byte: the headroom against an idle timeout. */
  maxSilentMs = 0;
  timedOut = false;
  aborted = false;

  constructor(transport: ActiveImageTransport, stream: boolean, startedAt = Date.now()) {
    this.transport = transport;
    this.stream = stream;
    this.startedAt = startedAt;
  }

  /** Every downstream byte resets the idle clock; the largest gap is what a proxy limits. */
  private noteActivity(elapsedMs: number): void {
    const previous = this.lastEventAt ?? this.headersAt;
    if (previous !== undefined) this.maxSilentMs = Math.max(this.maxSilentMs, elapsedMs - previous);
  }

  elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  enterStage(stage: ImageTraceStage): void {
    this.stage = stage;
  }

  /** Response headers arrived: the provider accepted the request and started answering. */
  markHeaders(elapsedMs = this.elapsedMs()): void {
    this.stage = "headers";
    if (this.headersAt === undefined) this.headersAt = elapsedMs;
  }

  noteBytes(count: number): void {
    if (Number.isFinite(count) && count > 0) this.bytes += count;
  }

  /** One complete SSE frame arrived. Partial previews count as activity as well. */
  markEvent(isPartial = false, elapsedMs = this.elapsedMs()): void {
    this.noteActivity(elapsedMs);
    this.events += 1;
    if (isPartial) this.partials += 1;
    this.lastEventAt = elapsedMs;
    if (this.firstEventAt === undefined) {
      this.firstEventAt = elapsedMs;
      this.stage = "result";
    }
  }

  markTimeout(): void {
    this.timedOut = true;
  }

  markAbort(): void {
    this.aborted = true;
  }

  markDone(): void {
    this.stage = "done";
  }

  ending(): ImageTraceEnding {
    if (this.aborted) return "caller cancellation";
    if (this.timedOut) return "plugin timeout";
    return "provider";
  }

  snapshot(): ImageTraceSnapshot {
    const elapsedMs = this.elapsedMs();
    const lastActivityAt = this.lastEventAt ?? this.headersAt;
    return {
      stage: this.stage,
      elapsedMs,
      bytes: this.bytes,
      events: this.events,
      partials: this.partials,
      ...(this.headersAt === undefined ? {} : { headersMs: this.headersAt }),
      ...(this.firstEventAt === undefined ? {} : { firstEventMs: this.firstEventAt }),
      ...(this.lastEventAt === undefined ? {} : { lastEventMs: this.lastEventAt }),
      ...(lastActivityAt === undefined ? {} : { silentMs: Math.max(0, elapsedMs - lastActivityAt) }),
      maxSilentMs: Math.max(this.maxSilentMs, lastActivityAt === undefined ? 0 : elapsedMs - lastActivityAt),
      timedOut: this.timedOut,
      aborted: this.aborted,
    };
  }

  /** One bracketed suffix appended to a failure message. */
  format(ending: ImageTraceEnding = this.ending()): string {
    const snapshot = this.snapshot();
    const parts = [
      `${this.stream ? "streamed" : "non-streamed"} ${this.transport} transport`,
      `${formatSeconds(snapshot.elapsedMs)} elapsed`,
      ...(snapshot.headersMs === undefined ? [] : [`headers ${formatSeconds(snapshot.headersMs)}`]),
      ...(snapshot.firstEventMs === undefined ? [] : [`first event ${formatSeconds(snapshot.firstEventMs)}`]),
      `${snapshot.events} event(s)`,
      ...(snapshot.partials === 0 ? [] : [`${snapshot.partials} partial preview(s)`]),
      `${formatBytes(snapshot.bytes)} received`,
      ...(snapshot.silentMs === undefined ? [] : [`silent for ${formatSeconds(snapshot.silentMs)} before ending`]),
      `ended by ${ending}`,
    ];
    return `[${parts.join(", ")}]`;
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KiB", "MiB", "GiB"] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : String(Math.round(value))} ${units[unit]}`;
}

export function formatSeconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

/**
 * Explains a failure whose timeline points at an intermediate hop rather than at the
 * provider. Silent gaps are the signature of a proxy or CDN idle read timeout: the
 * upstream generation usually keeps running and gets billed while the client only
 * sees the connection end.
 */
export function describeIdleCut(trace: ImageRequestTrace): string | undefined {
  const snapshot = trace.snapshot();
  if (snapshot.timedOut || snapshot.aborted) return undefined;
  if (snapshot.headersMs === undefined && snapshot.events === 0) {
    if (snapshot.elapsedMs < SUSPECT_IDLE_MS) return undefined;
    return `No response header arrived within ${formatSeconds(snapshot.elapsedMs)}, so an intermediate proxy may have dropped the request before it answered; the provider may still be generating and billing it. Verify the gateway's own log for this request before retrying.`;
  }
  if (snapshot.silentMs === undefined || snapshot.silentMs < SUSPECT_IDLE_MS) return undefined;
  return `The connection was silent for ${formatSeconds(snapshot.silentMs)} before it ended, which is the signature of an intermediate proxy or CDN closing an idle connection (for example an nginx/openresty proxy_read_timeout). The provider may still have completed and billed the generation. Compare with transport "images", raise partialImages, or check the intermediary's idle timeout.`;
}

/** Base message plus the timeline, plus an actionable hint when the timeline explains it. */
export function describeImageFailure(base: string, trace: ImageRequestTrace): string {
  const hint = describeIdleCut(trace);
  return `${base} ${trace.format()}${hint ? ` ${hint}` : ""}`;
}

/** Keeps credentials and query strings out of the debug log. */
export function redactEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return sanitizeDiagnostic(url.replace(/[?#].*$/, ""), "unknown endpoint");
  }
}

export function buildImageDebugRecord(input: {
  trace: ImageRequestTrace;
  endpoint: string;
  provider: string;
  api: string;
  textModel: string;
  bindingReason: ImageBindingReason;
  imageModel: string;
  params: NormalizedImageParams;
  /** Partial previews the request asked the Responses tool for. */
  partialImages: number;
  referenceCount: number;
  result: { outcome: "ok" | "failure"; reason?: string; status?: number; truncated?: boolean; message?: string };
}): ImageDebugRecord {
  const { trace } = input;
  return {
    event: "image_request",
    at: new Date().toISOString(),
    endpoint: redactEndpoint(input.endpoint),
    provider: input.provider,
    api: input.api,
    bindingReason: input.bindingReason,
    transport: trace.transport,
    stream: trace.stream,
    partialImages: input.partialImages,
    model: {
      text: input.textModel,
      image: input.imageModel,
    },
    request: {
      action: input.params.action,
      size: input.params.size,
      quality: input.params.quality,
      referenceCount: input.referenceCount,
    },
    result: {
      outcome: input.result.outcome,
      ...(input.result.reason === undefined ? {} : { reason: input.result.reason }),
      ...(input.result.status === undefined ? {} : { status: input.result.status }),
      ...(input.result.truncated === undefined ? {} : { truncated: input.result.truncated }),
      ...(input.result.message === undefined ? {} : { message: sanitizeDiagnostic(input.result.message, "unknown error") }),
    },
    timing: {
      elapsedMs: trace.snapshot().elapsedMs,
      ...(trace.headersAt === undefined ? {} : { headersMs: trace.headersAt }),
      ...(trace.firstEventAt === undefined ? {} : { firstEventMs: trace.firstEventAt }),
      ...(trace.lastEventAt === undefined ? {} : { lastEventMs: trace.lastEventAt }),
      ...(trace.snapshot().silentMs === undefined ? {} : { silentMs: trace.snapshot().silentMs }),
      maxSilentMs: trace.snapshot().maxSilentMs,
    },
    traffic: { bytes: trace.bytes, events: trace.events, partials: trace.partials },
    flags: { timedOut: trace.timedOut, aborted: trace.aborted },
  };
}

/** Best-effort metadata log. Returns an error message instead of breaking a paid request. */
export function appendImageDebugRecord(agentDir: string, record: ImageDebugRecord): string | undefined {
  try {
    appendFileSync(join(agentDir, DEBUG_LOG_FILENAME), `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600, flag: "a" });
    return undefined;
  } catch (error) {
    return sanitizeDiagnostic(error, "the debug log could not be written");
  }
}

export const _diagnosticsTest = { formatBytes, formatSeconds, SUSPECT_IDLE_MS, redactEndpoint };
