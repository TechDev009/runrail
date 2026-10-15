import { PiBackend, type PiBackendOptions } from "@nifrajs/coding-agent"

export function createPiBackend(options: PiBackendOptions = {}): PiBackend {
  return new PiBackend(options)
}
