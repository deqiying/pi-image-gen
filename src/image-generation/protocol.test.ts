import test from "node:test";
import assert from "node:assert/strict";
import { buildImageEditRequest, buildImageGenerationRequest, buildImageResponsesRequest, decodeGeneratedPng, decodeImageGenerationCall, normalizeImageParams, parseImageGenerationResponse, parseImageResponsesPayload, supportsResponsesTool } from "./protocol.js";
import type { ImageEditRequest } from "./types.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function multipartText(request: ImageEditRequest): string {
  return Buffer.from(request.body).toString("latin1");
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

test("builds a direct GPT Images API generation payload", () => {
  const generate = normalizeImageParams({ prompt: "a red square", action: "generate" });
  assert.deepEqual(buildImageGenerationRequest("image-2", generate), {
    model: "image-2",
    prompt: "a red square",
    n: 1,
    size: "auto",
    quality: "auto",
    output_format: "png",
    partial_images: 0,
  });
  // The streamed Images path carries its own keep-alive parameter.
  assert.deepEqual(buildImageGenerationRequest("image-2", generate, 2), {
    model: "image-2",
    prompt: "a red square",
    n: 1,
    size: "auto",
    quality: "auto",
    output_format: "png",
    partial_images: 2,
  });
  assert.equal(buildImageGenerationRequest("image-2", generate, 9).partial_images, 3);
});

test("does not apply DALL-E payload rules to prefixed custom models", () => {
  const generate = normalizeImageParams({ prompt: "a red square", action: "generate" });
  assert.deepEqual(buildImageGenerationRequest("dall-e-3-custom", generate), {
    model: "dall-e-3-custom",
    prompt: "a red square",
    n: 1,
    size: "auto",
    quality: "auto",
    output_format: "png",
    // Only exact `dall-e-2`/`dall-e-3` ids take the DALL-E contract; this stays streamed.
    partial_images: 0,
  });
});

test("builds clearable single and multi-image edit payloads", () => {
  const edit = normalizeImageParams({ prompt: "remove the logo", action: "edit", referenceImagePaths: ["input.png"] });
  const singleSource = Buffer.from("png");
  const single = buildImageEditRequest("image-2", edit, [
    { path: "input.png", mimeType: "image/png", bytes: singleSource },
  ]);
  const singleText = multipartText(single);
  assert.match(single.contentType, /^multipart\/form-data; boundary=----pi-image-gen-/);
  assert.match(singleText, /name="model"\r\n\r\nimage-2\r\n/);
  assert.match(singleText, /name="prompt"\r\n\r\nremove the logo\r\n/);
  assert.equal(occurrences(singleText, 'name="image"; filename="input.png"'), 1);
  assert.equal(singleSource.every((byte) => byte === 0), true);
  single.clear();
  assert.equal(single.body.every((byte) => byte === 0), true);

  const first = Buffer.from("first");
  const second = Buffer.from("second");
  const multi = buildImageEditRequest("image-2", edit, [
    { path: "first.png", mimeType: "image/png", bytes: first },
    { path: "second.webp", mimeType: "image/webp", bytes: second },
  ]);
  const multiText = multipartText(multi);
  assert.equal(occurrences(multiText, 'name="image[]"; filename='), 2);
  assert.equal(first.every((byte) => byte === 0), true);
  assert.equal(second.every((byte) => byte === 0), true);
  multi.clear();
});

test("requests inline base64 for DALL-E models", () => {
  const generate = normalizeImageParams({ prompt: "a red square", action: "generate" });
  assert.deepEqual(buildImageGenerationRequest("dall-e-3", generate), {
    model: "dall-e-3",
    prompt: "a red square",
    n: 1,
    response_format: "b64_json",
  });

  const source = Buffer.from(PNG, "base64");
  const edit = normalizeImageParams({ prompt: "edit", action: "edit", referenceImagePaths: ["input.png"] });
  const body = buildImageEditRequest("dall-e-2", edit, [{ path: "input.png", mimeType: "image/png", bytes: source }]);
  const text = multipartText(body);
  assert.match(text, /name="response_format"\r\n\r\nb64_json\r\n/);
  assert.doesNotMatch(text, /name="output_format"/);
  body.clear();
});

