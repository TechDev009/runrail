import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createRunrailSessionController } from "../../src/control.ts"
import { RunrailWorkbench, renderWorkbench } from "../../src/workbench/state.ts"
import { parseTerminalInput, TerminalInputDecoder } from "../../src/workbench/input.ts"
import { createWorkspaceDiffReview } from "../../src/workbench/diff.ts"
import { createWorkbenchResourcePicker } from "../../src/workbench/resources.ts"
import { WorkbenchThemeHost, defaultWorkbenchTheme } from "../../src/workbench/theme.ts"
import { runRunrailWorkbench } from "../../src/workbench/runner.ts"
import { HotkeyRegistry, WorkbenchCommandRegistry } from "../../src/workbench/commands.ts"
import { createContextResourceSet } from "../../src/context/resources.ts"
import { createWorkspacePolicy } from "../../src/workspace/policy.ts"

describe("native workbench parity", () => {
  test("decodes a character whose bytes arrive in separate chunks", () => {
    const decoder = new TerminalInputDecoder()
    const euro = new TextEncoder().encode("€!")
    expect([...decoder.feed(euro.subarray(0, 1)), ...decoder.feed(euro.subarray(1, 3)), ...decoder.feed(euro.subarray(3)), ...decoder.flush()]).toEqual([
      { type: "text", text: "€" },
      { type: "text", text: "!" },
    ])
  })

  test("decodes split ANSI input and editing controls", () => {
    const decoder = new TerminalInputDecoder()
    expect(decoder.feed("ab\x1b[")).toEqual([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ])
    expect(decoder.feed("D\x7f\r")).toEqual([
      { type: "left" },
      { type: "backspace" },
      { type: "submit" },
    ])
    expect(parseTerminalInput("\x1b[3~\x1b[5~\x03")).toEqual([
      { type: "delete" },
      { type: "pageUp" },
      { type: "interrupt" },
    ])
  })

  test("edits multiline input, keeps history, and renders bounded live output", async () => {
    const cwd = await mkdtemp(join("/tmp", "runrail-workbench-"))
    try {
      const controller = await createRunrailSessionController({
        cwd,
        backend: "native",
        loadExtensions: false,
        model: { complete: () => ({ type: "text", text: "workbench complete" }) },
      })
      const workbench = new RunrailWorkbench(controller, { width: 40, height: 8 })
      try {
        await workbench.dispatch({ type: "text", text: "line one" })
        await workbench.dispatch({ type: "newline" })
        await workbench.dispatch({ type: "text", text: "line two" })
        await workbench.dispatch({ type: "submit" })
        await workbench.waitForIdle()
        expect(workbench.view().input).toBe("")
        expect(workbench.view().scrollback).toContain("workbench complete")
        await workbench.dispatch({ type: "up" })
        expect(workbench.view().input).toBe("line one\nline two")
        await workbench.dispatch({ type: "home" })
        expect(workbench.view().cursor).toBe("line one\n".length)
        await workbench.dispatch({ type: "end" })
        expect(workbench.view().cursor).toBe("line one\nline two".length)
        await workbench.dispatch({ type: "resize", width: 60, height: 10 })
        expect(renderWorkbench(workbench.view())).toContain("native")
        expect(renderWorkbench(workbench.view())).not.toContain("\x1b[")
        const themed = renderWorkbench({ ...workbench.view(), theme: { ...defaultWorkbenchTheme(), tokens: { ...defaultWorkbenchTheme().tokens, accent: "#ff8800" } } })
        expect(themed).toContain("\x1b[38;5;8m")
        expect(themed).toContain("\x1b[38;2;255;136;0m>\x1b[39m")
      } finally {
        await workbench.close("test complete")
      }
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test("selects resources, reviews bounded diffs, and rolls back invalid themes", async () => {
    const cwd = await mkdtemp(join("/tmp", "runrail-workbench-resources-"))
    try {
      await writeFile(join(cwd, "AGENTS.md"), "Use project rules.\n", "utf8")
      await writeFile(join(cwd, "index.ts"), "const value = 1\n", "utf8")
      const policy = await createWorkspacePolicy(cwd)
      const context = await createContextResourceSet(policy)
      const picker = await createWorkbenchResourcePicker(policy, context)
      expect(picker.list("agents").map((entry) => entry.id)).toContain("context:AGENTS.md")
      expect(picker.select("index.ts")).toMatchObject({ path: "index.ts", attachment: { kind: "file" } })
      const review = createWorkspaceDiffReview(policy)
      await review.capture(["index.ts"])
      await writeFile(join(cwd, "index.ts"), "const value = 2\nconst next = true\n", "utf8")
      const diff = await review.inspect()
      expect(diff).toHaveLength(1)
      expect(diff[0]?.diff).toMatchObject({ added: 2, removed: 1, truncated: false })
      const themes = new WorkbenchThemeHost()
      expect(themes.reload([defaultWorkbenchTheme()])).toMatchObject({ rolledBack: false })
      const validRevision = themes.currentRevision
      expect(themes.reload([{ name: "bad", revision: "1", tokens: {} }])).toMatchObject({ rolledBack: true, revision: validRevision })
      expect(themes.themes[0]?.name).toBe("default")
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test("a long file or a long line gives a truncated diff instead of failing the review", async () => {
    const cwd = await mkdtemp(join("/tmp", "runrail-workbench-long-diff-"))
    try {
      await writeFile(join(cwd, "long.ts"), "", "utf8")
      const policy = await createWorkspacePolicy(cwd)
      const review = createWorkspaceDiffReview(policy, { maxLineChars: 4_096 })
      await review.capture(["long.ts"])
      const lines = Array.from({ length: 600 }, (_, index) => `line ${index}`)
      lines.push("x".repeat(5_000))
      await writeFile(join(cwd, "long.ts"), `${lines.join("\n")}\n`, "utf8")
      const [entry] = await review.inspect()
      expect(entry?.diff.truncated).toBe(true)
      expect(entry?.diff.added).toBeGreaterThan(0)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })


  test("runs the native workbench over an injected key transport", async () => {
    const cwd = await mkdtemp(join("/tmp", "runrail-workbench-runner-"))
    try {
      async function* keys(): AsyncIterable<import("../../src/workbench/input.ts").WorkbenchKey> {
        yield { type: "text", text: "finish" }
        yield { type: "submit" }
      }
      const output: string[] = []
      const status = await runRunrailWorkbench({
        cwd,
        backend: "native",
        loadExtensions: false,
        model: { complete: () => ({ type: "text", text: "runner complete" }) },
        input: keys(),
        output: { write: (text) => output.push(text) },
      })
      expect(status).toBe("completed")
      expect(output.join("" )).toContain("runner complete")
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
  test("a turn that fails makes the workbench exit failed", async () => {
    const cwd = await mkdtemp(join("/tmp", "runrail-workbench-failed-"))
    try {
      async function* keys(): AsyncIterable<import("../../src/workbench/input.ts").WorkbenchKey> {
        yield { type: "text", text: "go" }
        yield { type: "submit" }
      }
      const status = await runRunrailWorkbench({
        cwd,
        backend: "native",
        loadExtensions: false,
        model: { complete: () => { throw new Error("model is down") } },
        input: keys(),
        output: { write: () => undefined },
      })
      expect(status).toBe("failed")
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test("interrupts an active turn and exits with stopped status", async () => {
    const cwd = await mkdtemp(join("/tmp", "runrail-workbench-interrupt-"))
    try {
      async function* keys(): AsyncIterable<import("../../src/workbench/input.ts").WorkbenchKey> {
        yield { type: "text", text: "cancel" }
        yield { type: "submit" }
        yield { type: "interrupt" }
      }
      const output: string[] = []
      const status = await runRunrailWorkbench({
        cwd,
        backend: "native",
        loadExtensions: false,
        model: {
          complete: async () => {
            await new Promise((resolve) => setTimeout(resolve, 100))
            return { type: "text", text: "should not complete" }
          },
        },
        input: keys(),
        output: { write: (text) => output.push(text) },
      })
      expect(status).toBe("stopped")
      expect(output.join("")).toContain("stopped")
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test("dispatches admitted hotkeys through the bounded command registry", async () => {
    const cwd = await mkdtemp(join("/tmp", "runrail-workbench-hotkey-"))
    try {
      const commands = new WorkbenchCommandRegistry()
      commands.register({ id: "fixture.hotkey", description: "fixture hotkey", execute: () => "hotkey fired" })
      const hotkeys = new HotkeyRegistry()
      hotkeys.register({ key: "ctrl-l", command: "fixture.hotkey" })
      const controller = await createRunrailSessionController({ cwd, backend: "native", loadExtensions: false, model: { complete: () => ({ type: "text", text: "unused" }) } })
      const workbench = new RunrailWorkbench(controller, { commandRegistry: commands, hotkeyRegistry: hotkeys })
      try {
        await workbench.dispatch({ type: "clear" })
        expect(workbench.view().scrollback).toContain("hotkey fired")
        expect(workbench.view().lastAction).toBe("hotkey:ctrl-l")
      } finally {
        await workbench.close("test complete")
      }
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

test("modified and unknown escape sequences are read whole, and a paste never submits", async () => {
  const { parseTerminalInput, TerminalInputDecoder } = await import("../../src/workbench/input.ts")
  // Ctrl+Left, a focus report, Shift+Up in SS3 form, then plain text and Ctrl+C.
  expect(parseTerminalInput("\x1b[1;5D\x1b[I\x1bOAhi\x03").map((key) => key.type)).toEqual(["left", "escape", "up", "text", "text", "interrupt"])
  const decoder = new TerminalInputDecoder()
  expect(decoder.feed("\x1b[200~first line\nsecond")).toEqual([])
  expect(decoder.feed(" line\r\n\x1b[201~\r")).toEqual([
    { type: "text", text: "first line" },
    { type: "newline" },
    { type: "text", text: "second line" },
    { type: "newline" },
    { type: "submit" },
  ])
})

test("a streamed reply reads as one reply, with terminal escapes removed", async () => {
  const { ReplayBackend } = await import("@nifrajs/coding-agent")
  const cwd = await mkdtemp(join("/tmp", "runrail-workbench-stream-"))
  try {
    const base = { version: 1 as const, sessionId: "stream", at: 0 }
    const events = [
      { ...base, seq: 0, type: "turn.started" as const, turnId: "t", prompt: "go" },
      { ...base, seq: 1, type: "assistant.delta" as const, turnId: "t", text: "Hel" },
      { ...base, seq: 2, type: "assistant.delta" as const, turnId: "t", text: "lo\x1b]52;c;cGF3bmVk\x07 there\nsecond" },
      { ...base, seq: 3, type: "assistant.message" as const, turnId: "t", text: "Hello there\nsecond" },
    ]
    const controller = await createRunrailSessionController({ cwd, backend: "custom", adapter: { name: "custom", version: "1.0.0", capabilities: ["sessions"], create: () => new ReplayBackend({ events }) } })
    const workbench = new RunrailWorkbench(controller, { width: 60, height: 8 })
    try {
      await workbench.dispatch({ type: "text", text: "go" })
      await workbench.dispatch({ type: "submit" })
      await workbench.waitForIdle()
      const lines = workbench.view().scrollback
      expect(lines.filter((line) => line.startsWith("Hello"))).toEqual(["Hello]52;c;cGF3bmVk there"])
      expect(lines.filter((line) => line === "second")).toHaveLength(1)
      expect(lines.join("\n")).not.toContain("\x1b")
    } finally {
      await workbench.close("test complete")
    }
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
