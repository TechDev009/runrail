import {
  runModelGateway,
  structuredOutputParser,
  type ModelGateway,
  type ModelRoutePolicy,
} from "@nifrajs/agent"
import {
  createNativeGatewayModelPort,
  type NativeGatewayModelPortOptions,
  type NativeModelResponse,
} from "@nifrajs/coding-agent"
import type { ModelAdapter, ModelDescriptor } from "./catalog.ts"
import type { RunrailContentModelPort, RunrailContentModelRequest } from "./content.ts"

export interface GatewayModelAdapterOptions extends NativeGatewayModelPortOptions {
  readonly descriptor: ModelDescriptor
}

/** Adapt a caller-owned Nifra gateway and route policy into Runrail's model catalog. */
export function createGatewayModelAdapter(options: GatewayModelAdapterOptions): ModelAdapter {
  return Object.freeze({
    descriptor: options.descriptor,
    create: () => createNativeGatewayModelPort({
      gateway: options.gateway,
      policy: options.policy,
      ...(options.routeId === undefined ? {} : { routeId: options.routeId }),
    }),
  })
}

export interface GatewayContentModelOptions {
  readonly gateway: ModelGateway
  readonly policy: ModelRoutePolicy
  readonly routeId?: string
}

/** Gateway adapter variant that receives the canonical transient content-part request. */
export function createGatewayContentModelPort(options: GatewayContentModelOptions): RunrailContentModelPort {
  const parser = structuredOutputParser<NativeModelResponse>((value) => parseNativeResponse(value))
  return {
    complete(request: RunrailContentModelRequest) {
      const { signal: _signal, ...input } = request
      return runModelGateway(
        options.gateway,
        {
          input: {
            ...input,
            parts: Object.freeze([...request.parts]),
          },
          ...(options.routeId === undefined ? {} : { routeId: options.routeId }),
          parser,
          signal: request.signal,
        },
        options.policy,
      ).then((result) => {
        if (!result.ok) throw new Error(`native gateway failed: ${result.error.code}`)
        return result.output
      })
    },
  }
}

function parseNativeResponse(value: unknown): NativeModelResponse {
  if (!isRecord(value)) throw new TypeError("native model response is invalid")
  if (value.type === "text" && typeof value.text === "string")
    return Object.freeze({ type: "text", text: value.text })
  if (value.type === "tool" && typeof value.name === "string" && Object.hasOwn(value, "input"))
    return Object.freeze({ type: "tool", name: value.name, input: value.input })
  throw new TypeError("native model response is invalid")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
