import type { HarnessAdapter } from "./types.ts"
import { createPiHarnessAdapter } from "./pi.ts"
import { createCodexHarnessAdapter } from "./codex.ts"
import { createClaudeCodeHarnessAdapter } from "./claude-code.ts"
import { createCopilotHarnessAdapter } from "./copilot.ts"
import { createPtyHarnessAdapter } from "./pty.ts"
import { createOpenCodeHarnessAdapter } from "./opencode.ts"
import { createGeminiHarnessAdapter } from "./gemini.ts"
import { createGooseHarnessAdapter } from "./goose.ts"
import { createCandidateHarnessAdapter } from "./candidates.ts"
/** Shipped harness metadata. Command-backed adapters are opt-in because no CLI is assumed. */
export function createDefaultHarnessAdapters(): readonly HarnessAdapter[] {
  const pi = createPiHarnessAdapter()
  const codex = createCodexHarnessAdapter()
  const claude = createClaudeCodeHarnessAdapter()
  const copilot = createCopilotHarnessAdapter()
  const pty = createPtyHarnessAdapter({ command: "pty" })
  const acp = [createOpenCodeHarnessAdapter(), createGeminiHarnessAdapter(), createGooseHarnessAdapter()]
  // A tool with its own route replaces its JSONL candidate, which stays available by name.
  return Object.freeze([pi, codex, claude, copilot, ...acp, pty, createCandidateHarnessAdapter("aider")])
}
