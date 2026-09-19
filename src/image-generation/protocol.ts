import {
  IMAGE_ACTIONS,
  IMAGE_QUALITIES,
  IMAGE_SIZES,
  MAX_GENERATED_BYTES,
  MAX_IMAGE_DIMENSION,
  MAX_MODEL_CHARS,
  MAX_PATH_CHARS,
  MAX_PROMPT_CHARS,
  MAX_REFERENCE_COUNT,
  ImageGenerationError,
  type ImageAction,
  type ImageGenerationRequest,
  type ImageQuality,
  type ImageSize,
  type NormalizedImageParams,
  type ParsedGeneratedImage,
  type PreparedReferenceImage,
} from "./types.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizePaths(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ImageGenerationError("invalid-parameters", "referenceImagePaths must be an array.");
  const paths: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !item.trim() || item.length > MAX_PATH_CHARS) throw new ImageGenerationError("invalid-parameters", "referenceImagePaths must contain bounded non-empty path strings.");
    paths.push(item.trim());
    if (paths.length > MAX_REFERENCE_COUNT) throw new ImageGenerationError("invalid-parameters", `At most ${MAX_REFERENCE_COUNT} reference images are supported.`);
  }
  return paths;
}

export function normalizeImageParams(args: Record<string, unknown>, defaults?: { size?: ImageSize; quality?: ImageQuality }): NormalizedImageParams {
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (!prompt || prompt.length > MAX_PROMPT_CHARS) throw new ImageGenerationError("invalid-parameters", `prompt must contain 1-${MAX_PROMPT_CHARS} characters.`);
  const action = args.action;
  if (typeof action !== "string" || !(IMAGE_ACTIONS as readonly string[]).includes(action)) throw new ImageGenerationError("unsupported-action", "action must be generate or edit; image_variation is not supported.");
  const referenceImagePaths = normalizePaths(args.referenceImagePaths);
  if (action === "edit" && referenceImagePaths.length === 0) throw new ImageGenerationError("invalid-parameters", "edit requires at least one explicit reference image path.");
  if (action === "generate" && referenceImagePaths.length > 0) throw new ImageGenerationError("invalid-parameters", "generate does not accept reference images; use action edit.");
  const size = args.size ?? defaults?.size ?? "auto";
  const quality = args.quality ?? defaults?.quality ?? "auto";
  if (typeof size !== "string" || !(IMAGE_SIZES as readonly string[]).includes(size)) throw new ImageGenerationError("invalid-parameters", "Unsupported image size.");
  if (typeof quality !== "string" || !(IMAGE_QUALITIES as readonly string[]).includes(quality)) throw new ImageGenerationError("invalid-parameters", "Unsupported image quality.");
  let outputPath: string | undefined;
  if (args.outputPath !== undefined && args.outputPath !== null) {
    if (typeof args.outputPath !== "string" || !args.outputPath.trim() || args.outputPath.length > MAX_PATH_CHARS) throw new ImageGenerationError("invalid-parameters", "outputPath must be a bounded non-empty path string.");
    outputPath = args.outputPath.trim();
  }
  return { prompt, action: action as ImageAction, referenceImagePaths, size: size as ImageSize, quality: quality as ImageQuality, ...(outputPath ? { outputPath } : {}) };
}

export function buildImageGenerationRequest(args: {
  routingModel: string;
  imageModel: string;
  params: NormalizedImageParams;
  references: readonly PreparedReferenceImage[];
}): ImageGenerationRequest {
  if (!args.routingModel.trim() || args.routingModel.length > MAX_MODEL_CHARS) throw new ImageGenerationError("invalid-parameters", "A bounded routing model is required.");
  if (!args.imageModel.trim() || args.imageModel.length > MAX_MODEL_CHARS) throw new ImageGenerationError("invalid-parameters", "A bounded image model is required.");
  const content: ImageGenerationRequest["input"][number]["content"] = [{ type: "input_text", text: args.params.prompt }];
  for (const reference of args.references) content.push({ type: "input_image", image_url: `data:${reference.mimeType};base64,${reference.bytes.toString("base64")}`, detail: "auto" });
  return {
    model: args.routingModel,
    store: false,
    stream: false,
    parallel_tool_calls: false,
    input: [{ role: "user", content }],
    tools: [{ type: "image_generation", model: args.imageModel, action: args.params.action, size: args.params.size, quality: args.params.quality, output_format: "png" }],
    tool_choice: { type: "image_generation" },
  };
}

