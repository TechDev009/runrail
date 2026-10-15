import { readdir } from "node:fs/promises"
import { join } from "node:path"

// Bun 1.4.2 on macOS can block in wait4 at a PTY spawn after other suites.
// Separate runtimes avoid that shared spawn state; no test failure is retried away.
const files: string[] = []
for (const directory of ["test/unit", "test/conformance", "test/e2e"]) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".test.ts")) files.push(join(directory, entry.name))
  }
}
files.sort()
if (files.length === 0 || files.length > 1024) throw new Error("test file count is invalid")
let passed = 0
let skipped = 0
const failures: string[] = []
for (const file of files) {
  const child = Bun.spawn([process.execPath, "test", file], { stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try { process.kill(-child.pid, "SIGKILL") } catch { child.kill("SIGKILL") }
  }, 120_000)
  const output = Promise.all([boundedOutput(child.stdout), boundedOutput(child.stderr)])
  try {
    const status = await child.exited
    const text = (await output).join("\n")
    if (status !== 0 || timedOut) {
      failures.push(file)
      console.error(`FAIL ${file}${timedOut ? " (file timeout)" : ""}\n${text.slice(-12000)}`)
      continue
    }
    passed += Number(/\b(\d+) pass\b/.exec(text)?.[1] ?? 0)
    skipped += Number(/\b(\d+) skip\b/.exec(text)?.[1] ?? 0)
    console.log(`PASS ${file}`)
  } finally {
    clearTimeout(timer)
    // A test process is not permission to leave descendants running.
    try { process.kill(-child.pid, "SIGKILL") } catch { /* group already gone */ }
  }
}
console.log(`${passed} pass, ${skipped} skip, ${failures.length} failed files across ${files.length} files`)
if (failures.length > 0) process.exitCode = 1

async function boundedOutput(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder()
  let text = ""
  for await (const bytes of stream) text = `${text}${decoder.decode(bytes, { stream: true })}`.slice(-512 * 1024)
  return `${text}${decoder.decode()}`
}
