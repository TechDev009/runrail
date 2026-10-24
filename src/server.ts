import {
  CodingAgentRpcServer,
  type CodingAgentRpcServerHandle,
} from "@nifrajs/coding-agent"
import { refusedPlace } from "./control-server.ts"
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
  guardPlace(server, options.allowRemote === true)
  return { server, handle: await server.start() }
}

/**
 * The Nifra listener answers any Host and reflects any localhost Origin in CORS. Its request handler
 * is wrapped so a browser page or a rebound host name is refused before reaching it, as the control
 * server refuses them.
 */
function guardPlace(server: CodingAgentRpcServer, allowRemote: boolean): void {
  const target = server as unknown as { fetch?: unknown }
  const inner = target.fetch
  // The handler is Nifra's private method; without it there is nothing to wrap, so nothing is served.
  if (typeof inner !== "function") throw new Error("runrail serve: the RPC server's request handler cannot be guarded")
  target.fetch = (request: Request): unknown => {
    const refused = refusedPlace(request, allowRemote)
    if (refused === undefined) return inner.call(server, request)
    return Response.json({ error: { code: refused, message: "requests from a browser page or another host are refused" } }, { status: 403, headers: { "cache-control": "no-store" } })
  }
}
