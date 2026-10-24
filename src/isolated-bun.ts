/**
 * Flags for a Bun that Runrail starts in a folder it may not trust. Bun loads that folder's .env
 * files and bunfig.toml before any script runs, and a bunfig.toml `preload` runs the folder's code.
 * The user's own ~/.bunfig.toml still loads. `src/cli.ts` starts itself with the same flags.
 */
export const ISOLATED_BUN_FLAGS: readonly string[] = Object.freeze(
  // Naming an env file of its own stops the automatic ones, also on Bun 1.3.0, which has no
  // --no-env-file. Windows Bun opens /dev/null as an ordinary path, so there a folder's bunfig.toml
  // still loads. At most two flags: selfCommand() must fit the control server's four-part MCP command.
  process.platform === "win32" ? ["--no-env-file"] : ["--env-file=/dev/null", "--config=/dev/null"],
)
