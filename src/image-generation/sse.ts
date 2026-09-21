/** Thrown when a streamed response exceeds the configured byte budget. */
export class SseLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SseLimitError";
  }
}

export type SseEvent = {
  readonly event: string;
  readonly data: string;
};

const DEFAULT_MAX_CHARS = 64 * 1024 * 1024;

/**
 * Incremental Server-Sent Events parser. Providers stream image results as
 * `event:`/`data:` frames, and a single frame can carry a full base64 image, so the
 * parser buffers whole frames and only rejects input that exceeds the byte budget.
 */
export class SseParser {
  private buffer = "";
  private event = "";
  private data: string[] = [];
  private readonly maxChars: number;

  constructor(maxChars = DEFAULT_MAX_CHARS) {
    this.maxChars = maxChars;
  }

  push(chunk: string): SseEvent[] {
    const events: SseEvent[] = [];
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      const event = this.consumeLine(line);
      if (event) events.push(event);
    }
    if (this.buffer.length > this.maxChars) throw new SseLimitError("Image provider stream exceeded the size limit.");
    return events;
  }

  end(): SseEvent[] {
    const events: SseEvent[] = [];
    if (this.buffer) {
      const line = this.buffer.replace(/\r$/, "");
      this.buffer = "";
      const event = this.consumeLine(line);
      if (event) events.push(event);
    }
    const flushed = this.dispatch();
    if (flushed) events.push(flushed);
    return events;
  }

  private consumeLine(line: string): SseEvent | undefined {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return undefined;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const rawValue = separator < 0 ? "" : line.slice(separator + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "event") this.event = value;
    else if (field === "data") this.data.push(value);
    return undefined;
  }

  private dispatch(): SseEvent | undefined {
    if (!this.event && this.data.length === 0) return undefined;
    const event: SseEvent = { event: this.event || "message", data: this.data.join("\n") };
    this.event = "";
    this.data = [];
    return event;
  }
}

/** Parses an already fully-buffered SSE payload, used when a gateway ignores `stream`. */
export function parseSseText(text: string, maxChars = DEFAULT_MAX_CHARS): SseEvent[] {
  const parser = new SseParser(maxChars);
  return [...parser.push(text), ...parser.end()];
}

/**
 * Reads SSE events from a response body. The caller owns abort/timeout handling:
 * aborting the fetch signal rejects the underlying read.
 */
export async function* readSseEvents(chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, maxBytes: number): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  const parser = new SseParser(maxBytes);
  let total = 0;
  for await (const chunk of chunks) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new SseLimitError("Image provider response exceeded the size limit.");
    for (const event of parser.push(decoder.decode(chunk, { stream: true }))) yield event;
  }
  const tail = decoder.decode();
  for (const event of [...(tail ? parser.push(tail) : []), ...parser.end()]) yield event;
}
