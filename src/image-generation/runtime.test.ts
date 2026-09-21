import test from "node:test";
import assert from "node:assert/strict";
import { buildImageRequestHeaders, codexIdentity } from "./codex-headers.js";
import { buildImagesUrl, buildResponsesUrl, resolveImageRuntime, resolveImageTransport, selectImageBinding } from "./runtime.js";
import { DEFAULT_PARTIAL_IMAGES, ImageGenerationError, type ImageConfig, type ImageGenerationContext, type ImageGenerationRuntime, type RuntimeModel } from "./types.js";

// loadImageConfig supplies these values when the config file omits them.
const baseConfig: ImageConfig = { enabled: true, imageModel: "image-2", textModel: undefined, userAgent: undefined, transport: "auto", partialImages: DEFAULT_PARTIAL_IMAGES, stream: true, retryOnTransportFailure: false, debug: false, defaultSize: "auto", defaultQuality: "auto" };

const runtime: ImageGenerationRuntime = {
  provider: "image",
  api: "openai-codex-responses",
  providerModel: "credential-model",
  baseUrl: "https://image/v1",
  generationUrl: "https://image/v1/images/generations",
  editsUrl: "https://image/v1/images/edits",
  responsesUrl: "https://image/v1/responses",
  transport: "responses",
  textModel: "credential-model",
  bindingReason: "current-provider",
  apiKey: "secret",
  headers: { "User-Agent": "provider", Cookie: "private", "Content-Type": "invalid", "x-api-key": "gateway-key", "x-extra": "yes" },
  sessionId: "s",
  currentModel: { provider: "image", id: "credential-model", api: "openai-codex-responses" },
  partialImages: 1,
  stream: true,
  retryOnTransportFailure: false,
  debug: false,
};

const sessionModel: RuntimeModel = { provider: "main", id: "main-model", api: "anthropic-messages", baseUrl: "https://main/v1" };

/** Minimal host context; each test decides which catalogue its registry exposes. */
function sessionContext(model: RuntimeModel | undefined, registry: Record<string, unknown> | undefined = {}): ImageGenerationContext {
  return {
    model,
    modelRegistry: registry,
    sessionManager: { getSessionId: () => "session-1" },
    cwd: ".",
    hasUI: false,
    ui: {},
  } as never;
}

/** A registry with a fixed catalogue whose credentials resolve as a plain API key. */
function catalogue(models: RuntimeModel[]): Record<string, unknown> {
  return { getAvailable: () => models, getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "secret" }) };
}

test("builds direct Images API endpoints", () => {
  assert.equal(buildImagesUrl("https://gateway.example/v1", "generate"), "https://gateway.example/v1/images/generations");
  assert.equal(buildImagesUrl("https://gateway.example/v1/images/edits", "generate"), "https://gateway.example/v1/images/generations");
  assert.equal(buildImagesUrl("https://gateway.example/v1/images", "edit"), "https://gateway.example/v1/images/edits");
});

test("builds the Responses endpoint for gateways and codex backends", () => {
  assert.equal(buildResponsesUrl("https://gateway.example/v1", "openai-responses"), "https://gateway.example/v1/responses");
  assert.equal(buildResponsesUrl("https://gateway.example/v1/responses", "openai-responses"), "https://gateway.example/v1/responses");
  assert.equal(buildResponsesUrl("https://chatgpt.com/backend-api", "openai-codex-responses"), "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(buildResponsesUrl("https://chatgpt.com/backend-api/codex", "openai-codex-responses"), "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(buildResponsesUrl("https://chatgpt.com/backend-api/codex/responses", "openai-codex-responses"), "https://chatgpt.com/backend-api/codex/responses");
  // A gateway that advertises a versioned base URL serves the plain `/responses` route: its
  // `/v1/codex/responses` sibling does not exist, so the version suffix wins over the API id.
  assert.equal(buildResponsesUrl("https://gateway.example/v1", "openai-codex-responses"), "https://gateway.example/v1/responses");
  assert.equal(buildResponsesUrl("https://gateway.example/v1/", "openai-codex-responses"), "https://gateway.example/v1/responses");
});

test("selects the Responses transport only for Responses APIs unless configured", () => {
  assert.equal(resolveImageTransport("auto", "openai-responses"), "responses");
  assert.equal(resolveImageTransport("auto", "openai-codex-responses"), "responses");
  assert.equal(resolveImageTransport("auto", "openai-completions"), "images");
  assert.equal(resolveImageTransport("images", "openai-responses"), "images");
  assert.equal(resolveImageTransport("responses", "openai-completions"), "responses");
});

test("keeps the session provider when no textModel is configured", async () => {
  const resolved = await resolveImageRuntime(sessionContext(sessionModel, { getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "secret" }) }), baseConfig);
  assert.equal(resolved.provider, "main");
  assert.equal(resolved.providerModel, "main-model");
  assert.equal(resolved.generationUrl, "https://main/v1/images/generations");
  assert.equal(resolved.responsesUrl, "https://main/v1/responses");
  assert.equal(resolved.transport, "images");
  assert.equal(resolved.bindingReason, "current-provider");
  // The top-level Responses model defaults to the bound model id.
  assert.equal(resolved.textModel, "main-model");
  assert.equal(resolved.sessionId, "session-1");
});

