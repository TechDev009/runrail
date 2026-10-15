import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createRunrailSessionController, type RunrailSessionController } from "../../src/control.ts"
import { createNativeControlRuntime, nativeTaskController } from "../../src/control-native.ts"
import { createNativeTaskController } from "../../src/task/controller.ts"
import { createNativeTaskKernel, FileNativeEventJournal, FileNativeTaskStore, parseNativeCommand } from "../../src/index.ts"

function command(idempotencyKey: string, name: "task.start" | "task.enqueue" = "task.start") {
  return parseNativeCommand({
    contractVersion: 1,
    commandId: `command-${idempotencyKey}`,
    idempotencyKey,
    taskId: "task-1",
    sessionId: "session-1",
    name,
    requestedAt: 1,
    timeoutMs: 10_000,
  })
}

test("native task kernel persists bounded state and replays idempotent commands", async () => {
  const kernel = createNativeTaskKernel({ now: () => 100 })
  const created = await kernel.create({ taskId: "task-1", projectId: "project-1", sessionId: "session-1", title: "Native task", now: 100 })
  expect(created).toMatchObject({ status: "draft", lastEventSeq: 0 })

  const operation = async () => ({
    status: "completed" as const,
    events: [
      { type: "task.started" as const },
      { type: "task.completed" as const, terminal: "completed" as const, digest: "digest-1" },
    ],
    digest: "digest-1",
    completedAt: 101,
  })
  const first = await kernel.execute(command("same"), operation)
  const replay = await kernel.execute(command("same"), operation)
  expect(first.status).toBe("completed")
  expect(replay.status).toBe("replayed")
  expect(await kernel.snapshot("task-1")).toMatchObject({ status: "completed", revision: 1, lastEventSeq: 2, digest: "digest-1" })
  expect(kernel.events("task-1").map((event) => event.type)).toEqual(["task.created", "task.started", "task.completed"])
})

test("native task kernel rejects invalid transitions and preserves failure metadata", async () => {
  const kernel = createNativeTaskKernel({ now: () => 100 })
  await kernel.create({ taskId: "task-1", projectId: "project-1", sessionId: "session-1", title: "Native task", now: 100 })
  const failed = await kernel.execute(command("failure"), async () => {
    throw new Error("raw operation detail must not become evidence")
  })
  expect(failed).toMatchObject({ status: "rejected", code: "NATIVE_OPERATION_FAILED" })
  expect(await kernel.snapshot("task-1")).toMatchObject({ status: "failed", terminalCode: "NATIVE_OPERATION_FAILED" })
  expect(JSON.stringify(kernel.events("task-1"))).not.toContain("raw operation detail")
  await expect(kernel.execute(command("after-failure", "task.enqueue"), async () => ({ status: "completed", events: [] }))).rejects.toMatchObject({ code: "NATIVE_STATE_CONFLICT" })
})

test("native task kernel validates transitions before appending events", async () => {
  const kernel = createNativeTaskKernel({ now: () => 100 })
  await kernel.create({ taskId: "task-1", projectId: "project-1", sessionId: "session-1", title: "Native task", now: 100 })
  await kernel.execute(command("complete"), async () => ({
    status: "completed" as const,
    events: [{ type: "task.started" as const }, { type: "task.completed" as const, terminal: "completed" as const }],
  }))
  const before = kernel.events("task-1")
  await expect(kernel.execute(command("invalid-after-terminal"), async () => ({
    status: "failed" as const,
    events: [{ type: "task.failed" as const, terminal: "failed" as const, code: "invalid" }],
  }))).rejects.toMatchObject({ code: "NATIVE_STATE_CONFLICT" })
  expect(kernel.events("task-1")).toEqual(before)
})

test("an approval answered within one operation completes the task, and a failing command leaves a finished task alone", async () => {
  const kernel = createNativeTaskKernel({ now: () => 100 })
  await kernel.create({ taskId: "task-1", projectId: "project-1", sessionId: "session-1", title: "Native task", now: 100 })
  const approved = await kernel.execute(command("approved"), async () => ({
    status: "completed" as const,
    events: [{ type: "task.started" as const }, { type: "approval.required" as const, capability: "process.exec" }, { type: "task.completed" as const, terminal: "completed" as const }],
  }))
  expect(approved.status).toBe("completed")
  expect(await kernel.snapshot("task-1")).toMatchObject({ status: "completed" })
  const rejected = await kernel.execute(command("throws-after-done", "task.enqueue"), async () => {
    throw new Error("late failure")
  })
  expect(rejected).toMatchObject({ status: "rejected", code: "NATIVE_OPERATION_FAILED" })
  expect(await kernel.snapshot("task-1")).toMatchObject({ status: "completed" })
})

