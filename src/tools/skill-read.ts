import type { NativeTool } from "@nifrajs/coding-agent"
import type { SkillRegistry } from "../skills/registry.ts"

/**
 * Loads an installed skill on demand. The project context lists skills by id and description
 * only, so a skill's instructions reach the model when it asks for them. Excluded skills are not
 * readable. A skill's own reference files are read through the same tool because a skill kept
 * outside the workspace is out of reach of `read_file`.
 */
export function createSkillReadTool(registry: SkillRegistry): NativeTool {
  return {
    name: "skill_read",
    description: "Load the full instructions of an installed skill by its id, or one of that skill's own reference files with `file`.",
    capabilities: ["read"],
    execute: async (input) => {
      const { id, file } = parseInput(input)
      if (file !== undefined) return { id, file, content: await registry.readFile(id, file) }
      const skill = registry.read(id)
      const files = await registry.files(id)
      return {
        id: skill.id,
        name: skill.name,
        ...(skill.description === undefined ? {} : { description: skill.description }),
        content: skill.content,
        ...(files.length === 0 ? {} : { files }),
      }
    },
  }
}

function parseInput(input: unknown): { readonly id: string; readonly file?: string } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new TypeError("skill_read input requires an id")
  const { id, file } = input as { id?: unknown; file?: unknown }
  if (typeof id !== "string" || id.length === 0 || id.length > 128) throw new TypeError("skill_read id is invalid")
  if (file !== undefined && (typeof file !== "string" || file.length === 0 || file.length > 512)) throw new TypeError("skill_read file is invalid")
  return file === undefined ? { id } : { id, file }
}
