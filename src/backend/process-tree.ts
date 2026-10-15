/**
 * Terminate a detached child process and its descendants as one unit.
 * Vendor CLIs commonly spawn helpers; killing only the direct child leaks
 * those helpers and can leave a cancelled turn consuming CPU or credentials.
 */
export async function terminateProcessTree(
  child: { readonly pid: number; readonly exited: Promise<number>; kill: (signal?: NodeJS.Signals | number) => void },
  graceMs = 250,
  first: NodeJS.Signals = "SIGTERM",
): Promise<void> {
  signalProcessGroup(child, first)
  const deadline = Date.now() + graceMs
  const exited = await Promise.race([child.exited.then(() => true, () => true), delay(graceMs).then(() => false)])
  // The leader can exit first while a helper that ignores the signal keeps the group alive.
  if (exited) while (processGroupAlive(child) && Date.now() < deadline) await delay(Math.min(25, Math.max(1, deadline - Date.now())))
  if (!exited || processGroupAlive(child)) signalProcessGroup(child, "SIGKILL")
  try {
    await child.exited
  } catch {
    // Process termination remains terminal even when the runtime reports an exit error.
  }
}

/** Whether any process of the child's own group is left, its leader gone or not. */
export function processGroupAlive(child: { readonly pid: number }): boolean {
  if (process.platform === "win32" || !Number.isSafeInteger(child.pid) || child.pid <= 0) return false
  try {
    process.kill(-child.pid, 0)
    return true
  } catch (error) {
    // EPERM means a member exists under another user.
    return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function signalProcessGroup(child: { readonly pid: number; kill: (signal?: NodeJS.Signals | number) => void }, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && Number.isSafeInteger(child.pid) && child.pid > 0) {
    try {
      // Bun's detached spawn uses setsid(), making the child its own group leader.
      process.kill(-child.pid, signal)
      return
    } catch {
      // Fall back to the runtime handle when the group is already gone.
    }
  }
  try {
    child.kill(signal)
  } catch {
    // The child may have exited between the group and direct signals.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
