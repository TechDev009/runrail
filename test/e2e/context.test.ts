import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createContextResourceSet, createContextAwareModelPort } from "../../src/context/resources.ts"
import { createWorkspacePolicy } from "../../src/workspace/policy.ts"
import { createRunrailSession } from "../../src/session.ts"

describe("native context and multimodal resources", () => {
  test("loads explicit instructions, expands @file, and validates image references", async () => {
    const cwd = await mkdtemp(join("/tmp", "runrail-context-"))
    try {
      await writeFile(join(cwd, "AGENTS.md"), "Use the bounded tools.\n", "utf8")
      await writeFile(join(cwd, "src.ts"), "export const value = 42\n", "utf8")
      await writeFile(join(cwd, "README"), "extensionless file\n", "utf8")
      await writeFile(join(cwd, "screen.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      const policy = await createWorkspacePolicy(cwd)
      const resources = await createContextResourceSet(policy, { instructionFiles: ["AGENTS.md"] })
      expect(resources.text()).toContain("Use the bounded tools")
      const prepared = await resources.prepare("inspect @src.ts")
      expect(prepared.text).toContain("export const value = 42")
      expect(prepared.attachments).toMatchObject([{ path: "src.ts", kind: "file" }])
      const extensionless = await resources.prepare("inspect @README")
      expect(extensionless.text).toContain("extensionless file")
      const multimodal = await resources.prepare({
        text: "review this",
        attachments: [{ path: "screen.png", kind: "image" }],
      })
      expect(multimodal.text).toContain("image attachment: screen.png")
      expect(multimodal.attachments).toMatchObject([{ path: "screen.png", kind: "image", mediaType: "image/png" }])
      expect(multimodal.parts).toContainEqual(expect.objectContaining({ kind: "image", mediaType: "image/png", bytes: 8 }))
      const inline = await resources.prepare({
        text: "inspect data",
        parts: [
          { kind: "image", dataBase64: "iVBORw0KGgo=", mediaType: "image/png" },
          { kind: "binary", dataBase64: "AQID", mediaType: "application/octet-stream" },
        ],
      })
      expect(inline.parts).toContainEqual(expect.objectContaining({ kind: "image", mediaType: "image/png" }))
      expect(inline.parts).toContainEqual(expect.objectContaining({ kind: "binary", mediaType: "application/octet-stream", bytes: 3 }))
      await expect(resources.prepare({ text: "bad", parts: [{ kind: "image", dataBase64: "bm90LWltYWdl", mediaType: "image/png" }] })).rejects.toMatchObject({ code: "CONTEXT_MEDIA_UNSUPPORTED" })
      await expect(resources.prepare("read @../outside.ts")).rejects.toMatchObject({ code: "CONTEXT_REFERENCE_NOT_FOUND" })
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test("an @name that is not a file stays text, and linked or oversized instructions still load", async () => {
    const cwd = await mkdtemp(join("/tmp", "runrail-context-"))
    const outside = await mkdtemp(join("/tmp", "runrail-context-outside-"))
    try {
      await writeFile(join(cwd, "AGENTS.md"), "Linked rules.\n", "utf8")
      await symlink("AGENTS.md", join(cwd, "CLAUDE.md"))
      await writeFile(join(cwd, "BIG.md"), `start ${"y".repeat(4_000)}`, "utf8")
      await writeFile(join(outside, "rules.md"), "outside rules\n", "utf8")
      await symlink(join(outside, "rules.md"), join(cwd, "OUTSIDE.md"))
      await writeFile(join(cwd, "app.ts"), "export const app = 1\n", "utf8")
      await mkdir(join(cwd, "src"))
      const policy = await createWorkspacePolicy(cwd)
      const resources = await createContextResourceSet(policy, { instructionFiles: ["CLAUDE.md", "BIG.md", "OUTSIDE.md"], maxResourceBytes: 1_024 })
      const listed = resources.list()
      expect(listed.find((resource) => resource.id === "CLAUDE.md")?.content).toBe("Linked rules.\n")
      const big = listed.find((resource) => resource.id === "BIG.md")?.content ?? ""
      expect(big.startsWith("start ")).toBe(true)
      expect(big).toContain("only the start is included")
      expect(Buffer.byteLength(big, "utf8")).toBeLessThanOrEqual(1_024)
      expect(listed.some((resource) => resource.id === "OUTSIDE.md")).toBe(false)
      const prepared = await resources.prepare("install @types/node, look in @src and fix @app.ts.")
      expect(prepared.attachments).toMatchObject([{ path: "app.ts", kind: "file" }])
      expect(prepared.text).toContain("export const app = 1")
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  test("rejects image input for a model without multimodal support and accepts declared support", async () => {
    const cwd = await mkdtemp(join("/tmp", "runrail-context-multimodal-"))
    try {
      await writeFile(join(cwd, "image.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      const rejected = await createRunrailSession({
        cwd,
        backend: "native",
        loadExtensions: false,
        model: { complete: () => ({ type: "text", text: "no image" }) },
      })
      try {
        await expect((async () => {
          for await (const _event of rejected.prompt({ text: "review", attachments: [{ path: "image.png", kind: "image" }] })) {}
        })()).rejects.toMatchObject({ code: "MODEL_CAPABILITY_UNAVAILABLE" })
      } finally {
        await rejected.stop("test complete")
      }
      let observedParts = 0
      const accepted = await createRunrailSession({ cwd, backend: "native", modelSelection: { id: "vision" }, loadExtensions: false, contentModel: {
        complete: (request) => {
          observedParts = request.parts.length
          return { type: "text", text: "image accepted" }
        },
      }, contentModelDescriptor: { id: "vision", provider: "fixture", version: "1.0.0", tier: "strong", capabilities: ["multimodal", "tools"], contextTokens: 4096 } })
      try {
        const events = []
        for await (const event of accepted.prompt({ text: "review", attachments: [{ path: "image.png", kind: "image" }] })) events.push(event)
        expect(events).toContainEqual(expect.objectContaining({ type: "assistant.message", text: "image accepted" }))
        expect(observedParts).toBeGreaterThan(1)
      } finally {
        await accepted.stop("test complete")
      }
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test("injects context transiently and leaves the inner model response intact", async () => {
    const cwd = await mkdtemp(join("/tmp", "runrail-context-model-"))
    try {
      const policy = await createWorkspacePolicy(cwd)
      const resources = await createContextResourceSet(policy, { systemPrompt: "Answer with bounded steps." })
      let observed = ""
      const port = createContextAwareModelPort(
        {
          complete: (request) => {
            observed = request.messages[0]?.text ?? ""
            return { type: "text", text: "done" }
          },
        },
        resources,
      )
      await port.complete({
        sessionId: "s",
        cwd,
        messages: [{ role: "user", text: "finish" }],
        tools: [],
        signal: new AbortController().signal,
      })
      expect(observed).toContain("Answer with bounded steps")
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  test("expands bounded prompt templates without persisting their values", async () => {
    const cwd = await mkdtemp(join("/tmp", "runrail-context-template-"))
    try {
      const policy = await createWorkspacePolicy(cwd)
      const resources = await createContextResourceSet(policy, { promptTemplates: { review: "Review {{path}} with {{style}}." } })
      expect(resources.getTemplate("review")).toContain("{{path}}")
      expect(resources.expandTemplate("review", { path: "src.ts", style: "small safe changes" })).toBe("Review src.ts with small safe changes.")
      await expect(resources.prepareTemplate("review", { path: "src.ts" })).rejects.toMatchObject({ code: "CONTEXT_INVALID" })
      expect(() => resources.expandTemplate("missing", {})).toThrow("prompt template is not available")
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
