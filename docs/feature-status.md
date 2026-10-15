# Runrail feature status

Assessment of the local Runrail engine and Runrail Desktop code as of
2026-10-07. The feature claims below describe a larger target than the current
implementation. General extension points do not establish that a hosted
service, integration catalog, or complete product flow is available.

"Tested" means unit and end-to-end tests plus the flow in the desktop preview.
"Real run" means one run against real tools and accounts, done only with the
person's OK.

| Feature | Implemented today | Gap to the requested target |
| --- | --- | --- |
| Memory | Persisted chat history, context restoration/carryover, compaction, project instructions, bounded resources, and skill loading. Long-term memory behind one provider interface: local SQLite with FTS5 per project and per person, or an external MCP memory server with a visible fallback to local. Recall before a turn (top 3 above a score floor, cited as "Recalled N memories"), "Remember this?" suggestions kept one by one. Tested; the official MCP memory server has not been run for real. | Recall is keyword search (FTS5), not semantic or vector search. No TinyHumans or CortexDB adapter. |
| Source sync | Memory sources: a folder (hash per file; a deleted file's entries are removed), GitHub issues (`updatedAt` cursor), and RSS or Atom feeds (ETag and Last-Modified). Secret-looking files (`.env*`, `*.pem`, `*.key`) are never read. Synced hourly while Desktop runs, its window open or closed into the menu bar, once when added, and on wake. | No app connectors (Drive, Notion, mail) as sources. Sync stops when Desktop quits or the Mac sleeps, and no workflow step syncs a source yet. |
| Integrations | GitHub (the person's own `gh` sign-in), Linear, Jira, and Slack connectors with keys in the credential vault, each reached only at its own host. Per-role grants (Off, Read, Ask, Write) for connectors and MCP servers. Runrail's own loop gets them as native tools, Claude Code through an MCP server the engine runs, Codex as dynamic tools. MCP client/server bridges; local skill discovery and progressive loading. Tested; no real connector key has been used yet. | The claimed 100+ OAuth, 5k+ MCP, and 90k+ skills catalogs are not implemented or verified in these repositories. No OAuth onboarding: keys are pasted. Pi and ACP routes get no connector tools yet. |
| Reviews | Pull requests waiting for the person, authored, or for their team, read through `gh`; summary, changes, checks, and review state. A review thread in a worktree at the PR's head, findings opted in one by one, posted as one GitHub review; merge with the repo's allowed methods, refused for drafts, closed PRs, or a head that moved. Every post and merge waits for a native confirmation the page cannot draw. Reading tested on the person's real inbox; a real review of a private scratch PR on Codex (2026-10-09) found its planted bug; posting and merging tested with a fake `gh` and in the real app against an unreachable host. | Posting and merging have not run against a real PR. GitHub only. |
| Setups | Plan, execute, and review roles, each with its own route, model, and access; plan approval (edit, reorder, send back), review rounds, a check command, and a budget in turns and minutes. Runs in one worktree, as threads the person can watch, grouped in the Threads list. One real run passed: Haiku on Claude Code, plan approved in the app, 4 turns, tests passing in the worktree. | Budget is turns and minutes, not tokens. Runs live in the project engine's memory and end with it; the composer has no setup chip. Manager and coder teams are not built yet. |
| Evals | Cases mined from a project's history (commits that change tests and source), validated one by one, saved as suites, and run against setups in worktrees with hidden tests restored for the check; a scoreboard and per-case grid. Results stay on this machine. Tested in the engine and the preview; one real eval (2 cases, Claude Code Haiku and Codex, 2026-10-09). | Runs need Desktop running (no headless port); a closed window keeps it going in the menu bar, Quit ends the run. One eval at a time per project. Runs are unattended: no plan approval, and executors at Full access in each case's throwaway checkout. |
| Orchestration | Public Nifra plan host with bounded steps, parallel execution, retries, branching, approval, verification, checkpoints, handoffs, and subagents. Setups and workflows compile to these plans. Runrail also has local task state/journals and a generic remote agent transport. Best of N runs one prompt on several models or tools in parallel worktrees, checks each, suggests the passing run with the smallest change, and applies the chosen one; run for real on Claude Code. | Built-in E2E-encrypted A2A is absent (`a2a` exists only as a harness kind). Hosted operation and durable execution across host outages require additional host infrastructure. |
| Workflows | Triggers: manual, schedule, a PR review request, a PR opened. Steps: setup step, check (with retry into a named step), decision, approval, and actions (open a PR, notify, a Slack message the person sends). A vertical editor, run history, and agent-proposed workflows that never run until approved. Old automations migrate once. One scheduled run passed for real. | Schedules run while Desktop runs: a closed window keeps it going in the menu bar while a workflow starts by itself (checked in a debug build, 2026-10-09). A missed slot runs once on wake or reopen. Nothing runs after Quit, a crash, log-out, or while the Mac sleeps; there is no launchd service. The editor is a vertical list, not a visual graph. |

## Code evidence

- Memory/context: [session.ts](../src/session.ts),
  [context/resources.ts](../src/context/resources.ts), and [memory](../src/memory/)
  ([local.ts](../src/memory/local.ts), [mcp.ts](../src/memory/mcp.ts),
  [block.ts](../src/memory/block.ts), [sources.ts](../src/memory/sources.ts)).
- Connectors and grants: [connectors](../src/connectors/) and
  [integrations.ts](../src/integrations.ts).
- MCP and skills: [mcp](../src/mcp/) and [skills](../src/skills/).
- Reviews: [control-git.ts](../src/control-git.ts) and [git](../src/git/).
- Setups, evals, workflows: [setups](../src/setups/), [evals](../src/evals/),
  [workflows](../src/workflows/), and [check](../src/check/).
- Orchestration: [plan-runner.ts](../src/plan-runner.ts),
  [agents/runner.ts](../src/agents/runner.ts), [task](../src/task/), and
  [backend/http-agent.ts](../src/backend/http-agent.ts).
- Desktop views: `src/ui/views/` (`Reviews.tsx`, `Agents.tsx`, `Evals.tsx`,
  `Workflows.tsx`, `Integrations.tsx`, `Memory.tsx`, `Compare.tsx`) and
  `src/app/workflows.ts` in the Runrail Desktop repository.
- Engine/Desktop/optional host responsibilities:
  [native-product-boundary.md](native-product-boundary.md).

Orchestration remains the strongest foundation, and every feature above now has
a working flow. What is left is mostly proof and scale: real runs of Reviews
acting, the external memory server, and a connector key; semantic
recall; and a service so schedules and source sync run after Quit. Closing the
window already keeps them going from the menu bar. The advertised integration catalog scale remains unbuilt.
