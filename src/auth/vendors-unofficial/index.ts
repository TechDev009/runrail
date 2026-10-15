import type { SignInFlow } from "../signin-types.ts"
import { createKimiSignIn } from "./kimi.ts"
import { createMetaSignIn } from "./meta.ts"
import { createXaiSignIn } from "./xai.ts"

export { createKimiSignIn } from "./kimi.ts"
export type { KimiSignInOverrides } from "./kimi.ts"
export { createMetaSignIn } from "./meta.ts"
export type { MetaSignInOverrides } from "./meta.ts"
export { createXaiSignIn } from "./xai.ts"
export type { XaiSignInOverrides } from "./xai.ts"

/**
 * Plan sign-ins the vendor runs for its own command-line tool and does not document for anyone
 * else. Each presents that tool's public client id and names itself as Runrail; each is marked
 * `unofficial`, and a client shows that before the user starts one.
 *
 * Nothing here is registered by default. A host opts in by passing these next to
 * `defaultSignInFlows()`; the `runrail` command line does.
 */
export function vendorSignInFlows(): readonly SignInFlow[] {
  return Object.freeze([createXaiSignIn(), createKimiSignIn(), createMetaSignIn()])
}
