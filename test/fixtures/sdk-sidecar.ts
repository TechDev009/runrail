import { runCliMain } from "../../src/cli.ts"
import { registerClaudeAgentSdk } from "../../src/index.ts"

/** A build that composes the CLI with a bundled SDK, as the desktop sidecar does. The SDK answers one turn. */
registerClaudeAgentSdk({
  query: ({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    let closed = false
    const turns = (async function* () {
      for await (const _message of prompt) {
        yield { type: "system", subtype: "init", session_id: "sidecar-session" }
        yield { type: "assistant", session_id: "sidecar-session", parent_tool_use_id: null, message: { content: [{ type: "text", text: "from the bundled sdk" }] } }
        yield { type: "result", subtype: "success", is_error: false, session_id: "sidecar-session" }
        if (closed) return
      }
    })()
    return Object.assign(turns, { interrupt: async () => undefined, setModel: async () => undefined, stopTask: async () => undefined, close: () => { closed = true } })
  },
})
await runCliMain()
