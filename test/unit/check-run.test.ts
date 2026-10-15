import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { CheckRuns, parseCheckCounts, stripAnsi } from "../../src/check/run.ts"

const cleanup: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp("/tmp/runrail-check-")
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test("bun: the counts before the closing Ran line", () => {
  const output = ["test/a.test.ts:", "(pass) one", "(fail) two", "", " 126 pass", " 2 skip", " 2 fail", " 400 expect() calls", "Ran 130 tests across 9 files. [3.10s]"].join("\n")
  expect(parseCheckCounts(output)).toEqual({ runner: "bun", passed: 126, failed: 2, skipped: 2, total: 130 })
})

test("vitest, with color codes", () => {
  const output = "\u001b[2m Test Files \u001b[22m 1 failed | 4 passed (5)\n\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[31m2 failed\u001b[39m\u001b[22m | \u001b[1m\u001b[32m126 passed\u001b[39m\u001b[22m\u001b[90m (128)\u001b[39m\n"
  expect(parseCheckCounts(output)).toEqual({ runner: "vitest", passed: 126, failed: 2, skipped: 0, total: 128 })
})

test("jest", () => {
  expect(parseCheckCounts("Test Suites: 1 failed, 3 passed, 4 total\nTests:       2 failed, 1 skipped, 125 passed, 128 total\nTime: 4.2 s")).toEqual({ runner: "jest", passed: 125, failed: 2, skipped: 1, total: 128 })
})

test("pytest, errors counted as failures", () => {
  expect(parseCheckCounts("collected 131 items\n\n=========== 2 failed, 126 passed, 2 skipped, 1 error in 4.21s ===========")).toEqual({ runner: "pytest", passed: 126, failed: 3, skipped: 2, total: 131 })
  expect(parseCheckCounts("============================== 12 passed in 0.31s ==============================")).toEqual({ runner: "pytest", passed: 12, failed: 0, skipped: 0, total: 12 })
})

test("cargo: every test binary's result line, summed", () => {
  const output = ["test result: ok. 79 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 4.13s", "test result: FAILED. 3 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out", "test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out"].join("\n")
  expect(parseCheckCounts(output)).toEqual({ runner: "cargo", passed: 82, failed: 1, skipped: 1, total: 84 })
})

test("anything else has no counts, and color codes are removed", () => {
  expect(parseCheckCounts("Checked 41 files.\nAll good.")).toBeUndefined()
  expect(stripAnsi("\u001b[31mred\u001b[0m \u001b]8;;https://x\u0007link\u001b]8;;\u0007")).toBe("red link")
})

test("a command's exit code, time, and the last 200 lines", async () => {
  const cwd = await tempDir()
  const result = await new CheckRuns().run({ id: "c1", cwd, command: "i=1; while [ $i -le 250 ]; do echo line $i; i=$((i+1)); done; echo oops >&2; exit 3", timeoutMs: 10_000 })
  expect(result.exitCode).toBe(3)
  expect(result.passed).toBe(false)
  expect(result.timedOut).toBe(false)
  expect(result.truncated).toBe(true)
  const lines = result.tail.split("\n")
  expect(lines).toHaveLength(200)
  expect(lines[lines.length - 1]).toBe("oops")
  expect(lines[0]).toBe("line 52")
})

test("output far past the kept size still ends with its last lines and counts as truncated", async () => {
  const cwd = await tempDir()
  const result = await new CheckRuns().run({ id: "c-long", cwd, command: "head -c 3000000 /dev/zero | tr '\\0' 'x'; echo; echo ' 1 pass'; echo ' 0 fail'; echo 'Ran 1 test across 1 file. [5ms]'", timeoutMs: 10_000 })
  expect(result.truncated).toBe(true)
  expect(result.tail.endsWith("Ran 1 test across 1 file. [5ms]")).toBe(true)
  expect(result.counts).toMatchObject({ passed: 1, failed: 0 })
})

test("a passing command reads as passed, with its runner's counts", async () => {
  const result = await new CheckRuns().run({ id: "c2", cwd: await tempDir(), command: "printf ' 3 pass\\n 0 fail\\nRan 3 tests across 1 file. [5ms]\\n'", timeoutMs: 10_000 })
  expect(result).toMatchObject({ exitCode: 0, passed: true, truncated: false, counts: { runner: "bun", passed: 3, failed: 0, total: 3 } })
})

test("a timeout kills the whole process tree", async () => {
  const cwd = await tempDir()
  const marker = `${cwd}/child.pid`
  const started = performance.now()
  const result = await new CheckRuns().run({ id: "c3", cwd, command: `sh -c 'echo $$ > ${marker}; sleep 30' & wait`, timeoutMs: 1_000 })
  expect(performance.now() - started).toBeLessThan(8_000)
  expect(result).toMatchObject({ timedOut: true, stopped: false, passed: false })
  expect(result.exitCode).toBeUndefined()
  const pid = Number((await Bun.file(marker).text()).trim())
  expect(() => process.kill(pid, 0)).toThrow()
})

test("stop ends a running check, and an id runs once at a time", async () => {
  const checks = new CheckRuns()
  const cwd = await tempDir()
  const running = checks.run({ id: "c4", cwd, command: "sleep 30", timeoutMs: 60_000 })
  await Bun.sleep(100)
  await expect(checks.run({ id: "c4", cwd, command: "true", timeoutMs: 1_000 })).rejects.toMatchObject({ code: "CHECK_RUNNING" })
  expect(await checks.stop("c4")).toBe(true)
  expect(await running).toMatchObject({ stopped: true, timedOut: false, passed: false })
  expect(await checks.stop("c4")).toBe(false)
  await checks.close()
  await expect(checks.run({ id: "c5", cwd, command: "true", timeoutMs: 1_000 })).rejects.toMatchObject({ code: "CHECK_CLOSED" })
})

test("a long line in the output never stalls reading the summary", () => {
  const started = performance.now()
  for (const line of [`Tests: ${"1 ".repeat(200_000)}`, ` Tests ${"1 ".repeat(200_000)}(`, `== ${"passed ".repeat(70_000)} in x`]) {
    expect(parseCheckCounts(`${line}\nTests:       1 passed, 1 total\n`)).toMatchObject({ runner: "jest", passed: 1 })
  }
  expect(performance.now() - started).toBeLessThan(1_000)
})
