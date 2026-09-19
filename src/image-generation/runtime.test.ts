import test from "node:test";
import assert from "node:assert/strict";
import { buildImageRequestHeaders } from "./codex-headers.js";
import { buildResponsesUrl, parseModelSpec, resolveImageRuntime } from "./runtime.js";

test("builds Responses and Codex endpoints", () => {
  assert.equal(buildResponsesUrl("https://gateway.example/v1", "openai-responses"), "https://gateway.example/v1/responses");
  assert.equal(buildResponsesUrl("https://chatgpt.example/backend-api", "openai-codex-responses"), "https://chatgpt.example/backend-api/codex/responses");
  assert.deepEqual(parseModelSpec("gateway/chat-model"), { provider: "gateway", model: "chat-model" });
});

test("resolves a configured model independently from the active model", async () => {
  const active = { provider: "main", id: "main-model", api: "openai-responses", baseUrl: "https://main/v1" };
  const selected = { provider: "image", id: "route-model", api: "openai-responses", baseUrl: "https://image/v1" };
  const ctx = {
    model: active,
    modelRegistry: {
      find: (provider: string, model: string) => provider === "image" && model === "route-model" ? selected : undefined,
      getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "secret" }),
    },
    sessionManager: { getSessionId: () => "session-1" },
    cwd: ".",
    hasUI: false,
    ui: {},
  } as never;
  const runtime = await resolveImageRuntime(ctx, { enabled: true, model: "image/route-model", imageModel: "image-2", userAgent: undefined, defaultSize: "auto", defaultQuality: "auto" });
  assert.equal(runtime.model, "route-model");
  assert.equal(runtime.responsesUrl, "https://image/v1/responses");
  assert.equal(runtime.sessionId, "session-1");
});

test("custom User-Agent wins without forwarding forbidden headers", () => {
  const headers = buildImageRequestHeaders({ provider: "image", api: "openai-codex-responses", model: "route-model", baseUrl: "https://image", responsesUrl: "https://image/codex/responses", apiKey: "secret", headers: { "User-Agent": "provider", Cookie: "private", "x-extra": "yes" }, sessionId: "s", currentModel: { provider: "image", id: "route-model", api: "openai-codex-responses" } }, "plugin-test/1");
  assert.equal(headers["user-agent"], "plugin-test/1");
  assert.equal(headers.cookie, undefined);
  assert.equal(headers.authorization, "Bearer secret");
  assert.equal(headers["session-id"], "s");
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
  await assert.rejects(() => resolveImageRuntime(ctx, { enabled: true, model: undefined, imageModel: undefined, userAgent: undefined, defaultSize: "auto", defaultQuality: "auto" }), (error: unknown) => error instanceof Error && !error.message.includes("secret-value") && error.message.includes("REDACTED"));
});
