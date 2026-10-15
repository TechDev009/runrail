import type { NativeTool } from "@nifrajs/coding-agent"
import { MAX_IMAGE_PROMPT } from "./generate.ts"
import type { ImageService } from "./service.ts"

/** The image tool, described once for every route: Runrail's own loop, Codex, and Claude Code. */

export interface ImageToolSpec {
  readonly name: string
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>
}

export const IMAGE_TOOL_SPECS: readonly ImageToolSpec[] = Object.freeze([
  {
    name: "image_generate",
    description:
      "Make a picture with the image model the person chose from their own connections, and save it in the workspace. With `from`, change an existing picture instead. Each call is billed to the person's account, so use it only when they asked for a picture or agreed to one.",
    inputSchema: Object.freeze({
      type: "object",
      properties: {
        prompt: { type: "string", maxLength: MAX_IMAGE_PROMPT, description: "What the picture shows, in detail: subject, style, colors, text in it." },
        path: { type: "string", maxLength: 1_024, description: "Where to save it in the workspace, ending in .png, .jpg, or .webp, for example public/hero.png." },
        shape: { type: "string", enum: ["square", "landscape", "portrait"], description: "Square if left out. Some models choose their own shape." },
        from: { type: "string", maxLength: 1_024, description: "A PNG, JPEG, or WebP in the workspace to change, up to 10 MB." },
      },
      required: ["prompt", "path"],
      additionalProperties: false,
    }),
  },
])

/** Runrail's own loop reads tool results as text, so the picture is described, not shown. */
export function createImageTools(service: ImageService): readonly NativeTool[] {
  return IMAGE_TOOL_SPECS.map((spec) => ({
    name: spec.name,
    description: spec.description,
    // Writes a file, so plan mode leaves it out.
    capabilities: ["image.generate"],
    requiresApproval: false,
    execute: async (input: unknown, context: { readonly signal: AbortSignal }) => (await service.request(input, context.signal)).text,
  }))
}
