import { ReplayBackend } from "@nifrajs/coding-agent"
import type { AgentBackend, AgentEvent } from "@nifrajs/agent-protocol"

export function createReplayBackend(): AgentBackend {
  const events: AgentEvent[] = [
    {
      version: 1,
      sessionId: "replay-fixture",
      seq: 0,
      at: 0,
      type: "turn.started",
      turnId: "turn-fixture",
      prompt: "replay",
    },
    {
      version: 1,
      sessionId: "replay-fixture",
      seq: 1,
      at: 1,
      type: "assistant.message",
      turnId: "turn-fixture",
      text: "Replay completed.",
    },
  ]
  return new ReplayBackend({ events })
}
