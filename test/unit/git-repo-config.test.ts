import { afterAll, beforeAll, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { previewGitPush, pushGitBranch } from "../../src/git/remote.ts"
import { repositoryProgramOverrides } from "../../src/git/repo-config.ts"
import { runGit } from "../../src/git/run.ts"
import { fetchOneRef } from "../../src/git/sources.ts"
import { probeGitRepository } from "../../src/git/status.ts"
import { commitGitChanges } from "../../src/git/write.ts"
import { createWorkspacePolicy } from "../../src/workspace/policy.ts"

let root: string
let repo: string
let home: string
let marker: string

const git = (args: readonly string[], cwd = repo): string => {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1" } })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
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

async function withHome<T>(work: () => Promise<T>): Promise<T> {
  const previous = process.env.HOME
  process.env.HOME = home
  try {
    return await work()
  } finally {
    process.env.HOME = previous
  }
}

async function freshRepo(name: string): Promise<string> {
  const dir = join(root, name)
  await mkdir(dir)
  git(["init", "-q", "-b", "main", "."], dir)
  await writeFile(join(dir, "a.txt"), "one\n")
  git(["add", "a.txt"], dir)
  git(["commit", "-q", "-m", "first"], dir)
  return dir
}

test("a commit runs no signing-key command the repository plants", async () => {
  const dir = await freshRepo("signed")
  const ran = join(root, "key-command-ran")
  git(["config", "commit.gpgsign", "true"], dir)
  git(["config", "gpg.format", "ssh"], dir)
  // Split on spaces and run directly, not through a shell.
  git(["config", "gpg.ssh.defaultKeyCommand", `touch ${ran}`], dir)
  await writeFile(join(dir, "a.txt"), "two\n")
  git(["add", "a.txt"], dir)
  await withHome(async () => commitGitChanges(await probeGitRepository(dir), { message: "signed", runHooks: false })).catch(() => undefined)
  expect(existsSync(ran)).toBe(false)
})

test("a fetch runs no alternate-refs command the repository plants", async () => {
  const source = await freshRepo("fetch-source")
  const dir = await freshRepo("fetch-victim")
  const ran = join(root, "alternate-refs-ran")
  git(["remote", "add", "origin", source], dir)
  // The command runs only for a repository that borrows objects from another.
  await writeFile(join(dir, ".git", "objects", "info", "alternates"), `${join(source, ".git", "objects")}\n`)
  git(["config", "core.alternateRefsCommand", `touch ${ran}; true`], dir)
  await withHome(async () => fetchOneRef(await probeGitRepository(dir), "origin", "refs/heads/main", "refs/runrail/fetched"))
  expect(existsSync(ran)).toBe(false)
  expect(git(["rev-parse", "refs/runrail/fetched"], dir)).toBe(git(["rev-parse", "HEAD"], source))
})

test("a push to a folder on this computer runs that repository's hooks and programs only with hooks on", async () => {
  const dir = await freshRepo("push-victim")
  const remote = join(dir, ".cache", "r.git")
  const ran = join(root, "receive-ran")
  await mkdir(join(dir, ".cache"))
  git(["init", "-q", "--bare", "-b", "main", remote], dir)
  git(["remote", "add", "origin", "./.cache/r.git"], dir)
  for (const hook of ["pre-receive", "update", "post-receive", "reference-transaction"]) {
    await writeFile(join(remote, "hooks", hook), `#!/bin/sh\necho ${hook} >> ${ran}\n`, { mode: 0o755 })
  }
  await writeFile(join(remote, "objects", "info", "alternates"), `${join(dir, ".git", "objects")}\n`)
  git(["config", "core.alternateRefsCommand", `echo alternates >> ${ran}; true`], remote)
  const push = async (runHooks: boolean): Promise<void> => {
    const repository = await probeGitRepository(dir)
    const preview = await previewGitPush(repository, { remote: "origin", branch: "main" })
    await pushGitBranch(repository, { remote: "origin", branch: "main", confirmation: preview.confirmation, runHooks })
  }

  await withHome(() => push(false))
  expect(existsSync(ran)).toBe(false)
  expect(git(["rev-parse", "main"], remote)).toBe(git(["rev-parse", "HEAD"], dir))

  // The person's own choice to run hooks reaches the receiving repository too; its programs stay off.
  await writeFile(join(dir, "a.txt"), "three\n")
  git(["commit", "-q", "-am", "second"], dir)
  await withHome(() => push(true))
  const lines = (await readFile(ran, "utf8")).trim().split("\n")
  expect(lines).toContain("pre-receive")
  expect(lines).not.toContain("alternates")
}, 30_000)

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

test("a kept answer is reused only while nothing git reads for it has changed", async () => {
  const dir = join(root, "kept")
  const log = join(dir, "git.log")
  const counting = join(dir, "counting-git")
  const plain = join(dir, "plain")
  const sub = join(plain, "sub")
  const included = join(dir, "included")
  await mkdir(sub, { recursive: true })
  await mkdir(included)
  await writeFile(counting, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec git "$@"\n`, { mode: 0o755 })
  git(["init", "-q", "."], plain)
  git(["config", "filter.a.clean", "planted"], plain)
  git(["init", "-q", "."], included)
  await writeFile(join(included, "extra.config"), "[filter \"i\"]\n\tclean = planted\n")
  git(["config", "include.path", "../extra.config"], included)
  const env = { PATH: process.env.PATH ?? "", HOME: home }
  const configReads = async (): Promise<number> => (await readFile(log, "utf8").catch(() => "")).split("\n").filter((line) => line.includes(" config --show-scope ")).length
  const ask = async (cwd: string, environment: Record<string, string> = env) => {
    const before = await configReads()
    const keys = (await repositoryProgramOverrides(counting, cwd, environment)).filter((_, index) => index % 2 === 1)
    return { keys, reads: (await configReads()) - before }
  }
  // Files changed within the last two seconds could change again unseen within one timestamp tick.
  await Bun.sleep(2_100)
  expect(await ask(plain)).toEqual({ keys: ["filter.a.clean="], reads: 1 })
  expect(await ask(plain)).toEqual({ keys: ["filter.a.clean="], reads: 0 })
  expect(await ask(sub)).toEqual({ keys: ["filter.a.clean="], reads: 1 })
  expect(await ask(sub)).toEqual({ keys: ["filter.a.clean="], reads: 0 })
  // A repository planted in a folder below is the one git now reads.
  git(["init", "-q", "."], sub)
  git(["config", "filter.n.clean", "planted"], sub)
  expect(await ask(sub)).toEqual({ keys: ["filter.n.clean="], reads: 1 })
  // An edit of the same size, in place, is seen at once.
  const config = join(plain, ".git", "config")
  await writeFile(config, (await readFile(config, "utf8")).replace("[filter \"a\"]", "[filter \"b\"]"))
  expect(await ask(plain)).toEqual({ keys: ["filter.b.clean="], reads: 1 })
  expect(await ask(plain)).toEqual({ keys: ["filter.b.clean="], reads: 1 })
  // Includes are not watched, and neither are files git variables could name: nothing is kept for them.
  for (let round = 0; round < 2; round += 1) expect(await ask(included)).toEqual({ keys: ["filter.i.clean="], reads: 1 })
  for (let round = 0; round < 2; round += 1) expect((await ask(sub, { ...env, GIT_CONFIG_NOSYSTEM: "1" })).reads).toBe(1)
}, 30_000)
