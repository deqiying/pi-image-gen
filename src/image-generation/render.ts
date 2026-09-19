import { readFileSync, realpathSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Container, Image, Spacer, Text } from "@earendil-works/pi-tui";
import { getGeneratedImagesRoot } from "./artifacts.js";
import { isValidPng, readPngDimensions } from "./protocol.js";
import { IMAGE_MIME_TYPE, MAX_GENERATED_BYTES, isImageGenerationDetails } from "./types.js";

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep));
}

export function renderImageGenerationResult(result: any, _options: any, theme: any, context: any): any {
  const text = Array.isArray(result?.content) ? result.content.filter((item: any) => item?.type === "text").map((item: any) => item.text).join("\n").trim() : "Image generation finished.";
  const container = new Container();
  const color = (role: string, value: string) => typeof theme?.fg === "function" ? theme.fg(role, value) : value;
  container.addChild(new Text(color("toolOutput", text || "Image generation finished."), 0, 0));
  const details = result?.details;
  if (context?.isError || context?.isPartial || !isImageGenerationDetails(details)) return container;
  const artifact = resolve(details.artifactPath);
  let root: string;
  let realArtifact: string;
  let info: ReturnType<typeof statSync>;
  try {
    root = realpathSync(getGeneratedImagesRoot(getAgentDir()));
    realArtifact = realpathSync(artifact);
    info = statSync(realArtifact);
  } catch {
    container.addChild(new Text(color("muted", "Image preview unavailable: saved artifact is missing."), 0, 0));
    return container;
  }
  if (!inside(root, realArtifact) || !info.isFile() || info.size <= 0 || info.size > MAX_GENERATED_BYTES) {
    container.addChild(new Text(color("muted", "Image preview unavailable: artifact path is not safe."), 0, 0));
    return container;
  }
  let bytes: Buffer;
  try { bytes = readFileSync(realArtifact); }
  catch { container.addChild(new Text(color("muted", "Image preview unavailable: artifact could not be read."), 0, 0)); return container; }
  if (bytes.length !== info.size || !isValidPng(bytes) || !readPngDimensions(bytes)) {
    bytes.fill(0);
    container.addChild(new Text(color("muted", "Image preview unavailable: artifact is not a valid PNG."), 0, 0));
    return container;
  }
  const base64 = bytes.toString("base64");
  bytes.fill(0);
  container.addChild(new Spacer(1));
  container.addChild(new Image(base64, IMAGE_MIME_TYPE, { fallbackColor: (value: string) => color("toolOutput", value) }, { maxWidthCells: 60, filename: realArtifact }));
  return container;
}

export const _renderTest = { inside };
