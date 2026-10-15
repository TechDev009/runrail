import { execFile, spawn } from "node:child_process"
import { readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { staleSourceCount } from "../memory/sources.ts"
import { watchedPullRequests } from "../workflows/pull-requests.ts"
import { PR_POLL_MS, WorkflowStore, type DueRun, type PullRequestRef } from "../workflows/store.ts"
import { filteredEnvironment } from "../workspace/policy.ts"

/**
 * Run after Quit: a small loop launchd (macOS) or a systemd user unit (Linux) keeps running
 * while the person allows it.
 * It runs nothing itself. When a workflow is due or memory sources are stale and the app is not
 * running, it opens the app hidden, with `--background`; the app's own scheduler starts the work
 * and the app quits again once it is done. It reads the workflows and sources files and the app's
 * note, and writes nothing.
 *
 * The app's note, `~/.runrail/service/app.json`, is `{ "pid": number | null, "at": ms }`, written
 * by the desktop host about every 30 seconds while it runs and with a null pid when it quits.
 */

export type WakeReason = "schedule" | "pull-request" | "memory-sync"

export interface AppNote {
  readonly pid?: number
  readonly at: number
}

export const TICK_MS = 30_000
/** A note older than this is from an app that stopped without saying so. */
export const NOTE_FRESH_MS = 90_000
/** After opening the app, give it this long before opening it again. */
export const WAKE_GAP_MS = 5 * 60_000
/** After a failed open (the app moved or was deleted), wait longer. */
export const FAILED_GAP_MS = 30 * 60_000
/** As the app's own hourly sync; stale sources open the app at most this often. */
export const SOURCE_SYNC_MS = 60 * 60_000
const MAX_NOTE_BYTES = 4_096

export interface WakeState {
  /** When the app was last opened, and whether that open failed. */
  lastWake?: number
  lastWakeFailed?: boolean
  lastMemoryWake?: number
  lastPrPoll?: number
}

export interface WakeInput {
  readonly now: number
  readonly appRunning: boolean
  readonly due: readonly DueRun[]
  readonly staleSources: number
}

/** Why the app should open now, if it should. */
export function wakeReason(input: WakeInput, state: WakeState): WakeReason | undefined {
  if (input.appRunning) return undefined
  if (state.lastWake !== undefined && input.now - state.lastWake < (state.lastWakeFailed === true ? FAILED_GAP_MS : WAKE_GAP_MS)) return undefined
  if (input.due.some((run) => run.trigger === "schedule")) return "schedule"
  if (input.due.length > 0) return "pull-request"
  if (input.staleSources > 0 && (state.lastMemoryWake === undefined || input.now - state.lastMemoryWake >= SOURCE_SYNC_MS)) return "memory-sync"
  return undefined
}

/** Whether the note says the app is running now: a fresh note from a live process. */
export function appRunning(note: AppNote | undefined, now: number, alive: (pid: number) => boolean): boolean {
  if (note?.pid === undefined || now - note.at > NOTE_FRESH_MS || note.at - now > NOTE_FRESH_MS) return false
  return alive(note.pid)
}

export function parseAppNote(text: string): AppNote | undefined {
  if (text.length > MAX_NOTE_BYTES) return undefined
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const { pid, at } = value as { pid?: unknown; at?: unknown }
  if (typeof at !== "number" || !Number.isFinite(at)) return undefined
  return { at, ...(typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}) }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // Another user's process answers EPERM; it is alive.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** The app bundle the service opens: an absolute path to an existing `.app` directory. */
export async function checkAppBundle(path: string): Promise<string> {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0") || !/\.app\/?$/.test(path) || path.length > 1_024) throw new Error("--app must be the absolute path of an .app bundle")
  const info = await stat(join(path, "Contents", "Info.plist")).catch(() => undefined)
  if (info?.isFile() !== true) throw new Error("--app is not an app bundle")
  return path.replace(/\/$/, "")
}

export interface WakeServiceOptions {
  readonly app: string
  /** `~/.runrail` by default. */
  readonly home?: string
  readonly signal?: AbortSignal
  readonly now?: () => number
  /** Opens the app hidden; rejects when it could not. */
  readonly open?: (app: string) => Promise<void>
  readonly alive?: (pid: number) => boolean
  readonly listPullRequests?: (root: string, trigger: "pr-review-requested" | "pr-opened") => Promise<readonly PullRequestRef[]>
  readonly tickMs?: number
}

/** One look: reads what is due and the app's note, and opens the app when it should. */
export async function wakeTick(options: WakeServiceOptions, state: WakeState): Promise<WakeReason | undefined> {
  const now = (options.now ?? Date.now)()
  const home = options.home ?? join(homedir(), ".runrail")
  const note = parseAppNote((await readFile(join(home, "service", "app.json"), "utf8").catch(() => "")) || "null")
  if (appRunning(note, now, options.alive ?? processAlive)) return undefined
  const store = new WorkflowStore(join(home, "workflows.json"))
  // GitHub is asked no more often than the app itself would.
  const askPrs = options.listPullRequests !== undefined && (state.lastPrPoll === undefined || now - state.lastPrPoll >= PR_POLL_MS)
  if (askPrs) state.lastPrPoll = now
  const due = await store.peek(now, askPrs ? options.listPullRequests : undefined).catch(() => [])
  const staleSources = await staleSourceCount(join(home, "memory", "sources.json"), now, SOURCE_SYNC_MS).catch(() => 0)
  const reason = wakeReason({ now, appRunning: false, due, staleSources }, state)
  if (reason === undefined) return undefined
  state.lastWake = now
  if (reason === "memory-sync") state.lastMemoryWake = now
  try {
    await (options.open ?? openHidden)(options.app)
    state.lastWakeFailed = false
  } catch {
    state.lastWakeFailed = true
  }
  return reason
}

function openHidden(app: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/open", ["-g", "-j", "-a", app, "--args", "--background"], { timeout: 15_000, env: filteredEnvironment() }, (error) => (error === null ? resolve() : reject(error)))
  })
}

