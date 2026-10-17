import { afterEach, beforeEach, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { doctorText, runDoctor, type DoctorOptions } from "../../src/doctor.ts"
import type { HarnessProbe, HarnessProbeTarget } from "../../src/harness/detect.ts"

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "runrail-doctor-"))
})

afterEach(async () => {
  await chmod(root, 0o700).catch(() => undefined)
  await rm(root, { recursive: true, force: true })
})

function options(overrides: Partial<DoctorOptions> = {}): DoctorOptions {
  const tools: Partial<Record<HarnessProbeTarget, HarnessProbe>> = { "claude-code": { installed: true, version: "2.1.0", signedIn: true }, codex: { installed: true, version: "0.160.0", signedIn: false } }
  return {
    accountsDir: join(root, "accounts"),
    sessionsDir: join(root, "sessions"),
    credentialStore: { detail: "Keys are read from the system keychain.", fallback: false },
    bunVersion: "1.4.2",
    probe: async (target) => tools[target] ?? { installed: false },
    gitVersion: async (cwd) => ({ version: "2.50.1", ...(cwd === undefined ? {} : { inRepository: false }) }),
    agentSdk: () => "missing",
    ...overrides,
  }
}

test("doctor reports each piece and passes when nothing is broken", async () => {
  const checks = await runDoctor(options())
  const by = (name: string) => checks.find((check) => check.name === name)
  expect(by("Bun")).toEqual({ name: "Bun", level: "ok", detail: "1.4.2" })
  expect(by("Claude Code")).toEqual({ name: "Claude Code", level: "ok", detail: "2.1.0, signed in" })
  expect(by("Codex")?.level).toBe("warn")
  expect(by("Goose")).toEqual({ name: "Goose", level: "off", detail: "not installed" })
  // Claude Code is there, so a missing SDK is worth a warning.
  expect(by("Claude Agent SDK")?.level).toBe("warn")
  expect(by("Project")).toBeUndefined()
  expect(checks.some((check) => check.level === "fail")).toBe(false)
  expect(doctorText(checks)).toContain("Ready, with 2 warnings.")
})

test("an old Bun and a folder that cannot be written are failures", async () => {
  await mkdir(join(root, "locked"))
  await chmod(join(root, "locked"), 0o500)
  const checks = await runDoctor(options({ bunVersion: "1.2.9", sessionsDir: join(root, "locked", "sessions") }))
  expect(checks.find((check) => check.name === "Bun")?.level).toBe("fail")
  expect(checks.find((check) => check.name === "Sessions folder")?.level).toBe("fail")
  expect(doctorText(checks)).toContain("2 problems to fix.")
})

test("a project folder outside git and a fallback key store are warnings", async () => {
  const checks = await runDoctor(options({ cwd: root, credentialStore: { detail: "file vault", fallback: true }, agentSdk: () => "installed" }))
  expect(checks.find((check) => check.name === "Project")?.level).toBe("warn")
  expect(checks.find((check) => check.name === "Key store")?.level).toBe("warn")
  expect(checks.find((check) => check.name === "Claude Agent SDK")?.level).toBe("ok")
})

test("without git or Claude Code, git warns and the SDK is not mentioned as a problem", async () => {
  const checks = await runDoctor(options({ gitVersion: async () => ({}), probe: async () => ({ installed: false }) }))
  expect(checks.find((check) => check.name === "git")?.level).toBe("warn")
  expect(checks.find((check) => check.name === "Claude Agent SDK")?.level).toBe("off")
})

test("a missing SDK says how to install it; one the desktop has not downloaded yet says it waits for a yes", async () => {
  const missing = (await runDoctor(options({ agentSdkInstallCommand: "bun add -g @anthropic-ai/claude-agent-sdk@^0.3.288" }))).find((check) => check.name === "Claude Agent SDK")
  expect(missing?.detail).toContain("cannot ask before tools. Install it with: bun add -g @anthropic-ai/claude-agent-sdk@^0.3.288 (https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)")
  const waiting = (await runDoctor(options({ agentSdk: () => "installable" }))).find((check) => check.name === "Claude Agent SDK")
  expect(waiting).toEqual({ name: "Claude Agent SDK", level: "warn", detail: "not downloaded yet; Runrail Desktop downloads it when you allow it" })
  expect((await runDoctor(options({ agentSdk: () => "downloaded" }))).find((check) => check.name === "Claude Agent SDK")?.level).toBe("ok")
})
