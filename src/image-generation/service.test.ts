import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeImageGeneration, type ImageExecutionDependencies } from "./service.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

test("executes image_gen through the direct Images API client", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-image-service-"));
  let sent: any;
  const ctx = {
    model: { provider: "main", id: "main-model", api: "openai-responses", baseUrl: "https://main/v1" },
    modelRegistry: {},
    sessionManager: { getSessionId: () => "session-1" },
    cwd: root,
    hasUI: false,
    ui: {},
  } as never;
  try {
    const result = await executeImageGeneration({
      params: { prompt: "a square", action: "generate" },
      toolCallId: "tool-1",
      ctx,
      deps: {
        loadConfig: () => ({ config: { enabled: true, imageModel: "image-2", textModel: undefined, userAgent: undefined, transport: "auto", partialImages: 1, stream: true, retryOnTransportFailure: false, debug: false, defaultSize: "auto", defaultQuality: "auto" }, warnings: [], valid: true }),
        resolveRuntime: async () => ({ provider: "image", api: "openai-responses", providerModel: "credential-model", baseUrl: "https://image/v1", generationUrl: "https://image/v1/images/generations", editsUrl: "https://image/v1/images/edits", responsesUrl: "https://image/v1/responses", transport: "responses", textModel: "credential-model", bindingReason: "current-provider", apiKey: "secret", headers: {}, sessionId: "session-1", partialImages: 1, stream: true, retryOnTransportFailure: false, debug: false, currentModel: { provider: "image", id: "credential-model", api: "openai-responses" } }),
        requestImage: async (args) => { sent = args; return { ok: true as const, status: 200, transport: "responses" as const, image: { bytes: Buffer.from(PNG), width: 1, height: 1 } }; },
        agentDir: () => root,
      },
    });
    assert.equal(sent.imageModel, "image-2");
    assert.equal(sent.runtime.textModel, "credential-model");
    assert.equal(sent.params.prompt, "a square");
    assert.deepEqual(sent.references, []);
    // No onProgress was passed and debug is off, so neither callback may reach the client.
    assert.equal("onProgress" in sent, false);
    assert.equal("onDebug" in sent, false);
    assert.equal(result.details.providerModel, "image/credential-model");
    assert.equal(result.details.transport, "responses");
    assert.equal(result.details.imageModel, "image-2");
    assert.equal(result.details.imageCallId, "tool-1");
    assert.equal(result.details.action, "generate");
    assert.deepEqual(readFileSync(result.details.artifactPath), PNG);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("requires an explicit imageModel for direct Images API calls", async () => {
  const ctx = {
    model: { provider: "main", id: "main-model", api: "openai-responses", baseUrl: "https://main/v1" },
    modelRegistry: {},
    sessionManager: { getSessionId: () => "session-1" },
    cwd: ".",
    hasUI: false,
    ui: {},
  } as never;
  await assert.rejects(() => executeImageGeneration({
    params: { prompt: "a square", action: "generate" },
    toolCallId: "tool-1",
    ctx,
    deps: {
      loadConfig: () => ({ config: { enabled: true, imageModel: undefined, textModel: undefined, userAgent: undefined, transport: "auto", partialImages: 1, stream: true, retryOnTransportFailure: false, debug: false, defaultSize: "auto", defaultQuality: "auto" }, warnings: [], valid: true }),
    },
  }), /imageModel is required/);
});

test("reports the configured image model as the model that produced the image", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-image-service-image-model-"));
  let sent: any;
  try {
    const result = await executeImageGeneration({
      params: { prompt: "a square", action: "generate" },
      toolCallId: "tool-2",
      ctx: {
        model: { provider: "main", id: "main-model", api: "openai-responses", baseUrl: "https://main/v1" },
        modelRegistry: {},
        sessionManager: { getSessionId: () => "session-1" },
        cwd: root,
        hasUI: false,
        ui: {},
      } as never,
      deps: {
        loadConfig: () => ({ config: { enabled: true, imageModel: "gpt-image-2", textModel: "gpt-5.4", userAgent: undefined, transport: "auto", partialImages: 1, stream: true, retryOnTransportFailure: false, debug: false, defaultSize: "auto", defaultQuality: "auto" }, warnings: [], valid: true }),
        resolveRuntime: async () => ({ provider: "image", api: "openai-responses", providerModel: "credential-model", baseUrl: "https://image/v1", generationUrl: "https://image/v1/images/generations", editsUrl: "https://image/v1/images/edits", responsesUrl: "https://image/v1/responses", transport: "responses", textModel: "gpt-5.4", bindingReason: "matched-provider", apiKey: "secret", headers: {}, sessionId: "session-1", partialImages: 1, stream: true, retryOnTransportFailure: false, debug: false, currentModel: { provider: "image", id: "credential-model", api: "openai-responses" } }),
        requestImage: async (args) => { sent = args; return { ok: true as const, status: 200, transport: "responses" as const, image: { bytes: Buffer.from(PNG), width: 1, height: 1 } }; },
        agentDir: () => root,
      },
    });
    // Both transports send one image model; the configured textModel only hosts the tool.
    assert.equal(sent.imageModel, "gpt-image-2");
    assert.equal(sent.runtime.textModel, "gpt-5.4");
    assert.equal(result.details.imageModel, "gpt-image-2");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("surfaces configuration notices on both the result and a failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-image-service-notice-"));
  const notice = "The toolModel key was removed: the image_generation tool always declares imageModel now, so move the value to imageModel.";
  const ctx = {
    model: { provider: "main", id: "main-model", api: "openai-responses", baseUrl: "https://main/v1" },
    modelRegistry: {},
    sessionManager: { getSessionId: () => "session-1" },
    cwd: root,
    hasUI: false,
    ui: {},
  } as never;
  const deps: Partial<ImageExecutionDependencies> = {
    loadConfig: () => ({ config: { enabled: true, imageModel: "gpt-image-2", textModel: undefined, userAgent: undefined, transport: "auto", partialImages: 1, stream: true, retryOnTransportFailure: false, debug: false, defaultSize: "auto", defaultQuality: "auto" }, warnings: [notice], valid: true }),
    resolveRuntime: async () => ({ provider: "image", api: "openai-responses", providerModel: "credential-model", baseUrl: "https://image/v1", generationUrl: "https://image/v1/images/generations", editsUrl: "https://image/v1/images/edits", responsesUrl: "https://image/v1/responses", transport: "responses", textModel: "credential-model", bindingReason: "current-provider", apiKey: "secret", headers: {}, sessionId: "session-1", partialImages: 1, stream: true, retryOnTransportFailure: false, debug: false, currentModel: { provider: "image", id: "credential-model", api: "openai-responses" } }),
    agentDir: () => root,
  };
  try {
    const ok = await executeImageGeneration({
      params: { prompt: "a square", action: "generate" },
      toolCallId: "tool-3",
      ctx,
      deps: { ...deps, requestImage: async () => ({ ok: true as const, status: 200, transport: "responses" as const, image: { bytes: Buffer.from(PNG), width: 1, height: 1 } }) },
    });
    // A config that is valid but carries a removed key has to reach the caller somewhere.
    assert.equal(ok.text.includes(`Configuration notice: ${notice}`), true);

    await assert.rejects(
      () => executeImageGeneration({
        params: { prompt: "a square", action: "generate" },
        toolCallId: "tool-4",
        ctx,
        deps: { ...deps, requestImage: async () => ({ ok: false as const, reason: "timeout" as const, errorMessage: "provider stayed silent", transport: "responses" as const, status: 504 }) },
      }),
      (error: unknown) => error instanceof Error && error.message.includes("provider stayed silent") && error.message.includes(notice),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
