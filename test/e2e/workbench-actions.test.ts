import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createRunrailSessionController } from "../../src/control.ts"
import { RunrailWorkbench } from "../../src/workbench/state.ts"
import { createContextResourceSet } from "../../src/context/resources.ts"
import { createWorkspacePolicy } from "../../src/workspace/policy.ts"
import { createWorkbenchResourcePicker } from "../../src/workbench/resources.ts"
import { createWorkspaceDiffReview } from "../../src/workbench/diff.ts"
import { MultiAgentCoordinator } from "../../src/agents/index.ts"
import { FileTranscriptStore } from "../../src/transcript/index.ts"
import { WorkbenchCommandRegistry } from "../../src/workbench/commands.ts"

test("workbench actions expose bounded session and review controls", async () => {
  const cwd = await mkdtemp(join("/tmp", "runrail-workbench-actions-"))
  const sessionDir = await mkdtemp(join("/tmp", "runrail-workbench-actions-store-"))
  try {
    await writeFile(join(cwd, "index.ts"), "const value = 1\n", "utf8")
    const policy = await createWorkspacePolicy(cwd)
    const context = await createContextResourceSet(policy)
    const resources = await createWorkbenchResourcePicker(policy, context)
    const diff = createWorkspaceDiffReview(policy)
    const agents = new MultiAgentCoordinator({ cwd, profiles: [{ id: "worker", role: "worker", capabilities: [] }], executor: { run: ({ spec }) => ({ output: spec.id }) } })
    const controller = await createRunrailSessionController({
      cwd,
      sessionDir,
      backend: "native",
      loadExtensions: false,
      model: { complete: () => ({ type: "text", text: "action complete" }) },
    })
    const workbench = new RunrailWorkbench(controller, { resources, diffReview: diff, agentCoordinator: agents, width: 50, height: 10 })
    try {
      expect(workbench.view().providers.map((provider) => provider.id)).toEqual(["anthropic", "bedrock", "google", "llama.cpp", "openai", "openai-compatible", "vertex", "xai"])
      expect(workbench.view().harnesses.map((harness) => harness.id)).toEqual(["aider", "claude-code", "codex", "copilot", "gemini", "goose", "opencode", "pi", "pty"])
      await workbench.dispatch({ type: "text", text: "finish" })
      await workbench.dispatch({ type: "submit" })
      await workbench.waitForIdle()
      await workbench.dispatch({ type: "action", action: { type: "agent.list" } })
      await workbench.dispatch({ type: "action", action: { type: "agent.run", task: { id: "worker-run", profile: "worker", prompt: "inspect" } } })
      expect(workbench.view().agents).toEqual(["worker"])
      expect(workbench.view().team).toMatchObject({ profiles: [{ id: "worker" }], completed: 1, running: 0, failed: 0, cancelled: 0 })
      await workbench.dispatch({ type: "action", action: { type: "agent.status" } })
      expect(workbench.view().scrollback.join("\n")).toContain("agents runs=1")
      await workbench.dispatch({ type: "action", action: { type: "session.tree" } })
      await workbench.dispatch({ type: "action", action: { type: "session.history", limit: 8 } })
      await workbench.dispatch({ type: "action", action: { type: "session.fork", targetSessionId: "action-child" } })
      const exported = await workbench.exportEvidence()
      expect(JSON.parse(exported)).toMatchObject({ version: 1, sessionId: expect.any(String) })
      expect(exported).not.toContain("finish")
      await workbench.dispatch({ type: "action", action: { type: "session.export" } })
      expect(workbench.view().scrollback.join("\n")).toContain("session evidence exported")
      await workbench.dispatch({ type: "action", action: { type: "resource.select", id: "index.ts" } })
      expect(workbench.view().selectedResource?.attachment).toMatchObject({ path: "index.ts", kind: "file" })
      await diff.capture(["index.ts"])
      await writeFile(join(cwd, "index.ts"), "const value = 2\n", "utf8")
      await workbench.dispatch({ type: "action", action: { type: "diff.refresh", paths: ["index.ts"] } })
      expect(workbench.view().diff).toMatchObject({ added: 1, removed: 1, truncated: false })
      expect(workbench.view().sessionTree.children).toContain("action-child")
      await workbench.dispatch({ type: "action", action: { type: "provider.switch", provider: { provider: "openai", model: "fixture-model", endpoint: "http://127.0.0.1:1", credential: { kind: "environment", environment: "RUNRAIL_FIXTURE_KEY" } } } })
      expect(workbench.view().model).toMatchObject({ id: "fixture-model", provider: "openai" })
    } finally {
      await workbench.close("action test complete")
    }
  } finally {
    await rm(cwd, { recursive: true, force: true })
    await rm(sessionDir, { recursive: true, force: true })
  }
})

