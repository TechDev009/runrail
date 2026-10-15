import type { GitChange } from "./status.ts"

export interface RawDiffRecord {
  readonly path: string
  readonly originalPath?: string
  readonly change: GitChange
  readonly submodule: boolean
}

export interface NumstatRecord {
  readonly additions: number
  readonly deletions: number
  readonly binary: boolean
}

export interface ParsedDiffMeta {
  readonly records: readonly RawDiffRecord[]
  readonly stats: ReadonlyMap<string, NumstatRecord>
}

/** Parses `git diff --raw --numstat -z` output. Unmerged paths reported twice are merged. */
export function parseRawNumstat(output: string, outputTruncated: boolean): ParsedDiffMeta {
  const tokens = output.split("\0")
  tokens.pop()
  if (outputTruncated) tokens.pop()
  const records: RawDiffRecord[] = []
  const seen = new Set<string>()
  const stats = new Map<string, NumstatRecord>()
  let index = 0
  while (index < tokens.length && (tokens[index] ?? "").startsWith(":")) {
    const header = (tokens[index] ?? "").slice(1).split(" ")
    const status = header[4] ?? ""
    const letter = status[0] ?? "M"
    const twoPaths = letter === "R" || letter === "C"
    const first = tokens[index + 1]
    const second = twoPaths ? tokens[index + 2] : undefined
    index += twoPaths ? 3 : 2
    if (first === undefined || (twoPaths && second === undefined)) break
    const path = twoPaths ? (second ?? first) : first
    if (seen.has(path)) continue
    seen.add(path)
    records.push(Object.freeze({
      path,
      ...(twoPaths ? { originalPath: first } : {}),
      change: rawChange(letter),
      submodule: header[0] === "160000" || header[1] === "160000",
    }))
  }
  while (index < tokens.length) {
    const token = tokens[index] ?? ""
    const match = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(token)
    if (match === null) break
    let path = match[3] ?? ""
    index += 1
    if (path.length === 0) {
      const next = tokens[index + 1]
      if (next === undefined) break
      path = next
      index += 2
    }
    const binary = match[1] === "-" || match[2] === "-"
    if (!stats.has(path))
      stats.set(path, Object.freeze({ additions: binary ? 0 : Number(match[1]), deletions: binary ? 0 : Number(match[2]), binary }))
  }
  return { records: Object.freeze(records), stats }
}

export interface PatchChunk {
  readonly header: string
  readonly text: string
}

/** Splits a unified `git diff -p` stream into per-file chunks. The final chunk is partial when truncated. */
export function splitPatch(output: string): readonly PatchChunk[] {
  const chunks: PatchChunk[] = []
  const starts: number[] = []
  const pattern = /^diff --(?:git|cc|combined) /gm
  for (let match = pattern.exec(output); match !== null; match = pattern.exec(output)) starts.push(match.index)
  for (let position = 0; position < starts.length; position += 1) {
    const start = starts[position] ?? 0
    const end = starts[position + 1] ?? output.length
    const text = output.slice(start, end)
    const newline = text.indexOf("\n")
    chunks.push({ header: newline < 0 ? text : text.slice(0, newline), text })
  }
  return chunks
}

/** True when a patch chunk header names `path`. Quoted headers (C-escaped names) are accepted positionally. */
export function headerMatches(header: string, path: string): boolean {
  if (header.startsWith("diff --cc ") || header.startsWith("diff --combined ")) return header.endsWith(` ${path}`)
  return header.endsWith(` b/${path}`) || header.includes("\"")
}

function rawChange(letter: string): GitChange {
  switch (letter) {
    case "A": return "added"
    case "D": return "deleted"
    case "R": return "renamed"
    case "C": return "copied"
    case "T": return "typechange"
    case "U": return "unmerged"
    default: return "modified"
  }
}
