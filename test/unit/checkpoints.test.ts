import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { TurnCheckpoints } from "../../src/checkpoints/turns.ts"

/** A rewind can put files back as they were before a turn. */

let root: string
let repo: string
let state: string

const git = (args: readonly string[], cwd = repo): string => {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.com", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.com" } })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`)
  return result.stdout.toString()
}

const read = (path: string, base = repo) => readFile(join(base, path), "utf8")
/** Everything in the person's repository that a checkpoint could have touched. */
const footprint = () => [git(["for-each-ref"]), git(["count-objects", "-v"]), git(["status", "--porcelain"])].join("\n")

beforeEach(async () => {
  root = await mkdtemp(join("/tmp", "runrail-checkpoints-"))
  repo = join(root, "repo")
  state = join(root, "session")
  await mkdir(repo)
  git(["init", "-q", "-b", "main", "."])
  await writeFile(join(repo, "a.txt"), "one\n")
  await writeFile(join(repo, "gone.txt"), "keep me\n")
  await writeFile(join(repo, ".gitignore"), "build/\n")
  git(["add", "."])
  git(["commit", "-q", "-m", "first"])
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const checkpoints = (fields: Partial<ConstructorParameters<typeof TurnCheckpoints>[0]> = {}) => new TurnCheckpoints({ root: repo, dir: state, ...fields })

describe("checkpoints in a git folder", () => {
  test("every change since a turn is listed, and putting them back restores the work tree; ignored files are left alone", async () => {
    await writeFile(join(repo, "notes.txt"), "untracked before\n")
    const store = checkpoints()
    const first = await store.capture()
    expect(first.tree).toMatch(/^[0-9a-f]{40,64}$/)
    await store.note(first.n, { userSeq: 4, turnId: "turn-1" })
    // The turn: an edit, an edit to an untracked file, a new file in a new folder, a delete, a build output.
    await writeFile(join(repo, "a.txt"), "two\n")
    await writeFile(join(repo, "notes.txt"), "untracked after\n")
    await mkdir(join(repo, "src", "deep"), { recursive: true })
    await writeFile(join(repo, "src", "deep", "new.ts"), "export {}\n")
    await rm(join(repo, "gone.txt"))
    await mkdir(join(repo, "build"))
    await writeFile(join(repo, "build", "out.js"), "built\n")

    const { files } = await store.changes(first.n)
    expect(files).toEqual([
      { path: "a.txt", change: "modified" },
      { path: "gone.txt", change: "deleted" },
      { path: "notes.txt", change: "modified" },
      { path: "src/deep/new.ts", change: "added" },
    ])
    const result = await store.restore(first.n, files.map((file) => file.path))
    expect(result).toEqual({ restored: ["a.txt", "gone.txt", "notes.txt", "src/deep/new.ts"], failed: [] })
    expect(await read("a.txt")).toBe("one\n")
    expect(await read("gone.txt")).toBe("keep me\n")
    expect(await read("notes.txt")).toBe("untracked before\n")
    expect(existsSync(join(repo, "src"))).toBe(false)
    expect(await read("build/out.js")).toBe("built\n")
    expect((await store.changes(first.n)).files).toEqual([])
  })

  test("only the ticked paths go back, and a path that did not change is reported, not touched", async () => {
    const store = checkpoints()
    const first = await store.capture()
    await store.note(first.n, { turnId: "turn-1" })
    await writeFile(join(repo, "a.txt"), "two\n")
    await writeFile(join(repo, "b.txt"), "new\n")
    const result = await store.restore(first.n, ["b.txt", "gone.txt"])
    expect(result).toEqual({ restored: ["b.txt"], failed: [{ path: "gone.txt", reason: "unchanged since then" }] })
    expect(await read("a.txt")).toBe("two\n")
    expect(existsSync(join(repo, "b.txt"))).toBe(false)
  })

  test("nothing is written into the person's repository: no refs, no objects, their index and staged changes as they were", async () => {
    await writeFile(join(repo, "a.txt"), "staged\n")
    git(["add", "a.txt"])
    await writeFile(join(repo, "c.txt"), "untracked\n")
    const before = footprint()
    const store = checkpoints()
    const first = await store.capture()
    await store.note(first.n, { turnId: "turn-1" })
    await writeFile(join(repo, "c.txt"), "changed\n")
    await store.capture()
    await store.changes(first.n)
    await writeFile(join(repo, "c.txt"), "untracked\n")
    expect(footprint()).toBe(before)
    expect(git(["status", "--porcelain"])).toBe("M  a.txt\n?? c.txt\n")
  })

  test("a turn's snapshot needs only what changed, and an edit of the same size is still seen", async () => {
    const store = checkpoints()
    await store.capture()
    const second = await store.capture()
    await store.note(second.n, { turnId: "turn-2" })
    await writeFile(join(repo, "a.txt"), "ONE\n")
    expect((await store.changes(second.n)).files).toEqual([{ path: "a.txt", change: "modified" }])
  })

  test("a workspace inside the repository sees and restores only its own paths", async () => {
    await mkdir(join(repo, "app"))
    await writeFile(join(repo, "app", "x.txt"), "x1\n")
    git(["add", "."])
    git(["commit", "-q", "-m", "app"])
    const store = new TurnCheckpoints({ root: join(repo, "app"), dir: state })
    const first = await store.capture()
    await store.note(first.n, { turnId: "turn-1" })
    await writeFile(join(repo, "app", "x.txt"), "x2\n")
    await writeFile(join(repo, "a.txt"), "outside\n")
    const { files } = await store.changes(first.n)
    expect(files).toEqual([{ path: "x.txt", change: "modified" }])
    await store.restore(first.n, ["x.txt"])
    expect(await read("app/x.txt")).toBe("x1\n")
    expect(await read("a.txt")).toBe("outside\n")
  })

  test("Runrail's runtime folders and likely secrets are never in a checkpoint; the repository's own excludes apply", async () => {
    await writeFile(join(repo, ".git", "info", "exclude"), "scratch.txt\n")
    const store = checkpoints()
    const first = await store.capture()
    await store.note(first.n, { turnId: "turn-1" })
    await mkdir(join(repo, ".runrail", "native"), { recursive: true })
    await writeFile(join(repo, ".runrail", "native", "journal.json"), "{}\n")
    await writeFile(join(repo, ".env"), "TOKEN=x\n")
    await writeFile(join(repo, "deploy.pem"), "-----\n")
    await writeFile(join(repo, "scratch.txt"), "mine\n")
    await writeFile(join(repo, ".env.example"), "TOKEN=\n")
    expect((await store.changes(first.n)).files).toEqual([{ path: ".env.example", change: "added" }])
  })
})

describe("checkpoints in a folder with no git", () => {
  let plain: string
  const shadowed = (fields: Partial<ConstructorParameters<typeof TurnCheckpoints>[0]> = {}) => new TurnCheckpoints({ root: plain, dir: state, ...fields })

  beforeEach(async () => {
    plain = join(root, "plain")
    await mkdir(join(plain, "docs"), { recursive: true })
    await writeFile(join(plain, "notes.md"), "draft\n")
    await writeFile(join(plain, "docs", "old.md"), "old\n")
  })

  test("edits, new files and deletes are all caught, whatever made them, and put back; the folder gets no git of its own", async () => {
    const store = shadowed()
    const first = await store.capture()
    expect(first.tree).toMatch(/^[0-9a-f]{40,64}$/)
    await store.note(first.n, { turnId: "turn-1" })
    await writeFile(join(plain, "notes.md"), "rewritten\n")
    await rm(join(plain, "docs", "old.md"))
    await mkdir(join(plain, "out"))
    await writeFile(join(plain, "out", "made-by-a-command.txt"), "x\n")
    await mkdir(join(plain, "node_modules", "dep"), { recursive: true })
    await writeFile(join(plain, "node_modules", "dep", "index.js"), "x\n")

    const { files } = await store.changes(first.n)
    expect(files).toEqual([
      { path: "docs/old.md", change: "deleted" },
      { path: "notes.md", change: "modified" },
      { path: "out/made-by-a-command.txt", change: "added" },
    ])
    expect(await store.restore(first.n, files.map((file) => file.path))).toEqual({ restored: ["docs/old.md", "notes.md", "out/made-by-a-command.txt"], failed: [] })
    expect(await read("notes.md", plain)).toBe("draft\n")
    expect(await read("docs/old.md", plain)).toBe("old\n")
    expect(existsSync(join(plain, "out"))).toBe(false)
    expect(existsSync(join(plain, "node_modules", "dep", "index.js"))).toBe(true)
    expect(existsSync(join(plain, ".git"))).toBe(false)
  })

  test("a later turn's snapshot needs only what changed, and an edit of the same size is still seen", async () => {
    const store = shadowed()
    await store.capture()
    const second = await store.capture()
    await store.note(second.n, { turnId: "turn-2" })
    await writeFile(join(plain, "notes.md"), "DRAFT\n")
    expect((await store.changes(second.n)).files).toEqual([{ path: "notes.md", change: "modified" }])
  })

  test("a folder too large to keep is not walked again this session", async () => {
    const store = shadowed({ limits: { maxPaths: 1 } })
    expect(await store.capture()).toMatchObject({ skipped: "too-large" })
    await rm(join(plain, "docs"), { recursive: true })
    expect(await store.capture()).toMatchObject({ skipped: "too-large" })
    expect((await shadowed().capture()).tree).toMatch(/^[0-9a-f]{40,64}$/)
  })
})

describe("what a checkpoint is kept for", () => {
  test("too much to hash before a turn is recorded as skipped, and a repository tries again next turn", async () => {
    for (const name of ["p.txt", "q.txt", "r.txt"]) await writeFile(join(repo, name), "x\n")
    const store = checkpoints({ limits: { maxPaths: 2 } })
    expect(await store.capture()).toMatchObject({ skipped: "too-large" })
    await rm(join(repo, "r.txt"))
    expect((await store.capture()).tree).toMatch(/^[0-9a-f]{40,64}$/)
    expect(await checkpoints({ dir: join(root, "big"), limits: { maxUntrackedBytes: 3 } }).capture()).toMatchObject({ skipped: "too-large" })
  })

  test("the list survives a restart, keeps the newest, and drops later turns on a rewind", async () => {
    const store = checkpoints({ limits: { maxCheckpoints: 2 } })
    for (const turn of ["t1", "t2", "t3"]) {
      const taken = await store.capture()
      await store.note(taken.n, { turnId: turn, vendor: { session: "vendor-1", at: `${turn}-end` } })
    }
    const refs = () => git(["--git-dir", join(state, "shadow.git"), "for-each-ref", "--format=%(refname)", "refs/runrail/checkpoints/"]).trim().split("\n").filter((line) => line.length > 0)
    expect(refs()).toEqual(["refs/runrail/checkpoints/2", "refs/runrail/checkpoints/3"])
    const again = checkpoints({ limits: { maxCheckpoints: 2 } })
    expect((await again.list()).map((item) => item.turnId)).toEqual(["t2", "t3"])
    expect((await again.list()).map((item) => item.vendor)).toEqual([{ session: "vendor-1", at: "t2-end" }, { session: "vendor-1", at: "t3-end" }])
    await again.dropFrom(3)
    expect((await again.list()).map((item) => item.turnId)).toEqual(["t2"])
    expect(refs()).toEqual(["refs/runrail/checkpoints/2"])
    await expect(again.changes(3)).rejects.toThrow("that turn has no checkpoint")
  })

  test("a turn id names only a turn this list took since it was opened; a message's record id names any", async () => {
    const before = checkpoints()
    const old = await before.capture()
    await before.note(old.n, { turnId: "turn-1", userId: "th:4" })
    // A restarted engine numbers its coding tool's turns from 1 again.
    const after = checkpoints()
    const next = await after.capture()
    await after.note(next.n, { turnId: "turn-1", userId: "th:9" })
    expect((await after.find({ turnId: "turn-1" })).n).toBe(next.n)
    expect((await after.find({ userId: "th:4" })).n).toBe(old.n)
    await expect(checkpoints().find({ turnId: "turn-1" })).rejects.toThrow("that turn has no checkpoint")
  })

  test("forgetting removes the list and the shadow repository, which live only in the session's folder", async () => {
    const store = checkpoints()
    await store.capture()
    expect(existsSync(join(state, "shadow.git", "HEAD"))).toBe(true)
    await store.forget()
    expect(existsSync(join(state, "shadow.git"))).toBe(false)
    expect(await store.list()).toEqual([])
  })
})
