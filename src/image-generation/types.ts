import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const IMAGE_TOOL_NAME = "image_gen" as const;
export const IMAGE_MIME_TYPE = "image/png" as const;
export const IMAGE_SIZES = ["auto", "1024x1024", "1536x1024", "1024x1536"] as const;
export const IMAGE_QUALITIES = ["auto", "low", "medium", "high"] as const;
export const IMAGE_ACTIONS = ["generate", "edit"] as const;
/** Request transports: Responses tools[] + image_generation, or the Images API. */
export const IMAGE_TRANSPORTS = ["auto", "responses", "images"] as const;

export const MAX_PROMPT_CHARS = 20_000;
export const MAX_PATH_CHARS = 4_096;
export const MAX_MODEL_CHARS = 256;
export const MAX_USER_AGENT_CHARS = 512;
export const MAX_REFERENCE_COUNT = 5;
export const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
export const MAX_TOTAL_REFERENCE_BYTES = 50 * 1024 * 1024;
export const MAX_GENERATED_BYTES = 32 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 48 * 1024 * 1024;
export const MAX_ERROR_BYTES = 64 * 1024;
export const IMAGE_TIMEOUT_MS = 5 * 60 * 1000;
export const MAX_IMAGE_DIMENSION = 100_000;

/** The Responses image_generation tool accepts 0-3 partial previews. */
export const MAX_PARTIAL_IMAGES = 3;
/** Partial previews keep the stream alive while a long generation stays silent. */
export const DEFAULT_PARTIAL_IMAGES = 1;

export type ImageSize = (typeof IMAGE_SIZES)[number];
export type ImageQuality = (typeof IMAGE_QUALITIES)[number];
export type ImageAction = (typeof IMAGE_ACTIONS)[number];
export type ImageTransport = (typeof IMAGE_TRANSPORTS)[number];
/** A transport that can actually be used for a request. */
export type ActiveImageTransport = Exclude<ImageTransport, "auto">;

/**
 * Why a provider binding was selected for a request. Mirrors the three selection rules and is
 * written to the debug log so an unexpected provider switch stays explainable.
 */
export type ImageBindingReason = "current-provider" | "matched-provider" | "session-fallback";

export type ImageConfig = {
  enabled: boolean;
  /** Image model sent to the provider request payload. */
  imageModel: string | undefined;
  /**
   * Top-level Responses model that hosts the image_generation tool. The provider binding that
   * owns this model also serves the request, so it doubles as the provider selector.
   * Defaults to the active session model id.
   */
  textModel: string | undefined;
  userAgent: string | undefined;
  /** Preferred transport; auto picks Responses for Responses-API providers. */
  transport: ImageTransport;
  /** Partial previews requested from the Responses tool (0 disables them). */
  partialImages: number;
  /** Use streamed SSE responses where the transport supports it. */
  stream: boolean;
  /** Opt-in retry of transport-level failures; a retry may duplicate charges. */
  retryOnTransportFailure: boolean;
  /** Append one metadata-only JSONL record per request to the agent debug log. */
  debug: boolean;
  defaultSize: ImageSize;
  defaultQuality: ImageQuality;
};

export type LoadedImageConfig = {
  config: ImageConfig;
  source?: string;
  warnings: string[];
  valid: boolean;
};

export type ImageToolParams = {
  prompt: string;
  action: ImageAction;
  referenceImagePaths?: string[] | null;
  size?: ImageSize;
  quality?: ImageQuality;
  outputPath?: string | null;
};

export type NormalizedImageParams = {
  prompt: string;
  action: ImageAction;
  referenceImagePaths: string[];
  size: ImageSize;
  quality: ImageQuality;
  outputPath?: string;
};

export type RuntimeModel = {
  provider: string;
  id: string;
  api: string;
  baseUrl?: string;
  headers?: Record<string, string | null>;
};

export type ResolvedAuth =
  | {
      ok: true;
      apiKey?: string;
      baseUrl?: string;
      headers?: Record<string, string | null>;
    }
  | { ok: false; error: string };

