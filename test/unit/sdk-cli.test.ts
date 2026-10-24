import { afterEach, expect, test } from "bun:test"
import { registerClaudeAgentSdkInstaller } from "../../src/backend/claude-agent-sdk.ts"
import { offerAgentSdk, parseSdkCliRequest, runSdkCli, type SdkCliIo } from "../../src/sdk-cli.ts"

afterEach(() => registerClaudeAgentSdkInstaller(undefined))

function installer(fails = false): { downloads: number } {
  const state = { downloads: 0 }
  registerClaudeAgentSdkInstaller({
    version: "0.3.288",
    command: "runrail sdk install",
    installed: () => state.downloads > 0,
    install: async () => {
      if (fails) throw new Error("agent SDK download failed: HTTP 503")
      state.downloads += 1
    },
  })
  return state
}

function io(answer?: boolean): SdkCliIo & { readonly lines: string[]; readonly asked: string[] } {
  const lines: string[] = []
  const asked: string[] = []
  return {
    lines,
    asked,
    out: (line) => lines.push(line),
    note: (line) => lines.push(line),
    ...(answer === undefined ? {} : { confirm: async (question: string) => { asked.push(question); return answer } }),
  }
}

test("sdk takes status and install, with --json for status and --yes for install", () => {
  expect(parseSdkCliRequest([])).toEqual({ action: "status", yes: false, json: false })
  expect(parseSdkCliRequest(["status", "--json"])).toEqual({ action: "status", yes: false, json: true })
  expect(parseSdkCliRequest(["install", "--yes"])).toEqual({ action: "install", yes: true, json: false })
  for (const argv of [["install", "--json"], ["status", "--yes"], ["remove"]]) expect(() => parseSdkCliRequest(argv)).toThrow("usage: runrail sdk")
})

test("install says what it downloads and from where, and downloads only after a yes", async () => {
  const state = installer()
  const declined = io(false)
  expect(await runSdkCli({ action: "install", yes: false, json: false }, declined, "/home/me/.runrail/agent-sdk")).toBe(1)
  expect(state.downloads).toBe(0)
  expect(declined.asked).toEqual(["Download it?"])
  expect(declined.lines.join("\n")).toContain("Claude Agent SDK 0.3.288 from npm into /home/me/.runrail/agent-sdk")
  expect(declined.lines.join("\n")).toContain("Anthropic's terms: https://code.claude.com/docs/en/legal-and-compliance")

  const nobody = io()
  expect(await runSdkCli({ action: "install", yes: false, json: false }, nobody, "/x")).toBe(2)
  expect(nobody.lines.at(-1)).toContain("runrail sdk install --yes")
  expect(state.downloads).toBe(0)

  const accepted = io(true)
  expect(await runSdkCli({ action: "install", yes: false, json: false }, accepted, "/x")).toBe(0)
  expect(state.downloads).toBe(1)
  expect(accepted.lines.at(-1)).toBe("Downloaded the Claude Agent SDK 0.3.288. Claude Code now asks before each tool.")

  const again = io()
  expect(await runSdkCli({ action: "install", yes: false, json: false }, again, "/x")).toBe(0)
  expect(again.lines).toEqual(["The Claude Agent SDK is ready, downloaded in /x. Claude Code asks before each tool."])
  expect(state.downloads).toBe(1)
})

test("--yes downloads without asking, and a failed download says why", async () => {
  installer(true)
  const failed = io()
  expect(await runSdkCli({ action: "install", yes: true, json: false }, failed, "/x")).toBe(1)
  expect(failed.lines.at(-1)).toBe("The Claude Agent SDK was not downloaded: agent SDK download failed: HTTP 503")
})

test("status names the folder and the command, and an engine without an installer names the package command", async () => {
  installer()
  const json = io()
  await runSdkCli({ action: "status", yes: false, json: true }, json, "/x")
  expect(JSON.parse(json.lines[0] ?? "{}")).toMatchObject({ ready: false, source: "installable", version: "0.3.288", downloadCommand: "runrail sdk install", directory: "/x" })
  registerClaudeAgentSdkInstaller(undefined)
  const plain = io()
  await runSdkCli({ action: "status", yes: false, json: false }, plain, "/x")
  expect(plain.lines[0]).toContain("is not installed, so Claude Code runs in print mode and cannot ask before tools. Install it with: bun add")
  expect(await runSdkCli({ action: "install", yes: true, json: false }, io(), "/x")).toBe(1)
})

test("a Claude Code run asks to download it when someone can answer, and otherwise names the command", async () => {
  const state = installer()
  const unattended = io()
  await offerAgentSdk(unattended, "/x")
  expect(unattended.lines.join("\n")).toContain("Claude Code is running in print mode, so it cannot ask before it uses a tool.")
  expect(unattended.lines.join("\n")).toContain("\n  runrail sdk install\n")

  const declined = io(false)
  await offerAgentSdk(declined, "/x")
  expect(declined.asked).toEqual(["Download it now?"])
  expect(declined.lines.at(-1)).toBe("Claude Code runs in print mode this time. To download the SDK later, run: runrail sdk install")
  expect(state.downloads).toBe(0)

  await offerAgentSdk(io(true), "/x")
  expect(state.downloads).toBe(1)
  const ready = io(true)
  await offerAgentSdk(ready, "/x")
  expect([ready.lines, ready.asked]).toEqual([[], []])
})
