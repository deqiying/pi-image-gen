import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { executeImageGeneration } from "./image-generation/service.js";
import { renderImageGenerationResult } from "./image-generation/render.js";
import { IMAGE_ACTIONS, IMAGE_QUALITIES, IMAGE_SIZES, IMAGE_TOOL_NAME, MAX_PATH_CHARS, MAX_PROMPT_CHARS, MAX_REFERENCE_COUNT, ImageGenerationError, sanitizeDiagnostic, type ImageToolParams } from "./image-generation/types.js";

const registered = new WeakSet<object>();

export const ImageGenerationParameters = Type.Object({
  prompt: Type.String({ minLength: 1, maxLength: MAX_PROMPT_CHARS, description: "The faithful image generation or editing prompt." }),
  action: StringEnum(IMAGE_ACTIONS, { description: "generate for text-to-image or edit for explicit local reference images." }),
  referenceImagePaths: Type.Optional(Type.Union([
    Type.Null(),
    Type.Array(Type.String({ minLength: 1, maxLength: MAX_PATH_CHARS }), { minItems: 1, maxItems: MAX_REFERENCE_COUNT }),
  ], { description: "Explicit local image paths. Required for edit and never inferred." })),
  size: Type.Optional(StringEnum(IMAGE_SIZES, { description: "Requested PNG size." })),
  quality: Type.Optional(StringEnum(IMAGE_QUALITIES, { description: "Requested image quality." })),
  outputPath: Type.Optional(Type.Union([Type.Null(), Type.String({ minLength: 1, maxLength: MAX_PATH_CHARS })], { description: "Optional explicit .png destination." })),
}, { additionalProperties: false });

function syncActiveTool(pi: ExtensionAPI): void {
  const candidate = pi as ExtensionAPI & { getActiveTools?: () => string[]; setActiveTools?: (names: string[]) => void };
  if (!candidate.getActiveTools || !candidate.setActiveTools) return;
  const active = candidate.getActiveTools();
  if (!active.includes(IMAGE_TOOL_NAME)) candidate.setActiveTools([...active, IMAGE_TOOL_NAME]);
}

export function registerImageGenerationExtension(pi: ExtensionAPI): void {
  if (registered.has(pi as object)) return;
  registered.add(pi as object);
  (pi.registerTool as unknown as (definition: unknown) => void)({
    name: IMAGE_TOOL_NAME,
    label: "Image generation",
    description: "Generate a PNG image or edit it using explicitly approved local reference images through a configured Codex Responses image_generation model.",
    promptSnippet: "Generate or edit an image with image_gen when the user explicitly requests it.",
    promptGuidelines: [
      "Use image_gen only for an explicit image generation or editing request because the provider operation may incur charges.",
      "Use action generate for text-to-image and action edit only when the user explicitly provided local reference image paths.",
      "Never invent reference paths or output paths. image_variation is not supported.",
    ],
    parameters: ImageGenerationParameters,
    executionMode: "sequential",
    async execute(toolCallId: string, params: ImageToolParams, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      try {
        const result = await executeImageGeneration({ params, toolCallId, ...(signal ? { signal } : {}), ctx: ctx as never });
        return { content: [{ type: "text", text: result.text }], details: result.details };
      } catch (error) {
        if (error instanceof ImageGenerationError) throw new Error(error.message);
        throw new Error(sanitizeDiagnostic(error, "Image generation failed."));
      }
    },
    renderResult: renderImageGenerationResult,
  });
  pi.on("session_start", (_event, _ctx) => { syncActiveTool(pi); });
  pi.on("before_agent_start", (_event, _ctx) => { syncActiveTool(pi); });
}

export default function imageGenerationExtension(pi: ExtensionAPI): void {
  registerImageGenerationExtension(pi);
}

export const _extensionTest = { syncActiveTool };
