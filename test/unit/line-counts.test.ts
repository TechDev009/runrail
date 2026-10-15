import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { lineCounts } from "../../src/tools/line-counts.ts"
import { createWriteFileTool } from "../../src/tools/write-file.ts"
import { createWorkspacePolicy } from "../../src/workspace/policy.ts"

describe("counting the lines a write changed", () => {
  test("counts a new, emptied, or unchanged file", () => {
    expect(lineCounts("", "a\nb\n")).toEqual({ additions: 2, deletions: 0 })
    expect(lineCounts("a\nb\n", "")).toEqual({ additions: 0, deletions: 2 })
    expect(lineCounts("a\nb\n", "a\nb\n")).toEqual({ additions: 0, deletions: 0 })
    // A missing final newline is not a line of its own.
    expect(lineCounts("a\nb", "a\nb\n")).toEqual({ additions: 0, deletions: 0 })
  })

  test("counts only the changed middle of an overwrite", () => {
    expect(lineCounts("one\ntwo\nthree\n", "one\n2\nthree\n")).toEqual({ additions: 1, deletions: 1 })
    expect(lineCounts("one\nthree\n", "one\ntwo\nthree\n")).toEqual({ additions: 1, deletions: 0 })
    // Lines kept between changes are not counted.
    expect(lineCounts("a\nb\nc\nd\ne\n", "x\nb\nc\ny\ne\n")).toEqual({ additions: 2, deletions: 2 })
    // A line that moved is one removal and one addition.
    expect(lineCounts("a\nb\nc\n", "b\nc\na\n")).toEqual({ additions: 1, deletions: 1 })
  })

  test("counts a large rewrite by line frequency without the exact match", () => {
    const old = Array.from({ length: 3_000 }, (_, index) => `line ${String(index)}`)
    const next = [...old].reverse()
    next[0] = "changed"
    const counts = lineCounts(`x\n${old.join("\n")}\ny\n`, `z\n${next.join("\n")}\nw\n`)
    // Order is not compared past the limit, so only the changed line and the two ends count.
    expect(counts).toEqual({ additions: 3, deletions: 3 })
  })
})

describe("write_file reports what it changed", () => {
  test("says whether the file is new and counts an overwrite against what it held", async () => {
    const root = await mkdtemp(join("/tmp", "runrail-line-counts-"))
    try {
      const write = createWriteFileTool(await createWorkspacePolicy(root), { allowWrite: true })
      const context = { cwd: root, signal: new AbortController().signal }
      expect(await write.execute({ path: "notes.txt", content: "a\nb\nc\n" }, context)).toEqual({ path: "notes.txt", bytes: 6, created: true, additions: 3, deletions: 0 })
      expect(await write.execute({ path: "notes.txt", content: "a\nB\nc\nd\n" }, context)).toEqual({ path: "notes.txt", bytes: 8, created: false, additions: 2, deletions: 1 })
      expect(await readFile(join(root, "notes.txt"), "utf8")).toBe("a\nB\nc\nd\n")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("gives no counts when the old file cannot be read", async () => {
    const root = await mkdtemp(join("/tmp", "runrail-line-counts-big-"))
    try {
      await writeFile(join(root, "big.txt"), "x".repeat(256 * 1024 + 1))
      const write = createWriteFileTool(await createWorkspacePolicy(root), { allowWrite: true })
      expect(await write.execute({ path: "big.txt", content: "small\n" }, { cwd: root, signal: new AbortController().signal })).toEqual({ path: "big.txt", bytes: 6, created: false })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