test("rejects unsupported DALL-E prompts, sizes, and edit inputs", () => {
  const longPrompt = normalizeImageParams({ prompt: "x".repeat(4_001), action: "generate" });
  assert.throws(() => buildImageGenerationRequest("dall-e-3", longPrompt), /4000 characters/);
  const dallE2LongPrompt = normalizeImageParams({ prompt: "x".repeat(1_001), action: "generate" });
  assert.throws(() => buildImageGenerationRequest("dall-e-2", dallE2LongPrompt), /1000 characters/);
  const landscape = normalizeImageParams({ prompt: "x", action: "generate", size: "1536x1024" });
  assert.throws(() => buildImageGenerationRequest("dall-e-3", landscape), /does not support image size/);

  const edit = normalizeImageParams({ prompt: "edit", action: "edit", referenceImagePaths: ["input.png"] });
  const dallE3Source = Buffer.from(PNG, "base64");
  assert.throws(() => buildImageEditRequest("dall-e-3", edit, [{ path: "input.png", mimeType: "image/png", bytes: dallE3Source }]), /does not support.*edits/);
  assert.equal(dallE3Source.every((byte) => byte === 0), true);

  const multiEdit = normalizeImageParams({ prompt: "edit", action: "edit", referenceImagePaths: ["one.png", "two.png"] });
  const first = Buffer.from(PNG, "base64");
  const second = Buffer.from(PNG, "base64");
  assert.throws(() => buildImageEditRequest("dall-e-2", multiEdit, [
    { path: "one.png", mimeType: "image/png", bytes: first },
    { path: "two.png", mimeType: "image/png", bytes: second },
  ]), /exactly one reference image/);
  assert.equal(first.every((byte) => byte === 0), true);
  assert.equal(second.every((byte) => byte === 0), true);

  const mismatchedFirst = Buffer.from(PNG, "base64");
  const mismatchedSecond = Buffer.from(PNG, "base64");
  assert.throws(() => buildImageEditRequest("dall-e-2", edit, [
    { path: "one.png", mimeType: "image/png", bytes: mismatchedFirst },
    { path: "two.png", mimeType: "image/png", bytes: mismatchedSecond },
  ]), /exactly one reference image/);
  assert.equal(mismatchedFirst.every((byte) => byte === 0), true);
  assert.equal(mismatchedSecond.every((byte) => byte === 0), true);
  const jpeg = Buffer.from(PNG, "base64");
  assert.throws(() => buildImageEditRequest("dall-e-2", edit, [{ path: "input.jpg", mimeType: "image/jpeg", bytes: jpeg }]), /square PNG smaller than 4 MiB/);
  assert.equal(jpeg.every((byte) => byte === 0), true);

  const nonSquare = Buffer.from(PNG, "base64");
  nonSquare.writeUInt32BE(2, 16);
  assert.throws(() => buildImageEditRequest("dall-e-2", edit, [{ path: "input.png", mimeType: "image/png", bytes: nonSquare }]), /square PNG smaller than 4 MiB/);
  assert.equal(nonSquare.every((byte) => byte === 0), true);

  const exactLimit = Buffer.alloc(4 * 1024 * 1024);
  Buffer.from(PNG, "base64").copy(exactLimit);
  assert.throws(() => buildImageEditRequest("dall-e-2", edit, [{ path: "input.png", mimeType: "image/png", bytes: exactLimit }]), /square PNG smaller than 4 MiB/);
  assert.equal(exactLimit.every((byte) => byte === 0), true);
});

test("rejects image variation and edit without references", () => {
  assert.throws(() => normalizeImageParams({ prompt: "x", action: "variation" }), /image_variation is not supported/);
  assert.throws(() => normalizeImageParams({ prompt: "x", action: "edit" }), /edit requires/);
});

test("parses a direct Images API base64 response", () => {
  const decoded = decodeGeneratedPng(PNG);
  assert.equal(decoded.ok, true);
  const result = parseImageGenerationResponse({ created: 1, data: [{ b64_json: PNG, revised_prompt: "a revised square" }] });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.image.revisedPrompt, "a revised square");
    assert.equal(result.image.width, 1);
    assert.equal(result.image.height, 1);
  }
});

test("rejects URL-only and multi-image responses", () => {
  const urlOnly = parseImageGenerationResponse({ created: 1, data: [{ url: "https://example.test/image.png" }] });
  assert.equal(urlOnly.ok, false);
  if (!urlOnly.ok) assert.equal(urlOnly.reason, "no-image");

  const multiple = parseImageGenerationResponse({ created: 1, data: [{ b64_json: PNG }, { b64_json: PNG }] });
  assert.equal(multiple.ok, false);
  if (!multiple.ok) assert.equal(multiple.reason, "malformed-response");
});

