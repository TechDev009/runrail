import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverPiExtensions, PiExtensionHost } from "../../src/plugins/pi/extensions.ts"
import { createRunrailRuntime, createRunrailSession } from "../../src/session.ts"
import { createRunrailSessionController } from "../../src/control.ts"

async function directory(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `${prefix}-`))
}

test("Pi extension host activates explicit extensions and bridges native contributions", async () => {
  const root = await directory("runrail-pi-extension")
  try {
    const discoveredRoot = join(root, ".pi", "agent", "extensions")
    await mkdir(discoveredRoot, { recursive: true })
    await writeFile(join(discoveredRoot, "discovered.ts"), `export default () => undefined\n`, "utf8")
    expect(await discoverPiExtensions(root)).toEqual([await realpath(join(discoveredRoot, "discovered.ts"))])
    const extensionPath = join(root, "fixture.ts")
    await writeFile(
      extensionPath,
      `
export const id = "fixture.pi"
export const capabilities = ["filesystem.read"]
export default (pi) => {
  pi.registerCommand("hello", {
    description: "Say hello",
    aliases: ["hi"],
    handler: async (args, ctx) => { ctx.ui.setStatus("fixture", args); return "hello:" + args }
  })
  pi.registerShortcut("ctrl-x", { handler: () => "shortcut" })
  pi.registerFlag("verbose", false)
  pi.registerTool({
    name: "fixture_echo",
    description: "Echo fixture input",
    capabilities: ["filesystem.read"],
    execute: async (input) => input.value
  })
  pi.registerTool({
    name: "fixture_pi_signature",
    label: "Pi signature",
    description: "Exercise the Pi three-argument tool callback",
    execute: async (toolCallId, input, signal) => toolCallId + ":" + input.value + ":" + signal.aborted
  })
  pi.registerUI({ id: "fixture.panel", slot: "sidebar", label: "Fixture" })
  pi.registerMarkdownTransformer("fixture.markdown", (value) => value.toUpperCase())
  pi.on("input", (event) => ({ text: event.text + "!" }))
}
`,
      "utf8",
    )

    const host = new PiExtensionHost({ cwd: root, trustedCapabilities: ["filesystem.read"] })
    await expect(host.activate(extensionPath)).rejects.toMatchObject({ code: "PI_EXTENSION_TRUST_REQUIRED" })
    const descriptor = await host.activate(extensionPath, { approvalGranted: true })
    expect(descriptor).toMatchObject({ id: "fixture.pi" })

    expect(host.snapshot().plugins).toEqual(["fixture.pi"])
    expect(host.snapshot().commands.map((command) => command.name)).toEqual(["hello"])
    expect(host.snapshot().tools.map((tool) => tool.name)).toEqual(["fixture_echo", "fixture_pi_signature"])
    await expect(host.commandRegistry.dispatch("hi", ["world"])).resolves.toBe("hello:world")
    expect(host.hotkeyRegistry.resolve("ctrl-x")).toMatchObject({ command: "pi.fixture.pi.shortcut.ctrl-x" })
    const tool = host.snapshot().tools[0]
    if (tool === undefined) throw new Error("fixture tool was not registered")
    await expect(tool.execute({ value: "ok" }, { cwd: root, signal: new AbortController().signal })).resolves.toBe("ok")
    const piSignatureTool = host.snapshot().tools.find((candidate) => candidate.name === "fixture_pi_signature")
    if (piSignatureTool === undefined) throw new Error("Pi signature fixture tool was not registered")
    await expect(piSignatureTool.execute({ value: "ok" }, { cwd: root, signal: new AbortController().signal })).resolves.toMatch(/^pi-call-.*:ok:false$/)
    await expect(host.emit("input", { text: "go", source: "interactive" })).resolves.toMatchObject({ text: "go!" })
    expect(host.uiSnapshot().statuses.fixture).toBe("world")
    expect(host.uiSnapshot().widgets).toEqual({})
    expect(host.providerRegistrationsSnapshot()).toEqual([])
    expect(host.rendererSnapshot().map((renderer) => renderer.id)).toEqual(["fixture.markdown"])
    expect(host.rendererSnapshot()[0]?.render("ok")).toBe("OK")
    await expect(createRunrailRuntime({ cwd: root, backend: "native", piExtensions: host })).resolves.toMatchObject({ plugins: { plugins: ["fixture.pi"] } })

    await expect(host.deactivate("fixture.pi")).resolves.toBe(true)
    expect(host.snapshot().plugins).toEqual([])
    expect(host.commandRegistry.get("hello")).toBeUndefined()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("Pi extension host fails closed for unsafe paths and capabilities", async () => {
  const root = await directory("runrail-pi-extension-security")
  try {
    const extensionPath = join(root, "unsafe.ts")
    await writeFile(extensionPath, `export default () => undefined\n`, "utf8")
    const host = new PiExtensionHost({ cwd: root })
    await expect(host.activate("../unsafe.ts", { approvalGranted: true })).rejects.toMatchObject({ code: "PI_EXTENSION_PATH_INVALID" })

    const deniedPath = join(root, "denied.ts")
    await writeFile(deniedPath, `export const capabilities = ["network.request"]\nexport default () => undefined\n`, "utf8")
    try {
      await host.activate(deniedPath, { approvalGranted: true })
      throw new Error("expected capability denial")
    } catch (error) {
      expect(error).toMatchObject({ code: "PI_EXTENSION_CAPABILITY_DENIED" })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("Pi extension reload preserves the last-known-good graph when staging fails", async () => {
  const root = await directory("runrail-pi-extension-reload")
  try {
    const extensionPath = join(root, "reload.ts")
    await writeFile(extensionPath, `export const id = "reload.pi"\nexport default (pi) => { if (globalThis.__runrailReloadBroken === true) throw new Error("broken reload")\n  pi.registerTool({ name: "reload_tool", description: "Reload fixture", execute: async () => "old" }) }\n`, "utf8")
    const host = new PiExtensionHost({ cwd: root })
    await host.activate(extensionPath, { approvalGranted: true })
    expect(host.snapshot().tools.map((tool) => tool.name)).toEqual(["reload_tool"])

    const globalState = globalThis as typeof globalThis & { __runrailReloadBroken?: boolean }
    globalState.__runrailReloadBroken = true
    try {
      await expect(host.reload()).rejects.toBeDefined()
      expect(host.snapshot().plugins).toEqual(["reload.pi"])
      const tool = host.snapshot().tools[0]
      if (tool === undefined) throw new Error("last-known-good tool was lost")
      await expect(tool.execute({}, { cwd: root, signal: new AbortController().signal })).resolves.toBe("old")
    } finally {
      delete globalState.__runrailReloadBroken
    }
    await writeFile(extensionPath, `export const id = "reload.pi"\nexport default (pi) => { pi.registerTool({ name: "reload_new", description: "Reload fixture", execute: async () => "new" }) }\n`, "utf8")
    await expect(host.reload()).resolves.toHaveLength(1)
    expect(host.snapshot().tools.map((tool) => tool.name)).toEqual(["reload_new"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("Pi extension reload loads a file again only when it has changed", async () => {
  const root = await directory("runrail-pi-extension-reuse")
  const globalState = globalThis as typeof globalThis & { __runrailPiLoads?: number }
  try {
    const extensionPath = join(root, "reuse.ts")
    const source = (name: string) => `globalThis.__runrailPiLoads = (globalThis.__runrailPiLoads ?? 0) + 1\nexport const id = "reuse.pi"\nexport default (pi) => { pi.registerTool({ name: "${name}", description: "Reuse fixture", execute: async () => "ok" }) }\n`
    await writeFile(extensionPath, source("reuse_one"), "utf8")
    const host = new PiExtensionHost({ cwd: root })
    await host.activate(extensionPath, { approvalGranted: true })
    await host.reload()
    await host.reload()
    expect(globalState.__runrailPiLoads).toBe(1)
    await writeFile(extensionPath, source("reuse_two"), "utf8")
    await host.reload()
    expect(globalState.__runrailPiLoads).toBe(2)
    expect(host.snapshot().tools.map((tool) => tool.name)).toEqual(["reuse_two"])
  } finally {
    delete globalState.__runrailPiLoads
    await rm(root, { recursive: true, force: true })
  }
})

test("controller refresh rebuilds the native model host with reloaded Pi tools", async () => {
  const root = await directory("runrail-pi-extension-controller")
  const globalState = globalThis as typeof globalThis & { __runrailRefreshVersion?: string }
  try {
    const extensionPath = join(root, "refresh.ts")
    await writeFile(
      extensionPath,
      `export const id = "refresh.pi"\nexport default (pi) => { const version = globalThis.__runrailRefreshVersion ?? "old"\n  pi.registerTool({ name: "refresh_" + version, description: "Refresh fixture", execute: async () => version }) }\n`,
      "utf8",
    )
    globalState.__runrailRefreshVersion = "old"
    const host = new PiExtensionHost({ cwd: root })
    await host.activate(extensionPath, { approvalGranted: true })
    const controller = await createRunrailSessionController({
      cwd: root,
      backend: "native",
      loadExtensions: false,
      model: { complete: () => ({ type: "text", text: "refresh" }) },
      piExtensions: host,
    })
    try {
      expect(controller.session.plugins?.tools.map((tool) => tool.name)).toContain("refresh_old")
      globalState.__runrailRefreshVersion = "new"
      await expect(controller.refreshSession()).resolves.toMatchObject({ backend: "native" })
      expect(controller.session.plugins?.tools.map((tool) => tool.name)).toContain("refresh_new")
      expect(controller.session.plugins?.tools.map((tool) => tool.name)).not.toContain("refresh_old")
    } finally {
      await controller.close()
      await host.close()
    }
  } finally {
    delete globalState.__runrailRefreshVersion
    await rm(root, { recursive: true, force: true })
  }
})

test("the Pi adapter covers its declared surface without becoming the native harness contract", async () => {
  const root = await directory("runrail-pi-extension-surface")
  try {
    const extensionPath = join(root, "surface.ts")
    await writeFile(
      extensionPath,
      `
export const id = "surface.pi"
export const capabilities = ["filesystem.read"]
export default (pi) => {
  pi.registerCommand("surface", {
    description: "Surface fixture",
    aliases: ["s"],
    handler: async (_args, ctx) => { ctx.ui.setStatus("command", "ran"); return "command-ok" }
  })
  pi.registerShortcut("ctrl-y", { handler: () => "shortcut-ok" })
  pi.registerFlag("verbose", "yes")
  pi.registerTool({ name: "surface_echo", description: "Echo", capabilities: ["filesystem.read"], execute: async (input) => input.value })
  pi.registerTool({ name: "surface_pi", description: "Pi callback", execute: async (toolCallId, input, signal) => toolCallId + ":" + input.value + ":" + signal.aborted })
  pi.registerProvider({
    name: "surface-provider",
    description: "Fixture provider",
    capabilities: ["streaming"],
    adapter: {
      descriptor: { id: "surface-model", provider: "surface-provider", version: "1", tier: "cheap", capabilities: ["streaming"], contextTokens: 1024 },
      create: () => ({ complete: () => ({ type: "text", text: "surface-model" }) })
    }
  })
  pi.registerUI({ id: "surface.ui", slot: "sidebar", label: "Surface", theme: { name: "surface", accent: "#00aaff" }, status: { text: "ready" } })
  pi.registerMessageRenderer("surface.message", (value) => "message:" + value)
  pi.registerEntryRenderer("surface.entry", (value) => "entry:" + value)
  pi.registerMarkdownTransformer("surface.markdown", (value) => value.toUpperCase())
  pi.on("input", (event) => ({ text: event.text + "!" }))
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("flag", String(pi.getFlag("verbose")))
    ctx.ui.setStatus("tools", pi.getActiveTools().join(","))
    ctx.ui.setWidget("surface", ["above", "below"], "aboveEditor")
    ctx.ui.setHeader("surface-header")
    ctx.ui.setFooter("surface-footer")
    ctx.ui.setTitle("surface-title")
    ctx.ui.setEditorText("draft")
    ctx.ui.pasteToEditor("-next")
    ctx.ui.setWorkingMessage("working")
    ctx.ui.setWorkingVisible(false)
    ctx.ui.setWorkingIndicator([".", ".."], 50)
    ctx.ui.setHiddenThinkingLabel("thinking")
    ctx.ui.setToolsExpanded(true)
    ctx.ui.setTheme("surface-theme")
    ctx.ui.notify("surface-ready", "info")
    pi.setSessionName("surface-session")
    pi.setActiveTools(["surface_echo", "surface_pi"])
    pi.appendEntry("surface.entry", { ok: true })
    pi.sendMessage("queued-message")
    pi.sendUserMessage("queued-user-message")
    const exec = await pi.exec("fixture", ["arg"])
    ctx.ui.setStatus("exec", String(exec))
    ctx.ui.setStatus("session", pi.getSessionName() ?? "missing")
  })
  pi.on("tool_call", (event, ctx) => { ctx.ui.setStatus("tool-call", event.toolName) })
  pi.on("tool_result", (event, ctx) => { ctx.ui.setStatus("tool-result", event.toolName + ":" + event.isError) })
}
`,
      "utf8",
    )

    const messages: string[] = []
    const userMessages: string[] = []
    const entries: string[] = []
    const host = new PiExtensionHost({
      cwd: root,
      trustedCapabilities: ["filesystem.read", "streaming"],
      runtime: {
        mode: "tui",
        sessionId: () => "surface-session-id",
        exec: async (command, args) => `${command}:${args.join(",")}`,
        sendMessage: (message) => { messages.push(message) },
        sendUserMessage: (message) => { userMessages.push(message) },
        appendEntry: (type) => { entries.push(type) },
      },
    })
    await host.activate(extensionPath, { approvalGranted: true })

    expect(host.snapshot().commands.map((command) => command.name)).toEqual(["surface"])
    expect(host.snapshot().tools.map((tool) => tool.name)).toEqual(["surface_echo", "surface_pi"])
    expect(host.snapshot().ui).toHaveLength(1)
    expect(host.providerRegistrationsSnapshot().map((provider) => provider.name)).toEqual(["surface-provider"])
    expect(host.snapshot().providers.map((provider) => provider.descriptor.id)).toEqual(["surface-model"])
    expect(host.rendererSnapshot().map((renderer) => renderer.id)).toEqual(["surface.message", "surface.entry", "surface.markdown"])
    expect(host.rendererSnapshot().find((renderer) => renderer.id === "surface.markdown")?.render("ok")).toBe("OK")
    await expect(host.commandRegistry.dispatch("s", [])).resolves.toBe("command-ok")
    expect(host.hotkeyRegistry.resolve("ctrl-y")).toMatchObject({ command: "pi.surface.pi.shortcut.ctrl-y" })

    const input = await host.emit("input", { text: "go", source: "interactive" })
    expect(input.text).toBe("go!")
    await host.emit("session_start", { sessionId: "surface-session-id" })
    expect(host.uiSnapshot()).toMatchObject({
      header: "surface-header",
      footer: "surface-footer",
      title: "surface-title",
      editorText: "draft-next",
      workingMessage: "working",
      workingVisible: false,
      hiddenThinkingLabel: "thinking",
      toolsExpanded: true,
      theme: "surface-theme",
      statuses: {
        command: "ran",
        flag: "yes",
        tools: "surface_echo,surface_pi",
        exec: "fixture:arg",
        session: "surface-session",
      },
      widgets: { surface: { content: ["above", "below"], placement: "aboveEditor" } },
    })
    expect(host.uiSnapshot().notifications).toContainEqual({ message: "surface-ready", type: "info" })
    expect(host.entriesSnapshot()).toEqual([{ customType: "surface.entry", data: { ok: true } }])
    expect(messages).toEqual(["queued-message"])
    expect(userMessages).toEqual(["queued-user-message"])
    expect(entries).toEqual(["surface.entry"])

    const echo = host.snapshot().tools.find((tool) => tool.name === "surface_echo")
    const piTool = host.snapshot().tools.find((tool) => tool.name === "surface_pi")
    if (echo === undefined || piTool === undefined) throw new Error("surface tools were not registered")
    const signal = new AbortController().signal
    await expect(echo.execute({ value: "ok" }, { cwd: root, signal })).resolves.toBe("ok")
    await expect(piTool.execute({ value: "ok" }, { cwd: root, signal })).resolves.toMatch(/^pi-call-.*:ok:false$/)
    expect(host.uiSnapshot().statuses["tool-call"]).toBe("surface_pi")
    expect(host.uiSnapshot().statuses["tool-result"]).toBe("surface_pi:false")

    await host.deactivate("surface.pi")
    expect(host.snapshot().plugins).toEqual([])
    expect(host.snapshot().commands).toEqual([])
    expect(host.snapshot().tools).toEqual([])
    expect(host.providerRegistrationsSnapshot()).toEqual([])
    expect(host.rendererSnapshot()).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("Pi adapter rejects handler failures, conflicts, unsupported UI fields, and unavailable exec", async () => {
  const root = await directory("runrail-pi-extension-refusal")
  try {
    const handlerPath = join(root, "handler.ts")
    await writeFile(handlerPath, `export default (pi) => { pi.on("session_start", () => { throw new Error("secret handler detail") }) }\n`, "utf8")
    const handlerHost = new PiExtensionHost({ cwd: root })
    await handlerHost.activate(handlerPath, { approvalGranted: true })
    await expect(handlerHost.emit("session_start", { sessionId: "fixture" })).rejects.toMatchObject({ code: "PI_EXTENSION_HANDLER_FAILED" })
    await expect(handlerHost.emit("session_start", { sessionId: "fixture" })).rejects.not.toThrow("secret handler detail")

    const conflictPath = join(root, "conflict.ts")
    await writeFile(conflictPath, `export const id = "conflict.pi"\nexport default (pi) => { pi.registerCommand("same", { description: "one", handler: () => undefined }); pi.registerCommand("same", { description: "two", handler: () => undefined }) }\n`, "utf8")
    const conflictHost = new PiExtensionHost({ cwd: root })
    await expect(conflictHost.activate(conflictPath, { approvalGranted: true })).rejects.toMatchObject({ code: "PI_EXTENSION_CONFLICT" })

    const uiPath = join(root, "ui.ts")
    await writeFile(uiPath, `export const id = "ui.pi"\nexport default (pi) => { pi.registerUI({ id: "bad", slot: "terminal", label: "Bad" }) }\n`, "utf8")
    const uiHost = new PiExtensionHost({ cwd: root })
    await expect(uiHost.activate(uiPath, { approvalGranted: true })).rejects.toMatchObject({ code: "PI_EXTENSION_CONTRIBUTION_INVALID" })

    const execPath = join(root, "exec.ts")
    await writeFile(execPath, `export const id = "exec.pi"\nexport default (pi) => { pi.on("session_start", async () => { await pi.exec("fixture") }) }\n`, "utf8")
    const execHost = new PiExtensionHost({ cwd: root })
    await execHost.activate(execPath, { approvalGranted: true })
    await expect(execHost.emit("session_start", { sessionId: "fixture" })).rejects.toMatchObject({ code: "PI_EXTENSION_HANDLER_FAILED" })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("an extension whose disposer throws is still fully removed by close", async () => {
  const root = await directory("runrail-pi-extension-dispose")
  try {
    const extensionPath = join(root, "dispose.ts")
    await writeFile(extensionPath, `export const id = "dispose.pi"\nexport default (pi) => { pi.registerTool({ name: "dispose_tool", description: "Tool", execute: async () => "ok" }); return { dispose: () => { throw new Error("dispose failed") } } }\n`, "utf8")
    const host = new PiExtensionHost({ cwd: root })
    await host.activate(extensionPath, { approvalGranted: true })
    expect(host.snapshot().tools.map((tool) => tool.name)).toEqual(["dispose_tool"])
    await expect(host.close()).rejects.toThrow("dispose failed")
    expect(host.snapshot()).toMatchObject({ plugins: [], tools: [] })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a Pi tool switched off is not offered to the model and refuses to run", async () => {
  const root = await directory("runrail-pi-extension-active")
  try {
    const extensionPath = join(root, "active.ts")
    await writeFile(extensionPath, `export const id = "active.pi"\nexport default (pi) => {\n  pi.registerTool({ name: "kept_tool", description: "Kept", execute: async () => "kept" })\n  pi.registerTool({ name: "off_tool", description: "Off", execute: async () => "ran" })\n  pi.on("session_start", () => { pi.setActiveTools(["kept_tool"]) })\n}\n`, "utf8")
    const host = new PiExtensionHost({ cwd: root })
    await host.activate(extensionPath, { approvalGranted: true })
    const offered: string[][] = []
    const session = await createRunrailSession({
      cwd: root,
      backend: "native",
      loadExtensions: false,
      verifyAfterTurn: false,
      piExtensions: host,
      model: { complete: (request) => (offered.push(request.tools.map((tool) => tool.name)), { type: "text", text: "done" }) },
    })
    try {
      for await (const _event of session.prompt("go")) {}
      expect(offered[0]).toContain("kept_tool")
      expect(offered[0]).not.toContain("off_tool")
      const off = host.snapshot().tools.find((tool) => tool.name === "off_tool")!
      await expect(Promise.resolve(off.execute({}, { cwd: root, signal: new AbortController().signal }))).rejects.toMatchObject({ code: "PI_EXTENSION_TOOL_BLOCKED" })
    } finally {
      await session.stop("test complete")
      await host.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a Pi extension reload picks up an edited helper the entry imports", async () => {
  const root = await directory("runrail-pi-extension-helper")
  try {
    const extensionPath = join(root, "helper-entry.ts")
    await writeFile(join(root, "helper.ts"), `export const toolName = "helper_one"\n`, "utf8")
    await writeFile(extensionPath, `import { toolName } from "./helper.ts"\nexport const id = "helper.pi"\nexport default (pi) => { pi.registerTool({ name: toolName, description: "Helper fixture", execute: async () => toolName }) }\n`, "utf8")
    const host = new PiExtensionHost({ cwd: root })
    await host.activate(extensionPath, { approvalGranted: true })
    expect(host.snapshot().tools.map((tool) => tool.name)).toEqual(["helper_one"])
    await writeFile(join(root, "helper.ts"), `export const toolName = "helper_two"\n`, "utf8")
    await host.reload()
    expect(host.snapshot().tools.map((tool) => tool.name)).toEqual(["helper_two"])
    await host.close()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
