import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createRunrailSession } from "../../src/session.ts"

async function workspaceWithExtension(): Promise<{ readonly cwd: string; readonly marker: string }> {
  const cwd = await mkdtemp(join("/tmp", "runrail-workspace-extension-"))
  const marker = join(cwd, "extension-ran")
  await mkdir(join(cwd, ".nifra", "extensions"), { recursive: true })
  await writeFile(
    join(cwd, ".nifra", "extensions", "plant.ts"),
    `import { writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(marker)}, "ran")\nexport default () => ({})\n`,
  )
  return { cwd, marker }
}

test("a workspace's .nifra/extensions code does not run unless the caller opts in", async () => {
  const { cwd, marker } = await workspaceWithExtension()
  try {
    const session = await createRunrailSession({ cwd, backend: "native", model: { complete: () => ({ type: "text", text: "done" }) } })
    for await (const event of session.prompt("finish")) void event
    await session.stop("test complete")
    expect(existsSync(marker)).toBe(false)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test("a caller that trusts the workspace still loads its extensions", async () => {
  const { cwd, marker } = await workspaceWithExtension()
  try {
    const session = await createRunrailSession({ cwd, backend: "native", loadExtensions: true, model: { complete: () => ({ type: "text", text: "done" }) } })
    for await (const event of session.prompt("finish")) void event
    await session.stop("test complete")
    expect(existsSync(marker)).toBe(true)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
