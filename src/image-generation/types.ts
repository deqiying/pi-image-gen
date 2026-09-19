import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const IMAGE_TOOL_NAME = "image_gen" as const;
export const IMAGE_MIME_TYPE = "image/png" as const;
export const IMAGE_SIZES = ["auto", "1024x1024", "1536x1024", "1024x1536"] as const;
export const IMAGE_QUALITIES = ["auto", "low", "medium", "high"] as const;
export const IMAGE_ACTIONS = ["generate", "edit"] as const;
export const SUPPORTED_RESPONSES_APIS = ["openai-responses", "openai-codex-responses"] as const;

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

export type ImageSize = (typeof IMAGE_SIZES)[number];
export type ImageQuality = (typeof IMAGE_QUALITIES)[number];
export type ImageAction = (typeof IMAGE_ACTIONS)[number];
export type ResponsesApi = (typeof SUPPORTED_RESPONSES_APIS)[number];

export type ImageConfig = {
  enabled: boolean;
  model: string | undefined;
  imageModel: string | undefined;
  userAgent: string | undefined;
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
  api: ResponsesApi;
  model: string;
  baseUrl: string;
  responsesUrl: string;
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

export type ImageGenerationRequest = {
  model: string;
  store: false;
  stream: false;
  parallel_tool_calls: false;
  input: Array<{
    role: "user";
    content: Array<
      | { type: "input_text"; text: string }
      | { type: "input_image"; image_url: string; detail: "auto" }
    >;
  }>;
  tools: Array<{
    type: "image_generation";
    model: string;
    action: ImageAction;
    size: ImageSize;
    quality: ImageQuality;
    output_format: "png";
  }>;
  tool_choice: { type: "image_generation" };
};

export type ParsedGeneratedImage = {
  bytes: Buffer;
  imageCallId: string;
  responseId?: string;
  revisedPrompt?: string;
  width: number;
  height: number;
};

export type ImageGenerationDetails = {
  artifactPath: string;
  outputPath?: string;
  routingModel: string;
  imageModel: string;
  imageCallId: string;
  responseId?: string;
  mimeType: typeof IMAGE_MIME_TYPE;
  byteCount: number;
  width: number;
  height: number;
  action: ImageAction;
  referenceCount: number;
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

export function sanitizeDiagnostic(value: unknown, fallback: string): string {
  const raw = value instanceof Error ? value.message : typeof value === "string" ? value : String(value);
  const normalized = raw
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

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isImageGenerationDetails(value: unknown): value is ImageGenerationDetails {
  if (!record(value)) return false;
  return (
    typeof value.artifactPath === "string" && value.artifactPath.length > 0 &&
    (value.outputPath === undefined || typeof value.outputPath === "string") &&
    typeof value.routingModel === "string" && typeof value.imageModel === "string" &&
    typeof value.imageCallId === "string" && value.mimeType === IMAGE_MIME_TYPE &&
    typeof value.byteCount === "number" && Number.isInteger(value.byteCount) && value.byteCount > 0 && value.byteCount <= MAX_GENERATED_BYTES &&
    typeof value.width === "number" && Number.isInteger(value.width) && value.width > 0 && value.width <= MAX_IMAGE_DIMENSION &&
    typeof value.height === "number" && Number.isInteger(value.height) && value.height > 0 && value.height <= MAX_IMAGE_DIMENSION &&
    typeof value.action === "string" && (IMAGE_ACTIONS as readonly string[]).includes(value.action) &&
    typeof value.referenceCount === "number" && Number.isInteger(value.referenceCount) && value.referenceCount >= 0 && value.referenceCount <= MAX_REFERENCE_COUNT
  );
}
