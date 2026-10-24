import { claudeAgentSdkStatus, installClaudeAgentSdk, type ClaudeAgentSdkStatus } from "./backend/claude-agent-sdk.ts"

export interface SdkCliIo {
  readonly out: (line: string) => void
  readonly note: (line: string) => void
  /** Asks the person; absent when no one is at the terminal to answer. */
  readonly confirm?: (question: string) => Promise<boolean>
}

export interface SdkCliRequest {
  readonly action: "status" | "install"
  /** The person said yes on the command line, so install does not ask. */
  readonly yes: boolean
  readonly json: boolean
}

export const SDK_CLI_USAGE = "usage: runrail sdk [status [--json] | install [--yes]]"

export function parseSdkCliRequest(argv: readonly string[]): SdkCliRequest {
  const [action = "status", ...rest] = argv
  if (action === "status" && rest.every((arg) => arg === "--json")) return { action, yes: false, json: rest.length > 0 }
  if (action === "install" && rest.every((arg) => arg === "--yes" || arg === "-y")) return { action, yes: rest.length > 0, json: false }
  throw new Error(SDK_CLI_USAGE)
}

/** `runrail sdk status` and `runrail sdk install`; `directory` is where a download goes. */
export async function runSdkCli(request: SdkCliRequest, io: SdkCliIo, directory: string): Promise<number> {
  const status = claudeAgentSdkStatus()
  if (request.action === "status") {
    if (request.json) io.out(JSON.stringify({ ...status, ...(status.downloadCommand === undefined ? {} : { directory }) }, null, 2))
    else io.out(statusLine(status, directory))
    return 0
  }
  if (status.ready) {
    io.out(statusLine(status, directory))
    return 0
  }
  if (status.source !== "installable") {
    io.note(`This Runrail cannot download the Claude Agent SDK. Install it with: ${status.installCommand}`)
    return 1
  }
  explain(status, directory, io)
  if (!request.yes) {
    if (io.confirm === undefined) {
      io.note("Nothing was downloaded: no one is here to answer. To download it without asking, run: runrail sdk install --yes")
      return 2
    }
    if (!(await io.confirm("Download it?"))) {
      io.note("Nothing was downloaded.")
      return 1
    }
  }
  return (await download(io)) ? 0 : 1
}

/**
 * Before a Claude Code run without the SDK: asks to download it when someone can answer and this
 * Runrail can download it, else says what Claude Code cannot do and how to fix that.
 */
export async function offerAgentSdk(io: Omit<SdkCliIo, "out">, directory: string): Promise<void> {
  const status = claudeAgentSdkStatus()
  if (status.ready) return
  const command = status.downloadCommand ?? status.installCommand
  if (status.source !== "installable" || io.confirm === undefined) {
    io.note(`Claude Code is running in print mode, so it cannot ask before it uses a tool. To fix that, install the Claude Agent SDK (Anthropic's package, under its terms: ${status.termsUrl}):\n  ${command}\n  ${status.npmUrl}`)
    return
  }
  io.note("Without the Claude Agent SDK, Claude Code runs in print mode and cannot ask before it uses a tool.")
  explain(status, directory, io)
  if (await io.confirm("Download it now?")) await download({ out: io.note, note: io.note })
  else io.note(`Claude Code runs in print mode this time. To download the SDK later, run: ${command}`)
}

function explain(status: ClaudeAgentSdkStatus, directory: string, io: Pick<SdkCliIo, "note">): void {
  io.note(`Runrail can download the Claude Agent SDK ${status.version} from npm into ${directory}.`)
  io.note(`It is Anthropic's package, used under Anthropic's terms: ${status.termsUrl}`)
  io.note(`  ${status.npmUrl}`)
  io.note("The download is checked against a pinned SHA-512 before it is unpacked, and its files on every load.")
}

async function download(io: Pick<SdkCliIo, "out" | "note">): Promise<boolean> {
  try {
    const after = await installClaudeAgentSdk()
    io.out(`Downloaded the Claude Agent SDK ${after.version}. Claude Code now asks before each tool.`)
    return true
  } catch (error) {
    io.note(`The Claude Agent SDK was not downloaded: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

function statusLine(status: ClaudeAgentSdkStatus, directory: string): string {
  if (status.source === "installable") return `The Claude Agent SDK ${status.version} is not downloaded yet, so Claude Code runs in print mode and cannot ask before tools. Download it with: ${status.downloadCommand ?? "runrail sdk install"}`
  if (status.source === "missing") return `The Claude Agent SDK is not installed, so Claude Code runs in print mode and cannot ask before tools. Install it with: ${status.installCommand}`
  const where = status.source === "downloaded" ? `downloaded in ${directory}` : status.source === "installed" ? "installed beside Runrail" : status.source === "registered" ? "built in" : "fetched from npm when first needed"
  return `The Claude Agent SDK is ready, ${where}. Claude Code asks before each tool.`
}
