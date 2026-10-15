import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { createRunrailSession } from "../../src/session.ts"
import { createModelCatalog } from "../../src/model/catalog.ts"
import { createRunrailSessionController } from "../../src/control.ts"

test("native sessions switch between caller-owned model adapters", async () => {
  const cwd = await mkdtemp(join("/tmp", "runrail-model-switch-"))
  try {
    const catalog = createModelCatalog([
      {
        descriptor: { id: "one", provider: "fixture", version: "1.0.0", tier: "cheap", capabilities: ["tools"], contextTokens: 1024 },
        create: () => ({ complete: () => ({ type: "text", text: "one" }) }),
      },
      {
        descriptor: { id: "two", provider: "fixture", version: "1.0.0", tier: "strong", capabilities: ["tools"], contextTokens: 1024 },
        create: () => ({ complete: () => ({ type: "text", text: "two" }) }),
      },
    ])
    const session = await createRunrailSession({ cwd, backend: "native", modelCatalog: catalog, modelSelection: { id: "one" }, loadExtensions: false })
    try {
      expect(session.model).toMatchObject({ id: "one" })
      await expect(session.switchModel({ id: "two" })).resolves.toMatchObject({ id: "two" })
      const events = []
      for await (const event of session.prompt("finish")) events.push(event)
      expect(events).toContainEqual(expect.objectContaining({ type: "assistant.message", text: "two" }))
    } finally {
      await session.stop("test complete")
    }
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test("a controller keeps a switched model across a session refresh", async () => {
  const cwd = await mkdtemp(join("/tmp", "runrail-model-switch-refresh-"))
  try {
    const catalog = createModelCatalog([
      { descriptor: { id: "first", provider: "fixture", version: "1.0.0", tier: "cheap", capabilities: ["tools"], contextTokens: 1024 }, create: () => ({ complete: () => ({ type: "text", text: "first" }) }) },
      { descriptor: { id: "second", provider: "fixture", version: "1.0.0", tier: "strong", capabilities: ["tools"], contextTokens: 1024 }, create: () => ({ complete: () => ({ type: "text", text: "second" }) }) },
    ])
    const controller = await createRunrailSessionController({ cwd, backend: "native", modelCatalog: catalog, modelSelection: { id: "first" }, loadExtensions: false })
    try {
      await controller.switchModel({ id: "second" })
      await controller.refreshSession()
      expect(controller.session.model).toMatchObject({ id: "second" })
    } finally {
      await controller.close("test complete")
    }
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
