import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, statSync } from "node:fs";
import {
  DEFAULT_PARTIAL_IMAGES,
  IMAGE_QUALITIES,
  IMAGE_SIZES,
  IMAGE_TRANSPORTS,
  MAX_MODEL_CHARS,
  MAX_PARTIAL_IMAGES,
  MAX_USER_AGENT_CHARS,
  type ImageConfig,
  type ImageQuality,
  type ImageSize,
  type ImageTransport,
  type LoadedImageConfig,
} from "./types.js";

export const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "pi-image-gen", "config.json");
export const LEGACY_CONFIG_PATH = join(homedir(), ".pi", "agent", "extensions", "pi-image-gen", "config.json");

const DEFAULT_CONFIG: ImageConfig = {
  enabled: false,
  imageModel: undefined,
  textModel: undefined,
  userAgent: undefined,
  transport: "auto",
  partialImages: DEFAULT_PARTIAL_IMAGES,
  stream: true,
  // A retry can duplicate a charge the gateway already booked, so it stays opt-in.
  retryOnTransportFailure: false,
  debug: false,
  defaultSize: "auto",
  defaultQuality: "auto",
};
const KNOWN_FIELDS = new Set(["enabled", "imageModel", "textModel", "userAgent", "transport", "partialImages", "stream", "retryOnTransportFailure", "debug", "defaultSize", "defaultQuality"]);
/**
 * Keys that selected a routing target before provider selection became automatic. They are
 * reported with a targeted warning so an existing configuration explains itself after upgrade.
 */
const REMOVED_FIELDS = new Map<string, string>([
  ["model", "The model routing key was removed: textModel now selects the provider binding, so delete it."],
  ["toolModel", "The toolModel key was removed: the image_generation tool always declares imageModel now, so move the value to imageModel."],
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validBareModel(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= MAX_MODEL_CHARS && !/[\r\n]/.test(value);
}

function validUserAgent(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_USER_AGENT_CHARS && !/[\r\n]/.test(value);
}

export function loadImageConfig(
  configPath = DEFAULT_CONFIG_PATH,
  fallbackConfigPath = configPath === DEFAULT_CONFIG_PATH ? LEGACY_CONFIG_PATH : undefined,
): LoadedImageConfig {
  const config: ImageConfig = { ...DEFAULT_CONFIG };
  const warnings: string[] = [];
  let valid = true;
  let source: string | undefined;
  let raw: unknown;
  const candidates = fallbackConfigPath ? [configPath, fallbackConfigPath] : [configPath];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) {
        source = candidate;
        break;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      warnings.push(`Ignoring image-gen configuration: ${error instanceof Error ? error.message : String(error)}`);
      return { config, warnings, valid: false };
    }
  }
  if (!source) return { config, warnings, valid };
  try {
    raw = JSON.parse(readFileSync(source, "utf8")) as unknown;
  } catch (error) {
    warnings.push(`Ignoring image-gen configuration: ${error instanceof Error ? error.message : String(error)}`);
    return { config, source, warnings, valid: false };
  }
  if (!isRecord(raw)) {
    warnings.push("Ignoring image-gen configuration: expected a JSON object.");
    return { config, source, warnings, valid: false };
  }
  // Key-level notices are collected separately so a field error still reaches the caller first:
  // service.ts reports warnings[0] when the configuration is invalid.
  const keyWarnings: string[] = [];
  for (const key of Object.keys(raw)) {
    const removal = REMOVED_FIELDS.get(key);
    if (removal) keyWarnings.push(removal);
    else if (!KNOWN_FIELDS.has(key)) keyWarnings.push(`Ignoring unknown configuration field: ${key}.`);
  }

  if (raw.enabled !== undefined) {
    if (typeof raw.enabled === "boolean") config.enabled = raw.enabled;
    else { warnings.push("enabled must be a boolean."); valid = false; }
  }
  if (raw.imageModel !== undefined) {
    if (raw.imageModel === null) config.imageModel = undefined;
    else if (validBareModel(raw.imageModel)) config.imageModel = raw.imageModel.trim();
    else { warnings.push("imageModel must be a non-empty image model id."); valid = false; }
  }
  if (raw.textModel !== undefined) {
    if (raw.textModel === null) config.textModel = undefined;
    else if (validBareModel(raw.textModel)) config.textModel = raw.textModel.trim();
    else { warnings.push("textModel must be a non-empty model id."); valid = false; }
  }
  if (raw.userAgent !== undefined) {
    if (raw.userAgent === null) config.userAgent = undefined;
    else if (validUserAgent(raw.userAgent)) config.userAgent = raw.userAgent.trim();
    else { warnings.push("userAgent must be a non-empty value without CR/LF."); valid = false; }
  }
  if (raw.transport !== undefined) {
    if (typeof raw.transport === "string" && (IMAGE_TRANSPORTS as readonly string[]).includes(raw.transport)) config.transport = raw.transport as ImageTransport;
    else { warnings.push(`transport must be one of ${IMAGE_TRANSPORTS.join(", ")}.`); valid = false; }
  }
  if (raw.partialImages !== undefined) {
    if (raw.partialImages === null) config.partialImages = DEFAULT_PARTIAL_IMAGES;
    else if (typeof raw.partialImages === "number" && Number.isInteger(raw.partialImages) && raw.partialImages >= 0 && raw.partialImages <= MAX_PARTIAL_IMAGES) config.partialImages = raw.partialImages;
    else { warnings.push(`partialImages must be an integer from 0 to ${MAX_PARTIAL_IMAGES}.`); valid = false; }
  }
  for (const key of ["stream", "retryOnTransportFailure", "debug"] as const) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "boolean") config[key] = value;
    else { warnings.push(`${key} must be a boolean.`); valid = false; }
  }
  if (raw.defaultSize !== undefined) {
    if (typeof raw.defaultSize === "string" && (IMAGE_SIZES as readonly string[]).includes(raw.defaultSize)) config.defaultSize = raw.defaultSize as ImageSize;
    else { warnings.push(`defaultSize must be one of ${IMAGE_SIZES.join(", ")}.`); valid = false; }
  }
  if (raw.defaultQuality !== undefined) {
    if (typeof raw.defaultQuality === "string" && (IMAGE_QUALITIES as readonly string[]).includes(raw.defaultQuality)) config.defaultQuality = raw.defaultQuality as ImageQuality;
    else { warnings.push(`defaultQuality must be one of ${IMAGE_QUALITIES.join(", ")}.`); valid = false; }
  }
  // Key notices stay behind field errors so an invalid configuration still reports its cause.
  warnings.push(...keyWarnings);
  if (!valid) config.enabled = false;
  return { config, source, warnings, valid };
}

export const _configTest = { validBareModel, validUserAgent };
