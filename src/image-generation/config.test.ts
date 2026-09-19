import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadImageConfig, _configTest } from "./config.js";

test("loads image config and preserves the selected routing/image model split", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-image-config-"));
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify({ enabled: true, model: "gateway/chat-model", imageModel: "image-2", userAgent: "test-client/1", defaultSize: "1024x1024" }));
  const loaded = loadImageConfig(file);
  assert.equal(loaded.valid, true);
  assert.equal(loaded.config.model, "gateway/chat-model");
  assert.equal(loaded.config.imageModel, "image-2");
  assert.equal(loaded.config.defaultSize, "1024x1024");
  rmSync(dir, { recursive: true, force: true });
});

test("invalid model and User-Agent values fail closed", () => {
  assert.equal(_configTest.validModelSpec("gateway/model"), true);
  assert.equal(_configTest.validModelSpec("not a model"), false);
  assert.equal(_configTest.validUserAgent("client/1"), true);
  assert.equal(_configTest.validUserAgent("bad\nvalue"), false);
});
