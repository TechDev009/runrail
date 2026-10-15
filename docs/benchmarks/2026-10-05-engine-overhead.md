# Runrail and OpenHuman engine smoke benchmark - 2026-10-05

Runrail's selected headless route completed this local mock workload faster than OpenHuman's selected headless route. This experiment compares configured product entry points. It does not isolate Rust versus JavaScript execution speed or establish coding-quality superiority.

## Results

Times are milliseconds. Cold rows contain 15 fresh-process samples per engine after two discarded warmup pairs. Warm rows contain 30 measured requests after five discarded requests.

| Measurement, median | Runrail | OpenHuman |
| --- | ---: | ---: |
| Process launch to authenticated server ready | 125.86 | 467.20 |
| First completed reply after server ready | 8.28 | 474.12 |
| Process launch to first completed reply | 134.67 | 939.03 |
| Warm completed reply, zero mock delay | 0.72 | 41.74 |
| Warm completed reply, 200 ms delay per model request | 207.06 | 452.87 |
| Model requests per completed reply | 1 | 2 |
| Cold peak resident memory, MiB | 89.59 | 88.11 |

Cold launch-to-reply sample p95 was 148.62 ms for Runrail and 974.27 ms for OpenHuman. These are small-sample summaries, not population estimates.

## Versions and execution paths

- Runrail pre-release source, numbered 0.5.0 before the public 0.1.0, at commit `d49ff70e62500912caa8ecb7046fbd885256be29` of the unpublished pre-release history, exported with `git archive` into an isolated directory. Public dependencies were installed with `bun install --frozen-lockfile --ignore-scripts`. Bun 1.4.2 ran the TypeScript source.
- OpenHuman 0.64.10, official macOS ARM64 application release, tag commit `2eb8a33049915cc5e4b6c10c5c9f2ab99862e0ea`. The compiled executable ran its `core` entry point with `--headless-api`; no desktop UI was launched.
- Runrail used its authenticated native control RPC `turn.enqueue` endpoint and a persistent session.
- OpenHuman used its authenticated `openhuman.agent_chat` endpoint, which creates a one-shot agent for each request.
- Both used the same loopback mock OpenAI-compatible endpoint and model identifier. Every completed reply was checked for the expected fixture marker. Actual model-request counts were recorded.

The shared working copy changed during the first experiment. Those preliminary measurements were discarded. These saved results use the pinned Runrail export and do not include concurrent working-copy edits.

## Scope and limits

This was a completion-only smoke experiment. No file edit, tool execution, build, test, repair, actual inference, provider cost, coding quality, or multi-agent density was measured. Runrail's verification and extension discovery were disabled for this fixture.

The configurations differ. Runrail advertised 13 tools and streamed its model response. OpenHuman advertised zero tools on this route, used non-streamed responses, sent larger request bodies, and made two model requests per reply. The 200 ms scenario delays each request, so OpenHuman incurs approximately 400 ms of simulated inference and Runrail approximately 200 ms.

The mock returns constant text for primary and auxiliary completions. It does not reproduce model reasoning or structured auxiliary responses. Its measurements apply to this fixture's execution path.

Cold means a fresh process with a warm filesystem cache. Generated fixture directories were reused across runs, so this is not a measurement of an empty workspace. Server readiness was polled every 5 ms. Native request parsing, routing, authentication, and model-response handling remain included.

Peak RSS comes from macOS `/usr/bin/time -l` around each server process, includes shutdown, and excludes the mock server and test driver. The Rust executable is the production application binary in core mode, rather than OpenHuman's slim `library-profile` build. Their published library measurements use a different setup.

## Rust migration assessment

This experiment does not identify Bun as a performance bottleneck. Runrail's measured warm native route completed in under 1 ms with immediate mock inference. Its architecture also depends on public TypeScript Nifra APIs; changing the desktop shell does not replace those dependencies.

A complete Rust implementation would require preserving or replacing session/event semantics, provider adapters, tools and policy gates, approvals, verification/repair, plugins, MCP, external harness adapters, coordination, recovery, and evidence contracts. The repository contains approximately 52,000 TypeScript source lines before counting Nifra's implementation. Not all of those lines must move for a smaller Rust kernel, but full feature parity is a substantial engineering project.

As a rough planning assessment, a narrow Rust prototype is much smaller than a full migration; replacing the current engine with comparable behavior is likely many weeks to months. A delivery estimate would require a migration design and conformance plan. The current measurements support profiling concrete bottlenecks before starting that work.

## Evidence

[Raw metadata, samples, hashes, and environment](./2026-10-05-engine-overhead.json) contain no model prompts, request bodies, response payloads, bearer tokens, or provider credentials.

The saved JSON is the historical result. The fixture scripts (`suite.py`, `compare.py` for the mock and fixture setup, and `runrail-server.ts`), the frozen Runrail export, and the downloaded OpenHuman executable stayed in a local temporary directory and are not published.

OpenHuman references: [release](https://github.com/tinyhumansai/openhuman/releases/tag/v0.64.10), [published measurement conditions](https://github.com/tinyhumansai/openhuman/blob/main/gitbooks/developing/performance.md).