test("workbench exposes caller-owned transcript controls without rendering payloads", async () => {
  const cwd = await mkdtemp(join("/tmp", "runrail-workbench-transcript-"))
  const transcriptRoot = await mkdtemp(join("/tmp", "runrail-workbench-transcript-store-"))
  const transcript = new FileTranscriptStore({ root: transcriptRoot })
  try {
    const controller = await createRunrailSessionController({
      cwd,
      backend: "native",
      loadExtensions: false,
      transcriptStore: transcript,
      model: { complete: () => ({ type: "text", text: "transcript response" }) },
    })
    const workbench = new RunrailWorkbench(controller, { width: 50, height: 10 })
    try {
      await workbench.dispatch({ type: "text", text: "secret transcript prompt" })
      await workbench.dispatch({ type: "submit" })
      await workbench.waitForIdle()

      const sessionId = controller.session.snapshot.id
      const records = await transcript.read(sessionId)
      expect(records.length).toBeGreaterThan(0)
      const exported = await workbench.exportTranscript()
      expect(exported).toContain("secret transcript prompt")

      await workbench.dispatch({ type: "action", action: { type: "session.transcript.export" } })
      expect(workbench.view().lastAction).toBe("session.transcript.export")
      expect(workbench.view().scrollback.join("\n")).toContain("session transcript exported")
      expect(workbench.view().scrollback.join("\n")).not.toContain("secret transcript prompt")

      await workbench.dispatch({ type: "action", action: { type: "session.transcript.branch", targetSessionId: "transcript-branch" } })
      await workbench.dispatch({ type: "action", action: { type: "session.transcript.import", transcript: exported, targetSessionId: "transcript-import" } })
      await workbench.dispatch({
        type: "action",
        action: {
          type: "session.transcript.compact",
          options: {
            throughSeq: records.at(-1)?.seq ?? 0,
            replacement: { kind: "message.summary", payload: { text: "private summary" } },
          },
        },
      })
      expect(workbench.view().lastAction).toBe("session.transcript.compact")
      // A branch is the same records plus a marker where the copy continues.
      const branched = await transcript.read("transcript-branch")
      expect(branched.map((record) => record.kind)).toEqual([...records.map((record) => record.kind), "session.continued"])
      expect((await transcript.read("transcript-import")).length).toBe(records.length)
    } finally {
      await workbench.close("transcript workbench test complete")
    }
  } finally {
    await rm(cwd, { recursive: true, force: true })
    await rm(transcriptRoot, { recursive: true, force: true })
  }
})

test("the workbench input line runs commands and answers approvals instead of prompting the model", async () => {
  const cwd = await mkdtemp(join("/tmp", "runrail-workbench-commands-"))
  const sessionDir = await mkdtemp(join("/tmp", "runrail-workbench-commands-store-"))
  try {
    await writeFile(join(cwd, "notes.txt"), "picked file\n", "utf8")
    const policy = await createWorkspacePolicy(cwd)
    const resources = await createWorkbenchResourcePicker(policy, await createContextResourceSet(policy))
    const prompts: string[] = []
    let step = 0
    const controller = await createRunrailSessionController({
      cwd,
      sessionDir,
      backend: "native",
      loadExtensions: false,
      model: {
        complete: (request) => {
          const last = request.messages.at(-1)
          if (last?.role === "user") prompts.push(last.text)
          step += 1
          return step === 1 ? { type: "tool", name: "write_file", input: { path: "made.txt", content: "approved\n" } } : { type: "text", text: "done" }
        },
      },
    })
    const enqueued: unknown[] = []
    const enqueue = controller.enqueue.bind(controller)
    controller.enqueue = (input, signal) => {
      enqueued.push(input)
      return enqueue(input, signal)
    }
    const ran: string[][] = []
    const commandRegistry = new WorkbenchCommandRegistry().register({ id: "fixture", description: "a fixture command", execute: ({ args }) => { ran.push([...args]); return "fixture ran" } })
    const workbench = new RunrailWorkbench(controller, { resources, commandRegistry, width: 80, height: 20 })
    const type = async (text: string): Promise<void> => {
      await workbench.dispatch({ type: "text", text })
      await workbench.dispatch({ type: "submit" })
    }
    try {
      await type(":fixture one two")
      expect(ran).toEqual([["one", "two"]])
      expect(workbench.view().scrollback.join("\n")).toContain("fixture ran")
      await type(":nonsense")
      expect(workbench.view().error).toContain("unknown command")
      await type(":approve")
      expect(workbench.view().error).toContain("nothing is waiting")
      expect(enqueued).toEqual([])

      await workbench.dispatch({ type: "action", action: { type: "resource.select", id: "notes.txt" } })
      await type("make the file")
      expect(enqueued).toEqual([{ text: "make the file", attachments: [{ path: "notes.txt", kind: "file" }] }])
      expect(workbench.view().selectedResource).toBeUndefined()
      // A fixed short poll lost this race under heavy machine load; wait for the prompt itself.
      const approvalShown = () => controller.session.pendingApprovals.length > 0 && workbench.view().scrollback.join("\n").includes(":approve or :deny")
      for (const deadline = Date.now() + 20_000; !approvalShown() && Date.now() < deadline; ) await Bun.sleep(10)
      expect(workbench.view().scrollback.join("\n")).toContain(":approve or :deny")
      await type(":approve")
      await workbench.waitForIdle()
      expect(await Bun.file(join(cwd, "made.txt")).text()).toBe("approved\n")
      expect(prompts.some((text) => text.startsWith(":"))).toBe(false)
      expect(enqueued).toHaveLength(1)
    } finally {
      await workbench.close("command test complete")
    }
  } finally {
    await rm(cwd, { recursive: true, force: true })
    await rm(sessionDir, { recursive: true, force: true })
  }
}, 30_000)
