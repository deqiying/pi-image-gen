import {
  ImageGenerationError,
  type ActiveImageTransport,
  type ImageGenerationContext,
  type ImageGenerationRuntime,
  type ImageConfig,
  type ImageBindingReason,
  type ImageTransport,
  type ResolvedAuth,
  sanitizeDiagnostic,
  type RuntimeModel,
} from "./types.js";

export type ModelRegistryLike = {
  /** Catalogue entries whose provider has configured credentials. */
  getAvailable?: () => readonly RuntimeModel[];
  getApiKeyAndHeaders?: (model: RuntimeModel) => Promise<ResolvedAuth>;
};

/** Provider API ids that speak the OpenAI Responses API and can host the image_generation tool. */
const RESPONSES_APIS = new Set(["openai-responses", "openai-codex-responses"]);

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
 * Responses endpoint for the tools[] + image_generation transport. A ChatGPT/Codex
 * backend is backend-scoped (`.../backend-api[/codex]`) and serves
 * `/backend-api/codex/responses`, so those base URLs get the codex suffix (mirroring the
 * host's own codex client). An OpenAI-compatible gateway that advertises a versioned base
 * URL (`.../v1`) is not that backend: it serves the plain `/responses` route and has no
 * `/codex/responses` sibling, so it is used directly instead of being probed.
 */
export function buildResponsesUrl(baseUrl: string, api: string): string {
  const root = imageRequestRoot(baseUrl);
  const versioned = /\/v\d+(?:\.\d+)*$/i.test(root);
  const codexBackend = api === "openai-codex-responses" || /\/backend-api(?:\/|$)/i.test(root);
  if (codexBackend && !versioned) {
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

function sameModelId(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/** A binding is usable only when the host resolved every field the request shape needs. */
function usableBinding(value: RuntimeModel | undefined): RuntimeModel | undefined {
  if (!value) return undefined;
  return value.provider && value.id && value.api ? value : undefined;
}

/**
 * Available catalogue entries whose model id matches: providers that both offer the model and
 * have configured credentials. A host without an availability-aware registry cannot be searched,
 * so no provider is offered and the session binding keeps serving its own requests.
 */
function providersOffering(registry: ModelRegistryLike, modelId: string): RuntimeModel[] {
  if (typeof registry.getAvailable !== "function") return [];
  return registry.getAvailable().filter((model) => !!model.id && sameModelId(model.id, modelId));
}

/**
 * Orders the candidates that may answer once the session provider does not serve the model. A
 * Responses-capable provider comes first because its `/responses` endpoint hosts the built-in
 * image tool, while a chat-completions gateway may serve no `/images/*` route at all. Catalogue
 * order decides inside each group, and `transport: "images"` fixes the contract up front, so such
 * a configuration keeps its plain catalogue order.
 */
function orderCandidates(candidates: readonly RuntimeModel[], transport: ImageTransport): RuntimeModel[] {
  if (transport === "images") return [...candidates];
  const native = candidates.filter((model) => RESPONSES_APIS.has(model.api));
  const others = candidates.filter((model) => !RESPONSES_APIS.has(model.api));
  return [...native, ...others];
}

/** Rule 1: the session provider already serves the host model, so nothing has to move. */
function sessionProvidesHostModel(session: RuntimeModel, textModel: string | undefined, candidates: readonly RuntimeModel[]): boolean {
  if (textModel === undefined) return true;
  return sameModelId(session.id, textModel) || candidates.some((model) => model.provider === session.provider);
}

/**
 * Selects the provider binding for one image request. The configured `textModel` decides where
 * the request goes: the session provider wins while it serves that model, otherwise an available
 * provider that serves it is used, and the session binding is the last resort when no available
 * provider serves it. An unconfigured `textModel` makes the session model the host model, which
 * the session binding always serves, so the session provider keeps sending.
 */
export function selectImageBinding(ctx: ImageGenerationContext, config: ImageConfig): { binding: RuntimeModel; reason: ImageBindingReason } {
  const registry = (ctx.modelRegistry ?? {}) as unknown as ModelRegistryLike;
  const session = usableBinding(ctx.model as RuntimeModel | undefined);
  const textModel = config.textModel?.trim();
  const hostModel = textModel ?? session?.id;
  const candidates = hostModel ? orderCandidates(providersOffering(registry, hostModel), config.transport) : [];
  if (session && sessionProvidesHostModel(session, textModel, candidates)) return { binding: session, reason: "current-provider" };
  const match = textModel ? candidates[0] : undefined;
  if (match) return { binding: match, reason: "matched-provider" };
  if (session) return { binding: session, reason: "session-fallback" };
  throw new ImageGenerationError("unsupported-model", "The active session has no usable provider binding.");
}

export async function resolveImageRuntime(ctx: ImageGenerationContext, config: ImageConfig): Promise<ImageGenerationRuntime> {
  const { binding: selected, reason } = selectImageBinding(ctx, config);
  const registry = (ctx.modelRegistry ?? {}) as unknown as ModelRegistryLike;
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
    // The top-level Responses model: the configured textModel, or the selected binding's own
    // model id when no textModel is configured.
    textModel: config.textModel ?? selected.id,
    bindingReason: reason,
    partialImages: config.partialImages,
    stream: config.stream,
    retryOnTransportFailure: config.retryOnTransportFailure,
    debug: config.debug,
    ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
    headers: { ...(selected.headers ?? {}), ...(auth.headers ?? {}) },
    ...(sessionId ? { sessionId } : {}),
    currentModel: selected,
  };
}

export const _runtimeTest = { normalizeBaseUrl, imageRequestRoot, RESPONSES_APIS, selectImageBinding };
