import { afterAll, beforeAll, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { repositoryProgramOverrides } from "../../src/git/repo-config.ts"
import { runGit } from "../../src/git/run.ts"
import { createWorkspacePolicy } from "../../src/workspace/policy.ts"

let root: string
let repo: string
let home: string
let marker: string

const git = (args: readonly string[], cwd = repo) => {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1" } })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`)
}

beforeAll(async () => {
  root = await mkdtemp(join("/tmp", "runrail-git-config-"))
  repo = join(root, "repo")
  home = join(root, "home")
  marker = join(root, "planted-ran")
  await mkdir(repo)
  await mkdir(home)
  await writeFile(join(home, ".gitconfig"), "[user]\n\tname = Fixture\n\temail = fixture@example.com\n[credential]\n\thelper = person-helper\n")
  git(["init", "-q", "."])
  await writeFile(join(repo, "a.txt"), "one\n")
  git(["add", "a.txt"])
  git(["commit", "-q", "-m", "first"])
  // What an agent with only file edits could plant: a filter driver for every file, plus programs for the network.
  await writeFile(join(repo, ".gitattributes"), "* filter=planted diff=planted\n")
  git(["config", "filter.planted.clean", `touch ${marker}; cat`])
  git(["config", "filter.planted.required", "true"])
  git(["config", "diff.planted.textconv", `touch ${marker}; cat`])
  git(["config", "core.sshCommand", `touch ${marker}; ssh`])
  git(["config", "--add", "credential.helper", `!touch ${marker}`])
  await writeFile(join(repo, "a.txt"), "two\n")
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

test("the repository's own programs are replaced; the person's own helper is kept", async () => {
  const overrides = await repositoryProgramOverrides("git", repo, { PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_NOSYSTEM: "1" })
  const pairs = overrides.filter((_, index) => index % 2 === 1)
  expect(pairs).toContain("filter.planted.clean=")
  expect(pairs).toContain("filter.planted.required=false")
  expect(pairs).toContain("diff.planted.textconv=")
  expect(pairs).toContain("core.sshcommand=ssh")
  expect(pairs.slice(pairs.indexOf("credential.helper="))).toEqual(["credential.helper=", "credential.helper=person-helper"])
})

test("engine git calls in that repository run none of them", async () => {
  const previous = process.env.HOME
  process.env.HOME = home
  try {
    const status = await runGit({ cwd: repo, args: ["status", "--porcelain=v1"] })
    expect(status.stdout).toContain("a.txt")
    await runGit({ cwd: repo, args: ["diff", "--no-ext-diff", "--no-textconv"] })
    await runGit({ cwd: repo, args: ["add", "a.txt"] })
  } finally {
    process.env.HOME = previous
  }
  expect(existsSync(marker)).toBe(false)
})

test("engine git runs no hook and no fsmonitor the repository plants", async () => {
  const ran = join(root, "hook-ran")
  await mkdir(join(repo, ".git", "hooks"), { recursive: true })
  for (const hook of ["pre-commit", "commit-msg", "post-commit"]) await writeFile(join(repo, ".git", "hooks", hook), `#!/bin/sh\ntouch ${ran}\n`, { mode: 0o755 })
  git(["config", "core.fsmonitor", `touch ${ran}; true`])
  const previous = process.env.HOME
  process.env.HOME = home
  try {
    await writeFile(join(repo, "hooked.txt"), "hooked\n")
    await runGit({ cwd: repo, args: ["add", "hooked.txt"] })
    await runGit({ cwd: repo, args: ["status", "--porcelain=v1"] })
    await runGit({ cwd: repo, args: ["commit", "-q", "-m", "hooked"] })
  } finally {
    process.env.HOME = previous
    git(["config", "--unset", "core.fsmonitor"])
  }
  expect(existsSync(ran)).toBe(false)
})

test("an agent's file tools never write git's or Runrail's own configuration", async () => {
  const policy = await createWorkspacePolicy(repo)
  for (const path of [".git/config", ".git/hooks/pre-commit", ".GIT/config", "sub/.git/config", ".runrail/setups.json", ".runrail/plugins/x/index.js"]) {
    await expect(policy.write(path, "planted")).rejects.toThrow("git's or Runrail's own configuration")
  }
  await expect(policy.write("src/.runrail-notes.md", "fine")).resolves.toMatchObject({ path: "src/.runrail-notes.md" })
})

test("git output is drained while its stdin is still being written", async () => {
  const blob = Bun.spawnSync(["git", "hash-object", "-w", "--stdin"], { cwd: repo, stdin: Buffer.from("x".repeat(1_024)) }).stdout.toString().trim()
  const input = new TextEncoder().encode(`${blob}\n`.repeat(2_000))
  const result = await runGit({ cwd: repo, args: ["cat-file", "--batch"], stdin: input, maxOutputBytes: 8 * 1024 * 1024, timeoutMs: 10_000 })
  expect(result.exitCode).toBe(0)
  expect(result.stdout.length).toBeGreaterThan(2_000 * 1_024)
})
