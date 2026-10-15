import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createApplyPatchTool } from "../../src/tools/apply-patch.ts"
import { createWorkspacePolicy } from "../../src/workspace/policy.ts"

describe("workspace-boundary safety", () => {
  test("cannot apply a patch outside the root", async () => {
    const root = await mkdtemp(join("/tmp", "runrail-safety-"))
    await writeFile(join(root, "index.ts"), "export {}\n")
    const policy = await createWorkspacePolicy(root)
    const tool = createApplyPatchTool(policy, { allowWrite: true })
    await expect(tool.execute({ path: "../escape.ts", content: "bad" }, { cwd: root, signal: new AbortController().signal })).rejects.toThrow("escapes")
  })
})
