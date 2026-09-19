import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareReferenceImages } from "./references.js";
import { saveCanonicalImage, copyImageToExplicitPath } from "./artifacts.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

test("requires confirmation and clears reference buffers after rejection", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-image-ref-"));
  const file = join(root, "input.png");
  writeFileSync(file, PNG);
  await assert.rejects(() => prepareReferenceImages({ paths: [file], cwd: root, hasUI: true, confirm: async () => false }), /declined/);
  rmSync(root, { recursive: true, force: true });
});

test("writes canonical artifacts uniquely and never overwrites explicit output", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-image-artifact-"));
  const first = await saveCanonicalImage({ bytes: PNG, agentDir: root, sessionId: "s", imageCallId: "call" });
  const second = await saveCanonicalImage({ bytes: PNG, agentDir: root, sessionId: "s", imageCallId: "call" });
  assert.notEqual(first, second);
  const output = join(root, "out.png");
  writeFileSync(output, Buffer.from("old"));
  await assert.rejects(() => copyImageToExplicitPath(PNG, { path: output }));
  assert.deepEqual(readFileSync(output), Buffer.from("old"));
  rmSync(root, { recursive: true, force: true });
});
