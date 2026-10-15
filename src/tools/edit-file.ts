import type { NativeTool } from "@nifrajs/coding-agent"
import { DEFAULT_MAX_FILE_BYTES, type WorkspacePolicy } from "../workspace/policy.ts"

export function createEditFileTool(
  policy: WorkspacePolicy,
  options: { readonly allowWrite?: boolean } = {},
): NativeTool {
  return {
    name: "edit_file",
    description: "Replace a bounded exact text occurrence in a workspace file.",
    capabilities: ["filesystem.write"],
    requiresApproval: options.allowWrite !== true,
    execute: async (input) => {
      const edit = parseEditInput(input)
      const current = await policy.read(edit.path)
      const occurrences = countOccurrences(current, edit.oldText)
      if (occurrences === 0) throw new Error("edit_file oldText was not found")
      if (occurrences > 1 && edit.replaceAll !== true)
        throw new Error("edit_file oldText is not unique")
      // Checked before the new text is built: a UTF-8 file has at least as many bytes as UTF-16 units,
      // and many small matches times a large replacement would otherwise allocate gigabytes first.
      const replaced = edit.replaceAll === true ? occurrences : 1
      if (current.length + replaced * (edit.newText.length - edit.oldText.length) > DEFAULT_MAX_FILE_BYTES)
        throw new RangeError("edit_file result would exceed the file size limit")
      const content = edit.replaceAll
        ? current.split(edit.oldText).join(edit.newText)
        // A function, so `$&`, `$$` and the like in the new text are written as they are.
        : current.replace(edit.oldText, () => edit.newText)
      return policy.write(edit.path, content)
    },
  }
}

function parseEditInput(input: unknown): {
  readonly path: string
  readonly oldText: string
  readonly newText: string
  readonly replaceAll?: boolean
} {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new TypeError("edit_file input is invalid")
  const value = input as { path?: unknown; oldText?: unknown; newText?: unknown; replaceAll?: unknown }
  if (
    typeof value.path !== "string" ||
    typeof value.oldText !== "string" ||
    typeof value.newText !== "string" ||
    value.oldText.length === 0
  )
    throw new TypeError("edit_file requires path, oldText, and newText")
  if (value.oldText.length > 64 * 1024 || value.newText.length > 64 * 1024)
    throw new RangeError("edit_file text is too large")
  if (value.replaceAll !== undefined && typeof value.replaceAll !== "boolean")
    throw new TypeError("edit_file replaceAll must be boolean")
  return {
    path: value.path,
    oldText: value.oldText,
    newText: value.newText,
    ...(value.replaceAll === undefined ? {} : { replaceAll: value.replaceAll }),
  }
}

function countOccurrences(value: string, needle: string): number {
  let count = 0
  let offset = 0
  while (offset <= value.length - needle.length) {
    const index = value.indexOf(needle, offset)
    if (index < 0) break
    count += 1
    offset = index + needle.length
  }
  return count
}