/** PR triggers are asked through the GitHub CLI when it is installed. */
function gitHubLister(): WakeServiceOptions["listPullRequests"] {
  const gh = Bun.which("gh", { PATH: filteredEnvironment().PATH ?? "" })
  if (gh === null || gh.length === 0) return undefined
  return (root, trigger) => watchedPullRequests(gh, root, trigger)
}

/** On Linux the app is the AppImage or the installed program: an absolute path to an executable file. */
export async function checkLinuxApp(path: string): Promise<string> {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0") || path.length > 1_024) throw new Error("--app must be the absolute path of the Runrail program")
  const info = await stat(path).catch(() => undefined)
  if (info?.isFile() !== true || (info.mode & 0o111) === 0) throw new Error("--app is not an executable program")
  return path
}

/** The desktop session's display and bus, which the user manager has when the desktop imported them. */
const SESSION_VARIABLES = ["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP"]

function openHiddenLinux(app: string): Promise<void> {
  const env = filteredEnvironment()
  for (const name of SESSION_VARIABLES) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return new Promise((resolve, reject) => {
    const child = spawn(app, ["--background"], { detached: true, stdio: "ignore", env })
    child.once("error", reject)
    child.once("spawn", () => {
      child.unref()
      resolve()
    })
  })
}

/** Runs until the signal aborts (launchd or systemd stops it with SIGTERM). */
export async function runWakeService(options: WakeServiceOptions): Promise<void> {
  const linux = process.platform === "linux"
  if (process.platform !== "darwin" && !linux && options.open === undefined) throw new Error("the wake service runs on macOS and Linux")
  const app = linux ? await checkLinuxApp(options.app) : await checkAppBundle(options.app)
  const lister = options.listPullRequests ?? gitHubLister()
  const settings = { ...options, app, ...(options.open === undefined && linux ? { open: openHiddenLinux } : {}), ...(lister === undefined ? {} : { listPullRequests: lister }) }
  const state: WakeState = {}
  const tick = options.tickMs ?? TICK_MS
  while (options.signal?.aborted !== true) {
    await wakeTick(settings, state).catch(() => undefined)
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, tick)
      options.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
    })
  }
}
