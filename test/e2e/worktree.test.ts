import { expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { createLocalGitWorktreeManager, WorktreeError } from "../../src/worktree/index.ts"

const fakeGit = resolve(import.meta.dir, "../fixtures/fake-git.ts")

test("creates bounded local worktree leases and cleans them up", async () => {
  const workspace = await mkdtemp(join("/tmp", "runrail-worktree-"))
  const manager = createLocalGitWorktreeManager({ workspaceRoot: workspace, gitCommand: "bun", gitArgs: ["run", fakeGit] })
  try {
    const lease = await manager.create({ id: "agent-one", revision: "HEAD" })
    expect(lease.cwd).toContain(join(".runrail", "worktrees", "agent-one"))
    await expect(readdir(lease.cwd)).resolves.toEqual([])
    await lease.cleanup()
    await expect(readdir(lease.cwd)).rejects.toThrow()
  } finally {
    await manager.close()
    await rm(workspace, { recursive: true, force: true })
  }
})

test("rejects unsafe or cancelled worktree requests", async () => {
  const workspace = await mkdtemp(join("/tmp", "runrail-worktree-invalid-"))
  const manager = createLocalGitWorktreeManager({ workspaceRoot: workspace, gitCommand: "bun", gitArgs: ["run", fakeGit] })
  try {
    await expect(manager.create({ id: "../escape" })).rejects.toMatchObject({ code: "WORKTREE_INVALID" })
    const controller = new AbortController()
    controller.abort()
    await expect(manager.create({ id: "cancelled", signal: controller.signal })).rejects.toMatchObject({ code: "WORKTREE_CANCELLED" })
    expect(() => createLocalGitWorktreeManager({ workspaceRoot: workspace, worktreeRoot: "/tmp/outside" })).toThrow(WorktreeError)
  } finally {
    await manager.close()
    await rm(workspace, { recursive: true, force: true })
  }
})

test("parallel creations share the lease limit, and a failed one gives its slot back", async () => {
  const workspace = await mkdtemp(join("/tmp", "runrail-worktree-parallel-"))
  const manager = createLocalGitWorktreeManager({ workspaceRoot: workspace, gitCommand: "bun", gitArgs: ["run", fakeGit], maxLeases: 1 })
  try {
    const results = await Promise.allSettled([manager.create({ id: "first" }), manager.create({ id: "second" }), manager.create({ id: "first" })])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.map((result) => result.status === "rejected" ? (result.reason as WorktreeError).code : "ok")).toEqual(["ok", "WORKTREE_LIMIT", "WORKTREE_LIMIT"])
    await (results[0] as PromiseFulfilledResult<{ cleanup: () => Promise<void> }>).value.cleanup()
    await expect(manager.create({ id: "bad", revision: "missing-revision" })).rejects.toMatchObject({ code: "WORKTREE_FAILED" })
    await expect(manager.create({ id: "after-failure" })).resolves.toMatchObject({ id: "after-failure" })
  } finally {
    await manager.close()
    await rm(workspace, { recursive: true, force: true })
  }
})
