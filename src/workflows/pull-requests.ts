import { runGitHubCli } from "../git/github-cli.ts"
import type { PullRequestRef } from "./store.ts"

/** A pull request as a trigger knows it: its number, and its title and link when they are sound. */
export function pullRequestRef(value: unknown): PullRequestRef[] {
  if (typeof value !== "object" || value === null) return []
  const item = value as Record<string, unknown>
  if (typeof item.number !== "number" || !Number.isSafeInteger(item.number) || item.number < 1) return []
  const title = typeof item.title === "string" ? item.title.replace(/[\r\n]+/g, " ").slice(0, 200) : undefined
  const url = typeof item.url === "string" && /^https:\/\/[^\s]{1,500}$/.test(item.url) ? item.url : undefined
  return [{ number: item.number, ...(title === undefined ? {} : { title }), ...(url === undefined ? {} : { url }) }]
}

/** The open pull requests a PR trigger watches, through the GitHub CLI at `gh`. */
export async function watchedPullRequests(gh: string, root: string, trigger: "pr-review-requested" | "pr-opened"): Promise<readonly PullRequestRef[]> {
  const args = ["pr", "list", "--state", "open", "--json", "number,title,url", "--limit", "20", ...(trigger === "pr-review-requested" ? ["--search", "user-review-requested:@me"] : [])]
  const listed = JSON.parse((await runGitHubCli({ command: gh, cwd: root }, args, { maxOutput: 1024 * 1024 })).text) as unknown
  return Array.isArray(listed) ? listed.flatMap((entry: unknown) => pullRequestRef(entry)) : []
}
