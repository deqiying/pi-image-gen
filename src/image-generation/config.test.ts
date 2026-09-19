import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG_PATH, LEGACY_CONFIG_PATH, loadImageConfig, _configTest } from "./config.js";

test("loads image config and preserves the provider binding/image model split", () => {
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

test("uses the shared config path and falls back to the legacy pi-agent path", () => {
  assert.equal(DEFAULT_CONFIG_PATH, join(homedir(), ".config", "pi-image-gen", "config.json"));
  assert.match(LEGACY_CONFIG_PATH, /[\\/]\.pi[\\/]agent[\\/]extensions[\\/]pi-image-gen[\\/]config\.json$/);

  const dir = mkdtempSync(join(tmpdir(), "pi-image-config-fallback-"));
  const primary = join(dir, "primary.json");
  const legacy = join(dir, "legacy.json");
  try {
    writeFileSync(legacy, JSON.stringify({ enabled: true, model: "legacy/model" }));
    const fallback = loadImageConfig(primary, legacy);
    assert.equal(fallback.source, legacy);
    assert.equal(fallback.config.model, "legacy/model");

    writeFileSync(primary, JSON.stringify({ enabled: true, model: "primary/model" }));
    const preferred = loadImageConfig(primary, legacy);
    assert.equal(preferred.source, primary);
    assert.equal(preferred.config.model, "primary/model");

    writeFileSync(primary, "{");
    const invalidPrimary = loadImageConfig(primary, legacy);
    assert.equal(invalidPrimary.source, primary);
    assert.equal(invalidPrimary.valid, false);
    assert.equal(invalidPrimary.config.enabled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uses disabled defaults when neither config path exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-image-config-missing-"));
  try {
    const loaded = loadImageConfig(join(dir, "primary.json"), join(dir, "legacy.json"));
    assert.equal(loaded.source, undefined);
    assert.equal(loaded.valid, true);
    assert.equal(loaded.config.enabled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid model and User-Agent values fail closed", () => {
  assert.equal(_configTest.validModelSpec("gateway/model"), true);
  assert.equal(_configTest.validModelSpec("not a model"), false);
  assert.equal(_configTest.validUserAgent("client/1"), true);
  assert.equal(_configTest.validUserAgent("bad\nvalue"), false);
});
