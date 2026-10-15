import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { matchGlob } from "../../src/behavior/config.ts"
import { createWorkspacePolicy } from "../../src/workspace/policy.ts"
import { wildcardMatch } from "../../src/workspace/wildcard.ts"

test("* is any run and ? is one character; everything else is literal", () => {
  expect(wildcardMatch("*.ts", "src/index.ts")).toBe(true)
  expect(wildcardMatch("*.ts", "src/index.tsx")).toBe(false)
  expect(wildcardMatch("src/?.ts", "src/a.ts")).toBe(true)
  expect(wildcardMatch("src/?.ts", "src/ab.ts")).toBe(false)
  expect(wildcardMatch("git push *", "git push origin main")).toBe(true)
  expect(wildcardMatch("git push *", "git pull")).toBe(false)
  expect(wildcardMatch("a.(b)+[c]", "a.(b)+[c]")).toBe(true)
  expect(wildcardMatch("a.c", "abc")).toBe(false)
  expect(wildcardMatch("*", "")).toBe(true)
  expect(wildcardMatch("", "")).toBe(true)
  expect(wildcardMatch("?", "é")).toBe(true)
  expect(wildcardMatch("**a**", "bab")).toBe(true)
})

test("a pattern built to backtrack finishes at once, where a regex of .* took seconds", async () => {
  const pattern = `${"*a".repeat(60)}*b`
  const started = performance.now()
  expect(wildcardMatch(pattern, "a".repeat(200))).toBe(false)
  expect(matchGlob(pattern, "a".repeat(4_000))).toBe(false)
  const root = await mkdtemp(join("/tmp", "runrail-wildcard-"))
  try {
    await writeFile(join(root, "a".repeat(200)), "")
    const policy = await createWorkspacePolicy(root)
    expect(await policy.find("", pattern.slice(0, 256))).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
  expect(performance.now() - started).toBeLessThan(1_000)
})
