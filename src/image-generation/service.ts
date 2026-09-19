import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadImageConfig } from "./config.js";
import { requestGeneratedImage } from "./client.js";
import { prepareExplicitOutputPath, saveCanonicalImage, copyImageToExplicitPath } from "./artifacts.js";
import { clearPreparedReferences, prepareReferenceImages } from "./references.js";
import { normalizeImageParams, validateImageRequest } from "./protocol.js";
import { resolveImageRuntime } from "./runtime.js";
import { IMAGE_MIME_TYPE, ImageGenerationError, sanitizeDiagnostic, type ImageGenerationContext, type ImageGenerationResult, type ImageToolParams } from "./types.js";

export type ImageExecutionDependencies = {
  loadConfig: typeof loadImageConfig;
  resolveRuntime: typeof resolveImageRuntime;
  requestImage: typeof requestGeneratedImage;
  agentDir: typeof getAgentDir;
};

const DEFAULT_DEPS: ImageExecutionDependencies = {
  loadConfig: loadImageConfig,
  resolveRuntime: resolveImageRuntime,
  requestImage: requestGeneratedImage,
  agentDir: getAgentDir,
};

function getSessionId(ctx: ImageGenerationContext): string {
  try { return ctx.sessionManager.getSessionId(); } catch { return "session"; }
}

export async function executeImageGeneration(args: {
  params: ImageToolParams;
  toolCallId: string;
  signal?: AbortSignal;
  ctx: ImageGenerationContext;
  deps?: Partial<ImageExecutionDependencies>;
}): Promise<ImageGenerationResult> {
  const deps = { ...DEFAULT_DEPS, ...(args.deps ?? {}) };
  const loaded = deps.loadConfig();
  if (!loaded.valid) throw new ImageGenerationError("config", loaded.warnings[0] ?? "Image generation configuration is invalid.");
  if (!loaded.config.enabled) throw new ImageGenerationError("config", "Image generation is disabled. Set enabled to true in the plugin configuration.");
  const params = normalizeImageParams(args.params as unknown as Record<string, unknown>, { size: loaded.config.defaultSize, quality: loaded.config.defaultQuality });
  const imageModel = loaded.config.imageModel?.trim();
  if (!imageModel) throw new ImageGenerationError("config", "Direct Images API requests require imageModel in the plugin configuration.");
  validateImageRequest(imageModel, params);
  const runtime = await deps.resolveRuntime(args.ctx, loaded.config);
  const confirm = args.ctx.hasUI ? async (title: string, message: string, options?: { signal?: AbortSignal }) => args.ctx.ui.confirm(title, message, options) : undefined;
  const outputPlan = await prepareExplicitOutputPath({ cwd: args.ctx.cwd, agentDir: deps.agentDir(), hasUI: args.ctx.hasUI, ...(params.outputPath ? { rawPath: params.outputPath } : {}), ...(confirm ? { confirm } : {}), ...(args.signal ? { signal: args.signal } : {}) });
  const references = params.action === "edit"
    ? await prepareReferenceImages({ paths: params.referenceImagePaths, cwd: args.ctx.cwd, hasUI: args.ctx.hasUI, ...(confirm ? { confirm } : {}), ...(args.signal ? { signal: args.signal } : {}) })
    : [];
  let generated: Buffer | undefined;
  try {
    if (args.signal?.aborted) throw new ImageGenerationError("aborted", "Image generation was cancelled.");
    const response = await deps.requestImage({ runtime, imageModel, params, references, ...(loaded.config.userAgent ? { userAgent: loaded.config.userAgent } : {}), ...(args.signal ? { signal: args.signal } : {}) });
    if (!response.ok) throw new ImageGenerationError(response.reason === "no-image" ? "no-image" : response.reason, response.errorMessage);
    generated = response.image.bytes;
    const artifactPath = await saveCanonicalImage({ bytes: generated, agentDir: deps.agentDir(), sessionId: getSessionId(args.ctx), imageCallId: args.toolCallId });
    let outputPath: string | undefined;
    if (outputPlan) {
      try { await copyImageToExplicitPath(generated, outputPlan); outputPath = outputPlan.path; }
      catch (error) { throw new ImageGenerationError("artifact-write-failed", `Canonical artifact was saved, but outputPath failed: ${sanitizeDiagnostic(error, "copy failed")}`); }
    }
    const details = {
      artifactPath,
      ...(outputPath ? { outputPath } : {}),
      providerModel: `${runtime.provider}/${runtime.providerModel}`,
      imageModel,
      imageCallId: args.toolCallId,
      mimeType: IMAGE_MIME_TYPE,
      byteCount: generated.length,
      width: response.image.width,
      height: response.image.height,
      action: params.action,
      referenceCount: references.length,
      ...(response.image.revisedPrompt ? { revisedPrompt: response.image.revisedPrompt } : {}),
    };
    const lines = [
      `${params.action === "edit" ? "Edited" : "Generated"} PNG image (${details.width}x${details.height}).`,
      `Artifact: ${details.artifactPath}`,
      ...(details.outputPath ? [`Copied to: ${details.outputPath}`] : []),
    ];
    return { details, text: lines.join("\n") };
  } finally {
    clearPreparedReferences(references);
    generated?.fill(0);
  }
}
