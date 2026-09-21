import test from "node:test";
import assert from "node:assert/strict";
import { _clientTest, requestGeneratedImage } from "./client.js";
import { normalizeImageParams } from "./protocol.js";
import type { ImageGenerationRuntime } from "./types.js";
import type { ImageDebugRecord } from "./diagnostics.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function makeRuntime(overrides: Partial<ImageGenerationRuntime> = {}): ImageGenerationRuntime {
  return {
    provider: "gateway",
    api: "openai-responses",
    providerModel: "chat",
    baseUrl: "https://gateway/v1",
    generationUrl: "https://gateway/v1/images/generations",
    editsUrl: "https://gateway/v1/images/edits",
    responsesUrl: "https://gateway/v1/responses",
    transport: "responses",
    textModel: "chat",
    bindingReason: "current-provider",
    partialImages: 1,
    stream: true,
    retryOnTransportFailure: false,
    debug: false,
    apiKey: "secret",
    headers: { "User-Agent": "provider" },
    currentModel: { provider: "gateway", id: "chat", api: "openai-responses" },
    ...overrides,
  };
}

const generate = normalizeImageParams({ prompt: "x", action: "generate" });

function sseEvent(name: string, payload: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function sseResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const responsesDone = (result = PNG, status = "completed") => sseResponse(sseEvent("response.output_item.done", {
  type: "response.output_item.done",
  item: { type: "image_generation_call", id: "ig_1", status, result },
}));

const imagesCompleted = (b64 = PNG) => sseResponse(sseEvent("image_generation.completed", { type: "image_generation.completed", b64_json: b64 }));

const jsonImagesResponse = () => new Response(JSON.stringify({ created: 1, data: [{ b64_json: PNG }] }), { status: 200, headers: { "content-type": "application/json" } });

const jsonResponsesResponse = () => new Response(JSON.stringify({ output: [{ type: "image_generation_call", id: "ig_1", status: "completed", result: PNG }] }), { status: 200, headers: { "content-type": "application/json" } });

function responseWithReader(reader: {
  read: () => Promise<ReadableStreamReadResult<Uint8Array>>;
  cancel: () => Promise<void>;
  releaseLock: () => void;
}): Response {
  return { headers: new Headers(), body: { getReader: () => reader } } as unknown as Response;
}

test("declares the image_generation tool on the Responses endpoint", async () => {
  _clientTest.resetResponsesFallbackState();
  let capturedUrl = "";
  let captured: RequestInit | undefined;
  const result = await requestGeneratedImage({
    runtime: makeRuntime(),
    imageModel: "gpt-image-2",
    params: generate,
    references: [],
    userAgent: "image-plugin/1",
    timeoutMs: 1_000,
    fetchFn: async (url, init) => { capturedUrl = String(url); captured = init; return responsesDone(); },
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.transport, "responses");
  assert.equal(capturedUrl, "https://gateway/v1/responses");
  const headers = new Headers(captured?.headers);
  assert.equal(headers.get("user-agent"), "image-plugin/1");
  assert.equal(headers.get("accept"), "text/event-stream");
  assert.equal(headers.get("authorization"), "Bearer secret");
  assert.equal(captured?.redirect, "error");
  const body = JSON.parse(String(captured?.body));
  assert.equal(body.model, "chat");
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  assert.deepEqual(body.tool_choice, { type: "image_generation" });
  assert.deepEqual(body.tools, [{ type: "image_generation", model: "gpt-image-2", action: "generate", size: "auto", quality: "auto", output_format: "png", partial_images: 1 }]);
  assert.equal(body.parallel_tool_calls, false);
  assert.deepEqual(body.input, [{ type: "message", role: "user", content: [{ type: "input_text", text: "x" }] }]);
});

test("sends the configured text model with the image model declared by the tool", async () => {
  _clientTest.resetResponsesFallbackState();
  let captured: RequestInit | undefined;
  const result = await requestGeneratedImage({
    runtime: makeRuntime({ textModel: "gpt-5.4" }),
    imageModel: "gpt-image-2",
    params: generate,
    references: [],
    timeoutMs: 1_000,
    fetchFn: async (_url, init) => { captured = init; return responsesDone(); },
  });
  assert.equal(result.ok, true);
  const body = JSON.parse(String(captured?.body));
  assert.equal(body.model, "gpt-5.4");
  // The image_generation tool always declares the image model the request is sent with.
  assert.equal(body.tools[0].model, "gpt-image-2");
  assert.deepEqual(body.tool_choice, { type: "image_generation" });
});

test("derives the codex originator from a codex user agent", async () => {
  _clientTest.resetResponsesFallbackState();
  let captured: RequestInit | undefined;
  await requestGeneratedImage({
    runtime: makeRuntime({ headers: { "User-Agent": "codex_cli_rs/0.153.4 (Windows 10.0.26200; x86_64) xterm-256color" } }),
    imageModel: "gpt-image-2",
    params: generate,
    references: [],
    timeoutMs: 1_000,
    fetchFn: async (_url, init) => { captured = init; return responsesDone(); },
  });
  const headers = new Headers(captured?.headers);
  assert.equal(headers.get("originator"), "codex_cli_rs");
  assert.equal(headers.get("version"), "0.153.4");
  assert.equal(headers.get("user-agent"), "codex_cli_rs/0.153.4 (Windows 10.0.26200; x86_64) xterm-256color");
  assert.equal(headers.get("openai-beta"), "responses=experimental");
});

test("falls back to the Images API only for capability failures", async () => {
  _clientTest.resetResponsesFallbackState();
  const urls: string[] = [];
  const bodies: string[] = [];
  const result = await requestGeneratedImage({
    runtime: makeRuntime(),
    imageModel: "gpt-image-2",
    params: generate,
    references: [],
    timeoutMs: 1_000,
    fetchFn: async (url, init) => {
      urls.push(String(url));
      bodies.push(String(init?.body));
      if (urls.length === 1) return new Response(JSON.stringify({ error: { message: "Unknown tool: image_generation" } }), { status: 400 });
      return imagesCompleted();
    },
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.transport, "images");
  assert.deepEqual(urls, ["https://gateway/v1/responses", "https://gateway/v1/images/generations"]);
  assert.equal(JSON.parse(bodies[1]!).stream, true);

  // The provider is remembered, so the next request skips the doomed Responses attempt.
  const second: string[] = [];
  const again = await requestGeneratedImage({
    runtime: makeRuntime(),
    imageModel: "gpt-image-2",
    params: generate,
    references: [],
    timeoutMs: 1_000,
    fetchFn: async (url) => { second.push(String(url)); return imagesCompleted(); },
  });
  assert.equal(again.ok, true);
  assert.deepEqual(second, ["https://gateway/v1/images/generations"]);
});

test("never retries authentication, rate-limit or timeout failures on the Images API", async () => {
  _clientTest.resetResponsesFallbackState();
  let calls = 0;
  const unauthorized = await requestGeneratedImage({
    runtime: makeRuntime(),
    imageModel: "gpt-image-2",
    params: generate,
    references: [],
    timeoutMs: 1_000,
    fetchFn: async () => { calls++; return new Response(JSON.stringify({ error: { message: "no" } }), { status: 401 }); },
  });
  assert.equal(unauthorized.ok, false);
  if (!unauthorized.ok) assert.equal(unauthorized.reason, "authentication");
  assert.equal(calls, 1);
  assert.equal(_clientTest.shouldFallbackToImages({ ok: false, reason: "timeout", errorMessage: "t", transport: "responses" }), false);
  assert.equal(_clientTest.shouldFallbackToImages({ ok: false, reason: "request-rejected", errorMessage: "does not exist", transport: "responses" }), true);
  assert.equal(_clientTest.shouldFallbackToImages({ ok: false, reason: "no-image", errorMessage: "n", transport: "responses" }), true);
});

test("uses the Images API directly for non-Responses providers", async () => {
  _clientTest.resetResponsesFallbackState();
  const urls: string[] = [];
  const result = await requestGeneratedImage({
    runtime: makeRuntime({ transport: "images", api: "openai-completions" }),
    imageModel: "gpt-image-2",
    params: generate,
    references: [],
    timeoutMs: 1_000,
    fetchFn: async (url, init) => {
      urls.push(String(url));
      assert.equal(new Headers(init?.headers).get("accept"), "text/event-stream");
      return imagesCompleted();
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(urls, ["https://gateway/v1/images/generations"]);
});

test("keeps DALL-E on the non-streaming Images API contract", async () => {
  _clientTest.resetResponsesFallbackState();
  let captured: RequestInit | undefined;
  let capturedUrl = "";
  const result = await requestGeneratedImage({
    runtime: makeRuntime(),
    imageModel: "dall-e-3",
    params: generate,
    references: [],
    timeoutMs: 1_000,
    fetchFn: async (url, init) => { capturedUrl = String(url); captured = init; return jsonImagesResponse(); },
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.transport, "images");
  assert.equal(capturedUrl, "https://gateway/v1/images/generations");
  assert.equal(new Headers(captured?.headers).get("accept"), "application/json");
  const body = JSON.parse(String(captured?.body));
  assert.equal(body.stream, undefined);
  assert.equal(body.response_format, "b64_json");
});

test("accepts a JSON body when a provider ignores stream", async () => {
  _clientTest.resetResponsesFallbackState();
  const responses = await requestGeneratedImage({
    runtime: makeRuntime(),
    imageModel: "gpt-image-2",
    params: generate,
    references: [],
    timeoutMs: 1_000,
    fetchFn: async () => jsonResponsesResponse(),
  });
  assert.equal(responses.ok, true);

  const images = await requestGeneratedImage({
    runtime: makeRuntime({ transport: "images" }),
    imageModel: "gpt-image-2",
    params: generate,
    references: [],
    timeoutMs: 1_000,
    fetchFn: async () => jsonImagesResponse(),
  });
  assert.equal(images.ok, true);
});

test("reports streamed provider errors without falling back", async () => {
  _clientTest.resetResponsesFallbackState();
  let calls = 0;
  const result = await requestGeneratedImage({
    runtime: makeRuntime(),
    imageModel: "gpt-image-2",
    params: generate,
    references: [],
    timeoutMs: 1_000,
    fetchFn: async () => { calls++; return sseResponse(sseEvent("response.failed", { type: "response.failed", response: { error: { message: "safety refusal" } } })); },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "request-rejected");
    assert.match(result.errorMessage, /safety refusal/);
  }
  assert.equal(calls, 1);
});

test("uploads references as input images on the Responses transport", async () => {
  _clientTest.resetResponsesFallbackState();
  const params = normalizeImageParams({ prompt: "edit", action: "edit", referenceImagePaths: ["input.png"] });
  let captured: RequestInit | undefined;
  let capturedUrl = "";
  const result = await requestGeneratedImage({
    runtime: makeRuntime(),
    imageModel: "gpt-image-2",
    params,
    references: [{ path: "input.png", mimeType: "image/png", bytes: Buffer.from("png") }],
    timeoutMs: 1_000,
    fetchFn: async (url, init) => { capturedUrl = String(url); captured = init; return responsesDone(); },
  });
  assert.equal(result.ok, true);
  assert.equal(capturedUrl, "https://gateway/v1/responses");
  const body = JSON.parse(String(captured?.body));
  assert.equal(body.tools[0].action, "edit");
  assert.equal(body.input[0].content[1].type, "input_image");
  assert.equal(body.input[0].content[1].detail, "auto");
  assert.match(body.input[0].content[1].image_url, /^data:image\/png;base64,/);
});

test("falls back to multipart edits with intact reference bytes", async () => {
  _clientTest.resetResponsesFallbackState();
  const params = normalizeImageParams({ prompt: "edit", action: "edit", referenceImagePaths: ["input.png"] });
  const reference = Buffer.from("reference-bytes");
  const urls: string[] = [];
  let multipart: Buffer | undefined;
  const result = await requestGeneratedImage({
    runtime: makeRuntime(),
    imageModel: "gpt-image-2",
    params,
    references: [{ path: "input.png", mimeType: "image/png", bytes: reference }],
    timeoutMs: 1_000,
    fetchFn: async (url, init) => {
      urls.push(String(url));
      if (urls.length === 1) return new Response(JSON.stringify({ error: { message: "Unknown tool: image_generation" } }), { status: 400 });
      multipart = Buffer.from(init?.body as Uint8Array);
      return jsonImagesResponse();
    },
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.transport, "images");
  assert.deepEqual(urls, ["https://gateway/v1/responses", "https://gateway/v1/images/edits"]);
  // The fallback must upload the real bytes, not an already-cleared buffer.
  assert.match(multipart?.toString("latin1") ?? "", /reference-bytes/);
  assert.equal(reference.every((byte) => byte === 0), true);
});
test("declares the image model on both the Responses tool and the Images fallback", async () => {
  _clientTest.resetResponsesFallbackState();
  const params = normalizeImageParams({ prompt: "edit", action: "edit", referenceImagePaths: ["input.png"] });
  const urls: string[] = [];
  let responsesBody = "";
  let multipart = "";
  const result = await requestGeneratedImage({
    runtime: makeRuntime(),
    imageModel: "gpt-image-2",
    params,
    references: [{ path: "input.png", mimeType: "image/png", bytes: Buffer.from("reference-bytes") }],
    timeoutMs: 1_000,
    fetchFn: async (url, init) => {
      urls.push(String(url));
      if (urls.length === 1) {
        responsesBody = String(init?.body);
        return new Response(JSON.stringify({ error: { message: "Unknown tool: image_generation" } }), { status: 400 });
      }
      multipart = Buffer.from(init?.body as Uint8Array).toString("latin1");
      return jsonImagesResponse();
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(urls, ["https://gateway/v1/responses", "https://gateway/v1/images/edits"]);
  // One image model drives both transports; the fallback must not drift to another id.
  assert.equal(JSON.parse(responsesBody).tools[0].model, "gpt-image-2");
  assert.match(multipart, /name="model"\r\n\r\ngpt-image-2/);
});

test("uses the Responses tool for a prefixed custom model that only looks like DALL-E", async () => {
  _clientTest.resetResponsesFallbackState();
  const urls: string[] = [];
  let captured: RequestInit | undefined;
  const result = await requestGeneratedImage({
    runtime: makeRuntime(),
    // Only exact `dall-e-2`/`dall-e-3` ids are guarded; this custom id still uses the tool.
    imageModel: "dall-e-3-custom",
    params: generate,
    references: [],
    timeoutMs: 1_000,
    fetchFn: async (url, init) => { urls.push(String(url)); captured = init; return responsesDone(); },
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.transport, "responses");
  assert.deepEqual(urls, ["https://gateway/v1/responses"]);
  assert.equal(JSON.parse(String(captured?.body)).tools[0].model, "dall-e-3-custom");
});

test("keeps an exact DALL-E id off the Responses tool even for edits", async () => {
  _clientTest.resetResponsesFallbackState();
  const params = normalizeImageParams({ prompt: "edit", action: "edit", referenceImagePaths: ["input.png"] });
  const urls: string[] = [];
  const result = await requestGeneratedImage({
    runtime: makeRuntime(),
    // DALL-E ids are never reachable through the Responses tool, edits included.
    imageModel: "dall-e-2",
    params,
    references: [{ path: "input.png", mimeType: "image/png", bytes: Buffer.from(PNG, "base64") }],
    timeoutMs: 1_000,
    fetchFn: async (url) => { urls.push(String(url)); return jsonImagesResponse(); },
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.transport, "images");
  assert.deepEqual(urls, ["https://gateway/v1/images/edits"]);
});

test("falls back on 501 but not for fulfilled or parameter-level failures", async () => {
  _clientTest.resetResponsesFallbackState();
  const urls: string[] = [];
  const notImplemented = await requestGeneratedImage({
    runtime: makeRuntime(),
    imageModel: "gpt-image-2",
    params: generate,
    references: [],
    timeoutMs: 1_000,
    fetchFn: async (url) => {
      urls.push(String(url));
      return urls.length === 1
        ? new Response(JSON.stringify({ error: { message: "not implemented" } }), { status: 501 })
        : imagesCompleted();
    },
  });
  assert.equal(notImplemented.ok, true);
  assert.deepEqual(urls, ["https://gateway/v1/responses", "https://gateway/v1/images/generations"]);

  // A provider that already answered (unparseable body) is not billed twice.
  _clientTest.resetResponsesFallbackState();
  let calls = 0;
  const malformed = await requestGeneratedImage({
    runtime: makeRuntime(),
    imageModel: "gpt-image-2",
    params: generate,
    references: [],
    timeoutMs: 1_000,
    fetchFn: async () => { calls++; return new Response("not json", { status: 200, headers: { "content-type": "application/json" } }); },
  });
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.equal(malformed.reason, "malformed-response");
  assert.equal(calls, 1);

  assert.equal(_clientTest.shouldFallbackToImages({ ok: false, reason: "request-rejected", status: 400, errorMessage: "Unsupported size for this model", transport: "responses" }), false);
  assert.equal(_clientTest.shouldFallbackToImages({ ok: false, reason: "backend-unavailable", status: 503, errorMessage: "busy", transport: "responses" }), false);
  assert.equal(_clientTest.shouldFallbackToImages({ ok: false, reason: "backend-unavailable", status: 501, errorMessage: "not implemented", transport: "responses" }), true);
});

test("keeps provider error frames instead of reading them as a missing image", async () => {
  _clientTest.resetResponsesFallbackState();
  let calls = 0;
  const result = await requestGeneratedImage({
    runtime: makeRuntime(),
    imageModel: "gpt-image-2",
    params: generate,
    references: [],
    timeoutMs: 1_000,
    fetchFn: async () => { calls++; return sseResponse(sseEvent("error", { error: { message: "content policy violation" } })); },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "request-rejected");
    assert.match(result.errorMessage, /content policy violation/);
  }
  assert.equal(calls, 1);
});

test("only marks Responses-only headers on the Responses request", async () => {
  _clientTest.resetResponsesFallbackState();
  const captured: Headers[] = [];
  const codexRuntime = () => makeRuntime({ headers: { "User-Agent": "codex_cli_rs/0.153.4 (Windows; x86_64)" } });
  await requestGeneratedImage({
    runtime: codexRuntime(),
    imageModel: "gpt-image-2",
    params: generate,
    references: [],
    timeoutMs: 1_000,
    fetchFn: async (_url, init) => { captured.push(new Headers(init?.headers)); return responsesDone(); },
  });
  assert.equal(captured[0]?.get("openai-beta"), "responses=experimental");
  assert.equal(captured[0]?.get("originator"), "codex_cli_rs");

  _clientTest.resetResponsesFallbackState();
  await requestGeneratedImage({
    runtime: codexRuntime(),
    imageModel: "gpt-image-2",
    params: generate,
    references: [],
    timeoutMs: 1_000,
    fetchFn: async (url, init) => {
      if (String(url).endsWith("/responses")) return new Response(JSON.stringify({ error: { message: "Unknown tool: image_generation" } }), { status: 400 });
      captured.push(new Headers(init?.headers));
      return imagesCompleted();
    },
  });
  assert.equal(captured[1]?.get("openai-beta"), null);
  assert.equal(captured[1]?.get("accept"), "text/event-stream");
});

test("stops reading the stream as soon as an image arrives", async () => {
  _clientTest.resetResponsesFallbackState();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sseEvent("image_generation.completed", { type: "image_generation.completed", b64_json: PNG })));
      // Deliberately stay open: waiting for the provider to close would hang the tool.
    },
    cancel() { cancelled = true; },
  });
  const result = await requestGeneratedImage({
    runtime: makeRuntime({ transport: "images" }),
    imageModel: "gpt-image-2",
    params: generate,
    references: [],
    timeoutMs: 2_000,
    fetchFn: async () => new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
  });
  assert.equal(result.ok, true);
  assert.equal(cancelled, true);
});

test("classifies an aborted stream as cancellation", async () => {
  _clientTest.resetResponsesFallbackState();
  const controller = new AbortController();
  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      streamController.enqueue(new TextEncoder().encode(": keepalive\n\n"));
      // A real fetch errors its body when the request signal aborts.
      controller.signal.addEventListener("abort", () => streamController.error(new DOMException("This operation was aborted", "AbortError")));
      setTimeout(() => controller.abort(), 10);
    },
  });
  const result = await requestGeneratedImage({
    runtime: makeRuntime({ transport: "images" }),
    imageModel: "gpt-image-2",
    params: generate,
    references: [],
    signal: controller.signal,
    timeoutMs: 5_000,
    fetchFn: async () => new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "aborted");
});

test("keeps the responses downgrade per provider and endpoint", async () => {
  _clientTest.resetResponsesFallbackState();
  const bodies: string[] = [];
  const failing = async (runtime: ReturnType<typeof makeRuntime>) => requestGeneratedImage({
    runtime,
    imageModel: "gpt-image-2",
    params: generate,
    references: [],
    timeoutMs: 1_000,
    fetchFn: async (url) => {
      bodies.push(String(url));
      return String(url).endsWith("/responses")
        ? new Response(JSON.stringify({ error: { message: "Unknown tool" } }), { status: 400 })
        : imagesCompleted();
    },
  });
  await failing(makeRuntime());
  // A different endpoint is probed on its own merits.
  await failing(makeRuntime({ responsesUrl: "https://other.example/v1/responses" }));
  assert.deepEqual(bodies, [
    "https://gateway/v1/responses",
    "https://gateway/v1/images/generations",
    "https://other.example/v1/responses",
    "https://gateway/v1/images/generations",
  ]);
});
test("posts clearable reference bytes directly to images/edits as multipart data", async () => {
  _clientTest.resetResponsesFallbackState();
  const params = normalizeImageParams({ prompt: "edit", action: "edit", referenceImagePaths: ["input.png"] });
  const reference = Buffer.from("png");
  let capturedUrl = "";
  let captured: RequestInit | undefined;
  let requestBody: Uint8Array | undefined;
  let bodyBeforeClear: Buffer | undefined;
  const result = await requestGeneratedImage({
    runtime: makeRuntime({ transport: "images" }),
    imageModel: "gpt-image-2",
    params,
    references: [{ path: "input.png", mimeType: "image/png", bytes: reference }],
    timeoutMs: 1_000,
    fetchFn: async (url, init) => {
      capturedUrl = String(url);
      captured = init;
      requestBody = init?.body as Uint8Array;
      bodyBeforeClear = Buffer.from(requestBody);
      return jsonImagesResponse();
    },
  });
  assert.equal(result.ok, true);
  assert.equal(capturedUrl, "https://gateway/v1/images/edits");
  assert.equal(captured?.redirect, "error");
  assert.match(bodyBeforeClear?.toString("latin1") ?? "", /name="model"\r\n\r\ngpt-image-2\r\n/);
  assert.match(bodyBeforeClear?.toString("latin1") ?? "", /name="image"; filename="input.png"/);
  const headers = new Headers(captured?.headers);
  assert.match(headers.get("content-type") ?? "", /^multipart\/form-data; boundary=----pi-image-gen-/);
  assert.equal(reference.every((byte) => byte === 0), true);
  assert.equal(requestBody?.every((byte) => byte === 0), true);
});

test("maps provider errors without exposing bearer values", async () => {
  _clientTest.resetResponsesFallbackState();
  const result = await requestGeneratedImage({
    runtime: makeRuntime({ transport: "images" }),
    imageModel: "gpt-image-2",
    params: generate,
    references: [],
    fetchFn: async () => new Response(JSON.stringify({ error: { message: "Bearer secret-value" } }), { status: 401 }),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "authentication");
    assert.equal(result.errorMessage.includes("secret-value"), false);
  }
});

test("reports a mid-stream read failure as a truncated stream, not as a retryable endpoint failure", async () => {
  _clientTest.resetResponsesFallbackState();
  const urls: string[] = [];
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("stream failed")); } });
  const result = await requestGeneratedImage({
    runtime: makeRuntime({ transport: "images" }),
    imageModel: "gpt-image-2",
    params: generate,
    references: [],
    timeoutMs: 2_000,
    fetchFn: async (url) => {
      urls.push(String(url));
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "no-image");
    assert.equal(result.truncated, true);
    // The provider accepted the request, so no second endpoint may be billed for it.
    assert.match(result.errorMessage, /ended before a complete image result/);
    assert.match(result.errorMessage, /stream failed/);
  }
  assert.deepEqual(urls, ["https://gateway/v1/images/generations"]);
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

test("streams partial preview frames as progress without ending the read", async () => {
  _clientTest.resetResponsesFallbackState();
  const progress: Array<{ partials: number; elapsedMs: number }> = [];
  let captured: RequestInit | undefined;
  const body = [
    sseEvent("response.image_generation_call.partial_image", { type: "response.image_generation_call.partial_image", partial_image_index: 0, partial_image_b64: "aGk=" }),
    sseEvent("response.image_generation_call.partial_image", { type: "response.image_generation_call.partial_image", partial_image_index: 1, partial_image_b64: "aGk=" }),
    sseEvent("response.output_item.done", { type: "response.output_item.done", item: { type: "image_generation_call", id: "ig_1", status: "completed", result: PNG } }),
  ].join("");
  const result = await requestGeneratedImage({
    runtime: makeRuntime({ partialImages: 2 }),
    imageModel: "gpt-image-2",
    params: generate,
    references: [],
    timeoutMs: 1_000,
    onProgress: (event) => progress.push(event),
    fetchFn: async (_url, init) => { captured = init; return sseResponse(body); },
  });
  assert.equal(result.ok, true);
  assert.equal(JSON.parse(String(captured?.body)).tools[0].partial_images, 2);
  assert.deepEqual(progress.map((event) => event.partials), [1, 2]);
});

test("treats a stream that ends without a terminal event as truncated and never falls back", async () => {
  _clientTest.resetResponsesFallbackState();
  const urls: string[] = [];
  const result = await requestGeneratedImage({
    runtime: makeRuntime(),
    imageModel: "gpt-image-2",
    params: generate,
    references: [],
    timeoutMs: 1_000,
    fetchFn: async (url) => {
      urls.push(String(url));
      // A proxy closed the connection after one preview frame, long before the image.
      return sseResponse(sseEvent("response.image_generation_call.partial_image", { type: "response.image_generation_call.partial_image", partial_image_index: 0 }));
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "no-image");
    assert.equal(result.truncated, true);
  }
  assert.deepEqual(urls, ["https://gateway/v1/responses"]);
});

test("keeps the requests non-streaming when stream is disabled", async () => {
  _clientTest.resetResponsesFallbackState();
  let captured: RequestInit | undefined;
  const responses = await requestGeneratedImage({
    runtime: makeRuntime({ stream: false }),
    imageModel: "gpt-image-2",
    params: generate,
    references: [],
    timeoutMs: 1_000,
    fetchFn: async (_url, init) => { captured = init; return jsonResponsesResponse(); },
  });
  assert.equal(responses.ok, true);
  assert.equal(new Headers(captured?.headers).get("accept"), "application/json");
  assert.equal(JSON.parse(String(captured?.body)).stream, false);

  _clientTest.resetResponsesFallbackState();
  const images = await requestGeneratedImage({
    runtime: makeRuntime({ transport: "images", stream: false }),
    imageModel: "gpt-image-2",
    params: generate,
    references: [],
    timeoutMs: 1_000,
    fetchFn: async (_url, init) => { captured = init; return jsonImagesResponse(); },
  });
  assert.equal(images.ok, true);
  assert.equal(new Headers(captured?.headers).get("accept"), "application/json");
  assert.equal(JSON.parse(String(captured?.body)).stream, undefined);
});

test("retries a transport failure only when the caller opted in", async () => {
  const truncated = () => new Response(sseEvent("image_generation.partial_image", { type: "image_generation.partial_image", b64_json: "aGk=" }), { status: 200, headers: { "content-type": "text/event-stream" } });

  _clientTest.resetResponsesFallbackState();
  let calls = 0;
  const defaultRun = await requestGeneratedImage({
    runtime: makeRuntime({ transport: "images" }),
    imageModel: "gpt-image-2",
    params: generate,
    references: [],
    timeoutMs: 1_000,
    fetchFn: async () => { calls++; return truncated(); },
  });
  assert.equal(defaultRun.ok, false);
  assert.equal(calls, 1);

  _clientTest.resetResponsesFallbackState();
  calls = 0;
  const retried = await requestGeneratedImage({
    runtime: makeRuntime({ transport: "images", retryOnTransportFailure: true }),
    imageModel: "gpt-image-2",
    params: generate,
    references: [],
    timeoutMs: 1_000,
    fetchFn: async () => { calls++; return calls === 1 ? truncated() : imagesCompleted(); },
  });
  assert.equal(retried.ok, true);
  assert.equal(calls, 2);

  assert.equal(_clientTest.isRetryableTransportFailure({ ok: false, reason: "network", errorMessage: "n", transport: "responses" }), true);
  assert.equal(_clientTest.isRetryableTransportFailure({ ok: false, reason: "no-image", truncated: true, errorMessage: "n", transport: "responses" }), true);
  assert.equal(_clientTest.isRetryableTransportFailure({ ok: false, reason: "no-image", errorMessage: "n", transport: "responses" }), false);
  assert.equal(_clientTest.isRetryableTransportFailure({ ok: false, reason: "authentication", errorMessage: "n", transport: "responses" }), false);
});

test("emits one metadata-only debug record per request", async () => {
  _clientTest.resetResponsesFallbackState();
  const records: ImageDebugRecord[] = [];
  await requestGeneratedImage({
    runtime: makeRuntime({ partialImages: 3, bindingReason: "session-fallback" }),
    imageModel: "gpt-image-2",
    params: generate,
    references: [],
    timeoutMs: 1_000,
    onDebug: (record) => records.push(record),
    // A deliberate delay keeps the recorded timing measurable instead of a same-millisecond zero.
    fetchFn: async () => { await new Promise((resolve) => setTimeout(resolve, 5)); return responsesDone(); },
  });
  assert.equal(records.length, 1);
  assert.equal(records[0]?.result.outcome, "ok");
  assert.equal(records[0]?.partialImages, 3);
  assert.equal(records[0]?.transport, "responses");
  assert.equal(records[0]?.stream, true);
  assert.deepEqual(records[0]?.model, { text: "chat", image: "gpt-image-2" });
  assert.equal(records[0]?.bindingReason, "session-fallback");
  assert.equal(records[0]!.timing.elapsedMs > 0, true);
  assert.equal(JSON.stringify(records[0]).includes("secret"), false);
});

test("keeps a provider verdict from an interrupted stream out of the Images fallback", async () => {
  _clientTest.resetResponsesFallbackState();
  const urls: string[] = [];
  const result = await requestGeneratedImage({
    runtime: makeRuntime(),
    imageModel: "gpt-image-2",
    params: generate,
    references: [],
    timeoutMs: 1_000,
    fetchFn: async (url) => {
      urls.push(String(url));
      // The provider announced the image call, then the connection ended before a result.
      return sseResponse(sseEvent("response.output_item.done", { type: "response.output_item.done", item: { type: "image_generation_call", id: "ig_1", status: "in_progress" } }));
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "no-image");
    assert.equal(result.truncated, true);
  }
  assert.deepEqual(urls, ["https://gateway/v1/responses"]);
  assert.equal(_clientTest.shouldFallbackToImages({ ok: false, reason: "no-image", truncated: true, errorMessage: "n", transport: "responses" }), false);
});

test("treats an incomplete response as a provider verdict, not a cut connection", async () => {
  _clientTest.resetResponsesFallbackState();
  const urls: string[] = [];
  const result = await requestGeneratedImage({
    runtime: makeRuntime({ retryOnTransportFailure: true }),
    imageModel: "gpt-image-2",
    params: generate,
    references: [],
    timeoutMs: 1_000,
    fetchFn: async (url) => {
      urls.push(String(url));
      return sseResponse(sseEvent("response.incomplete", {
        type: "response.incomplete",
        response: { id: "resp_1", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] },
      }));
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "request-rejected");
    assert.equal(result.truncated, undefined);
    assert.match(result.errorMessage, /max_output_tokens/);
  }
  // A turn the provider ended on purpose is neither retried nor billed on another endpoint.
  assert.deepEqual(urls, ["https://gateway/v1/responses"]);
});

test("reads a JSON error body even when the gateway labels it as a stream", async () => {
  _clientTest.resetResponsesFallbackState();
  const result = await requestGeneratedImage({
    runtime: makeRuntime(),
    imageModel: "gpt-image-2",
    params: generate,
    references: [],
    timeoutMs: 1_000,
    fetchFn: async () => new Response(JSON.stringify({ error: { message: "insufficient quota" } }), { status: 200, headers: { "content-type": "text/event-stream" } }),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "request-rejected");
    assert.equal(result.truncated, undefined);
    assert.match(result.errorMessage, /insufficient quota/);
  }
});

test("counts keep-alive frames as activity but never as preview images", async () => {
  _clientTest.resetResponsesFallbackState();
  const progress: number[] = [];
  const body = [
    sseEvent("response.in_progress", { type: "response.in_progress" }),
    sseEvent("response.output_item.done", { type: "response.output_item.done", item: { type: "image_generation_call", id: "ig_1", status: "completed", result: PNG } }),
  ].join("");
  const result = await requestGeneratedImage({
    runtime: makeRuntime(),
    imageModel: "gpt-image-2",
    params: generate,
    references: [],
    timeoutMs: 1_000,
    onProgress: (event) => progress.push(event.partials),
    fetchFn: async () => sseResponse(body),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(progress, []);
});

test("does not mistake a throwing progress callback for a broken connection", async () => {
  _clientTest.resetResponsesFallbackState();
  const body = [
    sseEvent("response.image_generation_call.partial_image", { type: "response.image_generation_call.partial_image", partial_image_index: 0 }),
    sseEvent("response.output_item.done", { type: "response.output_item.done", item: { type: "image_generation_call", id: "ig_1", status: "completed", result: PNG } }),
  ].join("");
  const result = await requestGeneratedImage({
    runtime: makeRuntime({ retryOnTransportFailure: true }),
    imageModel: "gpt-image-2",
    params: generate,
    references: [],
    timeoutMs: 1_000,
    onProgress: () => { throw new Error("ui exploded"); },
    fetchFn: async () => sseResponse(body),
  });
  assert.equal(result.ok, true);
});

test("never retries after a cancellation even when retries are enabled", async () => {
  _clientTest.resetResponsesFallbackState();
  const controller = new AbortController();
  const truncated = () => new Response(sseEvent("image_generation.partial_image", { type: "image_generation.partial_image", b64_json: "aGk=" }), { status: 200, headers: { "content-type": "text/event-stream" } });
  let calls = 0;
  const result = await requestGeneratedImage({
    runtime: makeRuntime({ transport: "images", retryOnTransportFailure: true }),
    imageModel: "gpt-image-2",
    params: generate,
    references: [],
    signal: controller.signal,
    timeoutMs: 2_000,
    fetchFn: async () => { calls++; controller.abort(); return truncated(); },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "aborted");
  assert.equal(calls, 1);
});

test("requests partial previews on the Images API stream too", async () => {
  _clientTest.resetResponsesFallbackState();
  let captured: RequestInit | undefined;
  const result = await requestGeneratedImage({
    runtime: makeRuntime({ transport: "images", partialImages: 2 }),
    imageModel: "gpt-image-2",
    params: generate,
    references: [],
    timeoutMs: 1_000,
    fetchFn: async (_url, init) => { captured = init; return imagesCompleted(); },
  });
  assert.equal(result.ok, true);
  const body = JSON.parse(String(captured?.body));
  assert.equal(body.stream, true);
  assert.equal(body.partial_images, 2);
});
