/**
 * JSON Schema for the input of each first-party native tool, mirroring the tool's own parser.
 * Provider adapters send these with the tool list so a model learns argument names and bounds
 * from the declaration instead of from a failed call.
 */
import { BROWSER_TOOL_SCHEMAS } from "../browser/tools.ts"

export type ToolInputSchema = Readonly<Record<string, unknown>>

const OPEN_SCHEMA: ToolInputSchema = Object.freeze({ type: "object", additionalProperties: true })

const path = (description: string) => ({ type: "string", description })
const integer = (description: string, minimum: number, maximum: number) => ({ type: "integer", description, minimum, maximum })

function object(properties: Record<string, unknown>, required: readonly string[]): ToolInputSchema {
  return Object.freeze({ type: "object", properties, required, additionalProperties: false })
}

const SCHEMAS: Readonly<Record<string, ToolInputSchema>> = Object.freeze({
  ...BROWSER_TOOL_SCHEMAS,
  read_file: object({ path: path("Workspace-relative file path.") }, ["path"]),
  write_file: object(
    { path: path("Workspace-relative file path."), content: { type: "string", description: "Full new file content, at most 256 KiB." } },
    ["path", "content"],
  ),
  apply_patch: object(
    { path: path("Workspace-relative file path."), content: { type: "string", description: "Full replacement file content, at most 256 KiB." } },
    ["path", "content"],
  ),
  edit_file: object(
    {
      path: path("Workspace-relative file path."),
      oldText: { type: "string", description: "Exact text to replace. Must be unique in the file unless replaceAll is true." },
      newText: { type: "string", description: "Replacement text." },
      replaceAll: { type: "boolean", description: "Replace every occurrence instead of requiring a unique one." },
    },
    ["path", "oldText", "newText"],
  ),
  list_files: object(
    {
      path: path("Workspace-relative directory. Defaults to the workspace root."),
      depth: integer("Directory levels to descend. Defaults to 1.", 0, 32),
      maxEntries: integer("Entry limit. Defaults to 256.", 1, 2_048),
    },
    [],
  ),
  find_files: object(
    {
      pattern: { type: "string", description: "File name pattern using * and ? wildcards." },
      path: path("Workspace-relative directory to search. Defaults to the workspace root."),
      depth: integer("Directory levels to descend. Defaults to 16.", 0, 32),
      maxEntries: integer("Entry limit. Defaults to 256.", 1, 2_048),
    },
    ["pattern"],
  ),
  search_files: object(
    {
      query: { type: "string", description: "Exact text to search for, at most 512 characters." },
      path: path("Workspace-relative directory to search. Defaults to the workspace root."),
      maxResults: integer("Match limit. Defaults to 128.", 1, 512),
      maxFileBytes: integer("Largest file to scan, in bytes. Defaults to 262144.", 1, 262_144),
    },
    ["query"],
  ),
  run_command: object(
    {
      program: { type: "string", description: "One executable name or path, without arguments or whitespace." },
      args: { type: "array", items: { type: "string" }, description: "Arguments passed to the program as-is. No shell is involved." },
      timeoutMs: integer("Time limit in milliseconds. Defaults to 120000.", 1, 120_000),
      maxOutputBytes: integer("Output limit in bytes. Defaults to 65536.", 1, 65_536),
      cwd: { type: "string", description: "Folder to run in, when not the working folder: a folder inside the workspace, or the absolute path of one inside a related folder." },
      background: {
        type: "boolean",
        description: "Start it and return its id at once, for a dev server or a watcher. It keeps running after the turn; read it with command_output and end it with command_stop. No time limit applies.",
      },
    },
    ["program"],
  ),
  command_output: object(
    {
      id: { type: "string", description: "Id that run_command returned for a background command." },
      afterSeq: integer("Read only output after this point: the nextSeq of an earlier read. Defaults to 0.", 0, Number.MAX_SAFE_INTEGER),
    },
    ["id"],
  ),
  command_stop: object({ id: { type: "string", description: "Id that run_command returned for a background command." } }, ["id"]),
  skill_read: object(
    {
      id: { type: "string", description: "Skill id from the installed skills list." },
      file: { type: "string", description: "Optional reference file inside the skill's folder, relative to it, as listed by an earlier skill_read." },
    },
    ["id"],
  ),
  run_verification: object({ name: { type: "string", enum: ["check", "assure", "test"], description: "Verification gate to run." } }, ["name"]),
  update_plan: object(
    {
      explanation: { type: "string", description: "Optional note about why the plan changed." },
      plan: {
        type: "array",
        minItems: 1,
        maxItems: 64,
        items: {
          type: "object",
          properties: { step: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] } },
          required: ["step", "status"],
          additionalProperties: false,
        },
      },
    },
    ["plan"],
  ),
})

/** Input schema for a tool name; tools Runrail does not own (plugins, bridged servers) stay open. */
export function toolInputSchema(name: string): ToolInputSchema {
  return Object.hasOwn(SCHEMAS, name) ? (SCHEMAS[name] as ToolInputSchema) : OPEN_SCHEMA
}
