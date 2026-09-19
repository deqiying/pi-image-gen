import { constants as fsConstants } from "node:fs";
import { link, mkdir, open, realpath, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { MAX_PATH_CHARS, ImageGenerationError, sanitizeDiagnostic } from "./types.js";

export type OutputPlan = { path: string };

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function safePart(value: string, fallback: string): string {
  const result = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "").slice(0, 120);
  return result || fallback;
}

async function resolveWriteTarget(candidate: string): Promise<string> {
  const suffix: string[] = [];
  let current = resolve(candidate);
  while (true) {
    try {
      const info = await stat(current);
      if (suffix.length > 0 && !info.isDirectory()) throw new ImageGenerationError("output-path-invalid", "Output parent is not a directory.");
      return resolve(await realpath(current), ...suffix);
    } catch (error) {
      if (error instanceof ImageGenerationError) throw error;
      if (typeof error === "object" && error && "code" in error && error.code !== "ENOENT") throw new ImageGenerationError("output-path-invalid", "Unable to inspect output path.");
      const parent = dirname(current);
      if (parent === current) throw new ImageGenerationError("output-path-invalid", "Unable to resolve output path.");
      suffix.unshift(basename(current));
      current = parent;
    }
  }
}

async function publishNoOverwrite(bytes: Uint8Array, target: string): Promise<void> {
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const temp = join(parent, `.${basename(target)}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temp, target);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temp).catch(() => undefined);
  }
}

export function getGeneratedImagesRoot(agentDir: string): string {
  return join(resolve(agentDir), "generated-images");
}

export async function prepareExplicitOutputPath(args: {
  rawPath?: string;
  cwd: string;
  agentDir: string;
  hasUI: boolean;
  confirm?: (title: string, message: string, options?: { signal?: AbortSignal }) => Promise<boolean>;
  signal?: AbortSignal;
}): Promise<OutputPlan | undefined> {
  if (args.rawPath === undefined) return undefined;
  const raw = args.rawPath.trim();
  if (!raw || raw.length > MAX_PATH_CHARS || extname(raw).toLowerCase() !== ".png") throw new ImageGenerationError("output-path-invalid", "outputPath must be a non-empty .png path.");
  const target = await resolveWriteTarget(isAbsolute(raw) ? raw : resolve(args.cwd, raw));
  if (await stat(target).catch(() => undefined)) throw new ImageGenerationError("output-path-invalid", "Output path already exists and will not be overwritten.");
  const agentRoot = resolve(args.agentDir);
  const projectRoot = resolve(args.cwd);
  if (inside(agentRoot, target) || inside(projectRoot, target)) return { path: target };
  if (!args.hasUI || !args.confirm) throw new ImageGenerationError("output-path-approval-required", "Writing outside safe roots requires interactive approval.");
  const approved = await args.confirm("Write generated image outside safe roots?", `The generated PNG will be copied to:\n\n${target}\n\nContinue?`, ...(args.signal ? [{ signal: args.signal }] : []));
  if (!approved) throw new ImageGenerationError("output-path-declined", "External output path was declined.");
  if (await stat(target).catch(() => undefined)) throw new ImageGenerationError("output-path-invalid", "Output path appeared after approval and will not be overwritten.");
  return { path: target };
}

export async function saveCanonicalImage(args: { bytes: Uint8Array; agentDir: string; sessionId: string; imageCallId: string }): Promise<string> {
  const directory = join(getGeneratedImagesRoot(args.agentDir), safePart(args.sessionId, "session"));
  const image = safePart(args.imageCallId, "image_generation");
  for (let index = 1; index <= 1000; index += 1) {
    const suffix = index === 1 ? "" : `-${index}`;
    const target = join(directory, `${image}${suffix}.png`);
    try { await publishNoOverwrite(args.bytes, target); return target; }
    catch (error) {
      if (typeof error === "object" && error && "code" in error && error.code === "EEXIST") continue;
      throw new ImageGenerationError("artifact-write-failed", sanitizeDiagnostic(error, "Failed to persist generated image."));
    }
  }
  throw new ImageGenerationError("artifact-write-failed", "Could not reserve a unique image artifact path.");
}

export async function copyImageToExplicitPath(bytes: Uint8Array, plan: OutputPlan): Promise<void> {
  const target = await resolveWriteTarget(plan.path);
  if (target !== plan.path) throw new ImageGenerationError("output-path-invalid", "Output path changed after approval.");
  await publishNoOverwrite(bytes, plan.path);
}

export const _artifactTest = { inside, resolveWriteTarget, publishNoOverwrite };
