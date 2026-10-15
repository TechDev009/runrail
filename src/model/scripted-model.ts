import type {
  NativeModelPort,
  NativeModelRequest,
  NativeModelResponse,
} from "@nifrajs/coding-agent"

export interface ScriptedModelOptions {
  readonly path?: string
  readonly brokenContent?: string
  readonly repairedContent?: string
  readonly alwaysBroken?: boolean
  readonly delayMs?: number
}

/** Deterministic model used by replay/native tests; it never contacts a provider. */
export class ScriptedModel implements NativeModelPort {
  private readonly path: string
  private readonly brokenContent: string
  private readonly repairedContent: string
  private readonly alwaysBroken: boolean
  private readonly delayMs: number
  private initialEditDone = false
  private repairEditCount = 0

  constructor(options: ScriptedModelOptions = {}) {
    this.path = options.path ?? "index.ts"
    this.brokenContent = options.brokenContent ?? 'const answer: number = "wrong"\n\nexport { answer }\n'
    this.repairedContent = options.repairedContent ?? "const answer: number = 42\n\nexport { answer }\n"
    this.alwaysBroken = options.alwaysBroken === true
    this.delayMs = options.delayMs ?? 0
    if (!Number.isSafeInteger(this.delayMs) || this.delayMs < 0 || this.delayMs > 60_000)
      throw new RangeError("scripted model: delayMs must be between 0 and 60000")
  }

  complete(request: NativeModelRequest): NativeModelResponse | Promise<NativeModelResponse> {
    const run = async (): Promise<NativeModelResponse> => {
      await waitForDelay(this.delayMs, request.signal)
      if (request.signal.aborted) throw new Error("scripted model cancelled")
      const repairing = request.messages.some((message) => message.role === "user" && isRepairMessage(message.text))
      if (!repairing && !this.initialEditDone) {
        this.initialEditDone = true
        return this.patch(this.brokenContent)
      }
      let lastRepairIndex = -1
      for (let index = request.messages.length - 1; index >= 0; index -= 1) {
        const message = request.messages[index]
        if (message?.role === "user" && isRepairMessage(message.text)) {
          lastRepairIndex = index
          break
        }
      }
      const repairHasToolResult =
        lastRepairIndex >= 0 && request.messages.slice(lastRepairIndex + 1).some((message) => message.role === "tool")
      if (repairing && !repairHasToolResult) {
        this.repairEditCount += 1
        return this.patch(this.alwaysBroken ? this.brokenContent : this.repairedContent)
      }
      return { type: "text", text: "The bounded task is complete." }
    }
    return this.delayMs === 0 ? run() : run()
  }

  private patch(content: string): NativeModelResponse {
    return {
      type: "tool",
      name: "apply_patch",
      input: { path: this.path, content },
    }
  }
}

function isRepairMessage(text: string): boolean {
  return text.startsWith("[Runrail repair]") || text.includes("Nifra verification failed after your previous turn.")
}

async function waitForDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs === 0) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs)
    const abort = (): void => {
      clearTimeout(timer)
      reject(new Error("scripted model cancelled"))
    }
    if (signal.aborted) abort()
    else signal.addEventListener("abort", abort, { once: true })
  })
}
