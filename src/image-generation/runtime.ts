import {
  ImageGenerationError,
  type ActiveImageTransport,
  type ImageGenerationContext,
  type ImageGenerationRuntime,
  type ImageConfig,
  type ImageTransport,
  type ResolvedAuth,
  sanitizeDiagnostic,
  type RuntimeModel,
} from "./types.js";

export type ModelRegistryLike = {
  find: (provider: string, model: string) => RuntimeModel | undefined;
  getApiKeyAndHeaders?: (model: RuntimeModel) => Promise<ResolvedAuth>;
};

/** Provider API ids that speak the OpenAI Responses API and can host the image_generation tool. */
const RESPONSES_APIS = new Set(["openai-responses", "openai-codex-responses"]);

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

function imageRequestRoot(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl) ?? baseUrl;
  return normalized
    .replace(/\/images\/(?:generations|edits)$/i, "")
    .replace(/\/images$/i, "")
    .replace(/\/responses$/i, "");
}

export function buildImagesUrl(baseUrl: string, action: "generate" | "edit"): string {
  return `${imageRequestRoot(baseUrl)}/images/${action === "edit" ? "edits" : "generations"}`;
}

/**
 * Responses endpoint for the tools[] + image_generation transport. Codex-style
 * providers expose the ChatGPT backend under `/backend-api/codex/responses`, so a
 * base URL that is not already codex-scoped gets that suffix (mirrors the host's
 * own codex client, which appends `/codex/responses`).
 */
export function buildResponsesUrl(baseUrl: string, api: string): string {
  const root = imageRequestRoot(baseUrl);
  if (api === "openai-codex-responses" || /\/backend-api(?:\/|$)/i.test(root)) {
    return root.endsWith("/codex") ? `${root}/responses` : `${root}/codex/responses`;
  }
  return `${root}/responses`;
}

/** Config override wins; otherwise Responses-API providers prefer the native tool. */
export function resolveImageTransport(configured: ImageTransport, api: string): ActiveImageTransport {
  if (configured === "images") return "images";
  if (configured === "responses") return "responses";
  return RESPONSES_APIS.has(api) ? "responses" : "images";
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
    responsesUrl: buildResponsesUrl(baseUrl, selected.api),
    transport: resolveImageTransport(config.transport, selected.api),
    // The Responses body's top-level model defaults to the bound model; the tool model
    // stays unset unless configured, so the client can fall back to imageModel.
    textModel: config.textModel ?? selected.id,
    ...(config.toolModel ? { toolModel: config.toolModel } : {}),
    ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
    headers: { ...(selected.headers ?? {}), ...(auth.headers ?? {}) },
    ...(sessionId ? { sessionId } : {}),
    currentModel: selected,
  };
}

export const _runtimeTest = { normalizeBaseUrl, modelFromContext, imageRequestRoot, RESPONSES_APIS };
