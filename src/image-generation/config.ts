import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, statSync } from "node:fs";
import {
  IMAGE_QUALITIES,
  IMAGE_SIZES,
  IMAGE_TRANSPORTS,
  MAX_MODEL_CHARS,
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
  model: undefined,
  imageModel: undefined,
  textModel: undefined,
  toolModel: undefined,
  userAgent: undefined,
  transport: "auto",
  defaultSize: "auto",
  defaultQuality: "auto",
};
const KNOWN_FIELDS = new Set(["enabled", "model", "imageModel", "textModel", "toolModel", "userAgent", "transport", "defaultSize", "defaultQuality"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validModelSpec(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  return slash > 0 && slash < trimmed.length - 1 && trimmed.length <= MAX_MODEL_CHARS && !/[\s*?\[\]{}]/.test(trimmed);
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
  for (const key of Object.keys(raw)) {
    if (!KNOWN_FIELDS.has(key)) warnings.push(`Ignoring unknown configuration field: ${key}.`);
  }

  if (raw.enabled !== undefined) {
    if (typeof raw.enabled === "boolean") config.enabled = raw.enabled;
    else { warnings.push("enabled must be a boolean."); valid = false; }
  }
  if (raw.model !== undefined) {
    if (raw.model === null) config.model = undefined;
    else if (validModelSpec(raw.model)) config.model = raw.model.trim();
    else { warnings.push("model must be an exact provider/model-id string."); valid = false; }
  }
  if (raw.imageModel !== undefined) {
    if (raw.imageModel === null) config.imageModel = undefined;
    else if (validBareModel(raw.imageModel)) config.imageModel = raw.imageModel.trim();
    else { warnings.push("imageModel must be a non-empty image model id."); valid = false; }
  }
  for (const key of ["textModel", "toolModel"] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (value === null) config[key] = undefined;
    else if (validBareModel(value)) config[key] = value.trim();
    else { warnings.push(`${key} must be a non-empty model id.`); valid = false; }
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
  if (raw.defaultSize !== undefined) {
    if (typeof raw.defaultSize === "string" && (IMAGE_SIZES as readonly string[]).includes(raw.defaultSize)) config.defaultSize = raw.defaultSize as ImageSize;
    else { warnings.push(`defaultSize must be one of ${IMAGE_SIZES.join(", ")}.`); valid = false; }
  }
  if (raw.defaultQuality !== undefined) {
    if (typeof raw.defaultQuality === "string" && (IMAGE_QUALITIES as readonly string[]).includes(raw.defaultQuality)) config.defaultQuality = raw.defaultQuality as ImageQuality;
    else { warnings.push(`defaultQuality must be one of ${IMAGE_QUALITIES.join(", ")}.`); valid = false; }
  }
  if (!valid) config.enabled = false;
  return { config, source, warnings, valid };
}

export const _configTest = { validModelSpec, validBareModel, validUserAgent };
