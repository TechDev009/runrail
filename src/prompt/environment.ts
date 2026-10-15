import { arch, platform } from "node:os"
import { probeGitRepository, readGitStatus } from "../git/status.ts"
import { localDate, type PromptEnvironment } from "./default.ts"

const PLATFORM_NAMES: Readonly<Record<string, string>> = { darwin: "macOS", linux: "Linux", win32: "Windows" }
const MAX_STATUS_ENTRIES = 500

/**
 * What the default prompt says about where the model is working. Read once when a session starts,
 * so the text is the same on every request of the session. A folder git cannot describe is simply
 * not a repository here; nothing about it fails the session.
 */
export async function readPromptEnvironment(cwd: string, now: Date = new Date()): Promise<PromptEnvironment> {
  const name = platform()
  const base = { cwd, platform: `${PLATFORM_NAMES[name] ?? name} (${arch()})`, date: localDate(now) }
  try {
    const repository = await probeGitRepository(cwd)
    const status = await readGitStatus(repository, MAX_STATUS_ENTRIES)
    return Object.freeze({
      ...base,
      git: Object.freeze({
        ...(status.branch === undefined ? {} : { branch: status.branch }),
        ...(status.truncated ? {} : { changedFiles: status.entries.length }),
      }),
    })
  } catch {
    return Object.freeze(base)
  }
}
