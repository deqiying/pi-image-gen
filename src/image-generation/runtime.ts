import {
  ImageGenerationError,
  type ImageGenerationContext,
  type ImageGenerationRuntime,
  type ImageConfig,
  type ResolvedAuth,
  sanitizeDiagnostic,
  type RuntimeModel,
} from "./types.js";

export type ModelRegistryLike = {
  find: (provider: string, model: string) => RuntimeModel | undefined;
  getApiKeyAndHeaders?: (model: RuntimeModel) => Promise<ResolvedAuth>;
};

export function parseModelSpec(value: string): { provider: string; model: string } | undefined {
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash >= trimmed.length - 1) return undefined;
  return { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) };
}

function normalizeBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/\/+$/, "");
  return trimmed || undefined;
}

export function buildImagesUrl(baseUrl: string, action: "generate" | "edit"): string {
  const normalized = normalizeBaseUrl(baseUrl) ?? baseUrl;
  const root = normalized
    .replace(/\/images\/(?:generations|edits)$/i, "")
    .replace(/\/images$/i, "");
  return `${root}/images/${action === "edit" ? "edits" : "generations"}`;
}

function modelFromContext(ctx: ImageGenerationContext, config: ImageConfig): RuntimeModel {
  const current = ctx.model as RuntimeModel | undefined;
  if (!config.model) {
    if (!current?.provider || !current.id || !current.api) throw new ImageGenerationError("unsupported-model", "The active session has no usable provider binding.");
    return current;
  }
  const spec = parseModelSpec(config.model);
  if (!spec) throw new ImageGenerationError("config", "Configured provider binding must be an exact provider/model-id key.");
  const registry = ctx.modelRegistry as unknown as ModelRegistryLike;
  const selected = registry.find(spec.provider, spec.model);
  if (!selected) throw new ImageGenerationError("unsupported-model", `Configured provider binding was not found: ${config.model}`);
  return selected;
}

export async function resolveImageRuntime(ctx: ImageGenerationContext, config: ImageConfig): Promise<ImageGenerationRuntime> {
  const selected = modelFromContext(ctx, config);
  const registry = ctx.modelRegistry as unknown as ModelRegistryLike;
  let auth: ResolvedAuth = { ok: true };
  if (typeof registry.getApiKeyAndHeaders === "function") {
    try {
      auth = await registry.getApiKeyAndHeaders(selected);
    } catch (error) {
      throw new ImageGenerationError("authentication", `Unable to resolve image provider credentials: ${sanitizeDiagnostic(error, "credential resolution failed")}`);
    }
  }
  if (!auth.ok) throw new ImageGenerationError("authentication", sanitizeDiagnostic(auth.error, "Unable to resolve image provider credentials."));
  const baseUrl = normalizeBaseUrl(auth.baseUrl) ?? normalizeBaseUrl(selected.baseUrl);
  if (!baseUrl) throw new ImageGenerationError("authentication", "The selected image provider has no base URL.");
  let sessionId: string | undefined;
  try { sessionId = ctx.sessionManager.getSessionId(); } catch { sessionId = undefined; }
  return {
    provider: selected.provider,
    api: selected.api,
    providerModel: selected.id,
    baseUrl,
    generationUrl: buildImagesUrl(baseUrl, "generate"),
    editsUrl: buildImagesUrl(baseUrl, "edit"),
    ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
    headers: { ...(selected.headers ?? {}), ...(auth.headers ?? {}) },
    ...(sessionId ? { sessionId } : {}),
    currentModel: selected,
  };
}

export const _runtimeTest = { normalizeBaseUrl, modelFromContext };
