import { randomBytes } from "node:crypto";
import { basename } from "node:path";
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
  type ImageCreateRequest,
  type ImageEditRequest,
  type ImageQuality,
  type ImageResponsesRequest,
  type ImageResponsesRequestOptions,
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

function requireModel(value: string, label: string): string {
  const model = value.trim();
  if (!model || model.length > MAX_MODEL_CHARS || /[\r\n]/.test(model)) throw new ImageGenerationError("invalid-parameters", `A bounded ${label} is required.`);
  return model;
}

function requireImageModel(value: string): string {
  return requireModel(value, "imageModel");
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

export function isDallEModel(model: string): boolean {
  return /^(?:dall-e-2|dall-e-3)$/i.test(model);
}

export function validateImageRequest(imageModel: string, params: NormalizedImageParams, references?: readonly PreparedReferenceImage[]): void {
  const model = requireImageModel(imageModel).toLowerCase();
  if (model !== "dall-e-2" && model !== "dall-e-3") return;
  const promptLimit = model === "dall-e-2" ? 1_000 : 4_000;
  if (params.prompt.length > promptLimit) throw new ImageGenerationError("invalid-parameters", `${model} prompts may not exceed ${promptLimit} characters.`);
  if (params.size !== "auto" && params.size !== "1024x1024") throw new ImageGenerationError("invalid-parameters", `${model} does not support image size ${params.size} in this plugin.`);
  if (params.action !== "edit") return;
  if (model === "dall-e-3") throw new ImageGenerationError("unsupported-model", "dall-e-3 does not support the Images API edits endpoint.");
  if (params.referenceImagePaths.length !== 1 || (references && references.length !== 1)) {
    throw new ImageGenerationError("invalid-parameters", "dall-e-2 editing requires exactly one reference image.");
  }
  if (!references) return;
  const reference = references[0];
  const dimensions = reference ? readPngDimensions(reference.bytes) : undefined;
  if (!reference || reference.mimeType !== "image/png" || reference.bytes.length >= 4 * 1024 * 1024 || !dimensions || dimensions.width !== dimensions.height) {
    throw new ImageGenerationError("reference-input-invalid", "dall-e-2 editing requires one square PNG smaller than 4 MiB.");
  }
}

export function buildImageGenerationRequest(imageModel: string, params: NormalizedImageParams): ImageCreateRequest {
  const model = requireImageModel(imageModel);
  validateImageRequest(model, params);
  if (isDallEModel(model)) {
    return { model, prompt: params.prompt, n: 1, ...(params.size !== "auto" ? { size: params.size } : {}), response_format: "b64_json" };
  }
  return { model, prompt: params.prompt, n: 1, size: params.size, quality: params.quality, output_format: "png" };
}

function safeMultipartFilename(path: string, index: number): string {
  return (basename(path) || `reference-${index + 1}.png`).replace(/["\\\r\n]/g, "_");
}

function appendMultipartText(chunks: Buffer[], boundary: string, name: string, value: string): void {
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, "utf8"));
}

export function buildImageEditRequest(imageModel: string, params: NormalizedImageParams, references: readonly PreparedReferenceImage[]): ImageEditRequest {
  if (references.length === 0) throw new ImageGenerationError("invalid-parameters", "Image editing requires at least one prepared reference image.");
  const model = requireImageModel(imageModel);
  const chunks: Buffer[] = [];
  try {
    validateImageRequest(model, params, references);
    const boundary = `----pi-image-gen-${randomBytes(18).toString("hex")}`;
    appendMultipartText(chunks, boundary, "model", model);
    appendMultipartText(chunks, boundary, "prompt", params.prompt);
    appendMultipartText(chunks, boundary, "n", "1");
    if (params.size !== "auto" || !isDallEModel(model)) appendMultipartText(chunks, boundary, "size", params.size);
    if (isDallEModel(model)) appendMultipartText(chunks, boundary, "response_format", "b64_json");
    else {
      appendMultipartText(chunks, boundary, "quality", params.quality);
      appendMultipartText(chunks, boundary, "output_format", "png");
    }
    const field = references.length === 1 ? "image" : "image[]";
    for (const [index, reference] of references.entries()) {
      const filename = safeMultipartFilename(reference.path, index);
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${reference.mimeType}\r\n\r\n`, "utf8"));
      chunks.push(reference.bytes);
      chunks.push(Buffer.from("\r\n", "ascii"));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`, "ascii"));
    const encoded = Buffer.concat(chunks);
    const body = Uint8Array.from(encoded);
    encoded.fill(0);
    return { body, contentType: `multipart/form-data; boundary=${boundary}`, clear: () => body.fill(0) };
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    for (const reference of references) reference.bytes.fill(0);
  }
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

export function parseImageGenerationResponse(value: unknown): { ok: true; image: ParsedGeneratedImage } | { ok: false; reason: "malformed-response" | "request-rejected" | "no-image" | "oversized-response"; errorMessage: string } {
  if (!isRecord(value)) return { ok: false, reason: "malformed-response", errorMessage: "Images API response was not an object." };
  if (isRecord(value.error)) {
    const message = typeof value.error.message === "string" ? value.error.message : "Images API returned an error.";
    return { ok: false, reason: "request-rejected", errorMessage: message };
  }
  if (!Array.isArray(value.data)) return { ok: false, reason: "malformed-response", errorMessage: "Images API response did not contain a data array." };
  if (value.data.length === 0) return { ok: false, reason: "no-image", errorMessage: "Images API completed without an image result." };
  if (value.data.length !== 1) return { ok: false, reason: "malformed-response", errorMessage: "A single image request returned multiple image results." };
  const item = value.data[0];
  if (!isRecord(item) || typeof item.b64_json !== "string" || !item.b64_json.trim()) {
    return { ok: false, reason: "no-image", errorMessage: "Images API response did not contain an inline base64 image." };
  }
  const decoded = decodeGeneratedPng(item.b64_json);
  if (!decoded.ok) return decoded;
  return { ok: true, image: { bytes: decoded.bytes, ...(typeof item.revised_prompt === "string" ? { revisedPrompt: item.revised_prompt } : {}), width: decoded.width, height: decoded.height } };
}

export type ImageResultParse =
  | { ok: true; image: ParsedGeneratedImage }
  | { ok: false; reason: "malformed-response" | "request-rejected" | "no-image" | "oversized-response"; errorMessage: string };

/** DALL-E models are only reachable through the Images API, never the Responses tool. */
export function supportsResponsesTool(imageModel: string): boolean {
  return !isDallEModel(imageModel);
}

function referenceDataUrl(reference: PreparedReferenceImage): string {
  return `data:${reference.mimeType};base64,${reference.bytes.toString("base64")}`;
}

/**
 * Builds the Responses API payload that declares the server-side image_generation
 * tool. This mirrors the official Codex client: the top-level `textModel` answers the
 * request while the built-in tool named by `tool_choice` runs on `toolModel`.
 *
 * `tool_choice` only selects the tool (`{ "type": "image_generation" }`); the API
 * defines no model field there, so the image model lives in `tools[0].model`.
 *
 * Reference bytes are read but not cleared here: the caller owns their lifetime so a
 * capability fallback can still rebuild the same references as multipart data.
 */
export function buildImageResponsesRequest(options: ImageResponsesRequestOptions): string {
  const { toolModel, textModel, params, references } = options;
  const model = requireImageModel(toolModel);
  if (isDallEModel(model)) throw new ImageGenerationError("unsupported-model", "DALL-E models do not support the Responses image_generation tool.");
  validateImageRequest(model, params);
  const content: Array<{ type: "input_text"; text: string } | { type: "input_image"; image_url: string }> = [{ type: "input_text", text: params.prompt }];
  for (const reference of references) content.push({ type: "input_image", image_url: referenceDataUrl(reference) });
  const request: ImageResponsesRequest = {
    model: requireModel(textModel, "textModel"),
    store: false,
    stream: true,
    input: [{ type: "message", role: "user", content }],
    tools: [{ type: "image_generation", model, action: params.action, size: params.size, quality: params.quality, output_format: "png" }],
    tool_choice: { type: "image_generation" },
  };
  return JSON.stringify(request);
}

/**
 * Decodes one Responses output item. Returns undefined when the item is not an
 * image_generation_call at all, so callers can skip unrelated output items.
 */
export function decodeImageGenerationCall(item: unknown): ImageResultParse | undefined {
  if (!isRecord(item) || item.type !== "image_generation_call") return undefined;
  if (typeof item.result !== "string" || !item.result.trim()) {
    const status = typeof item.status === "string" ? item.status : "unknown";
    return { ok: false, reason: "no-image", errorMessage: `Responses API returned an image_generation_call without a result (status ${status}).` };
  }
  const decoded = decodeGeneratedPng(item.result);
  if (!decoded.ok) return decoded;
  return {
    ok: true,
    image: {
      bytes: decoded.bytes,
      ...(typeof item.revised_prompt === "string" ? { revisedPrompt: item.revised_prompt } : {}),
      width: decoded.width,
      height: decoded.height,
    },
  };
}

/** Parses a non-streaming Responses payload even though the tool always asks for SSE. */
export function parseImageResponsesPayload(value: unknown): ImageResultParse {
  if (!isRecord(value)) return { ok: false, reason: "malformed-response", errorMessage: "Responses API response was not an object." };
  if (isRecord(value.error)) {
    const message = typeof value.error.message === "string" ? value.error.message : "Responses API returned an error.";
    return { ok: false, reason: "request-rejected", errorMessage: message };
  }
  if (!Array.isArray(value.output)) return { ok: false, reason: "malformed-response", errorMessage: "Responses API response did not contain an output array." };
  const calls = value.output.map((item) => decodeImageGenerationCall(item)).filter((entry): entry is ImageResultParse => entry !== undefined);
  if (calls.length === 0) return { ok: false, reason: "no-image", errorMessage: "Responses API completed without an image_generation_call output." };
  const completed = calls.filter((entry) => entry.ok);
  if (completed.length === 0) return calls[0]!;
  if (completed.length > 1) return { ok: false, reason: "malformed-response", errorMessage: "A single image request returned multiple image results." };
  return completed[0]!;
}

export const _protocolTest = { PNG_SIGNATURE, hasPngEndChunk, requireImageModel, isDallEModel, supportsResponsesTool, referenceDataUrl };
