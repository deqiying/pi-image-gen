import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  appendImageDebugRecord,
  buildImageDebugRecord,
  DEBUG_LOG_FILENAME,
  describeIdleCut,
  describeImageFailure,
  ImageRequestTrace,
  redactEndpoint,
  _diagnosticsTest,
} from "./diagnostics.js";
import { normalizeImageParams } from "./protocol.js";
import { sanitizeDiagnostic } from "./types.js";

const params = normalizeImageParams({ prompt: "x", action: "generate" });

test("sanitizeDiagnostic never renders a literal undefined for empty values", () => {
  assert.equal(sanitizeDiagnostic(undefined, "fallback message"), "fallback message");
  assert.equal(sanitizeDiagnostic(null, "fallback message"), "fallback message");
  assert.equal(sanitizeDiagnostic("   ", "fallback message"), "fallback message");
  assert.equal(sanitizeDiagnostic({}, "fallback message"), "fallback message");
  assert.equal(sanitizeDiagnostic(0, "fallback message"), "0");
  assert.equal(sanitizeDiagnostic("boom", "fallback message"), "boom");
  assert.equal(sanitizeDiagnostic({ message: "boom" }, "fallback message"), '{"message":"boom"}');
});

test("sanitizeDiagnostic describes errors with their code and cause", () => {
  const cause = new Error("socket closed");
  const error = new Error("fetch failed", { cause });
  (error as Error & { code?: string }).code = "ECONNRESET";
  const rendered = sanitizeDiagnostic(error, "fallback message");
  assert.match(rendered, /fetch failed/);
  assert.match(rendered, /code=ECONNRESET/);
  assert.match(rendered, /cause=socket closed/);
});

test("sanitizeDiagnostic redacts credentials and image payloads", () => {
  const dataUrl = `data:image/png;base64,${"A".repeat(160)}`;
  assert.equal(sanitizeDiagnostic(`failed for ${dataUrl}`, "fallback"), "failed for [REDACTED_IMAGE_DATA]");
  assert.match(sanitizeDiagnostic("Authorization: Bearer sk-abcdefgh1234", "fallback"), /redacted/i);
  assert.match(sanitizeDiagnostic("cookie=session-abc; account-id=abc", "fallback"), /REDACTED/);
});

test("the trace renders one diagnostic suffix with its timeline", () => {
  const trace = new ImageRequestTrace("responses", true, Date.now() - 30_000);
  trace.enterStage("sending");
  trace.markHeaders(400);
  trace.markEvent(false, 1_200);
  trace.noteBytes(2_048);
  trace.markEvent(true, 20_000);
  const suffix = trace.format();
  assert.match(suffix, /^\[streamed responses transport, 30\.0s elapsed/);
  assert.match(suffix, /headers 0\.4s/);
  assert.match(suffix, /first event 1\.2s/);
  assert.match(suffix, /2 event\(s\)/);
  assert.match(suffix, /1 partial preview\(s\)/);
  assert.match(suffix, /2\.0 KiB received/);
  assert.match(suffix, /silent for 10\.0s before ending/);
  assert.match(suffix, /ended by provider\]$/);
  assert.deepEqual(trace.snapshot().partials, 1);
});

test("the trace measures silence from the last activity, including bare response headers", () => {
  const silent = new ImageRequestTrace("responses", true, Date.now() - 40_000);
  silent.markHeaders(300);
  assert.ok(silent.snapshot().silentMs !== undefined);
  assert.ok((silent.snapshot().silentMs ?? 0) >= 39_000);
  assert.match(silent.format(), /silent for 39\./);
});

test("the trace names who ended the request", () => {
  const timedOut = new ImageRequestTrace("images", false, Date.now() - 1_000);
  timedOut.markTimeout();
  assert.match(timedOut.format(), /non-streamed images transport/);
  assert.match(timedOut.format(), /ended by plugin timeout\]$/);

  const aborted = new ImageRequestTrace("responses", true, Date.now() - 1_000);
  aborted.markAbort();
  assert.match(aborted.format(), /ended by caller cancellation\]$/);
});

