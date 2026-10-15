import { readdir } from "node:fs/promises"
import { join } from "node:path"
import type { EvalCase } from "./mine.ts"
import { writeFileAtomic } from "../runtime/atomic-write.ts"
import { containedPath, ensureContainedDirectory } from "../runtime/contained-path.ts"
import { readBoundedText } from "../runtime/bounded-read.ts"

/**
 * Eval suites in a project's `.runrail/evals/<name>.yaml`: the check that scores a case
 * (`{tests}` stands for its hidden tests) and the cases, each a base and a fix commit by id.
 */

export interface EvalSuite {
  readonly name: string
  readonly check: string
  readonly cases: readonly EvalCase[]
}

export class EvalError extends Error {
  constructor(
    readonly code: "EVAL_INVALID" | "EVAL_NOT_FOUND" | "EVAL_LIMIT" | "EVAL_RUN_NOT_FOUND" | "EVAL_STORE_FAILED",
    message: string,
  ) {
    super(message)
    this.name = "EvalError"
  }
}

export const SUITE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/
export const MAX_CASES = 200
const COMMIT = /^[0-9a-f]{40,64}$/
const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const MAX_FILE_BYTES = 1024 * 1024

function invalid(message: string): never {
  throw new EvalError("EVAL_INVALID", message)
}

export function parseSuite(value: unknown, name: string): EvalSuite {
  if (!SUITE_NAME.test(name)) invalid("a suite name is 1-64 lowercase letters, digits, dots, dashes or underscores")
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid("a suite must be a mapping")
  const item = value as Record<string, unknown>
  if (typeof item.check !== "string" || item.check.trim().length === 0 || item.check.length > 4_000 || item.check.includes("\0")) invalid("check must be a command up to 4000 characters")
  if (!Array.isArray(item.cases) || item.cases.length === 0 || item.cases.length > MAX_CASES) invalid(`cases must list 1 to ${String(MAX_CASES)} cases`)
  const ids = new Set<string>()
  const cases = item.cases.map((entry: unknown, index): EvalCase => {
    const where = `cases[${String(index)}]`
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) invalid(`${where} must be a mapping`)
    const value = entry as Record<string, unknown>
    if (typeof value.id !== "string" || !CASE_ID.test(value.id) || ids.has(value.id)) invalid(`${where}.id must be a unique id`)
    ids.add(value.id)
    if (typeof value.base !== "string" || !COMMIT.test(value.base) || typeof value.fix !== "string" || !COMMIT.test(value.fix)) invalid(`${where} needs full base and fix commit ids`)
    if (!Array.isArray(value.tests) || value.tests.length === 0 || value.tests.length > 20) invalid(`${where}.tests must list 1 to 20 paths`)
    const tests = value.tests.map((path: unknown) => {
      if (typeof path !== "string" || path.length === 0 || path.length > 1024 || path.startsWith("/") || path.includes("\0") || path.split("/").includes("..")) invalid(`${where}.tests has a path outside the repository`)
      return path
    })
    return { id: value.id, base: value.base, fix: value.fix, tests }
  })
  return { name, check: item.check.trim(), cases }
}

export class SuiteStore {
  constructor(private readonly root: string) {}

  get dir(): string {
    return join(this.root, ".runrail", "evals")
  }

  async list(): Promise<{ readonly suites: readonly { readonly name: string; readonly cases: number; readonly check: string }[]; readonly skipped: readonly string[] }> {
    let names: string[]
    try {
      names = (await readdir(await containedPath(this.root, this.dir))).filter((name) => /\.ya?ml$/.test(name)).sort()
    } catch (error) {
      if (isNotFound(error)) return { suites: [], skipped: [] }
      throw new EvalError("EVAL_STORE_FAILED", "the suites directory cannot be read safely")
    }
    const suites: { name: string; cases: number; check: string }[] = []
    const skipped: string[] = []
    for (const file of names.slice(0, 100)) {
      try {
        const suite = await this.get(file.replace(/\.ya?ml$/, ""))
        suites.push({ name: suite.name, cases: suite.cases.length, check: suite.check })
      } catch {
        skipped.push(file)
      }
    }
    return { suites, skipped }
  }

  async get(name: string): Promise<EvalSuite> {
    if (!SUITE_NAME.test(name)) invalid("a suite name is 1-64 lowercase letters, digits, dots, dashes or underscores")
    let text: string | undefined
    for (const extension of ["yaml", "yml"]) {
      try {
        const path = await containedPath(this.root, join(this.dir, `${name}.${extension}`))
        text = await readBoundedText(path, MAX_FILE_BYTES, { noFollow: true })
        break
      } catch (error) {
        if (!isNotFound(error)) throw new EvalError("EVAL_STORE_FAILED", "the suite file cannot be read safely")
      }
    }
    if (text === undefined) throw new EvalError("EVAL_NOT_FOUND", "no suite has that name")
    let value: unknown
    try {
      value = Bun.YAML.parse(text)
    } catch {
      throw new EvalError("EVAL_INVALID", "the suite file is not valid YAML")
    }
    return parseSuite(value, name)
  }

  async save(suite: EvalSuite): Promise<EvalSuite> {
    const parsed = parseSuite({ check: suite.check, cases: suite.cases }, suite.name)
    let path: string
    try {
      await ensureContainedDirectory(this.root, this.dir)
      path = await containedPath(this.root, join(this.dir, `${parsed.name}.yaml`))
    } catch {
      throw new EvalError("EVAL_STORE_FAILED", "the suite path is not safe")
    }
    const header = "# A Runrail eval suite. Each case starts at `base` with `tests` removed; it passes when\n# `check` passes with them restored from `fix`. `{tests}` stands for the case's tests.\n"
    try {
      await writeFileAtomic(path, `${header}${Bun.YAML.stringify({ version: 1, check: parsed.check, cases: parsed.cases }, null, 2)}\n`, 0o644)
    } catch {
      throw new EvalError("EVAL_STORE_FAILED", "the suite could not be saved")
    }
    return parsed
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}
