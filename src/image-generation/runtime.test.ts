import test from "node:test";
import assert from "node:assert/strict";
import { buildImageRequestHeaders } from "./codex-headers.js";
import { buildImagesUrl, parseModelSpec, resolveImageRuntime } from "./runtime.js";
import type { ImageGenerationRuntime } from "./types.js";

const runtime: ImageGenerationRuntime = {
  provider: "image",
  api: "openai-codex-responses",
  providerModel: "credential-model",
  baseUrl: "https://image/v1",
  generationUrl: "https://image/v1/images/generations",
  editsUrl: "https://image/v1/images/edits",
  apiKey: "secret",
  headers: { "User-Agent": "provider", Cookie: "private", "Content-Type": "invalid", "x-api-key": "gateway-key", "x-extra": "yes" },
  sessionId: "s",
  currentModel: { provider: "image", id: "credential-model", api: "openai-codex-responses" },
};

test("builds direct Images API endpoints", () => {
  assert.equal(buildImagesUrl("https://gateway.example/v1", "generate"), "https://gateway.example/v1/images/generations");
  assert.equal(buildImagesUrl("https://gateway.example/v1/images/edits", "generate"), "https://gateway.example/v1/images/generations");
  assert.equal(buildImagesUrl("https://gateway.example/v1/images", "edit"), "https://gateway.example/v1/images/edits");
  assert.deepEqual(parseModelSpec("gateway/chat-model"), { provider: "gateway", model: "chat-model" });
});

test("resolves a configured provider binding independently from the active model", async () => {
  const active = { provider: "main", id: "main-model", api: "anthropic-messages", baseUrl: "https://main/v1" };
  const selected = { provider: "image", id: "credential-model", api: "openai-completions", baseUrl: "https://image/v1" };
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
  const resolved = await resolveImageRuntime(ctx, { enabled: true, model: "image/credential-model", imageModel: "image-2", userAgent: undefined, defaultSize: "auto", defaultQuality: "auto" });
  assert.equal(resolved.providerModel, "credential-model");
  assert.equal(resolved.generationUrl, "https://image/v1/images/generations");
  assert.equal(resolved.editsUrl, "https://image/v1/images/edits");
  assert.equal(resolved.sessionId, "session-1");
});

test("builds JSON and multipart headers without leaking forbidden values", () => {
  const jsonHeaders = buildImageRequestHeaders(runtime, "plugin-test/1", { contentType: "application/json" });
  assert.equal(jsonHeaders["user-agent"], "plugin-test/1");
  assert.equal(jsonHeaders.cookie, undefined);
  assert.equal(jsonHeaders.authorization, "Bearer secret");
  assert.equal(jsonHeaders["content-type"], "application/json");
  assert.equal(jsonHeaders["x-api-key"], "gateway-key");
  assert.equal(jsonHeaders["session-id"], "s");

  const multipartHeaders = buildImageRequestHeaders(runtime, "plugin-test/1");
  assert.equal(Object.keys(multipartHeaders).some((key) => key.toLowerCase() === "content-type"), false);
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
  await assert.rejects(() => resolveImageRuntime(ctx, { enabled: true, model: undefined, imageModel: "image-2", userAgent: undefined, defaultSize: "auto", defaultQuality: "auto" }), (error: unknown) => error instanceof Error && !error.message.includes("secret-value") && error.message.includes("REDACTED"));
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
  const resolved = await resolveImageRuntime(ctx, { enabled: true, model: undefined, imageModel: "image-2", userAgent: undefined, defaultSize: "auto", defaultQuality: "auto" });
  assert.equal(resolved.generationUrl, "http://127.0.0.1:8080/v1/images/generations");
  assert.equal(resolved.apiKey, undefined);
});