test("keeps the session provider when the configured textModel is the session model id modulo casing", () => {
  const chosen = selectImageBinding(sessionContext(sessionModel), { ...baseConfig, textModel: "  MAIN-MODEL " });
  assert.equal(chosen.reason, "current-provider");
  assert.equal(chosen.binding.provider, "main");
  assert.equal(chosen.binding.id, "main-model");
});

test("keeps the session provider when its catalogue entry also offers the configured textModel", async () => {
  const ctx = sessionContext(sessionModel, catalogue([{ provider: "main", id: "gpt-5.4", api: "openai-responses", baseUrl: "https://main/v1" }]));
  const chosen = selectImageBinding(ctx, { ...baseConfig, textModel: "gpt-5.4" });
  assert.equal(chosen.reason, "current-provider");
  assert.equal(chosen.binding.provider, "main");
  assert.equal(chosen.binding.id, "main-model");

  // The session model id differs from the configured text model, which is still what is declared.
  const resolved = await resolveImageRuntime(ctx, { ...baseConfig, textModel: "gpt-5.4" });
  assert.equal(resolved.textModel, "gpt-5.4");
  assert.equal(resolved.bindingReason, "current-provider");
});

test("resolves the first catalogue provider that serves the configured textModel", async () => {
  let authFor: RuntimeModel | undefined;
  const ctx = sessionContext(sessionModel, {
    getAvailable: () => [
      // The session provider offers a different model, so this entry must not win.
      { provider: "main", id: "other-model", api: "anthropic-messages", baseUrl: "https://main/v1" },
      { provider: "first", id: "gpt-5.4", api: "openai-responses", baseUrl: "https://first/v1" },
      { provider: "second", id: "GPT-5.4", api: "openai-completions", baseUrl: "https://second/v1" },
    ],
    getApiKeyAndHeaders: async (model: RuntimeModel) => { authFor = model; return { ok: true as const, apiKey: "secret" }; },
  });
  const resolved = await resolveImageRuntime(ctx, { ...baseConfig, textModel: "gpt-5.4" });
  assert.equal(resolved.bindingReason, "matched-provider");
  // The first matching entry wins, and its provider owns URL, transport and credentials.
  assert.equal(resolved.provider, "first");
  assert.equal(resolved.providerModel, "gpt-5.4");
  assert.equal(resolved.generationUrl, "https://first/v1/images/generations");
  assert.equal(resolved.editsUrl, "https://first/v1/images/edits");
  assert.equal(resolved.responsesUrl, "https://first/v1/responses");
  assert.equal(resolved.transport, "responses");
  assert.equal(resolved.textModel, "gpt-5.4");
  assert.deepEqual(authFor, { provider: "first", id: "gpt-5.4", api: "openai-responses", baseUrl: "https://first/v1" });
});

test("prefers a Responses-capable provider over an earlier chat-completions one", async () => {
  const ctx = sessionContext(sessionModel, catalogue([
    { provider: "plain", id: "gpt-5.4", api: "openai-completions", baseUrl: "https://plain/v1" },
    { provider: "native", id: "GPT-5.4", api: "openai-codex-responses", baseUrl: "https://native/backend-api" },
  ]));
  const resolved = await resolveImageRuntime(ctx, { ...baseConfig, textModel: "gpt-5.4" });
  // A Responses endpoint hosts the built-in image tool, so it outranks plain catalogue order.
  assert.equal(resolved.bindingReason, "matched-provider");
  assert.equal(resolved.provider, "native");
  assert.equal(resolved.providerModel, "GPT-5.4");
  assert.equal(resolved.responsesUrl, "https://native/backend-api/codex/responses");
  assert.equal(resolved.transport, "responses");
});

test("keeps plain catalogue order when the transport is pinned to the Images API", async () => {
  const ctx = sessionContext(sessionModel, catalogue([
    { provider: "plain", id: "gpt-5.4", api: "openai-completions", baseUrl: "https://plain/v1" },
    { provider: "native", id: "gpt-5.4", api: "openai-responses", baseUrl: "https://native/v1" },
  ]));
  // transport:"images" fixes the request contract, so the Responses preference no longer applies.
  const resolved = await resolveImageRuntime(ctx, { ...baseConfig, transport: "images", textModel: "gpt-5.4" });
  assert.equal(resolved.bindingReason, "matched-provider");
  assert.equal(resolved.provider, "plain");
  assert.equal(resolved.generationUrl, "https://plain/v1/images/generations");
  assert.equal(resolved.transport, "images");
});

