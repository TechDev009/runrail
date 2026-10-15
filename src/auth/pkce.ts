import { createHash, randomBytes } from "node:crypto"

export interface PkcePair {
  readonly verifier: string
  readonly challenge: string
}

/** RFC 7636 with S256. The verifier stays in this process; only the challenge goes into a URL. */
export function createPkcePair(): PkcePair {
  const verifier = randomUrlToken(32)
  return Object.freeze({ verifier, challenge: pkceChallenge(verifier) })
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url")
}

export function randomUrlToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url")
}
