import test from "node:test";
import assert from "node:assert/strict";
import { SseLimitError, SseParser, parseSseText, readSseEvents } from "./sse.js";

function encodeChunks(chunks: string[]): Uint8Array[] {
  return chunks.map((chunk) => new TextEncoder().encode(chunk));
}

test("parses frames split across chunks with CRLF and keepalive comments", () => {
  const parser = new SseParser();
  const events = [
    ...parser.push(": keepalive\r\n\r\nevent: image_generation.completed\r\ndata: {\"type\":\"image_generation."),
    ...parser.push("completed\",\"b64_json\":\"AA==\"}\r\n\r\n"),
    ...parser.end(),
  ];
  assert.deepEqual(events, [{ event: "image_generation.completed", data: "{\"type\":\"image_generation.completed\",\"b64_json\":\"AA==\"}" }]);
});

test("joins multi-line data and defaults the event name to message", () => {
  assert.deepEqual(parseSseText("data: line one\ndata: line two\n\n"), [{ event: "message", data: "line one\nline two" }]);
  assert.deepEqual(parseSseText("event: only-name\n\n"), [{ event: "only-name", data: "" }]);
});

test("flushes a trailing frame without a blank line", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push("event: x\ndata: 1"), []);
  assert.deepEqual(parser.end(), [{ event: "x", data: "1" }]);
});

test("rejects payloads beyond the byte budget", async () => {
  const parser = new SseParser(8);
  assert.throws(() => parser.push("data: 0123456789"), SseLimitError);

  const oversized = readSseEvents(encodeChunks(["data: a\n\n", "data: b\n\n"]), 4);
  await assert.rejects(async () => { for await (const _event of oversized) { /* consume */ } }, SseLimitError);
});

test("reads frames from a chunk iterable and reports the final tail", async () => {
  const events: unknown[] = [];
  for await (const event of readSseEvents(encodeChunks(["event: a\ndata: 1\n", "\nevent: b\ndata: 2"]), 64)) events.push(event);
  assert.deepEqual(events, [{ event: "a", data: "1" }, { event: "b", data: "2" }]);
});
