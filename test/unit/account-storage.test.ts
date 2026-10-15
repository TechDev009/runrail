import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { createNativeControlRuntime } from "../../src/control-native.ts"
import { toolConnectionHome } from "../../src/accounts/tool-account.ts"

test("connections and their signed-in tool homes are shared across threads, projects, and restarts by default", async () => {
  const root = await mkdtemp("/tmp/runrail-shared-accounts-")
  const previous = process.env.RUNRAIL_ACCOUNTS_DIR
  process.env.RUNRAIL_ACCOUNTS_DIR = join(root, "user-accounts")
  const open = (projectId: string, thread: string, accountsRoot?: string) => createNativeControlRuntime({ stateRoot: join(root, thread), workspaceRoot: join(root, projectId), projectId, ownerId: "local-owner", ...(accountsRoot === undefined ? {} : { accountsRoot }) })
  try {
    const first = open("project-one", "thread-one")
    await first.connections.addTool({ tool: "claude-code", separateAccount: true, models: ["sonnet"] })
    await first.connections.setDefault({ connectionId: "claude-code-1", model: "sonnet" })
    const connection = await first.connections.requireTool("claude-code-1")
    for (const other of [open("project-one", "thread-two"), open("project-two", "thread-three"), open("project-one", "thread-one")]) {
      expect(other.accountsRoot).toBe(first.accountsRoot)
      expect(await other.connections.list()).toEqual(await first.connections.list())
      expect(toolConnectionHome(other.accountsRoot, await other.connections.requireTool("claude-code-1"))).toBe(toolConnectionHome(first.accountsRoot, connection))
    }
    // A caller who explicitly asks for an isolated store keeps that boundary.
    expect((await open("project-one", "isolated", join(root, "isolated-accounts")).connections.list()).connections).toEqual([])
  } finally {
    if (previous === undefined) delete process.env.RUNRAIL_ACCOUNTS_DIR
    else process.env.RUNRAIL_ACCOUNTS_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})
