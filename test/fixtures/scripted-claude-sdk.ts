import type { ClaudeAgentSdk, ClaudeSdkQuery, ClaudeSdkQueryOptions } from "../../src/index.ts"

/** An Agent SDK whose Claude Code answers every prompt under the id `answerAs` picks, its messages numbered `msg-1`, `msg-2`, ... */
export function scriptedSdk(answerAs: (options: ClaudeSdkQueryOptions) => string): { readonly sdk: ClaudeAgentSdk; readonly queries: { readonly options: ClaudeSdkQueryOptions; readonly prompts: string[] }[] } {
  const queries: { readonly options: ClaudeSdkQueryOptions; readonly prompts: string[] }[] = []
  let messages = 0
  const sdk: ClaudeAgentSdk = {
    query: ({ prompt, options }) => {
      const record = { options, prompts: [] as string[] }
      queries.push(record)
      const output: unknown[] = []
      const waiters: ((result: IteratorResult<unknown>) => void)[] = []
      let done = false
      const emit = (value: unknown) => {
        const waiter = waiters.shift()
        if (waiter !== undefined) waiter({ done: false, value })
        else output.push(value)
      }
      const finish = () => {
        done = true
        for (const waiter of waiters.splice(0)) waiter({ done: true, value: undefined })
      }
      void (async () => {
        for await (const message of prompt) {
          if (done) return
          record.prompts.push(message.message.content)
          const sessionId = answerAs(options)
          emit({ type: "system", subtype: "init", session_id: sessionId })
          emit({ type: "assistant", session_id: sessionId, uuid: `msg-${++messages}`, parent_tool_use_id: null, message: { content: [{ type: "text", text: "the cookie race" }] } })
          emit({ type: "result", subtype: "success", is_error: false, session_id: sessionId })
        }
        finish()
      })()
      const query: ClaudeSdkQuery = {
        interrupt: async () => ({}),
        setModel: async () => {},
        stopTask: async () => {},
        close: finish,
        [Symbol.asyncIterator]: () => ({
          next: () => {
            const value = output.shift()
            if (value !== undefined) return Promise.resolve({ done: false, value })
            if (done) return Promise.resolve({ done: true, value: undefined })
            return new Promise((resolve) => waiters.push(resolve))
          },
        }),
      }
      return query
    },
  }
  return { sdk, queries }
}

/** Claude Code's `--fork-session` answers under a new id; a plain resume keeps the one it resumed. */
export const forkAware = (options: ClaudeSdkQueryOptions): string => options.forkSession === true ? "vendor-copy" : options.resume ?? "vendor-new"
