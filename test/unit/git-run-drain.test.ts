import { afterEach, expect, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runGit } from "../../src/git/run.ts"

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

test("runGit returns once git has exited, though a helper it started still holds the output open", async () => {
  const dir = await mkdtemp(join(tmpdir(), "runrail-git-drain-"))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const fake = join(dir, "git")
  // Stands in for git: prints, leaves a helper holding stdout and stderr, and exits.
  await writeFile(fake, '#!/bin/sh\nfor a in "$@"; do last=$a; done\nif [ "$last" = helper-test ]; then sleep 20 & echo done; exit 0; fi\nexec git "$@"\n')
  await chmod(fake, 0o755)
  const started = performance.now()
  const result = await runGit({ cwd: dir, args: ["helper-test"], gitCommand: fake, timeoutMs: 10_000 })
  expect(result.stdout).toBe("done\n")
  expect(performance.now() - started).toBeLessThan(5_000)
})