test("keeps catalogue order between two responses-capable providers", async () => {
  const ctx = sessionContext(sessionModel, catalogue([
    { provider: "first", id: "gpt-5.4", api: "openai-responses", baseUrl: "https://first/v1" },
    { provider: "second", id: "gpt-5.4", api: "openai-codex-responses", baseUrl: "https://second/v1" },
  ]));
  const resolved = await resolveImageRuntime(ctx, { ...baseConfig, textModel: "gpt-5.4" });
  assert.equal(resolved.bindingReason, "matched-provider");
  assert.equal(resolved.provider, "first");
  assert.equal(resolved.responsesUrl, "https://first/v1/responses");
});

test("falls back to the session provider when nothing offers the configured textModel", async () => {
  const resolved = await resolveImageRuntime(sessionContext(sessionModel, catalogue([])), { ...baseConfig, textModel: "ghost-model" });
  assert.equal(resolved.bindingReason, "session-fallback");
  assert.equal(resolved.provider, "main");
  assert.equal(resolved.providerModel, "main-model");
  // The configured text model is still what the request declares.
  assert.equal(resolved.textModel, "ghost-model");
});

test("resolves a catalogue provider when the session has no usable binding", async () => {
  const resolved = await resolveImageRuntime(sessionContext(undefined, catalogue([{ provider: "other", id: "gpt-5.4", api: "openai-responses", baseUrl: "https://other/v1" }])), { ...baseConfig, textModel: "gpt-5.4" });
  assert.equal(resolved.bindingReason, "matched-provider");
  assert.equal(resolved.provider, "other");
  assert.equal(resolved.providerModel, "gpt-5.4");
  assert.equal(resolved.responsesUrl, "https://other/v1/responses");
});

test("fails closed when the session has no usable binding and no textModel", async () => {
  await assert.rejects(
    () => resolveImageRuntime(sessionContext(undefined, catalogue([{ provider: "other", id: "gpt-5.4", api: "openai-responses" }])), baseConfig),
    (error: unknown) => error instanceof ImageGenerationError && error.code === "unsupported-model",
  );
});

test("cannot search a registry that exposes no catalogue", () => {
  const chosen = selectImageBinding(sessionContext(sessionModel, { getApiKeyAndHeaders: async () => ({ ok: true as const }) }), { ...baseConfig, textModel: "gpt-5.4" });
  assert.equal(chosen.reason, "session-fallback");
  assert.equal(chosen.binding.provider, "main");
});

test("treats a session model without an api id as no usable binding", () => {
  const incomplete = { provider: "main", id: "main-model" } as RuntimeModel;
  assert.throws(() => selectImageBinding(sessionContext(incomplete), baseConfig), (error: unknown) => error instanceof ImageGenerationError && error.code === "unsupported-model");
});

test("tolerates a host that exposes no model registry", () => {
  const ctx = sessionContext(sessionModel, undefined);
  assert.equal(selectImageBinding(ctx, baseConfig).reason, "current-provider");
  // Without a catalogue to search, the session binding stays the only candidate.
  assert.equal(selectImageBinding(ctx, { ...baseConfig, textModel: "gpt-5.4" }).reason, "session-fallback");
});

test("honors an explicit transport override", async () => {
  const ctx = {
    model: { provider: "main", id: "model", api: "openai-responses", baseUrl: "https://main/v1" },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "secret" }) },
    sessionManager: { getSessionId: () => "s" },
    cwd: ".",
    hasUI: false,
    ui: {},
  } as never;
  const resolved = await resolveImageRuntime(ctx, { ...baseConfig, transport: "images" });
  assert.equal(resolved.transport, "images");
});

test("builds JSON and multipart headers without leaking forbidden values", () => {
  const jsonHeaders = buildImageRequestHeaders(runtime, "plugin-test/1", { contentType: "application/json" });
  assert.equal(jsonHeaders["user-agent"], "plugin-test/1");
  assert.equal(jsonHeaders.cookie, undefined);
  assert.equal(jsonHeaders.authorization, "Bearer secret");
  assert.equal(jsonHeaders["content-type"], "application/json");
  assert.equal(jsonHeaders["x-api-key"], "gateway-key");
  assert.equal(jsonHeaders["session-id"], "s");
  assert.equal(jsonHeaders["accept"], "application/json");

  const streamed = buildImageRequestHeaders(runtime, "plugin-test/1", { contentType: "application/json", accept: "text/event-stream" });
  assert.equal(streamed["accept"], "text/event-stream");
  assert.equal(streamed["openai-beta"], "responses=experimental");

  const multipartHeaders = buildImageRequestHeaders(runtime, "plugin-test/1");
  assert.equal(Object.keys(multipartHeaders).some((key) => key.toLowerCase() === "content-type"), false);
});

