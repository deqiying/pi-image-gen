import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeImageGeneration } from "./service.js";

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
        loadConfig: () => ({ config: { enabled: true, model: "image/credential-model", imageModel: "image-2", userAgent: undefined, defaultSize: "auto", defaultQuality: "auto" }, warnings: [], valid: true }),
        resolveRuntime: async () => ({ provider: "image", api: "openai-responses", providerModel: "credential-model", baseUrl: "https://image/v1", generationUrl: "https://image/v1/images/generations", editsUrl: "https://image/v1/images/edits", apiKey: "secret", headers: {}, sessionId: "session-1", currentModel: { provider: "image", id: "credential-model", api: "openai-responses" } }),
        requestImage: async (args) => { sent = args; return { ok: true as const, status: 200, image: { bytes: Buffer.from(PNG), width: 1, height: 1 } }; },
        agentDir: () => root,
      },
    });
    assert.equal(sent.imageModel, "image-2");
    assert.equal(sent.params.prompt, "a square");
    assert.deepEqual(sent.references, []);
    assert.equal(result.details.providerModel, "image/credential-model");
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
      loadConfig: () => ({ config: { enabled: true, model: undefined, imageModel: undefined, userAgent: undefined, defaultSize: "auto", defaultQuality: "auto" }, warnings: [], valid: true }),
    },
  }), /require imageModel/);
});
