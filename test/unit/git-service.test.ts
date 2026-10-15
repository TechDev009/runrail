import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { describeRemote, GitWorkspace } from "../../src/git/index.ts"

const cleanup: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const step of cleanup.splice(0)) await step()
})

describe("which service a remote is on", () => {
  test("each rule, from the URL alone", () => {
    const cases: [string, Record<string, unknown>][] = [
      ["git@github.com:example-org/widgets.git", { service: "github", serviceFrom: "host", owner: "example-org", repo: "widgets", path: "example-org/widgets" }],
      ["https://GitLab.com/example-org/platform/widgets.git", { service: "gitlab", serviceFrom: "host", path: "example-org/platform/widgets" }],
      ["git@bitbucket.org:team/widgets.git", { service: "bitbucket", serviceFrom: "host", owner: "team", repo: "widgets" }],
      ["https://git.corp.example/scm/PROJ/widgets.git", { service: "bitbucket", serviceFrom: "path", path: "PROJ/widgets" }],
      ["ssh://git@code.corp.example:7999/proj/widgets.git", { service: "bitbucket", serviceFrom: "path" }],
      ["https://code.corp.example/group/sub/widgets.git", { service: "gitlab", serviceFrom: "path", path: "group/sub/widgets" }],
      ["https://gitlab.corp.example/example-org/widgets.git", { service: "gitlab", serviceFrom: "name", owner: "example-org", repo: "widgets" }],
      ["https://github.corp.example/example-org/widgets", { service: "github", serviceFrom: "name" }],
      ["https://bitbucket.corp.example/scm/x", { service: "bitbucket", serviceFrom: "name" }],
      ["https://code.corp.example/example-org/widgets.git", { service: "unknown", owner: "example-org", repo: "widgets" }],
    ]
    for (const [url, expected] of cases) expect([url, describeRemote("origin", url)]).toMatchObject([url, expected])
  })

  test("nested paths give no owner and repo pair, and local paths no service", () => {
    expect(describeRemote("origin", "https://gitlab.com/a/b/c.git")).not.toHaveProperty("owner")
    expect(describeRemote("origin", "/srv/git/widgets.git")).toEqual({ name: "origin", url: "local" })
    expect(describeRemote("origin", "https://code.corp.example/../../etc")).not.toHaveProperty("path")
  })
})

async function repoWith(remotes: Record<string, string>, files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp("/tmp/runrail-git-service-")
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: dir })
  for (const [name, url] of Object.entries(remotes)) Bun.spawnSync(["git", "remote", "add", name, url], { cwd: dir })
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true })
    await writeFile(join(dir, path), text)
  }
  return dir
}

describe("the remote list", () => {
  test("a CI file names an unknown host's service; two kinds of CI file name none", async () => {
    const one = await repoWith({ origin: "https://code.corp.example/example-org/widgets.git" }, { ".gitlab-ci.yml": "x" })
    expect(await new GitWorkspace({ root: one }).remotes()).toMatchObject([{ name: "origin", service: "gitlab", serviceFrom: "ci" }])
    const two = await repoWith({ origin: "https://code.corp.example/example-org/widgets.git" }, { ".gitlab-ci.yml": "x", "bitbucket-pipelines.yml": "x" })
    expect(await new GitWorkspace({ root: two }).remotes()).toMatchObject([{ name: "origin", service: "unknown" }])
  })

  test("the person's answer wins over any guess, by host and port or by host", async () => {
    const dir = await repoWith({ origin: "https://gitlab.corp.example/example-org/widgets.git", other: "ssh://git@code.corp.example:7999/p/r.git" }, { ".github/workflows/ci.yml": "x" })
    const services = new Map([["gitlab.corp.example", "github" as const], ["code.corp.example:7999", "gitlab" as const]])
    const remotes = await new GitWorkspace({ root: dir, hints: async () => ({ services }) }).remotes()
    expect(remotes).toEqual([
      expect.objectContaining({ name: "origin", service: "github", serviceFrom: "user" }),
      expect.objectContaining({ name: "other", service: "gitlab", serviceFrom: "user" }),
    ])
    expect(remotes.some((remote) => "port" in remote)).toBe(false)
  })
})