export function isValidPng(bytes: Uint8Array): boolean {
  return bytes.byteLength >= PNG_SIGNATURE.length && Buffer.from(bytes).subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

export function readPngDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  const buffer = Buffer.from(bytes);
  if (!isValidPng(buffer) || buffer.length < 24 || buffer.readUInt32BE(8) !== 13 || buffer.toString("ascii", 12, 16) !== "IHDR") return undefined;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return width > 0 && height > 0 && width <= MAX_IMAGE_DIMENSION && height <= MAX_IMAGE_DIMENSION ? { width, height } : undefined;
}

function hasPngEndChunk(bytes: Uint8Array): boolean {
  const buffer = Buffer.from(bytes);
  return buffer.length >= 33 && buffer.readUInt32BE(buffer.length - 12) === 0 && buffer.toString("ascii", buffer.length - 8, buffer.length - 4) === "IEND";
}

export function decodeGeneratedPng(value: string): { ok: true; bytes: Buffer; width: number; height: number } | { ok: false; reason: "malformed-response" | "oversized-response"; errorMessage: string } {
  const trimmed = value.trim();
  const dataUrl = /^data:image\/[a-z0-9.+-]+;base64,(.*)$/is.exec(trimmed);
  const base64 = (dataUrl?.[1] ?? trimmed).trim();
  if (base64.length > Math.ceil(MAX_GENERATED_BYTES / 3) * 4) return { ok: false, reason: "oversized-response", errorMessage: "Generated image exceeded the size limit." };
  if (!base64 || base64.length % 4 !== 0 || !BASE64.test(base64)) return { ok: false, reason: "malformed-response", errorMessage: "Generated image did not contain valid base64." };
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0 || bytes.length > MAX_GENERATED_BYTES || bytes.toString("base64") !== base64 || !isValidPng(bytes) || !hasPngEndChunk(bytes)) {
    bytes.fill(0);
    return { ok: false, reason: bytes.length > MAX_GENERATED_BYTES ? "oversized-response" : "malformed-response", errorMessage: "Generated image was not a valid PNG." };
  }
  const dimensions = readPngDimensions(bytes);
  if (!dimensions) { bytes.fill(0); return { ok: false, reason: "malformed-response", errorMessage: "Generated PNG dimensions were invalid." }; }
  return { ok: true, bytes, ...dimensions };
}

function responsePayload(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === "response.completed" && isRecord(value.response)) return value.response;
  if (value.event === "response.completed" && isRecord(value.response)) return value.response;
  return value;
}

export function parseImageGenerationResponse(value: unknown): { ok: true; image: ParsedGeneratedImage } | { ok: false; reason: "malformed-response" | "request-rejected" | "no-image" | "oversized-response"; errorMessage: string } {
  const payload = responsePayload(value);
  if (!payload) return { ok: false, reason: "malformed-response", errorMessage: "Image response was not an object." };
  if (payload.status !== undefined && payload.status !== "completed") {
    const error = isRecord(payload.error) && typeof payload.error.message === "string" ? payload.error.message : `Image response status was ${String(payload.status)}.`;
    return { ok: false, reason: "request-rejected", errorMessage: error };
  }
  if (!Array.isArray(payload.output)) return { ok: false, reason: "malformed-response", errorMessage: "Image response did not contain output." };
  const calls: Array<{ id: string; result: string; revisedPrompt?: string }> = [];
  for (const [index, item] of payload.output.entries()) {
    if (!isRecord(item) || item.type !== "image_generation_call") continue;
    if (item.status !== undefined && item.status !== "completed") continue;
    const result = typeof item.result === "string" ? item.result : typeof item.b64_json === "string" ? item.b64_json : undefined;
    if (!result?.trim()) continue;
    calls.push({ id: typeof item.id === "string" && item.id.trim() ? item.id : `image_generation_${index}`, result, ...(typeof item.revised_prompt === "string" ? { revisedPrompt: item.revised_prompt } : {}) });
  }
  if (calls.length === 0) return { ok: false, reason: "no-image", errorMessage: "Image response completed without an image result." };
  if (calls.length !== 1) return { ok: false, reason: "malformed-response", errorMessage: "A single image request returned multiple image results." };
  const call = calls[0];
  if (!call) return { ok: false, reason: "no-image", errorMessage: "Image response completed without an image result." };
  const decoded = decodeGeneratedPng(call.result);
  if (!decoded.ok) return decoded;
  return { ok: true, image: { bytes: decoded.bytes, imageCallId: call.id, ...(typeof payload.id === "string" ? { responseId: payload.id } : {}), ...(call.revisedPrompt ? { revisedPrompt: call.revisedPrompt } : {}), width: decoded.width, height: decoded.height } };
}

export const _protocolTest = { PNG_SIGNATURE, hasPngEndChunk };
