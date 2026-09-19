import test from "node:test";
import assert from "node:assert/strict";
import { buildImageEditRequest, buildImageGenerationRequest, decodeGeneratedPng, normalizeImageParams, parseImageGenerationResponse } from "./protocol.js";
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
  });
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
