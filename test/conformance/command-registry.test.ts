import { expect, test } from "bun:test"
import {
  HotkeyRegistry,
  WorkbenchCommandError,
  WorkbenchCommandRegistry,
} from "../../src/workbench/commands.ts"

test("command registry resolves bounded aliases and executes caller-owned handlers", async () => {
  const registry = new WorkbenchCommandRegistry()
  registry.register({
    id: "fixture.echo",
    aliases: ["echo"],
    description: "Echo bounded arguments",
    execute: ({ args }) => args.join(" "),
  })

  expect(registry.list()).toEqual([{ id: "fixture.echo", aliases: ["echo"], description: "Echo bounded arguments" }])
  await expect(registry.dispatch("echo", ["one", "two"])).resolves.toBe("one two")
  expect(() => registry.register({ id: "echo", description: "collision", execute: () => undefined })).toThrow(WorkbenchCommandError)
  await expect(registry.dispatch("missing", [])).rejects.toMatchObject({ code: "WORKBENCH_COMMAND_NOT_FOUND" })
})

test("hotkey registry rejects collisions and exposes deterministic bindings", () => {
  const registry = new HotkeyRegistry()
  registry.register({ key: "ctrl-l", command: "clear" })
  registry.register({ key: "escape", command: "cancel", args: ["terminal"] })

  expect(registry.list()).toEqual([
    { key: "ctrl-l", command: "clear" },
    { key: "escape", command: "cancel", args: ["terminal"] },
  ])
  expect(registry.resolve("escape")).toMatchObject({ command: "cancel", args: ["terminal"] })
  expect(() => registry.register({ key: "escape", command: "other" })).toThrow("WORKBENCH_HOTKEY_CONFLICT")
})

test("registry bounds reject malformed command input", () => {
  const registry = new WorkbenchCommandRegistry({ maxCommands: 1 })
  expect(() => registry.register({ id: "one", description: "one", execute: () => undefined })).not.toThrow()
  expect(() => registry.register({ id: "two", description: "two", execute: () => undefined })).toThrow("WORKBENCH_COMMAND_LIMIT")
  expect(() => registry.register({ id: "bad id", description: "bad", execute: () => undefined })).toThrow("WORKBENCH_COMMAND_INVALID")
  expect(() => registry.register({ id: "three", description: "bad", execute: () => undefined })).toThrow("WORKBENCH_COMMAND_LIMIT")
})
