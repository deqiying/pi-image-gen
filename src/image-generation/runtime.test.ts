import test from "node:test";
import assert from "node:assert/strict";
import { buildImageRequestHeaders, codexIdentity } from "./codex-headers.js";
import { buildImagesUrl, buildResponsesUrl, parseModelSpec, resolveImageRuntime, resolveImageTransport } from "./runtime.js";
import { DEFAULT_PARTIAL_IMAGES, type ImageConfig, type ImageGenerationRuntime } from "./types.js";

// loadImageConfig supplies these values when the config file omits them.
const baseConfig: ImageConfig = { enabled: true, model: undefined, imageModel: "image-2", textModel: undefined, toolModel: undefined, userAgent: undefined, transport: "auto", partialImages: DEFAULT_PARTIAL_IMAGES, stream: true, retryOnTransportFailure: false, debug: false, defaultSize: "auto", defaultQuality: "auto" };

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
  apiKey: "secret",
  headers: { "User-Agent": "provider", Cookie: "private", "Content-Type": "invalid", "x-api-key": "gateway-key", "x-extra": "yes" },
  sessionId: "s",
  currentModel: { provider: "image", id: "credential-model", api: "openai-codex-responses" },
  partialImages: 1,
  stream: true,
  retryOnTransportFailure: false,
  debug: false,
};

test("builds direct Images API endpoints", () => {
  assert.equal(buildImagesUrl("https://gateway.example/v1", "generate"), "https://gateway.example/v1/images/generations");
  assert.equal(buildImagesUrl("https://gateway.example/v1/images/edits", "generate"), "https://gateway.example/v1/images/generations");
  assert.equal(buildImagesUrl("https://gateway.example/v1/images", "edit"), "https://gateway.example/v1/images/edits");
  assert.deepEqual(parseModelSpec("gateway/chat-model"), { provider: "gateway", model: "chat-model" });
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

test("resolves a configured provider binding independently from the active model", async () => {
  const active = { provider: "main", id: "main-model", api: "anthropic-messages", baseUrl: "https://main/v1" };
  const selected = { provider: "image", id: "credential-model", api: "openai-responses", baseUrl: "https://image/v1" };
  const ctx = {
    model: active,
    modelRegistry: {
      find: (provider: string, model: string) => provider === "image" && model === "credential-model" ? selected : undefined,
      getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "secret" }),
    },
    sessionManager: { getSessionId: () => "session-1" },
    cwd: ".",
    hasUI: false,
    ui: {},
  } as never;
  const resolved = await resolveImageRuntime(ctx, { ...baseConfig, model: "image/credential-model" });
  assert.equal(resolved.providerModel, "credential-model");
  assert.equal(resolved.generationUrl, "https://image/v1/images/generations");
  assert.equal(resolved.editsUrl, "https://image/v1/images/edits");
  assert.equal(resolved.responsesUrl, "https://image/v1/responses");
  assert.equal(resolved.transport, "responses");
  assert.equal(resolved.sessionId, "session-1");
  // The top-level Responses model falls back to the bound model; the tool model stays unset.
  assert.equal(resolved.textModel, "credential-model");
  assert.equal(resolved.toolModel, undefined);
});

test("applies the configured text and tool models", async () => {
  const ctx = {
    model: { provider: "main", id: "main-model", api: "anthropic-messages", baseUrl: "https://main/v1" },
    modelRegistry: {
      find: (provider: string, model: string) => provider === "image" && model === "credential-model" ? { provider: "image", id: "credential-model", api: "openai-responses", baseUrl: "https://image/v1" } : undefined,
      getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "secret" }),
    },
    sessionManager: { getSessionId: () => "session-1" },
    cwd: ".",
    hasUI: false,
    ui: {},
  } as never;
  const resolved = await resolveImageRuntime(ctx, { ...baseConfig, model: "image/credential-model", textModel: "gpt-5.4", toolModel: "gpt-image-1.5" });
  assert.equal(resolved.textModel, "gpt-5.4");
  assert.equal(resolved.toolModel, "gpt-image-1.5");
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
