import test from "node:test";
import assert from "node:assert/strict";
import { _clientTest, requestGeneratedImage } from "./client.js";
import { normalizeImageParams } from "./protocol.js";
import type { ImageGenerationRuntime } from "./types.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const runtime: ImageGenerationRuntime = {
  provider: "gateway",
  api: "openai-responses",
  providerModel: "chat",
  baseUrl: "https://gateway/v1",
  generationUrl: "https://gateway/v1/images/generations",
  editsUrl: "https://gateway/v1/images/edits",
  apiKey: "secret",
  headers: { "User-Agent": "provider" },
  currentModel: { provider: "gateway", id: "chat", api: "openai-responses" },
};
const generate = normalizeImageParams({ prompt: "x", action: "generate" });
const successResponse = () => new Response(JSON.stringify({ created: 1, data: [{ b64_json: PNG }] }), { status: 200, headers: { "content-type": "application/json" } });

function responseWithReader(reader: {
  read: () => Promise<ReadableStreamReadResult<Uint8Array>>;
  cancel: () => Promise<void>;
  releaseLock: () => void;
}): Response {
  return { headers: new Headers(), body: { getReader: () => reader } } as unknown as Response;
}

test("posts a JSON request directly to images/generations", async () => {
  let capturedUrl = "";
  let captured: RequestInit | undefined;
  const result = await requestGeneratedImage({
    runtime,
    imageModel: "image-2",
    params: generate,
    references: [],
    userAgent: "image-plugin/1",
    timeoutMs: 1_000,
    fetchFn: async (url, init) => { capturedUrl = String(url); captured = init; return successResponse(); },
  });
  assert.equal(result.ok, true);
  assert.equal(capturedUrl, runtime.generationUrl);
  const headers = new Headers(captured?.headers);
  assert.equal(headers.get("user-agent"), "image-plugin/1");
  assert.equal(headers.get("authorization"), "Bearer secret");
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(captured?.redirect, "error");
  assert.deepEqual(JSON.parse(String(captured?.body)), {
    model: "image-2",
    prompt: "x",
    n: 1,
    size: "auto",
    quality: "auto",
    output_format: "png",
  });
});

test("posts clearable reference bytes directly to images/edits as multipart data", async () => {
  const params = normalizeImageParams({ prompt: "edit", action: "edit", referenceImagePaths: ["input.png"] });
  const reference = Buffer.from("png");
  let capturedUrl = "";
  let captured: RequestInit | undefined;
  let requestBody: Uint8Array | undefined;
  let bodyBeforeClear: Buffer | undefined;
  const result = await requestGeneratedImage({
    runtime,
    imageModel: "image-2",
    params,
    references: [{ path: "input.png", mimeType: "image/png", bytes: reference }],
    timeoutMs: 1_000,
    fetchFn: async (url, init) => {
      capturedUrl = String(url);
      captured = init;
      requestBody = init?.body as Uint8Array;
      bodyBeforeClear = Buffer.from(requestBody);
      return successResponse();
    },
  });
  assert.equal(result.ok, true);
  assert.equal(capturedUrl, runtime.editsUrl);
  assert.equal(captured?.redirect, "error");
  assert.match(bodyBeforeClear?.toString("latin1") ?? "", /name="model"\r\n\r\nimage-2\r\n/);
  assert.match(bodyBeforeClear?.toString("latin1") ?? "", /name="image"; filename="input.png"/);
  const headers = new Headers(captured?.headers);
  assert.match(headers.get("content-type") ?? "", /^multipart\/form-data; boundary=----pi-image-gen-/);
  assert.equal(reference.every((byte) => byte === 0), true);
  assert.equal(requestBody?.every((byte) => byte === 0), true);
});

test("maps provider errors without exposing bearer values", async () => {
  const result = await requestGeneratedImage({ runtime, imageModel: "image-2", params: generate, references: [], fetchFn: async () => new Response(JSON.stringify({ error: { message: "Bearer secret-value" } }), { status: 401 }) });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "authentication");
    assert.equal(result.errorMessage.includes("secret-value"), false);
  }
});

test("classifies a response stream read failure as a network error", async () => {
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("stream failed")); } });
  const result = await requestGeneratedImage({ runtime, imageModel: "image-2", params: generate, references: [], fetchFn: async () => new Response(stream, { status: 200 }) });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "network");
});

test("clears bounded response chunks on success, overflow, and read failure", async () => {
  const successfulChunks = [Uint8Array.from([1, 2]), Uint8Array.from([3, 4])];
  let successIndex = 0;
  const successful = await _clientTest.readBounded(responseWithReader({
    read: async () => successIndex < successfulChunks.length
      ? { done: false, value: successfulChunks[successIndex++]! }
      : { done: true, value: undefined },
    cancel: async () => undefined,
    releaseLock: () => undefined,
  }), 4);
  assert.deepEqual(Array.from(successful ?? []), [1, 2, 3, 4]);
  assert.equal(successfulChunks.every((chunk) => chunk.every((byte) => byte === 0)), true);
  successful?.fill(0);

  const overflowChunks = [Uint8Array.from([1, 2]), Uint8Array.from([3, 4])];
  let overflowIndex = 0;
  let cancelled = false;
  const overflow = await _clientTest.readBounded(responseWithReader({
    read: async () => ({ done: false, value: overflowChunks[overflowIndex++]! }),
    cancel: async () => { cancelled = true; },
    releaseLock: () => undefined,
  }), 3);
  assert.equal(overflow, undefined);
  assert.equal(cancelled, true);
  assert.equal(overflowChunks.every((chunk) => chunk.every((byte) => byte === 0)), true);

  const failedChunk = Uint8Array.from([1, 2]);
  let failureReads = 0;
  await assert.rejects(() => _clientTest.readBounded(responseWithReader({
    read: async () => {
      if (failureReads++ === 0) return { done: false, value: failedChunk };
      throw new Error("stream failed");
    },
    cancel: async () => undefined,
    releaseLock: () => undefined,
  }), 4), /stream failed/);
  assert.equal(failedChunk.every((byte) => byte === 0), true);
});
