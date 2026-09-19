import test from "node:test";
import assert from "node:assert/strict";
import { requestGeneratedImage } from "./client.js";
import { buildImageGenerationRequest, normalizeImageParams } from "./protocol.js";
import type { ImageGenerationRuntime } from "./types.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const runtime: ImageGenerationRuntime = { provider: "gateway", api: "openai-responses", model: "chat", baseUrl: "https://gateway/v1", responsesUrl: "https://gateway/v1/responses", apiKey: "secret", headers: { "User-Agent": "provider" }, currentModel: { provider: "gateway", id: "chat", api: "openai-responses" } };
const body = buildImageGenerationRequest({ routingModel: "chat", imageModel: "image-2", params: normalizeImageParams({ prompt: "x", action: "generate" }), references: [] });

test("sends the image request with a scoped custom User-Agent", async () => {
  let captured: RequestInit | undefined;
  const result = await requestGeneratedImage({ runtime, body, userAgent: "image-plugin/1", timeoutMs: 1_000, fetchFn: async (_url, init) => { captured = init; return new Response(JSON.stringify({ status: "completed", output: [{ type: "image_generation_call", result: PNG }] }), { status: 200, headers: { "content-type": "application/json" } }); } });
  assert.equal(result.ok, true);
  const headers = new Headers(captured?.headers);
  assert.equal(headers.get("user-agent"), "image-plugin/1");
  assert.equal(headers.get("authorization"), "Bearer secret");
});

test("maps provider errors without exposing bearer values", async () => {
  const result = await requestGeneratedImage({ runtime, body, fetchFn: async () => new Response(JSON.stringify({ error: { message: "Bearer secret-value" } }), { status: 401 }) });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "authentication");
    assert.equal(result.errorMessage.includes("secret-value"), false);
  }
});
test("classifies a response stream read failure as a network error", async () => {
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("stream failed")); } });
  const result = await requestGeneratedImage({ runtime, body, fetchFn: async () => new Response(stream, { status: 200 }) });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "network");
});
