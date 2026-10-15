import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { AccountError } from "./types.ts"

/** User-owned connections outlive the project and thread that first used them. */
export function resolveAccountsRoot(value: unknown = process.env.RUNRAIL_ACCOUNTS_DIR ?? join(homedir(), ".runrail", "accounts")): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096 || /[\0-\x1f\x7f]/.test(value)) throw new AccountError("ACCOUNT_INVALID", "accounts directory is invalid")
  return resolve(value)
}
