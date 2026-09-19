import { readPngDimensions } from "./protocol.js";

export function detectReferenceImageMimeType(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | undefined {
  if (readPngDimensions(bytes)) return "image/png";
  const value = Buffer.from(bytes);
  if (value.length >= 4 && value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff && value.lastIndexOf(Buffer.from([0xff, 0xd9])) >= 3) return "image/jpeg";
  if (value.length >= 20 && value.toString("ascii", 0, 4) === "RIFF" && value.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return undefined;
}
