import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { RUNRAIL_PLUGIN_MANIFEST_FILE } from "./manifest.ts"

export type PluginSourceKind = "directory" | "archive"
export type PluginArchiveFormat = "tar" | "tgz"

export interface PluginSourceDescriptor {
  readonly kind: PluginSourceKind
  readonly path: string
  readonly format?: PluginArchiveFormat
}

export interface ResolvedPluginSource {
  readonly root: string
  readonly descriptor: PluginSourceDescriptor
  readonly release?: () => PromiseLike<void> | void
}

export interface PluginSourceResolver {
  resolve(input: string): Promise<ResolvedPluginSource>
}

export interface LocalPluginSourceResolverOptions {
  readonly temporaryRoot: string
  readonly maxArchiveBytes?: number
  readonly maxArchiveFiles?: number
  readonly maxFileBytes?: number
}

export type PluginSourceErrorCode =
  | "PLUGIN_SOURCE_INVALID"
  | "PLUGIN_SOURCE_NOT_FOUND"
  | "PLUGIN_ARCHIVE_INVALID"
  | "PLUGIN_ARCHIVE_LIMIT"

export class PluginSourceError extends Error {
  constructor(readonly code: PluginSourceErrorCode, reason: string) {
    super(`plugin source: ${reason}`)
    this.name = "PluginSourceError"
  }
}

/** Local-first resolver for explicit directories and safe tar archives. */
export class LocalPluginSourceResolver implements PluginSourceResolver {
  private readonly temporaryRoot: string
  private readonly maxArchiveBytes: number
  private readonly maxArchiveFiles: number
  private readonly maxFileBytes: number

  constructor(options: LocalPluginSourceResolverOptions) {
    this.temporaryRoot = resolve(options.temporaryRoot)
    this.maxArchiveBytes = options.maxArchiveBytes ?? 128 * 1024 * 1024
    this.maxArchiveFiles = options.maxArchiveFiles ?? 8_192
    this.maxFileBytes = options.maxFileBytes ?? 8 * 1024 * 1024
    if (
      !Number.isSafeInteger(this.maxArchiveBytes) ||
      this.maxArchiveBytes < 1 ||
      this.maxArchiveBytes > 1_024 * 1024 * 1024 ||
      !Number.isSafeInteger(this.maxArchiveFiles) ||
      this.maxArchiveFiles < 1 ||
      this.maxArchiveFiles > 65_536 ||
      !Number.isSafeInteger(this.maxFileBytes) ||
      this.maxFileBytes < 1 ||
      this.maxFileBytes > 64 * 1024 * 1024
    )
      throw new PluginSourceError("PLUGIN_SOURCE_INVALID", "source limits are invalid")
  }

  async resolve(input: string): Promise<ResolvedPluginSource> {
    if (typeof input !== "string" || input.length === 0 || input.length > 4_096)
      throw new PluginSourceError("PLUGIN_SOURCE_INVALID", "source path is invalid")
    let path: string
    try {
      path = await realpath(resolve(input))
    } catch (error) {
      throw new PluginSourceError("PLUGIN_SOURCE_NOT_FOUND", error instanceof Error ? error.message : "source cannot be read")
    }
    let info
    try {
      info = await stat(path)
    } catch (error) {
      throw new PluginSourceError("PLUGIN_SOURCE_NOT_FOUND", error instanceof Error ? error.message : "source cannot be read")
    }
    if (info.isDirectory()) {
      return Object.freeze({ root: path, descriptor: Object.freeze({ kind: "directory", path }) })
    }
    if (!info.isFile()) throw new PluginSourceError("PLUGIN_SOURCE_INVALID", "source must be a directory or archive")
    const format = archiveFormat(path)
    if (format === undefined) throw new PluginSourceError("PLUGIN_SOURCE_INVALID", "archive format is unsupported")
    if (info.size > this.maxArchiveBytes) throw new PluginSourceError("PLUGIN_ARCHIVE_LIMIT", "archive exceeds byte limit")
    const archive = await readFile(path)
    if (archive.length > this.maxArchiveBytes) throw new PluginSourceError("PLUGIN_ARCHIVE_LIMIT", "archive exceeds byte limit")
    const temporary = await mkdtemp(join(this.temporaryRoot, ".source-"))
    try {
      await extractTar(temporary, format === "tgz" ? await gunzipBounded(archive, this.maxArchiveBytes) : archive, this.maxArchiveFiles, this.maxFileBytes)
      const root = await locatePackageRoot(temporary)
      return Object.freeze({
        root,
        descriptor: Object.freeze({ kind: "archive", path, format }),
        release: () => rm(temporary, { recursive: true, force: true }),
      })
    } catch (error) {
      await rm(temporary, { recursive: true, force: true })
      if (error instanceof PluginSourceError) throw error
      throw new PluginSourceError("PLUGIN_ARCHIVE_INVALID", error instanceof Error ? error.message : "archive extraction failed")
    }
  }
}

export function createLocalPluginSourceResolver(options: LocalPluginSourceResolverOptions): LocalPluginSourceResolver {
  return new LocalPluginSourceResolver(options)
}

