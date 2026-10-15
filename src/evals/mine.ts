import { lstat, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CheckResult } from "../check/run.ts"
import { runGit, type GitRunOptions, type GitRunResult } from "../git/run.ts"

/**
 * Eval cases from a project's history. A candidate is a commit that changes tests and
 * source; it is kept only when its tests fail at the parent and pass at the commit. Only ids
 * and paths are kept: commit messages and diffs stay in git.
 */

export interface EvalCase {
  readonly id: string
  /** The commit the run starts from, with the hidden tests removed. */
  readonly base: string
  /** The commit whose tests are hidden and whose change is the reference fix. */
  readonly fix: string
  readonly tests: readonly string[]
}

export interface MinedCandidate extends EvalCase {
  readonly sources: number
}

export interface MineOptions {
  readonly root: string
  readonly limit: number
  /** Commits to look through, newest first. */
  readonly scan?: number
  readonly since?: string
  readonly signal?: AbortSignal
  readonly git?: (options: GitRunOptions) => Promise<GitRunResult>
}

const TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$|(^|\/)tests?\.rs$/
const SOURCE_PATH = /\.([cm]?[jt]sx?|py|rs|go|java|kt|rb|php|cs|swift|c|cc|cpp|h|hpp|vue|svelte)$/
const MAX_SCAN = 2_000
const MAX_TESTS = 20

export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path)
}

/** Commits, newest first, that add or change tests and change source, with one parent. */
export async function mineCandidates(options: MineOptions): Promise<readonly MinedCandidate[]> {
  const git = options.git ?? runGit
  const scan = Math.min(options.scan ?? 500, MAX_SCAN)
  const log = await git({
    cwd: options.root,
    args: ["log", "--no-merges", "--no-renames", "--format=%x1e%H %P", "--name-status", `-n${String(scan)}`, ...(options.since === undefined ? [] : [`--since=${options.since}`])],
    maxOutputBytes: 16 * 1024 * 1024,
    overflow: "truncate",
    timeoutMs: 60_000,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  const found: MinedCandidate[] = []
  for (const record of log.stdout.split("\x1e")) {
    const [head, ...lines] = record.trim().split("\n")
    const [commit, parent, extra] = (head ?? "").trim().split(" ")
    if (commit === undefined || parent === undefined || extra !== undefined || !/^[0-9a-f]{40,64}$/.test(commit) || !/^[0-9a-f]{40,64}$/.test(parent)) continue
    const tests: string[] = []
    let sources = 0
    for (const line of lines) {
      const [status, path] = line.split("\t")
      if (status === undefined || path === undefined || path.length === 0) continue
      if (isTestPath(path)) {
        if (status !== "D") tests.push(path)
      } else if (SOURCE_PATH.test(path)) sources += 1
    }
    if (tests.length === 0 || tests.length > MAX_TESTS || sources === 0) continue
    found.push({ id: commit.slice(0, 12), base: parent, fix: commit, tests, sources })
    if (found.length >= options.limit) break
  }
  return found
}

/** `{tests}` in a check command is replaced by the case's hidden test paths, quoted for the shell. */
export function checkFor(command: string, tests: readonly string[]): string {
  const quoted = tests.map((path) => `'${path.replaceAll("'", "'\\''")}'`).join(" ")
  return command.includes("{tests}") ? command.replaceAll("{tests}", quoted) : command
}

export interface ValidateOptions {
  readonly root: string
  readonly check: string
  readonly run: (input: { readonly cwd: string; readonly command: string }) => Promise<CheckResult>
  readonly git?: (options: GitRunOptions) => Promise<GitRunResult>
  readonly signal?: AbortSignal
}

export type CaseVerdict = "valid" | "passes-before" | "fails-after" | "error"

/**
 * D18: the hidden tests must fail at the base with them added, and pass at the fix. Runs in a
 * throwaway worktree outside the repository; the project's `node_modules` is linked in, since a
 * fresh worktree has none.
 */
export async function validateCase(candidate: EvalCase, options: ValidateOptions): Promise<CaseVerdict> {
  const git = options.git ?? runGit
  const scratch = await mkdtemp(join(tmpdir(), "runrail-eval-"))
  const tree = join(scratch, "tree")
  const signal = options.signal === undefined ? {} : { signal: options.signal }
  try {
    await git({ cwd: options.root, args: ["worktree", "add", "--detach", "--quiet", tree, candidate.base], timeoutMs: 120_000, ...signal })
    await linkDependencies(options.root, tree)
    await git({ cwd: tree, args: ["checkout", candidate.fix, "--", ...candidate.tests], ...signal })
    const command = checkFor(options.check, candidate.tests)
    const before = await options.run({ cwd: tree, command })
    if (before.passed) return "passes-before"
    if (before.timedOut || before.stopped) return "error"
    await git({ cwd: tree, args: ["checkout", "--force", "--detach", "--quiet", candidate.fix], ...signal })
    const after = await options.run({ cwd: tree, command })
    return after.passed ? "valid" : "fails-after"
  } catch {
    return "error"
  } finally {
    await git({ cwd: options.root, args: ["worktree", "remove", "--force", tree], okExitCodes: [0, 128] }).catch(() => undefined)
    await rm(scratch, { recursive: true, force: true })
  }
}

/** Links the project's `node_modules` into a worktree that has none. */
export async function linkDependencies(root: string, tree: string): Promise<void> {
  const source = join(root, "node_modules")
  const target = join(tree, "node_modules")
  const exists = async (path: string): Promise<boolean> =>
    lstat(path).then(
      () => true,
      () => false,
    )
  if ((await exists(source)) && !(await exists(target))) await symlink(source, target, "dir")
}
