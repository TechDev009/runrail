import { expect, test } from "bun:test"
import {
  createStepCatalog,
  type CatalogStep,
} from "@nifrajs/coding-agent/orchestration"
import { createDefaultBackendRegistry } from "../../src/backend/defaults.ts"
import { createPortableHandoff } from "../../src/handoff.ts"
import { RunrailPlanRunner } from "../../src/plan-runner.ts"
import { routeBackend } from "../../src/router.ts"

test("routes, runs, verifies, and hands off a declarative plan", async () => {
  const route = routeBackend(createDefaultBackendRegistry(), {
    requiredCapabilities: ["workspace.tools", "verification"],
  })
  expect(route.backend).toBe("native")
  const calls: string[] = []
  const steps: Record<string, CatalogStep> = {
    prepare: {
      kind: "task",
      run: (context) => {
        calls.push("prepare")
        context.set("ready", true)
      },
    },
    verify: {
      kind: "verify",
      run: () => {
        calls.push("verify")
        return { ok: true }
      },
    },
    handoff: {
      kind: "handoff",
      run: () => {
        calls.push("handoff")
      },
    },
  }
  const runner = new RunrailPlanRunner({ catalog: createStepCatalog(steps) })
  const result = await runner.run(
    {
      version: 1,
      id: "demo-plan",
      nodes: [
        { id: "prepare", kind: "task", step: "prepare" },
        { id: "verify", kind: "verify", step: "verify", dependsOn: ["prepare"] },
        { id: "handoff", kind: "handoff", step: "handoff", dependsOn: ["verify"] },
      ],
    },
    { runId: "demo-run" },
  )
  expect(result.status).toBe("succeeded")
  expect(result.completedNodeIds).toEqual(["handoff", "prepare", "verify"])
  expect(calls).toEqual(["prepare", "verify", "handoff"])
  const handoff = await createPortableHandoff({
    handoffId: "handoff-demo",
    runId: result.runId,
    source: route.backend,
    target: "pi",
    objective: "complete the demo",
    acceptance: "the verification gate passes",
    completedNodeIds: result.completedNodeIds,
    verification: { name: "check", ok: true, status: 0 },
  })
  expect(handoff.completedNodeIds).toEqual(result.completedNodeIds)
})

test("executes every bounded plan node family through the public kernel", async () => {
  const calls: string[] = []
  let flakyAttempts = 0
  const runner = new RunrailPlanRunner({
    catalog: createStepCatalog({
      task: { kind: "task", run: () => calls.push("task") },
      left: { kind: "task", run: () => calls.push("left") },
      right: { kind: "task", run: () => calls.push("right") },
      flaky: {
        kind: "task",
        run: () => {
          flakyAttempts += 1
          if (flakyAttempts === 1) throw new Error("retry once")
          calls.push("flaky")
        },
      },
      predicate: { kind: "branch", when: () => true },
      then: { kind: "task", run: () => calls.push("then") },
      otherwise: { kind: "task", run: () => calls.push("otherwise") },
      approve: { kind: "approve", run: () => true },
      verify: { kind: "verify", run: () => ({ ok: true }) },
      checkpoint: { kind: "checkpoint", run: () => calls.push("checkpoint") },
      handoff: { kind: "handoff", run: () => calls.push("handoff") },
      subagent: {
        kind: "subagent",
        spec: () => ({ id: "child-1", role: "reviewer", prompt: "review" }),
        executor: { run: () => calls.push("subagent") },
      },
    }),
  })
  const result = await runner.run({
    version: 1,
    id: "all-node-kinds",
    nodes: [
      {
        id: "pipeline",
        kind: "sequence",
        children: [
          { id: "task", kind: "task", step: "task" },
          {
            id: "parallel",
            kind: "parallel",
            maxConcurrency: 2,
            children: [
              { id: "left", kind: "task", step: "left" },
              { id: "right", kind: "task", step: "right" },
            ],
          },
          {
            id: "retry",
            kind: "retry",
            attempts: 2,
            child: { id: "flaky", kind: "task", step: "flaky" },
          },
          {
            id: "branch",
            kind: "branch",
            step: "predicate",
            then: { id: "then", kind: "task", step: "then" },
            otherwise: { id: "otherwise", kind: "task", step: "otherwise" },
          },
          { id: "approve", kind: "approve", step: "approve", reason: "safe" },
          { id: "verify", kind: "verify", step: "verify" },
          { id: "checkpoint", kind: "checkpoint", step: "checkpoint" },
          { id: "handoff", kind: "handoff", step: "handoff" },
          { id: "subagent", kind: "subagent", step: "subagent" },
        ],
      },
    ],
  })
  expect(result.status).toBe("succeeded")
  expect(calls).toEqual(["task", "left", "right", "flaky", "then", "checkpoint", "handoff", "subagent"])
})

test("cancels a live plan without reviving it", async () => {
  const controller = new AbortController()
  const runner = new RunrailPlanRunner({
    catalog: createStepCatalog({
      wait: {
        kind: "task",
        run: async (context) => {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 1_000)
            context.signal.addEventListener("abort", () => {
              clearTimeout(timer)
              reject(new Error("cancelled"))
            }, { once: true })
          })
        },
      },
    }),
  })
  setTimeout(() => controller.abort("test cancellation"), 10)
  const result = await runner.run({
    version: 1,
    id: "cancel-plan",
    nodes: [{ id: "wait", kind: "task", step: "wait" }],
  }, { signal: controller.signal })
  expect(result.status).toBe("cancelled")
})
