import test from "node:test";
import assert from "node:assert/strict";
import { buildImageGenerationRequest, decodeGeneratedPng, normalizeImageParams, parseImageGenerationResponse } from "./protocol.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("builds generate and edit payloads with the image_gen wire shape", () => {
  const generate = normalizeImageParams({ prompt: "a red square", action: "generate" });
  const generateBody = buildImageGenerationRequest({ routingModel: "chat-model", imageModel: "image-2", params: generate, references: [] });
  assert.equal(generateBody.model, "chat-model");
  assert.equal(generateBody.tools[0]?.type, "image_generation");
  assert.equal(generateBody.tools[0]?.model, "image-2");
  assert.equal(generateBody.tools[0]?.action, "generate");
  assert.deepEqual(generateBody.tool_choice, { type: "image_generation" });

  const edit = normalizeImageParams({ prompt: "remove the logo", action: "edit", referenceImagePaths: ["input.png"] });
  const editBody = buildImageGenerationRequest({
    routingModel: "chat-model",
    imageModel: "image-2",
    params: edit,
    references: [{ path: "input.png", mimeType: "image/png", bytes: Buffer.from("png") }],
  });
  assert.equal(editBody.tools[0]?.action, "edit");
  assert.equal(editBody.input[0]?.content[1]?.type, "input_image");
});

test("rejects image variation and edit without references", () => {
  assert.throws(() => normalizeImageParams({ prompt: "x", action: "variation" }), /image_variation is not supported/);
  assert.throws(() => normalizeImageParams({ prompt: "x", action: "edit" }), /edit requires/);
});

test("parses a completed image_generation_call", () => {
  const decoded = decodeGeneratedPng(PNG);
  assert.equal(decoded.ok, true);
  const result = parseImageGenerationResponse({ id: "resp_1", status: "completed", output: [{ type: "image_generation_call", id: "call_1", status: "completed", result: PNG }] });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.image.imageCallId, "call_1");
    assert.equal(result.image.width, 1);
    assert.equal(result.image.height, 1);
  }
});
