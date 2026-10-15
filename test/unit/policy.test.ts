import { describe, expect, test } from "bun:test"
import { mkdtemp, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createWorkspacePolicy, filteredEnvironment } from "../../src/workspace/policy.ts"

describe("workspace policy", () => {
  test("rejects traversal and sensitive files", async () => {
    const root = await mkdtemp(join(tmpdir(), "runrail-policy-"))
    await writeFile(join(root, "safe.txt"), "ok")
    await writeFile(join(root, ".env"), "TOKEN=secret")
    const policy = await createWorkspacePolicy(root)
    await expect(policy.read("safe.txt")).resolves.toBe("ok")
    await expect(policy.read("../outside.txt")).rejects.toThrow("escapes")
    await expect(policy.read(".env")).rejects.toThrow("credential")
  })

  test("rejects a symlink that escapes the root", async () => {
    const root = await mkdtemp(join(tmpdir(), "runrail-policy-link-"))
    const outside = await mkdtemp(join(tmpdir(), "runrail-outside-"))
    await writeFile(join(outside, "secret.txt"), "secret")
    await symlink(join(outside, "secret.txt"), join(root, "link.txt"))
    const policy = await createWorkspacePolicy(root)
    await expect(policy.read("link.txt")).rejects.toThrow("escapes")
  })

  test("filters credentials from subprocess environment", () => {
    const env = filteredEnvironment({ SECRET_TOKEN: "not-allowed", PATH: "/bin", USER: "sam", ANTHROPIC_BASE_URL: "http://127.0.0.1:1" })
    expect(env.PATH).toBe("/bin")
    expect(env.SECRET_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
    // A subscription sign-in is found by account name.
    expect(env.USER).toBe("sam")
  })
})

test("credential files beyond .env and keys are never read or diffed", async () => {
  const { isSensitiveWorkspacePath } = await import("../../src/workspace/policy.ts")
  for (const path of [".npmrc", "pkg/.npmrc", ".netrc", ".git-credentials", ".aws/credentials", "ops/.aws/config", ".ssh/id_ed25519", "id_rsa", "cert.p12", ".config/gcloud/application_default_credentials.json", ".env.local"]) expect([path, isSensitiveWorkspacePath(path)]).toEqual([path, true])
  for (const path of ["src/index.ts", "README.md", "aws/handler.ts", "config/app.json", "docs/env.md"]) expect([path, isSensitiveWorkspacePath(path)]).toEqual([path, false])
})

test("a find that matches nothing stops after a bounded number of entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "runrail-policy-budget-"))
  try {
    const marker = Bun.spawnSync(["sh", "-c", "mkdir many && cd many && seq -f 'f%06g' 1 50100 | xargs touch && touch zzz-last.txt"], { cwd: root })
    expect(marker.exitCode).toBe(0)
    const policy = await createWorkspacePolicy(root)
    // The one match sorts after the budget runs out, so it is not reached.
    expect(await policy.find("", "**/zzz-last.txt", 16, 1)).toEqual([])
    expect((await policy.find("many", "many/f000001", 16, 1)).map((entry) => entry.path)).toEqual(["many/f000001"])
  } finally {
    Bun.spawnSync(["rm", "-rf", root])
  }
}, 60_000)
