import { describe, expect, test } from "bun:test"
import { NifraBackend, ReplayBackend, runNifraVerification } from "@nifrajs/coding-agent"
import { AGENT_PROTOCOL_VERSION } from "@nifrajs/agent-protocol"
import { PiBackend } from "@nifrajs/pi"

describe("packed Nifra consumer", () => {
  test("loads only public package exports", () => {
    expect(AGENT_PROTOCOL_VERSION).toBe(1)
    expect(NifraBackend).toBeFunction()
    expect(ReplayBackend).toBeFunction()
    expect(PiBackend).toBeFunction()
    expect(runNifraVerification).toBeFunction()
  })
})
