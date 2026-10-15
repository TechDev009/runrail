import { afterEach, expect, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import type { AgentEvent } from "@nifrajs/agent-protocol"
import { createRunrailSession } from "../../src/session.ts"

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

interface TurnOptions {
  readonly verificationCommand?: string
  readonly verifyAfterTurn?: boolean
  readonly nifra?: boolean
  readonly manifest?: Record<string, unknown>
}

async function turn(options: TurnOptions = {}): Promise<readonly AgentEvent[]> {
  const { manifest, ...sessionOptions } = options
  const cwd = await mkdtemp(join("/tmp", "runrail-verify-optional-"))
  cleanup.push(() => rm(cwd, { recursive: true, force: true }))
  if (manifest !== undefined) await writeFile(join(cwd, "package.json"), JSON.stringify(manifest))
  const session = await createRunrailSession({ cwd, backend: "native", loadExtensions: false, verify: "check", maxRepairAttempts: 0, defaultSystemPrompt: false, model: { complete: () => ({ type: "text", text: "ok" }) }, ...sessionOptions })
  cleanup.push(() => session.close())
  const events: AgentEvent[] = []
  for await (const event of session.prompt("hello")) events.push(event)
  return events
}

/** PATH holds only a stand-in `nifra` that passes and leaves a mark, and no RUNRAIL_NIFRA_COMMAND. */
async function withNifraOnPath(installed: boolean, body: (ran: () => boolean) => Promise<void>): Promise<void> {
  const saved = { path: process.env.PATH, command: process.env.RUNRAIL_NIFRA_COMMAND }
  const bin = await mkdtemp(join("/tmp", "runrail-nifra-path-"))
  const mark = join(bin, "ran")
  if (installed) {
    await writeFile(join(bin, "nifra"), `#!/bin/sh\n: > '${mark}'\necho '{"ok":true,"diagnostics":[]}'\n`)
    await chmod(join(bin, "nifra"), 0o755)
  }
  process.env.PATH = bin
  delete process.env.RUNRAIL_NIFRA_COMMAND
  try {
    await body(() => existsSync(mark))
  } finally {
    process.env.PATH = saved.path
    if (saved.command !== undefined) process.env.RUNRAIL_NIFRA_COMMAND = saved.command
    await rm(bin, { recursive: true, force: true })
  }
}

const checked = (events: readonly AgentEvent[]) => events.find((event) => event.type === "verification.completed")

test("without a Nifra gate installed, a turn skips the check instead of failing", async () => {
  await withNifraOnPath(false, async () => {
    const events = await turn({ manifest: { dependencies: { "@nifrajs/agent": "5.3.0" } } })
    expect(events.some((event) => event.type === "session.completed")).toBe(true)
    expect(checked(events)).toBeUndefined()
  })
})

test("with `nifra` installed, a workspace that is not a Nifra project skips the check", async () => {
  await withNifraOnPath(true, async (ran) => {
    const events = await turn({ manifest: { name: "app", devDependencies: { typescript: "5.9.3" } } })
    expect(events.some((event) => event.type === "session.completed")).toBe(true)
    expect(checked(events)).toBeUndefined()
    expect(ran()).toBe(false)
  })
})

test("with `nifra` installed, a Nifra project is checked after the turn", async () => {
  await withNifraOnPath(true, async (ran) => {
    const events = await turn({ manifest: { dependencies: { "@nifrajs/agent": "5.3.0" } } })
    expect(checked(events)).toMatchObject({ name: "check", ok: true })
    expect(ran()).toBe(true)
  })
})

test("verifyAfterTurn: true runs the installed gate outside a Nifra project too", async () => {
  await withNifraOnPath(true, async (ran) => {
    const events = await turn({ verifyAfterTurn: true, manifest: { name: "app" } })
    expect(checked(events)).toMatchObject({ name: "check", ok: true })
    expect(ran()).toBe(true)
  })
})

test("with Nifra turned off, a Nifra project is not checked by the installed gate", async () => {
  await withNifraOnPath(true, async (ran) => {
    expect(checked(await turn({ nifra: false, manifest: { dependencies: { "@nifrajs/agent": "5.3.0" } } }))).toBeUndefined()
    process.env.RUNRAIL_NIFRA = "off"
    try {
      expect(checked(await turn({ verifyAfterTurn: true, manifest: { dependencies: { "@nifrajs/agent": "5.3.0" } } }))).toBeUndefined()
    } finally {
      delete process.env.RUNRAIL_NIFRA
    }
    expect(ran()).toBe(false)
  })
})

test("a check command the caller chose still has to run: one that cannot is a failed check, with why", async () => {
  const events = await turn({ verificationCommand: "/nonexistent/runrail-verifier" })
  const check = checked(events)
  expect(check).toMatchObject({ name: "check", ok: false, report: { unavailable: true } })
  expect(JSON.stringify(check)).toContain("is not installed or cannot run")
})