/** Decompresses with a running count, so a small archive that expands without end stops at the limit. */
async function gunzipBounded(archive: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of new Blob([new Uint8Array(archive)]).stream().pipeThrough(new DecompressionStream("gzip"))) {
    total += chunk.byteLength
    if (total > maxBytes) throw new PluginSourceError("PLUGIN_ARCHIVE_LIMIT", "archive expands past its byte limit")
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function archiveFormat(path: string): PluginArchiveFormat | undefined {
  const lower = path.toLowerCase()
  if (lower.endsWith(".tar")) return "tar"
  if (lower.endsWith(".tgz") || lower.endsWith(".tar.gz")) return "tgz"
  return undefined
}

/** A pax record that names the entry or a link target, which this reader does not apply. */
function renamesEntry(records: Uint8Array): boolean {
  return /(?:^|\n)\d+ (?:path|linkpath)=/.test(new TextDecoder().decode(records))
}

async function extractTar(root: string, bytes: Uint8Array, maxFiles: number, maxFileBytes: number): Promise<void> {
  if (bytes.length === 0 || bytes.length % 512 !== 0) throw new PluginSourceError("PLUGIN_ARCHIVE_INVALID", "tar block alignment is invalid")
  let offset = 0
  let files = 0
  let totalBytes = 0
  let zeroBlocks = 0
  let entries = 0
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512)
    offset += 512
    if (header.every((value) => value === 0)) {
      zeroBlocks += 1
      if (zeroBlocks >= 2) break
      continue
    }
    zeroBlocks = 0
    // Directories and metadata headers count too, so an archive of empty ones is bounded as well.
    entries += 1
    if (entries > maxFiles * 4) throw new PluginSourceError("PLUGIN_ARCHIVE_LIMIT", "archive exceeds its entry limit")
    validateTarChecksum(header)
    const name = tarString(header.subarray(0, 100))
    const prefix = tarString(header.subarray(345, 500))
    const path = sanitizeArchivePath(prefix.length === 0 ? name : `${prefix}/${name}`)
    const type = header[156]
    const size = parseTarSize(header.subarray(124, 136))
    const blocks = Math.ceil(size / 512)
    const end = offset + blocks * 512
    if (end > bytes.length) throw new PluginSourceError("PLUGIN_ARCHIVE_INVALID", "tar entry exceeds archive")
    if (size > maxFileBytes) throw new PluginSourceError("PLUGIN_ARCHIVE_LIMIT", "archive file exceeds byte limit")
    if (type === 0 || type === 48) {
      files += 1
      totalBytes += size
      if (files > maxFiles || totalBytes > maxFiles * maxFileBytes) throw new PluginSourceError("PLUGIN_ARCHIVE_LIMIT", "archive exceeds file limits")
      const destination = safeArchiveDestination(root, path)
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, bytes.subarray(offset, offset + size), { flag: "wx" })
    } else if (type === 53) {
      // The typeflag is the ASCII digit '5'.
      await mkdir(safeArchiveDestination(root, path), { recursive: true })
    } else if ((type === 103 || type === 120) && !renamesEntry(bytes.subarray(offset, offset + size))) {
      // A pax header ('g' or 'x') that only carries metadata, as macOS tar adds for extended attributes.
    } else {
      throw new PluginSourceError("PLUGIN_ARCHIVE_INVALID", "archive contains a link or unsupported entry")
    }
    offset = end
  }
  if (zeroBlocks < 2) throw new PluginSourceError("PLUGIN_ARCHIVE_INVALID", "tar terminator is missing")
}

async function locatePackageRoot(temporary: string): Promise<string> {
  const directManifest = join(temporary, RUNRAIL_PLUGIN_MANIFEST_FILE)
  if (await isFile(directManifest)) return temporary
  const children = (await readdir(temporary, { withFileTypes: true })).filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
  const candidates: string[] = []
  for (const child of children) if (await isFile(join(temporary, child.name, RUNRAIL_PLUGIN_MANIFEST_FILE))) candidates.push(join(temporary, child.name))
  if (candidates.length !== 1) throw new PluginSourceError("PLUGIN_ARCHIVE_INVALID", "archive must contain one plugin root")
  return candidates[0]!
}

function validateTarChecksum(header: Uint8Array): void {
  const text = tarString(header.subarray(148, 156)).replace(/\0/g, "").trim()
  if (text.length === 0 || !/^[0-7]+$/.test(text)) throw new PluginSourceError("PLUGIN_ARCHIVE_INVALID", "tar checksum is invalid")
  const expected = Number.parseInt(text, 8)
  let actual = 0
  for (let index = 0; index < header.length; index += 1) actual += index >= 148 && index < 156 ? 0x20 : header[index]!
  if (!Number.isSafeInteger(expected) || actual !== expected) throw new PluginSourceError("PLUGIN_ARCHIVE_INVALID", "tar checksum is invalid")
}

function tarString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0)
  return new TextDecoder().decode(end < 0 ? bytes : bytes.subarray(0, end)).trim()
}

function parseTarSize(bytes: Uint8Array): number {
  const text = tarString(bytes).replace(/\0/g, "").trim()
  if (text.length === 0 || !/^[0-7]+$/.test(text)) throw new PluginSourceError("PLUGIN_ARCHIVE_INVALID", "tar size is invalid")
  const value = Number.parseInt(text, 8)
  if (!Number.isSafeInteger(value) || value < 0) throw new PluginSourceError("PLUGIN_ARCHIVE_INVALID", "tar size is invalid")
  return value
}

function sanitizeArchivePath(path: string): string {
  const normalized = path.replaceAll("\\", "/")
  if (normalized.length === 0 || normalized.includes("\0") || normalized.startsWith("/") || normalized.split("/").some((part) => part === ".."))
    throw new PluginSourceError("PLUGIN_ARCHIVE_INVALID", "archive path escapes extraction root")
  const result = normalized.split("/").filter((part) => part.length > 0 && part !== ".")
  if (result.length === 0) throw new PluginSourceError("PLUGIN_ARCHIVE_INVALID", "archive path is empty")
  return result.join("/")
}

function safeArchiveDestination(root: string, path: string): string {
  const destination = resolve(root, path)
  const rel = relative(resolve(root), destination)
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new PluginSourceError("PLUGIN_ARCHIVE_INVALID", "archive path escapes extraction root")
  return destination
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}