test("native task kernel serializes concurrent commands for one task", async () => {
  const kernel = createNativeTaskKernel({ now: () => 100 })
  await kernel.create({ taskId: "task-1", projectId: "project-1", sessionId: "session-1", title: "Native task", now: 100 })
  const operation = async () => {
    await new Promise((resolve) => setTimeout(resolve, 5))
    return {
      status: "completed" as const,
      events: [{ type: "task.started" as const }, { type: "task.completed" as const, terminal: "completed" as const }],
    }
  }
  const [first, second] = await Promise.all([
    kernel.execute(command("concurrent-1"), operation),
    kernel.execute(command("concurrent-2"), operation),
  ])
  expect(first.status).toBe("completed")
  expect(second.status).toBe("completed")
  expect(kernel.events("task-1").map((event) => event.seq)).toEqual([0, 1, 2, 3, 4])
})

test("native task file store survives reload without storing payloads", async () => {
  const root = await mkdtemp(join("/tmp", "runrail-native-task-store-"))
  try {
    const first = createNativeTaskKernel({ store: new FileNativeTaskStore({ root }), now: () => 100 })
    await first.create({ taskId: "task-1", projectId: "project-1", sessionId: "session-1", title: "Persisted task", now: 100 })
    const second = createNativeTaskKernel({ store: new FileNativeTaskStore({ root }), now: () => 200 })
    await expect(second.snapshot("task-1")).resolves.toMatchObject({ title: "Persisted task", status: "draft" })
    const files = await second.list("project-1")
    expect(files).toHaveLength(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test("a task store whose first read fails never writes over its file", async () => {
  const root = await mkdtemp(join("/tmp", "runrail-native-task-store-"))
  try {
    await writeFile(join(root, "tasks.json"), "{not json", "utf8")
    const store = new FileNativeTaskStore({ root })
    const record = (await createNativeTaskKernel({ now: () => 100 }).create({ taskId: "task-1", projectId: "project-1", sessionId: "session-1", title: "T", now: 100 }))
    await expect(store.list()).rejects.toMatchObject({ code: "NATIVE_INVALID" })
    await expect(store.put(record)).rejects.toMatchObject({ code: "NATIVE_INVALID" })
    expect(await readFile(join(root, "tasks.json"), "utf8")).toBe("{not json")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("the event journal appends lines, survives a torn last line, and drops its oldest events to stay in bounds", async () => {
  const root = await mkdtemp(join("/tmp", "runrail-native-journal-"))
  try {
    const journal = new FileNativeEventJournal({ root, maxBytes: 8_192 })
    for (let seq = 0; seq < 200; seq += 1) journal.append({ eventId: `t:${String(seq)}`, taskId: "t", sessionId: "s", seq, at: 1_000 + seq, type: "task.started" })
    const text = await readFile(join(root, "events.jsonl"), "utf8")
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(8_192)
    expect(journal.read("t", 198).map((event) => event.seq)).toEqual([199])
    expect(() => journal.read("t", -1)).toThrow("expired")
    await writeFile(join(root, "events.jsonl"), `${text}{"torn":`, "utf8")
    const reopened = new FileNativeEventJournal({ root, maxBytes: 8_192 })
    expect(reopened.read("t", 198).map((event) => event.seq)).toEqual([199])
    reopened.append({ eventId: "t:200", taskId: "t", sessionId: "s", seq: 200, at: 2_000, type: "task.started" })
    expect(new FileNativeEventJournal({ root, maxBytes: 8_192 }).read("t", 199).map((event) => event.seq)).toEqual([200])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("native task controller projects the Runrail session into metadata-only task events", async () => {
  const cwd = await mkdtemp(join("/tmp", "runrail-native-task-controller-"))
  try {
    const controller = await createRunrailSessionController({ cwd, backend: "native", loadExtensions: false, model: { complete: () => ({ type: "text", text: "done" }) } })
    const kernel = createNativeTaskKernel({ now: () => 100 })
    const task = await createNativeTaskController({ taskId: "task-controller", projectId: "project-1", sessionId: controller.session.snapshot.id, title: "Controller task", now: 100 }, controller, kernel)
    try {
      const result = await task.enqueue("finish", "controller-command")
      expect(result.status).toBe("completed")
      expect(await task.snapshot()).toMatchObject({ status: "completed" })
      expect(task.events().some((event) => event.type === "task.completed")).toBe(true)
      expect(JSON.stringify(task.events())).not.toContain("done")
    } finally {
      await controller.close("task controller test complete")
    }
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test("a task's cached controller is not handed to a session that replaced its own", async () => {
  const root = await mkdtemp(join("/tmp", "runrail-native-task-cache-"))
  try {
    const runtime = createNativeControlRuntime({ stateRoot: root, workspaceRoot: root, projectId: "project-1", ownerId: "owner-1", accountsRoot: join(root, "accounts") })
    let sessionId = "session-before"
    const controller = { session: { get snapshot() { return { id: sessionId } } } } as unknown as RunrailSessionController
    await runtime.taskKernel.create({ taskId: "task-cached", projectId: "project-1", sessionId, title: "Cached", now: 100 })
    const first = await nativeTaskController(runtime, "task-cached", controller)
    expect(await nativeTaskController(runtime, "task-cached", controller)).toBe(first)
    // A refresh keeps the controller object but puts another session behind it.
    sessionId = "session-after"
    await expect(nativeTaskController(runtime, "task-cached", controller)).rejects.toMatchObject({ code: "NATIVE_AUTH_REQUIRED" })
    sessionId = "session-before"
    const other = { session: { snapshot: { id: "session-before" } } } as unknown as RunrailSessionController
    expect(await nativeTaskController(runtime, "task-cached", other)).not.toBe(first)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("an idempotency key replays only the command it was first used for", async () => {
  const kernel = createNativeTaskKernel({ now: () => 100 })
  for (const taskId of ["task-one", "task-two"]) await kernel.create({ taskId, projectId: "project-1", sessionId: "session-1", title: taskId, now: 100 })
  const command = (taskId: string, message: string) => parseNativeCommand({ contractVersion: 1, commandId: `cmd-${taskId}`, idempotencyKey: "shared-key", taskId, sessionId: "session-1", name: "task.enqueue", requestedAt: 100, timeoutMs: 1_000, payload: { message } })
  let runs = 0
  const operation = async () => (runs += 1, { events: [{ type: "task.started" as const }, { type: "task.completed" as const, terminal: "completed" as const }] })
  await expect(kernel.execute(command("task-one", "hello"), operation)).resolves.toMatchObject({ status: "completed", commandId: "cmd-task-one" })
  await expect(kernel.execute(command("task-one", "hello"), operation)).resolves.toMatchObject({ status: "replayed" })
  await expect(kernel.execute(command("task-one", "changed"), operation)).rejects.toMatchObject({ code: "NATIVE_IDEMPOTENCY_CONFLICT" })
  await expect(kernel.execute(command("task-two", "hello"), operation)).rejects.toMatchObject({ code: "NATIVE_IDEMPOTENCY_CONFLICT" })
  expect(runs).toBe(1)
})

test("one key sent to two tasks at once runs only one of them", async () => {
  const kernel = createNativeTaskKernel({ now: () => 100 })
  for (const taskId of ["task-a", "task-b"]) await kernel.create({ taskId, projectId: "project-1", sessionId: "session-1", title: taskId, now: 100 })
  let runs = 0
  const operation = async () => {
    runs += 1
    await Bun.sleep(20)
    return { events: [{ type: "task.started" as const }] }
  }
  const command = (taskId: string) => parseNativeCommand({ contractVersion: 1, commandId: `cmd-${taskId}`, idempotencyKey: "racing-key", taskId, sessionId: "session-1", name: "task.start", requestedAt: 100, timeoutMs: 1_000 })
  const results = await Promise.allSettled([kernel.execute(command("task-a"), operation), kernel.execute(command("task-b"), operation)])
  expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"])
  expect(runs).toBe(1)
})

test("an operation whose last event is invalid journals none of them, and the task keeps working", async () => {
  const kernel = createNativeTaskKernel({ now: () => 100 })
  await kernel.create({ taskId: "task-poison", projectId: "project-1", sessionId: "session-1", title: "Poison", now: 100 })
  const command = (key: string) => parseNativeCommand({ contractVersion: 1, commandId: `cmd-${key}`, idempotencyKey: key, taskId: "task-poison", sessionId: "session-1", name: "task.start", requestedAt: 100, timeoutMs: 1_000 })
  await expect(kernel.execute(command("bad"), async () => ({ events: [{ type: "task.started" as const }, { type: "turn.started" as const, metadata: { name: "x".repeat(100_000) } }] }))).rejects.toMatchObject({ code: "NATIVE_INVALID" })
  expect(kernel.events("task-poison").map((event) => event.type)).toEqual(["task.created"])
  await expect(kernel.execute(command("good"), async () => ({ events: [{ type: "task.started" as const }] }))).resolves.toMatchObject({ status: "completed", firstEventSeq: 1 })
})

test("a journal left ahead of its task by a failed write does not block the next command", async () => {
  const kernel = createNativeTaskKernel({ now: () => 100 }) as unknown as { journal: { append(event: Record<string, unknown>): unknown } } & ReturnType<typeof createNativeTaskKernel>
  await kernel.create({ taskId: "task-ahead", projectId: "project-1", sessionId: "session-1", title: "Ahead", now: 100 })
  kernel.journal.append({ eventId: "task-ahead:1:task.started", taskId: "task-ahead", sessionId: "session-1", seq: 1, at: 100, type: "task.started" })
  const command = parseNativeCommand({ contractVersion: 1, commandId: "cmd-ahead", idempotencyKey: "ahead", taskId: "task-ahead", sessionId: "session-1", name: "task.start", requestedAt: 100, timeoutMs: 1_000 })
  await expect(kernel.execute(command, async () => ({ events: [{ type: "turn.started" as const, turnId: "turn-1" }] }))).resolves.toMatchObject({ status: "completed", firstEventSeq: 2 })
})
