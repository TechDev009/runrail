import { readdir, readFile, readlink } from "node:fs/promises"
import { basename } from "node:path"

/**
 * Listening TCP ports among this engine's descendants: dev servers an agent or a terminal started.
 * Only the executable's name is kept, never its arguments, and nothing here signals a process.
 */
export interface ListeningServer {
  readonly port: number
  readonly host: string
  readonly process: string
}

export interface ServerScan {
  readonly available: boolean
  readonly servers: readonly ListeningServer[]
}

interface ProcessRow {
  readonly pid: number
  readonly ppid: number
  readonly name: string
}

const MAX_ROWS = 20_000
const MAX_PIDS = 512
const MAX_SERVERS = 32
const MAX_OUTPUT = 2 * 1024 * 1024
const TIMEOUT_MS = 3_000
const MAX_FDS = 4_096

export function parseProcessTable(text: string): readonly ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of text.split("\n")) {
    if (rows.length >= MAX_ROWS) break
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    if (match === null) continue
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), name: basename(match[3] ?? "").slice(0, 64) })
  }
  return rows
}

export function descendantsOf(rows: readonly ProcessRow[], root: number): readonly ProcessRow[] {
  const children = new Map<number, ProcessRow[]>()
  for (const row of rows) {
    if (row.pid === row.ppid) continue
    const list = children.get(row.ppid) ?? []
    list.push(row)
    children.set(row.ppid, list)
  }
  const found: ProcessRow[] = []
  const seen = new Set<number>([root])
  const queue = [root]
  while (queue.length > 0 && found.length < MAX_PIDS) {
    for (const child of children.get(queue.shift() as number) ?? []) {
      if (seen.has(child.pid)) continue
      seen.add(child.pid)
      found.push(child)
      queue.push(child.pid)
    }
  }
  return found
}

/** `lsof -F pn` output: a `p<pid>` line, then `n<host>:<port>` lines for that process. */
export function parseListening(text: string, names: ReadonlyMap<number, string>): readonly ListeningServer[] {
  const servers = new Map<string, ListeningServer>()
  let pid: number | undefined
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1))
    else if (line.startsWith("n") && pid !== undefined) {
      const match = /^(.*):(\d{1,5})$/.exec(line.slice(1))
      const port = Number(match?.[2])
      if (match === null || !Number.isInteger(port) || port < 1 || port > 65_535) continue
      const host = (match[1] ?? "").replace(/^\[|\]$/g, "") || "*"
      // A server on both IPv4 and IPv6 is one server.
      if (!servers.has(String(port))) servers.set(String(port), { port, host, process: names.get(pid) ?? "process" })
    }
    if (servers.size >= MAX_SERVERS) break
  }
  return [...servers.values()].sort((a, b) => a.port - b.port)
}

/** `/proc/<pid>/stat`: the name sits in parentheses and may hold spaces or parentheses itself. */
export function parseProcStat(text: string): ProcessRow | undefined {
  const open = text.indexOf("(")
  const close = text.lastIndexOf(")")
  if (open < 1 || close < open) return undefined
  const pid = Number(text.slice(0, open).trim())
  const ppid = Number(text.slice(close + 2).split(" ")[1])
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) return undefined
  return { pid, ppid, name: text.slice(open + 1, close).slice(0, 64) }
}

/** `/proc/net/tcp` or `tcp6`: listening sockets (state 0A) by inode. Addresses are hex words in host order. */
export function parseProcNet(text: string): ReadonlyMap<string, { readonly host: string; readonly port: number }> {
  const sockets = new Map<string, { host: string; port: number }>()
  for (const line of text.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/)
    const [address, portHex] = (fields[1] ?? "").split(":")
    const inode = fields[9]
    if (fields[3] !== "0A" || address === undefined || portHex === undefined || inode === undefined || inode === "0") continue
    const port = Number.parseInt(portHex, 16)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) continue
    sockets.set(inode, { host: procHost(address), port })
  }
  return sockets
}

