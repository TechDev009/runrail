import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { McpStdioTransport } from "../../src/mcp/transport.ts"

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 3_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await check()) return true
    await Bun.sleep(20)
  }
  return false
}

test.skipIf(process.platform === "win32")("closing an MCP stdio server also ends the helpers it started", async () => {
  const dir = await mkdtemp(join("/tmp", "runrail-process-group-"))
  const pidFile = join(dir, "helper.pid")
  try {
    const transport = new McpStdioTransport({ command: "sh", args: ["-c", `sleep 30 & echo $! > ${pidFile}; cat >/dev/null`] })
    expect(await waitFor(async () => (await readFile(pidFile, "utf8").catch(() => "")).trim().length > 0)).toBe(true)
    const helper = Number((await readFile(pidFile, "utf8")).trim())
    expect(alive(helper)).toBe(true)
    await transport.close()
    expect(await waitFor(() => !alive(helper))).toBe(true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