test("builds the Responses image tool payload with independent text and tool models", () => {
  const params = normalizeImageParams({ prompt: "a red square", action: "edit", referenceImagePaths: ["input.png"] });
  const reference = Buffer.from("reference-bytes");
  const body = JSON.parse(buildImageResponsesRequest({
    toolModel: "gpt-image-2",
    textModel: "chat-model",
    params,
    references: [{ path: "input.png", mimeType: "image/png", bytes: reference }],
    partialImages: 0,
    stream: true,
  })) as Record<string, any>;
  assert.equal(body.model, "chat-model");
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  // One image tool call only: a preview must never race a parallel tool call.
  assert.equal(body.parallel_tool_calls, false);
  // tool_choice only selects the built-in tool; the API defines no model field there.
  assert.deepEqual(body.tool_choice, { type: "image_generation" });
  assert.deepEqual(body.tools, [{ type: "image_generation", model: "gpt-image-2", action: "edit", size: "auto", quality: "auto", output_format: "png", partial_images: 0 }]);
  assert.equal(body.input[0].content[1].type, "input_image");
  assert.match(body.input[0].content[1].image_url, /^data:image\/png;base64,/);
  // References are sent at the provider's default detail level.
  assert.equal(body.input[0].content[1].detail, "auto");
  // Caller owns the lifetime: the Images fallback rebuilds the same references.
  assert.equal(reference.toString("latin1"), "reference-bytes");

  assert.equal(supportsResponsesTool("gpt-image-2"), true);
  assert.equal(supportsResponsesTool("dall-e-3"), false);
  // The top-level model is validated as a text model, so the failure names it.
  assert.throws(() => buildImageResponsesRequest({
    toolModel: "gpt-image-2",
    textModel: "  ",
    params: normalizeImageParams({ prompt: "x", action: "generate" }),
    references: [],
    partialImages: 0,
    stream: true,
  }), /textModel/);
  assert.throws(() => buildImageResponsesRequest({
    toolModel: "dall-e-3",
    textModel: "chat-model",
    params: normalizeImageParams({ prompt: "x", action: "generate" }),
    references: [],
    partialImages: 0,
    stream: true,
  }), /DALL-E/);
});

test("decodes Responses image_generation_call output items", () => {
  const done = decodeImageGenerationCall({ type: "image_generation_call", id: "ig_1", status: "completed", result: PNG, revised_prompt: "revised" });
  assert.equal(done?.ok, true);
  if (done?.ok) assert.equal(done.image.revisedPrompt, "revised");
  assert.equal(decodeImageGenerationCall({ type: "message" }), undefined);

  const empty = decodeImageGenerationCall({ type: "image_generation_call", status: "failed" });
  assert.equal(empty?.ok, false);
  if (empty && !empty.ok) assert.equal(empty.reason, "no-image");
});

test("parses non-streaming Responses payloads", () => {
  const ok = parseImageResponsesPayload({ output: [{ type: "message" }, { type: "image_generation_call", status: "completed", result: PNG }] });
  assert.equal(ok.ok, true);

  const empty = parseImageResponsesPayload({ output: [] });
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.reason, "no-image");

  const textOnly = parseImageResponsesPayload({ output: [{ type: "message" }] });
  assert.equal(textOnly.ok, false);
  if (!textOnly.ok) assert.equal(textOnly.reason, "no-image");

  const multiple = parseImageResponsesPayload({ output: [{ type: "image_generation_call", result: PNG }, { type: "image_generation_call", result: PNG }] });
  assert.equal(multiple.ok, false);
  if (!multiple.ok) assert.equal(multiple.reason, "malformed-response");

  const failed = parseImageResponsesPayload({ error: { message: "tool unsupported" } });
  assert.equal(failed.ok, false);
  if (!failed.ok) {
    assert.equal(failed.reason, "request-rejected");
    assert.match(failed.errorMessage, /tool unsupported/);
  }
});

test("clamps partial previews and passes the stream flag through", () => {
  const params = normalizeImageParams({ prompt: "a red square", action: "generate" });
  const body = (partialImages: number, stream: boolean) =>
    JSON.parse(buildImageResponsesRequest({ toolModel: "gpt-image-2", textModel: "chat-model", params, references: [], partialImages, stream })) as Record<string, any>;
  // The Responses tool accepts 0-3 previews; out-of-range values are clamped into that band.
  assert.equal(body(7, true).tools[0].partial_images, 3);
  assert.equal(body(-2, true).tools[0].partial_images, 0);
  assert.equal(body(2, true).tools[0].partial_images, 2);
  // A host that does not stream asks for one JSON response instead of SSE frames.
  assert.equal(body(0, false).stream, false);
});
