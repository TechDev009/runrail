import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { runRunrailConsole } from "../../src/console.ts"
import { WorkbenchCommandRegistry } from "../../src/workbench/commands.ts"
import { PiExtensionHost } from "../../src/plugins/pi/extensions.ts"

// `:quit` cancels a turn still running, so it waits for the replay's answer.
async function* input(output: readonly string[]): AsyncIterable<string> {
  yield ":backends"
  yield ":backend replay"
  yield "run replay"
  const deadline = Date.now() + 10_000
  while (!output.join("").includes("Replay completed.") && Date.now() < deadline) await Bun.sleep(10)
  yield ":quit"
}

test("native console discovers and switches backends through the control facade", async () => {
  const cwd = await mkdtemp(join("/tmp", "runrail-console-"))
  const output: string[] = []
  try {
    const status = await runRunrailConsole({
      cwd,
      backend: "native",
      input: input(output),
      output: { write: (text) => output.push(text) },
      loadExtensions: false,
      model: { complete: () => ({ type: "text", text: "native" }) },
    })
    expect(status).toBe("stopped")
    expect(output.join("")).toContain("backend: replay")
    expect(output.join("")).toContain("Replay completed.")
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test("native console dispatches a bounded caller command", async () => {
  const cwd = await mkdtemp(join("/tmp", "runrail-console-command-"))
  const output: string[] = []
  const commands = new WorkbenchCommandRegistry()
  commands.register({ id: "fixture.echo", description: "echo fixture args", execute: ({ args }) => args.join("|") })
  try {
    const status = await runRunrailConsole({
      cwd,
      backend: "native",
      input: (async function* (): AsyncIterable<string> { yield ":fixture.echo one two"; yield ":quit" })(),
      output: { write: (text) => output.push(text) },
      commandRegistry: commands,
      loadExtensions: false,
      model: { complete: () => ({ type: "text", text: "unused" }) },
    })
    expect(status).toBe("stopped")
    expect(output.join("")).toContain("one|two")
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test("native console exposes explicitly activated Pi extension commands", async () => {
  const cwd = await mkdtemp(join("/tmp", "runrail-console-pi-extension-"))
  const extensionPath = join(cwd, "extension.ts")
  const host = new PiExtensionHost({ cwd })
  const output: string[] = []
  try {
    await writeFile(extensionPath, `export const id = "console.pi"\nexport default (pi) => { pi.registerCommand("pi.echo", { description: "Pi echo", handler: async (args) => "pi:" + args }) }\n`, "utf8")
    await host.activate(extensionPath, { approvalGranted: true })
    const status = await runRunrailConsole({
      cwd,
      backend: "native",
      input: (async function* (): AsyncIterable<string> { yield ":pi.echo hello"; yield ":quit" })(),
      output: { write: (text) => output.push(text) },
      loadExtensions: false,
      piExtensions: host,
      model: { complete: () => ({ type: "text", text: "unused" }) },
    })
    expect(status).toBe("stopped")
    expect(output.join(" ")).toContain("pi:hello")
  } finally {
    await host.close()
    await rm(cwd, { recursive: true, force: true })
  }
})

test("an approval the session cannot take is reported and the console keeps going", async () => {
  const cwd = await mkdtemp(join("/tmp", "runrail-console-approve-"))
  const output: string[] = []
  async function* lines(): AsyncIterable<string> {
    yield ":approve no-such-approval yes"
    yield ":approve bad\u0000id yes"
    yield ":backends"
    yield ":quit"
  }
  try {
    const status = await runRunrailConsole({ cwd, backend: "native", input: lines(), output: { write: (text) => output.push(text) }, loadExtensions: false, model: { complete: () => ({ type: "text", text: "native" }) } })
    expect(status).toBe("stopped")
    expect(output.join("")).toContain("error:")
    expect(output.join("")).toContain("replay")
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test("the console shows a streamed reply once, without its terminal escapes, and reports a failed turn", async () => {
  const cwd = await mkdtemp(join("/tmp", "runrail-console-escapes-"))
  const escape = "\x1b]52;c;ZXZpbA==\x07"
  const output: string[] = []
  try {
    const status = await runRunrailConsole({
      cwd,
      backend: "native",
      input: (async function* (): AsyncIterable<string> { yield "hello" })(),
      output: { write: (text) => output.push(text) },
      loadExtensions: false,
      model: {
        complete: async function* () {
          yield { type: "text_delta" as const, text: `streamed ${escape}reply` }
          yield { type: "response" as const, response: { type: "text" as const, text: `streamed ${escape}reply` } }
        },
      },
    })
    expect(status).toBe("completed")
    const text = output.join("")
    // The escape is defused, its bytes shown as text, and the reply appears once.
    expect(text.split("streamed ")).toHaveLength(2)
    expect(text).not.toContain("\x1b")
    expect(text).not.toContain("\x07")

    const failing: string[] = []
    const failed = await runRunrailConsole({
      cwd,
      backend: "native",
      input: (async function* (): AsyncIterable<string> { yield "hello" })(),
      output: { write: (text) => failing.push(text) },
      loadExtensions: false,
      model: { complete: () => { throw new Error("model is down") } },
    })
    expect(failing.join("")).toContain("session failed")
    expect(failed).toBe("failed")
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
