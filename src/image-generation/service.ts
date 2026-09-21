import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadImageConfig } from "./config.js";
import { requestGeneratedImage } from "./client.js";
import { appendImageDebugRecord, type ImageDebugRecord, type ImageProgressEvent } from "./diagnostics.js";
import { prepareExplicitOutputPath, saveCanonicalImage, copyImageToExplicitPath } from "./artifacts.js";
import { clearPreparedReferences, prepareReferenceImages } from "./references.js";
import { normalizeImageParams, validateImageRequest } from "./protocol.js";
import { resolveImageRuntime } from "./runtime.js";
import { IMAGE_MIME_TYPE, ImageGenerationError, sanitizeDiagnostic, type ActiveImageTransport, type ImageGenerationContext, type ImageGenerationResult, type ImageGenerationRuntime, type ImageToolParams } from "./types.js";

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

/** Model a given transport runs on: the Responses path declares toolModel when it is set. */
function effectiveImageModel(runtime: ImageGenerationRuntime, imageModel: string, transport: ActiveImageTransport): string {
  return transport === "responses" ? runtime.toolModel ?? imageModel : imageModel;
}

export async function executeImageGeneration(args: {
  params: ImageToolParams;
  toolCallId: string;
  signal?: AbortSignal;
  ctx: ImageGenerationContext;
  /** Reports partial previews so the caller can stream progress to the user. */
  onProgress?: (event: ImageProgressEvent) => void;
  deps?: Partial<ImageExecutionDependencies>;
}): Promise<ImageGenerationResult> {
  const deps = { ...DEFAULT_DEPS, ...(args.deps ?? {}) };
  const loaded = deps.loadConfig();
  if (!loaded.valid) throw new ImageGenerationError("config", loaded.warnings[0] ?? "Image generation configuration is invalid.");
  if (!loaded.config.enabled) throw new ImageGenerationError("config", "Image generation is disabled. Set enabled to true in the plugin configuration.");
  const params = normalizeImageParams(args.params as unknown as Record<string, unknown>, { size: loaded.config.defaultSize, quality: loaded.config.defaultQuality });
  const imageModel = loaded.config.imageModel?.trim();
  if (!imageModel) throw new ImageGenerationError("config", "Direct Images API requests require imageModel in the plugin configuration.");
  const runtime = await deps.resolveRuntime(args.ctx, loaded.config);
  // Validate the model the primary transport actually sends: the Responses path runs on
  // toolModel and would otherwise inherit DALL-E-only restrictions from imageModel.
  validateImageRequest(effectiveImageModel(runtime, imageModel, runtime.transport), params);
  // The debug log is best effort: a write failure must never lose an already paid result.
  let debugWarning: string | undefined;
  const onDebug = loaded.config.debug
    ? (record: ImageDebugRecord) => { debugWarning = appendImageDebugRecord(deps.agentDir(), record); }
    : undefined;
  const confirm = args.ctx.hasUI ? async (title: string, message: string, options?: { signal?: AbortSignal }) => args.ctx.ui.confirm(title, message, options) : undefined;
  const outputPlan = await prepareExplicitOutputPath({ cwd: args.ctx.cwd, agentDir: deps.agentDir(), hasUI: args.ctx.hasUI, ...(params.outputPath ? { rawPath: params.outputPath } : {}), ...(confirm ? { confirm } : {}), ...(args.signal ? { signal: args.signal } : {}) });
  const references = params.action === "edit"
    ? await prepareReferenceImages({ paths: params.referenceImagePaths, cwd: args.ctx.cwd, hasUI: args.ctx.hasUI, ...(confirm ? { confirm } : {}), ...(args.signal ? { signal: args.signal } : {}) })
    : [];
  let generated: Buffer | undefined;
  try {
    if (args.signal?.aborted) throw new ImageGenerationError("aborted", "Image generation was cancelled.");
    const response = await deps.requestImage({
      runtime,
      imageModel,
      params,
      references,
      ...(loaded.config.userAgent ? { userAgent: loaded.config.userAgent } : {}),
      ...(args.signal ? { signal: args.signal } : {}),
      ...(args.onProgress ? { onProgress: args.onProgress } : {}),
      ...(onDebug ? { onDebug } : {}),
    });
    if (!response.ok) {
      const failureMessage = debugWarning ? `${response.errorMessage} Debug log unavailable: ${debugWarning}` : response.errorMessage;
      throw new ImageGenerationError(response.reason === "no-image" ? "no-image" : response.reason, failureMessage);
    }
    // Report the model that actually produced the image, not the Images-API default.
    const usedImageModel = effectiveImageModel(runtime, imageModel, response.transport);
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
      imageModel: usedImageModel,
      imageCallId: args.toolCallId,
      mimeType: IMAGE_MIME_TYPE,
      byteCount: generated.length,
      width: response.image.width,
      height: response.image.height,
      action: params.action,
      referenceCount: references.length,
      transport: response.transport,
      ...(response.image.revisedPrompt ? { revisedPrompt: response.image.revisedPrompt } : {}),
    };
    const lines = [
      `${params.action === "edit" ? "Edited" : "Generated"} PNG image (${details.width}x${details.height}).`,
      `Artifact: ${details.artifactPath}`,
      ...(details.outputPath ? [`Copied to: ${details.outputPath}`] : []),
      ...(debugWarning ? [`Debug log unavailable: ${debugWarning}`] : []),
    ];
    return { details, text: lines.join("\n") };
  } finally {
    clearPreparedReferences(references);
    generated?.fill(0);
  }
}
