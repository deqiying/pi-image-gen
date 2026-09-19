import { open, realpath } from "node:fs/promises";
import { isAbsolute, resolve, relative, sep } from "node:path";
import { detectReferenceImageMimeType } from "./references-mime.js";
import { MAX_REFERENCE_BYTES, MAX_REFERENCE_COUNT, MAX_TOTAL_REFERENCE_BYTES, ImageGenerationError, type PreparedReferenceImage } from "./types.js";

export type ReferenceConfirm = (title: string, message: string, options?: { signal?: AbortSignal }) => Promise<boolean>;

function displayPath(path: string, cwd: string): string {
  const rel = relative(cwd, path);
  return rel && !rel.startsWith(`..${sep}`) && rel !== ".." ? rel : path;
}

export function clearPreparedReferences(references: readonly PreparedReferenceImage[]): void {
  for (const reference of references) reference.bytes.fill(0);
}

export async function prepareReferenceImages(args: {
  paths: readonly string[];
  cwd: string;
  hasUI: boolean;
  confirm?: ReferenceConfirm;
  signal?: AbortSignal;
}): Promise<PreparedReferenceImage[]> {
  if (args.paths.length === 0) return [];
  if (args.paths.length > MAX_REFERENCE_COUNT) throw new ImageGenerationError("reference-input-invalid", `At most ${MAX_REFERENCE_COUNT} reference images are supported.`);
  if (!args.hasUI || !args.confirm) throw new ImageGenerationError("reference-upload-approval-required", "Reference-image upload requires interactive approval.");
  const prepared: PreparedReferenceImage[] = [];
  let total = 0;
  const seen = new Set<string>();
  try {
    for (const rawPath of args.paths) {
      if (args.signal?.aborted) throw new ImageGenerationError("aborted", "Image generation was cancelled.");
      const candidate = isAbsolute(rawPath) ? resolve(rawPath) : resolve(args.cwd, rawPath);
      let path: string;
      try { path = await realpath(candidate); } catch { throw new ImageGenerationError("reference-input-invalid", `Reference image is not accessible: ${displayPath(candidate, args.cwd)}`); }
      if (seen.has(path)) continue;
      const handle = await open(path, "r").catch(() => undefined);
      if (!handle) throw new ImageGenerationError("reference-input-invalid", `Reference image is not accessible: ${displayPath(path, args.cwd)}`);
      let bytes: Buffer | undefined;
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size <= 0 || info.size > MAX_REFERENCE_BYTES) throw new ImageGenerationError("reference-input-invalid", `Reference image must be a regular file no larger than 20 MiB: ${displayPath(path, args.cwd)}`);
        total += info.size;
        if (total > MAX_TOTAL_REFERENCE_BYTES) throw new ImageGenerationError("reference-input-invalid", "Reference images exceed the 50 MiB total limit.");
        bytes = Buffer.alloc(info.size);
        let offset = 0;
        while (offset < bytes.length) {
          if (args.signal?.aborted) throw new ImageGenerationError("aborted", "Image generation was cancelled.");
          const part = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (part.bytesRead === 0) break;
          offset += part.bytesRead;
        }
        const after = await handle.stat();
        if (offset !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new ImageGenerationError("reference-input-invalid", `Reference image changed while being read: ${displayPath(path, args.cwd)}`);
      } catch (error) {
        bytes?.fill(0);
        throw error;
      } finally { await handle.close().catch(() => undefined); }
      if (!bytes) throw new ImageGenerationError("reference-input-invalid", "Reference image could not be read.");
      const mimeType = detectReferenceImageMimeType(bytes);
      if (!mimeType) { bytes.fill(0); throw new ImageGenerationError("reference-input-invalid", `Reference image must be PNG, JPEG, or WebP: ${displayPath(path, args.cwd)}`); }
      seen.add(path);
      prepared.push({ path, mimeType, bytes });
    }
    const approved = await args.confirm("Upload reference images?", `The following explicit local files will be uploaded for paid image editing:\n\n${prepared.map((item) => `- ${displayPath(item.path, args.cwd)} (${item.bytes.length} bytes)`).join("\n")}\n\nContinue?`, ...(args.signal ? [{ signal: args.signal }] : []));
    if (args.signal?.aborted) throw new ImageGenerationError("aborted", "Image generation was cancelled.");
    if (!approved) throw new ImageGenerationError("reference-upload-declined", "Reference-image upload was declined.");
    return prepared;
  } catch (error) {
    clearPreparedReferences(prepared);
    throw error;
  }
}