test("describeIdleCut explains a long silent gap as an intermediate idle timeout", () => {
  const cut = new ImageRequestTrace("responses", true, Date.now() - 40_000);
  cut.markHeaders(500);
  cut.markEvent(true, 1_000);
  const hint = describeIdleCut(cut);
  assert.ok(hint !== undefined);
  assert.match(hint, /proxy_read_timeout/);
  assert.match(hint, /still have completed and billed/);

  const message = describeImageFailure("Image provider stream ended without an image result.", cut);
  assert.match(message, /Image provider stream ended without an image result\. \[/);
  assert.match(message, /proxy_read_timeout/);
});

test("describeIdleCut stays quiet for short gaps and for our own endings", () => {
  const quick = new ImageRequestTrace("responses", true, Date.now() - 3_000);
  quick.markHeaders(100);
  quick.markEvent(false, 900);
  assert.equal(describeIdleCut(quick), undefined);
  assert.equal(describeImageFailure("base", quick), `base ${quick.format()}`);

  const timedOut = new ImageRequestTrace("responses", true, Date.now() - 300_000);
  timedOut.markHeaders(400);
  timedOut.markTimeout();
  assert.equal(describeIdleCut(timedOut), undefined);

  const aborted = new ImageRequestTrace("responses", true, Date.now() - 300_000);
  aborted.markHeaders(400);
  aborted.markAbort();
  assert.equal(describeIdleCut(aborted), undefined);
});

test("describeIdleCut calls out a request that never received response headers", () => {
  const stuck = new ImageRequestTrace("responses", true, Date.now() - 31_000);
  const hint = describeIdleCut(stuck);
  assert.ok(hint !== undefined);
  assert.match(hint, /No response header arrived within 31\.0s/);
  assert.match(hint, /may still be generating and billing/);
});

test("buildImageDebugRecord captures metadata only", () => {
  const trace = new ImageRequestTrace("responses", true, Date.now() - 12_000);
  trace.markHeaders(300);
  trace.markEvent(true, 5_000);
  trace.noteBytes(1_024);
  const record = buildImageDebugRecord({
    trace,
    endpoint: "https://gateway/v1/responses?api-key=secret",
    provider: "gateway",
    api: "openai-responses",
    textModel: "chat",
    bindingReason: "matched-provider",
    imageModel: "gpt-image-2",
    params,
    referenceCount: 0,
    partialImages: 2,
    result: { outcome: "failure", reason: "no-image", status: 200, truncated: true, message: "stream ended" },
  });
  assert.equal(record.event, "image_request");
  assert.equal(record.endpoint, "https://gateway/v1/responses");
  assert.equal(record.partialImages, 2);
  assert.deepEqual(record.model, { text: "chat", image: "gpt-image-2" });
  assert.equal(record.bindingReason, "matched-provider");
  assert.deepEqual(record.request, { action: "generate", size: "auto", quality: "auto", referenceCount: 0 });
  assert.equal(record.result.truncated, true);
  assert.equal(record.traffic.partials, 1);
  assert.equal(record.flags.timedOut, false);
  assert.ok(JSON.stringify(record).includes("secret") === false);
});

test("appendImageDebugRecord appends one JSONL line per request", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-image-debug-"));
  try {
    const trace = new ImageRequestTrace("images", true, Date.now());
    const record = buildImageDebugRecord({
      trace,
      endpoint: "https://gateway/v1/images/generations",
      provider: "gateway",
      api: "openai-responses",
      textModel: "chat",
      bindingReason: "current-provider",
      imageModel: "gpt-image-2",
      params,
      referenceCount: 0,
      partialImages: 1,
      result: { outcome: "ok", status: 200 },
    });
    assert.equal(appendImageDebugRecord(dir, record), undefined);
    assert.equal(appendImageDebugRecord(dir, record), undefined);
    const lines = readFileSync(join(dir, DEBUG_LOG_FILENAME), "utf8").trimEnd().split("\n");
    assert.equal(lines.length, 2);
    assert.equal((JSON.parse(lines[0]!) as { event: string }).event, "image_request");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendImageDebugRecord reports a write failure instead of throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-image-debug-missing-"));
  rmSync(dir, { recursive: true, force: true });
  const trace = new ImageRequestTrace("images", true, Date.now());
  const record = buildImageDebugRecord({
    trace,
    endpoint: "https://gateway/v1/images/generations",
    provider: "gateway",
    api: "openai-responses",
    textModel: "chat",
    bindingReason: "current-provider",
    imageModel: "gpt-image-2",
    params,
    referenceCount: 0,
    partialImages: 1,
    result: { outcome: "ok", status: 200 },
  });
  const warning = appendImageDebugRecord(dir, record);
  assert.ok(warning !== undefined);
  assert.notEqual(warning, "undefined");
});

test("redactEndpoint drops credentials, query strings and fragments", () => {
  assert.equal(redactEndpoint("https://user:pass@gateway/v1/responses?a=1#b"), "https://gateway/v1/responses");
  assert.equal(redactEndpoint("not a url?token=secret"), "not a url");
  assert.equal(_diagnosticsTest.formatBytes(0), "0 B");
  assert.equal(_diagnosticsTest.formatBytes(512), "512 B");
  assert.equal(_diagnosticsTest.formatBytes(1_536), "1.5 KiB");
  assert.equal(_diagnosticsTest.formatBytes(48 * 1024 * 1024), "48 MiB");
  assert.equal(_diagnosticsTest.formatSeconds(1_234), "1.2s");
});

test("the trace remembers the longest silent gap, not only the trailing one", () => {
  const trace = new ImageRequestTrace("responses", true, Date.now() - 40_000);
  trace.markHeaders(100);
  trace.markEvent(false, 500);
  // A 35s mid-stream gap that the trailing silence would otherwise hide.
  trace.markEvent(true, 36_000);
  const snapshot = trace.snapshot();
  assert.ok(snapshot.maxSilentMs >= 35_000, `maxSilentMs was ${snapshot.maxSilentMs}`);
  assert.ok((snapshot.silentMs ?? 0) < 5_000, `silentMs was ${snapshot.silentMs}`);
  assert.equal(trace.format().includes("silent for 4.0s before ending"), true);
});
