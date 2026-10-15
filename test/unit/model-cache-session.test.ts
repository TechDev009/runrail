import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { NativeModelResponse } from "@nifrajs/coding-agent"
import { createRunrailSession } from "../../src/session.ts"

class MemoryCache {
  private readonly values = new Map<string, NativeModelResponse>()
  get(key: string): NativeModelResponse | undefined { return this.values.get(key) }
  set(key: string, response: NativeModelResponse): void { this.values.set(key, response) }
}

test("a cached answer is reused only for the same attachments", async () => {
  const cwd = await mkdtemp(join("/tmp", "runrail-model-cache-"))
  const cache = new MemoryCache()
  const seen: string[] = []
  const run = async (body: string): Promise<string | undefined> => {
    await writeFile(join(cwd, "notes.txt"), body, "utf8")
    const session = await createRunrailSession({
      cwd,
      backend: "native",
      loadExtensions: false,
      cache,
      modelSelection: { id: "reader" },
      contentModel: {
        complete: (request) => {
          const text = request.parts.map((part) => ("text" in part ? part.text : "")).join("")
          seen.push(text)
          return { type: "text", text: text.includes("two") ? "saw two" : "saw one" }
        },
      },
      contentModelDescriptor: { id: "reader", provider: "fixture", version: "1.0.0", tier: "strong", capabilities: ["tools"], contextTokens: 4096 },
    })
    try {
      let answer: string | undefined
      for await (const event of session.prompt({ text: "summarize", attachments: [{ path: "notes.txt", kind: "file" }] })) if (event.type === "assistant.message") answer = event.text
      return answer
    } finally {
      await session.stop("test complete")
    }
  }
  try {
    expect(await run("one")).toBe("saw one")
    expect(await run("two")).toBe("saw two")
    expect(seen).toHaveLength(2)
    expect(await run("two")).toBe("saw two")
    expect(seen).toHaveLength(2)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
