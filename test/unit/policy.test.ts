import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
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

test("search and find reach the project's own files past large git, dependency, and deep folders", async () => {
  const root = await mkdtemp(join(tmpdir(), "runrail-policy-walk-"))
  try {
    const made = Bun.spawnSync(["sh", "-c", [
      "mkdir -p .git/objects src node_modules/pkg docs/a/b",
      "(cd .git/objects && seq -f 'o%05g' 1 2100 | xargs touch)",
      "(cd node_modules/pkg && seq -f 'm%05g.js' 1 2100 | xargs touch)",
      "(cd docs/a/b && seq -f 'd%05g.md' 1 2100 | xargs touch)",
      "echo 'export function createRunCommandTool() {}' > src/tool.ts",
      "echo 'needle' > node_modules/pkg/index.js",
    ].join(" && ")], { cwd: root })
    expect(made.exitCode).toBe(0)
    const policy = await createWorkspacePolicy(root)
    expect((await policy.search(undefined, "createRunCommandTool")).map((match) => match.path)).toEqual(["src/tool.ts"])
    expect((await policy.find(undefined, "**/*.ts")).map((entry) => entry.path)).toEqual(["src/tool.ts"])
    // Asked for by name or by starting there, a generated folder is still looked in.
    expect((await policy.find(undefined, "node_modules/pkg/index.js")).map((entry) => entry.path)).toEqual(["node_modules/pkg/index.js"])
    expect((await policy.search("node_modules", "needle")).map((match) => match.path)).toEqual(["node_modules/pkg/index.js"])
    expect((await policy.list(undefined, 0)).map((entry) => entry.path)).toEqual(["docs", "node_modules", "src"])
  } finally {
    Bun.spawnSync(["rm", "-rf", root])
  }
}, 60_000)

test("git's own files are never read, listed, found, or searched", async () => {
  const root = await mkdtemp(join(tmpdir(), "runrail-policy-git-"))
  try {
    await mkdir(join(root, ".git"))
    await writeFile(join(root, ".git", "config"), "[remote \"origin\"]\n\turl = https://x-access-token:ghp_secret@github.com/o/r.git\n")
    await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n")
    await mkdir(join(root, "vendor-lib", ".hg"), { recursive: true })
    await writeFile(join(root, "vendor-lib", ".hg", "hgrc"), "[paths]\ndefault = https://user:ghp_secret@example.com/r\n")
    await writeFile(join(root, "app.ts"), "export {}\n")
    const policy = await createWorkspacePolicy(root)
    for (const path of [".git/config", ".git/HEAD", ".GIT/config", join(policy.root, ".git", "config"), "vendor-lib/.hg/hgrc"]) {
      await expect(policy.read(path)).rejects.toThrow("git commands")
    }
    await expect(policy.list(".git")).rejects.toThrow("git commands")
    await expect(policy.search(".git", "ghp_secret")).rejects.toThrow("git commands")
    expect(await policy.search(undefined, "ghp_secret")).toEqual([])
    expect(await policy.find(undefined, "*")).toEqual([{ path: "app.ts", type: "file", bytes: 10 }, { path: "vendor-lib", type: "directory" }])
    expect((await policy.list(undefined, 4)).map((entry) => entry.path)).toEqual(["app.ts", "vendor-lib"])
    // Writes keep their own refusal; .hg is refused as version control data.
    await expect(policy.write(".git/config", "x")).rejects.toThrow("git's or Runrail's own configuration")
    await expect(policy.write("vendor-lib/.hg/hgrc", "x")).rejects.toThrow("version control data")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("an agent's file tools never write the Nifra extensions the engine imports", async () => {
  const root = await mkdtemp(join(tmpdir(), "runrail-policy-extensions-"))
  try {
    const policy = await createWorkspacePolicy(root)
    for (const path of [".nifra/extensions/planted.ts", ".nifra/extensions/nested/helper.js", ".NIFRA/Extensions/x.ts", join(policy.root, ".nifra", "extensions", "y.ts")]) {
      await expect(policy.write(path, "export default () => {}\n")).rejects.toThrow("Nifra extension")
    }
    await expect(policy.write(".nifra/notes.md", "fine\n")).resolves.toMatchObject({ path: ".nifra/notes.md" })
    await expect(policy.write("src/extensions/x.ts", "fine\n")).resolves.toMatchObject({ path: "src/extensions/x.ts" })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("checkpoint excludes are derived from the sensitive file rules", async () => {
  const { SENSITIVE_IGNORE_PATTERNS } = await import("../../src/workspace/policy.ts")
  expect(SENSITIVE_IGNORE_PATTERNS).toContain("[cC][rR][eE][dD][eE][nN][tT][iI][aA][lL][sS].[jJ][sS][oO][nN]")
  expect(SENSITIVE_IGNORE_PATTERNS).toContain("**/.[cC][oO][nN][fF][iI][gG]/[gG][cC][lL][oO][uU][dD]/")
  expect(SENSITIVE_IGNORE_PATTERNS).toContain("*.[jJ][kK][sS]")
})
