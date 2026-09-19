import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeImageGeneration } from "./service.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

test("executes image_gen against the configured image routing model", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-image-service-"));
  let sentBody: any;
  const ctx = {
    model: { provider: "main", id: "main-model", api: "openai-responses", baseUrl: "https://main/v1" },
    modelRegistry: {},
    sessionManager: { getSessionId: () => "session-1" },
    cwd: root,
    hasUI: false,
    ui: {},
  } as never;
  const result = await executeImageGeneration({
    params: { prompt: "a square", action: "generate" },
    toolCallId: "tool-1",
    ctx,
    deps: {
      loadConfig: () => ({ config: { enabled: true, model: "image/route-model", imageModel: "image-2", userAgent: undefined, defaultSize: "auto", defaultQuality: "auto" }, warnings: [], valid: true }),
      resolveRuntime: async () => ({ provider: "image", api: "openai-responses", model: "route-model", baseUrl: "https://image/v1", responsesUrl: "https://image/v1/responses", apiKey: "secret", headers: {}, sessionId: "session-1", currentModel: { provider: "image", id: "route-model", api: "openai-responses" } }),
      requestImage: async ({ body }) => { sentBody = body; return { ok: true as const, status: 200, image: { bytes: Buffer.from(PNG), imageCallId: "call-1", width: 1, height: 1 } }; },
      agentDir: () => root,
    },
  });
  assert.equal(sentBody.model, "route-model");
  assert.equal(sentBody.tools[0].model, "image-2");
  assert.equal(sentBody.tools[0].action, "generate");
  assert.equal(result.details.action, "generate");
  assert.deepEqual(readFileSync(result.details.artifactPath), PNG);
  rmSync(root, { recursive: true, force: true });
});