export type ImageGenerationRuntime = {
  provider: string;
  api: string;
  providerModel: string;
  baseUrl: string;
  generationUrl: string;
  editsUrl: string;
  /** Responses endpoint used by the tools[] + image_generation transport. */
  responsesUrl: string;
  /** Primary transport resolved from configuration and provider API id. */
  transport: ActiveImageTransport;
  /** Top-level model for the Responses request. */
  textModel: string;
  /** Why this provider binding was chosen; diagnostics only. */
  bindingReason: ImageBindingReason;
  /** Partial previews requested from the Responses tool (0 disables them). */
  partialImages: number;
  /** Whether requests stream SSE responses or wait for one JSON response. */
  stream: boolean;
  /** Whether a transport-level failure may be retried once (may re-bill). */
  retryOnTransportFailure: boolean;
  /** Whether the caller wants a metadata-only debug record per request. */
  debug: boolean;
  apiKey?: string;
  headers?: Record<string, string | null>;
  sessionId?: string;
  currentModel: RuntimeModel;
};

export type ImageGenerationContext = Pick<ExtensionContext, "model" | "modelRegistry" | "sessionManager" | "cwd" | "hasUI" | "ui"> & {
  isProjectTrusted?: () => boolean;
};

export type PreparedReferenceImage = {
  path: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  bytes: Buffer;
};

export type ImageCreateRequest = {
  model: string;
  prompt: string;
  n: 1;
  size?: ImageSize;
  quality?: ImageQuality;
  output_format?: "png";
  response_format?: "b64_json";
  /** Images API keep-alive for streamed generations (0-3); DALL-E requests omit it. */
  partial_images?: number;
};

export type ImageEditRequest = {
  body: Uint8Array<ArrayBuffer>;
  contentType: string;
  clear: () => void;
};

/** Responses API request that declares the server-side image_generation tool. */
export type ImageResponsesRequest = {
  model: string;
  store: false;
  stream: boolean;
  parallel_tool_calls: false;
  input: Array<{
    type: "message";
    role: "user";
    content: Array<
      | { type: "input_text"; text: string }
      | { type: "input_image"; image_url: string; detail?: "auto" }
    >;
  }>;
  tools: Array<{
    type: "image_generation";
    model: string;
    action: ImageAction;
    size: ImageSize;
    quality: ImageQuality;
    output_format: "png";
    /** 0 disables previews; 1-3 make the provider stream partial images. */
    partial_images: number;
  }>;
  tool_choice: { type: "image_generation" };
};

/** Inputs for the Responses body; the caller decides which model plays which role. */
export type ImageResponsesRequestOptions = {
  /** Image model declared by the image_generation tool (tools[0].model). */
  imageModel: string;
  /** Top-level Responses model that hosts the tool. */
  textModel: string;
  params: NormalizedImageParams;
  references: readonly PreparedReferenceImage[];
  /** Partial previews requested from the tool; the builder clamps it to 0-3. */
  partialImages: number;
  /** Stream the Responses body instead of waiting for one JSON response. */
  stream: boolean;
};

export type ParsedGeneratedImage = {
  bytes: Buffer;
  revisedPrompt?: string;
  width: number;
  height: number;
};

export type ImageGenerationDetails = {
  artifactPath: string;
  outputPath?: string;
  providerModel: string;
  imageModel: string;
  imageCallId: string;
  mimeType: typeof IMAGE_MIME_TYPE;
  byteCount: number;
  width: number;
  height: number;
  action: ImageAction;
  referenceCount: number;
  /** Transport used for this result; absent on results persisted before transports existed. */
  transport?: ActiveImageTransport;
  revisedPrompt?: string;
};

export type ImageGenerationResult = {
  details: ImageGenerationDetails;
  text: string;
};