function procHost(hex: string): string {
  if (/^0+$/.test(hex)) return "*"
  // Each 32-bit word is little-endian on the machines Runrail runs on (x86_64, aarch64).
  const bytes = (hex.match(/.{8}/g) ?? []).flatMap((word) => (word.match(/../g) ?? []).reverse().map((byte) => Number.parseInt(byte, 16)))
  if (bytes.length === 4) return bytes.join(".")
  if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 255 && bytes[11] === 255) return bytes.slice(12).join(".")
  const groups = Array.from({ length: 8 }, (_, index) => (((bytes[index * 2] ?? 0) << 8) | (bytes[index * 2 + 1] ?? 0)).toString(16))
  const joined = groups.join(":")
  const run = /(?:^|:)0(?::0)+(?::|$)/.exec(joined)
  return run === null ? joined : `${joined.slice(0, run.index)}::${joined.slice(run.index + run[0].length)}`
}

/** Linux without `ps` or `lsof`, which minimal installs and containers lack: the same answer read from /proc. */
async function scanProc(root: number): Promise<ServerScan> {
  let entries: string[]
  try {
    entries = (await readdir("/proc")).filter((entry) => /^\d+$/.test(entry)).slice(0, MAX_ROWS)
  } catch {
    return { available: false, servers: [] }
  }
  const stats = await Promise.all(entries.map((pid) => readFile(`/proc/${pid}/stat`, "utf8").then(parseProcStat, () => undefined)))
  const descendants = descendantsOf(stats.filter((row): row is ProcessRow => row !== undefined), root)
  if (descendants.length === 0) return { available: true, servers: [] }
  const sockets = new Map<string, { host: string; port: number }>()
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const text = await readFile(file, "utf8").catch(() => "")
    for (const [inode, socket] of parseProcNet(text.slice(0, MAX_OUTPUT))) sockets.set(inode, socket)
  }
  const servers = new Map<number, ListeningServer>()
  for (const row of descendants) {
    const fds = await readdir(`/proc/${row.pid}/fd`).catch(() => [] as string[])
    for (const fd of fds.slice(0, MAX_FDS)) {
      const target = await readlink(`/proc/${row.pid}/fd/${fd}`).catch(() => "")
      const socket = sockets.get(/^socket:\[(\d+)\]$/.exec(target)?.[1] ?? "")
      // A server on both IPv4 and IPv6 is one server.
      if (socket !== undefined && !servers.has(socket.port)) servers.set(socket.port, { ...socket, process: row.name })
    }
    if (servers.size >= MAX_SERVERS) break
  }
  return { available: true, servers: [...servers.values()].sort((a, b) => a.port - b.port).slice(0, MAX_SERVERS) }
}

export async function scanServers(root = process.pid): Promise<ServerScan> {
  if (process.platform === "linux") return scanProc(root)
  if (process.platform !== "darwin") return { available: false, servers: [] }
  const table = await run(["ps", "-A", "-o", "pid=,ppid=,comm="])
  if (table === undefined) return { available: false, servers: [] }
  const descendants = descendantsOf(parseProcessTable(table), root)
  if (descendants.length === 0) return { available: true, servers: [] }
  const listing = await run(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", descendants.map((row) => row.pid).join(","), "-F", "pn"])
  // lsof exits 1 when nothing listens; an unrunnable lsof is reported as unavailable.
  if (listing === undefined) return { available: false, servers: [] }
  return { available: true, servers: parseListening(listing, new Map(descendants.map((row) => [row.pid, row.name]))) }
}

async function run(argv: readonly string[]): Promise<string | undefined> {
  let child: ReturnType<typeof Bun.spawn>
  try {
    child = Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { PATH: "/usr/sbin:/usr/bin:/bin:/sbin" } })
  } catch {
    return undefined
  }
  const timer = setTimeout(() => child.kill(), TIMEOUT_MS)
  try {
    const text = await readCapped(child.stdout as ReadableStream<Uint8Array>, MAX_OUTPUT)
    const code = await child.exited
    if (code !== 0 && code !== 1) return undefined
    return text
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/** The first `maxBytes` of a stream; the rest is drained unread so the child is never blocked on it. */
async function readCapped(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of stream) {
    if (total >= maxBytes) continue
    const kept = chunk.byteLength > maxBytes - total ? chunk.subarray(0, maxBytes - total) : chunk
    chunks.push(kept)
    total += kept.byteLength
  }
  return Buffer.concat(chunks).toString("utf8")
}