test("derives codex identity from codex user agents only", () => {
  assert.deepEqual(codexIdentity("codex_cli_rs/0.153.4 (Windows 10.0.26200; x86_64) xterm-256color"), { originator: "codex_cli_rs", version: "0.153.4" });
  assert.deepEqual(codexIdentity("codex-tui/0.144.0"), { originator: "codex-tui", version: "0.144.0" });
  assert.equal(codexIdentity("pi (win32 10.0.26200; x64)"), undefined);
  assert.equal(codexIdentity(undefined), undefined);

  // A codex backend without a codex user agent still gets a matching pi identity pair.
  const headers = buildImageRequestHeaders({ ...runtime, headers: {} }, undefined, { accept: "text/event-stream" });
  assert.equal(headers["originator"], "pi");
  assert.match(headers["user-agent"] ?? "", /^pi \(/);

  // A host-provided codex user agent keeps originator and version in sync.
  const codexHeaders = buildImageRequestHeaders({ ...runtime, headers: { "User-Agent": "codex_cli_rs/0.153.4 (Windows; x86_64)" } }, undefined, { accept: "text/event-stream" });
  assert.equal(codexHeaders["originator"], "codex_cli_rs");
  assert.equal(codexHeaders["version"], "0.153.4");

  // Unknown codex-looking clients are not treated as the official identity.
  assert.equal(codexIdentity("codex_foo/1.0"), undefined);
  const unknownHeaders = buildImageRequestHeaders({ ...runtime, api: "openai-responses", headers: { "User-Agent": "codex_foo/1.0" } }, undefined, { accept: "text/event-stream" });
  assert.equal(unknownHeaders["originator"], undefined);
  assert.equal(unknownHeaders["session-id"], undefined);

  // A host-configured version survives when the user agent carries none.
  const hostVersion = buildImageRequestHeaders({ ...runtime, headers: { "User-Agent": "codex-tui", version: "0.144.0" } }, undefined, { accept: "text/event-stream" });
  assert.equal(hostVersion["originator"], "codex-tui");
  assert.equal(hostVersion["version"], "0.144.0");
});

test("sanitizes credential resolution errors", async () => {
  const ctx = {
    model: { provider: "main", id: "model", api: "openai-responses", baseUrl: "https://main/v1" },
    modelRegistry: { getApiKeyAndHeaders: async () => { throw new Error("Bearer secret-value"); } },
    sessionManager: { getSessionId: () => "s" },
    cwd: ".",
    hasUI: false,
    ui: {},
  } as never;
  await assert.rejects(() => resolveImageRuntime(ctx, baseConfig), (error: unknown) => error instanceof Error && !error.message.includes("secret-value") && error.message.includes("REDACTED"));
});

test("allows a host-resolved provider that requires no credential", async () => {
  const ctx = {
    model: { provider: "local", id: "chat", api: "openai-completions", baseUrl: "http://127.0.0.1:8080/v1" },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true as const }) },
    sessionManager: { getSessionId: () => "s" },
    cwd: ".",
    hasUI: false,
    ui: {},
  } as never;
  const resolved = await resolveImageRuntime(ctx, baseConfig);
  assert.equal(resolved.generationUrl, "http://127.0.0.1:8080/v1/images/generations");
  assert.equal(resolved.responsesUrl, "http://127.0.0.1:8080/v1/responses");
  assert.equal(resolved.transport, "images");
  assert.equal(resolved.apiKey, undefined);
});

test("passes the streaming, retry, and debug switches into the runtime", async () => {
  const ctx = {
    model: { provider: "image", id: "credential-model", api: "openai-codex-responses", baseUrl: "https://image/v1" },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "secret" }) },
    sessionManager: { getSessionId: () => "session-1" },
    cwd: ".",
    hasUI: false,
    ui: {},
  } as never;
  const configured = await resolveImageRuntime(ctx, { ...baseConfig, partialImages: 2, stream: false, retryOnTransportFailure: true, debug: true });
  assert.equal(configured.partialImages, 2);
  assert.equal(configured.stream, false);
  assert.equal(configured.retryOnTransportFailure, true);
  assert.equal(configured.debug, true);

  // baseConfig carries the values loadImageConfig applies when the config file omits them,
  // so an unconfigured host must resolve to the documented defaults.
  const defaults = await resolveImageRuntime(ctx, baseConfig);
  assert.equal(defaults.partialImages, 1);
  assert.equal(defaults.stream, true);
  assert.equal(defaults.retryOnTransportFailure, false);
  assert.equal(defaults.debug, false);
});
