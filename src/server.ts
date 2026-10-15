import {
  CodingAgentRpcServer,
  type CodingAgentRpcServerHandle,
} from "@nifrajs/coding-agent"
import { createRunrailRuntime, type RunrailSessionOptions } from "./session.ts"
import { filteredEnvironment } from "./workspace/policy.ts"

export interface RunrailRpcServerOptions extends RunrailSessionOptions {
  readonly hostname?: string
  readonly allowRemote?: boolean
  readonly port?: number
  readonly authToken?: string
  readonly exposeErrorStacks?: boolean
  readonly maxBodyBytes?: number
}

export interface RunrailRpcServerHandle {
  readonly server: CodingAgentRpcServer
  readonly handle: CodingAgentRpcServerHandle
}

/** Start the authenticated Nifra RPC surface with Runrail's shared runtime wiring. */
export async function startRunrailRpcServer(
  options: RunrailRpcServerOptions,
): Promise<RunrailRpcServerHandle> {
  const runtime = await createRunrailRuntime(options)
  const server = new CodingAgentRpcServer({
    backend: runtime.backend,
    cwd: runtime.policy.root,
    ...(options.hostname === undefined ? {} : { hostname: options.hostname }),
    ...(options.allowRemote === undefined ? {} : { allowRemote: options.allowRemote }),
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.authToken === undefined ? {} : { authToken: options.authToken }),
    ...(options.exposeErrorStacks === undefined ? {} : { exposeErrorStacks: options.exposeErrorStacks }),
    ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
    ...(runtime.sessionStore === undefined ? {} : { sessionStore: runtime.sessionStore }),
    ...(runtime.extensions === undefined ? {} : { extensions: runtime.extensions }),
    ...(runtime.ui === undefined ? {} : { ui: runtime.ui }),
    verifyAfterTurn: runtime.adapter.name === "replay" || !runtime.verificationAvailable ? [] : [runtime.verify],
    maxRepairAttempts: runtime.maxRepairAttempts,
    verification: {
      command: runtime.verificationCommand,
      timeoutMs: runtime.verificationTimeoutMs,
      maxOutputBytes: 64 * 1024,
      env: filteredEnvironment(),
    },
  })
  return { server, handle: await server.start() }
}
