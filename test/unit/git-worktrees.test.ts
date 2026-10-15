import { afterAll, expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runGit, type GitRunOptions } from "../../src/git/run.ts"
import { ThreadWorktrees } from "../../src/git/worktrees.ts"

const dirs: string[] = []
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

test("thread worktrees work with git before 2.36, which has no `worktree list -z`", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runrail-old-git-")))
  dirs.push(root)
  const repo = join(root, "repo")
  for (const args of [["init", "-q", repo], ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "first"]])
    expect(Bun.spawnSync(["git", ...args]).exitCode).toBe(0)
  let refused = 0
  // Git 2.34 (Ubuntu 22.04) answers an unknown switch with exit code 129.
  const oldGit = async (options: GitRunOptions) => {
    if (options.args[0] === "worktree" && options.args[1] === "list" && options.args.includes("-z")) {
      refused += 1
      return { exitCode: 129, stdout: "", stderr: "error: unknown switch `z'", truncated: false }
    }
    return runGit(options)
  }
  const worktrees = new ThreadWorktrees({ root: repo, baseDir: join(root, "worktrees"), run: oldGit })
  expect(await worktrees.create({ id: "first", branch: "thread/first" })).toMatchObject({ id: "first", branch: "thread/first", detached: false })
  await worktrees.create({ id: "second" })
  expect((await worktrees.list()).map((entry) => [entry.id, entry.detached])).toEqual([["first", false], ["second", true]])
  expect(refused).toBe(3)
})
