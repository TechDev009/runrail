import { expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import type { AgentEvent } from "@nifrajs/agent-protocol"
import { CodexAppServerBackend } from "../../src/index.ts"
import { ImageService } from "../../src/images/service.ts"
import { IMAGE_TOOL_SPECS } from "../../src/images/tools.ts"
import { createWorkspacePolicy } from "../../src/workspace/policy.ts"

/** Codex's dynamic image tool. */

const fixture = new URL("../fixtures/codex-app-server.ts", import.meta.url).pathname
const PNG = Buffer.from("89504e470d0a1a0a0000000d494844520000000200000003080600000000000000", "hex")

async function turn(backend: CodexAppServerBackend, sessionId: string): Promise<{ method: string; tools: string[]; result: { success: boolean; contentItems: Record<string, string>[] } }> {
  const events: AgentEvent[] = []
  for await (const event of backend.send({ sessionId, message: "draw a fox" })) events.push(event)
  const message = events.find((event) => event.type === "assistant.message")
  if (message?.type !== "assistant.message") throw new Error("the fixture gave no answer")
  return JSON.parse(message.text)
}

test("a new Codex thread starts with the image tool, and the picture comes back for the model to see", async () => {
  const root = await mkdtemp("/tmp/runrail-codex-images-")
  const policy = await createWorkspacePolicy(root)
  const images = new ImageService(async () => ({ mediaType: "image/png", bytes: new Uint8Array(PNG) }))
  images.bind({
    choice: async () => ({ connectionId: "conn-1", model: "gpt-image-1", route: "images" }),
    connection: async () => ({ name: "OpenAI", options: { provider: "openai", credential: { kind: "caller", account: "conn-1" } } }),
    workspace: () => policy,
  })
  const backend = new CodexAppServerBackend({ command: process.execPath, args: [fixture, "images"], images })
  const session = await backend.createSession({ cwd: root, sessionId: "codex-images-new" })
  const answer = await turn(backend, session.id)
  expect(answer.tools).toEqual(IMAGE_TOOL_SPECS.map((spec) => spec.name))
  expect(answer.result.success).toBe(true)
  expect(answer.result.contentItems[0]?.text).toContain("Saved a 2x3 PNG to fox.png, made by gpt-image-1 through OpenAI.")
  expect(answer.result.contentItems[1]).toEqual({ type: "inputImage", imageUrl: `data:image/png;base64,${PNG.toString("base64")}` })
  expect(await readdir(root)).toEqual(["fox.png"])
  await backend.close(session.id)
  await rm(root, { recursive: true, force: true })
})

test("without the image tool, a call to it is refused", async () => {
  const backend = new CodexAppServerBackend({ command: process.execPath, args: [fixture, "images"] })
  const session = await backend.createSession({ cwd: "/tmp", sessionId: "codex-images-off" })
  const answer = await turn(backend, session.id)
  expect(answer.tools).toEqual([])
  expect(answer.result).toEqual({ success: false, contentItems: [{ type: "inputText", text: "This thread has no image tool." }] })
  await backend.close(session.id)
})