export type ImageFailureCode =
  | "aborted"
  | "timeout"
  | "config"
  | "unsupported-model"
  | "authentication"
  | "network"
  | "rate-limit"
  | "request-rejected"
  | "backend-unavailable"
  | "oversized-response"
  | "malformed-response"
  | "no-image"
  | "invalid-parameters"
  | "reference-input-invalid"
  | "reference-upload-approval-required"
  | "reference-upload-declined"
  | "output-path-invalid"
  | "output-path-approval-required"
  | "output-path-declined"
  | "artifact-write-failed"
  | "unsupported-action";

export class ImageGenerationError extends Error {
  readonly code: ImageFailureCode;

  constructor(code: ImageFailureCode, message: string) {
    super(message);
    this.name = "ImageGenerationError";
    this.code = code;
  }
}

/**
 * Renders a human-readable diagnostic from an arbitrary failure value. Values that
 * carry no usable message (undefined, null, empty strings, opaque objects) fall back
 * to the supplied description instead of leaking a literal "undefined".
 */
export function sanitizeDiagnostic(value: unknown, fallback: string): string {
  const normalized = (describeDiagnosticValue(value) ?? "")
    .replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, "[REDACTED_IMAGE_DATA]")
    .replace(/[A-Za-z0-9+/]{128,}={0,2}/g, "[REDACTED_BASE64]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|api[-_ ]?key\s*[:=]\s*[^\s,;]+|(?:access|refresh)[-_ ]?token\s*[:=]\s*[^\s,;]+|token\s*[:=]\s*[^\s,;]+)/gi, "[REDACTED]")
    .replace(/\b(cookie|account[-_ ]?id|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1: [REDACTED]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (normalized || fallback).slice(0, 4_096);
}

/** Extracts a descriptive string from a thrown value, or undefined when it has none. */
function describeDiagnosticValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.trim() || undefined;
  if (value instanceof Error) {
    const parts: string[] = [];
    const detail = value.name && value.name !== "Error" ? `${value.name}: ${value.message}` : value.message;
    if (detail.trim()) parts.push(detail.trim());
    const code = (value as { code?: unknown }).code;
    if (typeof code === "string" || typeof code === "number") parts.push(`code=${code}`);
    const cause = (value as { cause?: unknown }).cause;
    if (cause !== undefined && cause !== value) parts.push(`cause=${describeDiagnosticValue(cause) ?? typeof cause}`);
    return parts.join(" ") || undefined;
  }
  if (typeof value === "object") {
    try {
      const json = JSON.stringify(value);
      return json && json !== "{}" ? json : undefined;
    } catch {
      return undefined;
    }
  }
  const primitive = String(value).trim();
  return primitive || undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isImageGenerationDetails(value: unknown): value is ImageGenerationDetails {
  if (!record(value)) return false;
  return (
    typeof value.artifactPath === "string" && value.artifactPath.length > 0 &&
    (value.outputPath === undefined || typeof value.outputPath === "string") &&
    typeof value.providerModel === "string" && typeof value.imageModel === "string" &&
    typeof value.imageCallId === "string" && value.mimeType === IMAGE_MIME_TYPE &&
    typeof value.byteCount === "number" && Number.isInteger(value.byteCount) && value.byteCount > 0 && value.byteCount <= MAX_GENERATED_BYTES &&
    typeof value.width === "number" && Number.isInteger(value.width) && value.width > 0 && value.width <= MAX_IMAGE_DIMENSION &&
    typeof value.height === "number" && Number.isInteger(value.height) && value.height > 0 && value.height <= MAX_IMAGE_DIMENSION &&
    typeof value.action === "string" && (IMAGE_ACTIONS as readonly string[]).includes(value.action) &&
    typeof value.referenceCount === "number" && Number.isInteger(value.referenceCount) && value.referenceCount >= 0 && value.referenceCount <= MAX_REFERENCE_COUNT &&
    (value.transport === undefined || (typeof value.transport === "string" && (["responses", "images"] as readonly string[]).includes(value.transport)))
  );
}
