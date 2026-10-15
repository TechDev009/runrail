export interface WorkbenchCommandContext {
  readonly args: readonly string[]
  readonly signal?: AbortSignal
}

export interface WorkbenchCommand {
  readonly id: string
  readonly aliases?: readonly string[]
  readonly description: string
  readonly execute: (context: WorkbenchCommandContext) => unknown | PromiseLike<unknown>
}

export interface WorkbenchCommandDescriptor {
  readonly id: string
  readonly aliases: readonly string[]
  readonly description: string
}

export interface WorkbenchCommandRegistryOptions {
  readonly maxCommands?: number
  readonly maxArguments?: number
  readonly maxArgumentBytes?: number
}

export interface WorkbenchHotkeyBinding {
  readonly key: string
  readonly command: string
  readonly args?: readonly string[]
}

export type WorkbenchCommandErrorCode =
  | "WORKBENCH_COMMAND_INVALID"
  | "WORKBENCH_COMMAND_LIMIT"
  | "WORKBENCH_COMMAND_CONFLICT"
  | "WORKBENCH_COMMAND_NOT_FOUND"
  | "WORKBENCH_HOTKEY_INVALID"
  | "WORKBENCH_HOTKEY_CONFLICT"

export class WorkbenchCommandError extends Error {
  constructor(readonly code: WorkbenchCommandErrorCode, reason: string) {
    super(`${code}: ${reason}`)
    this.name = "WorkbenchCommandError"
  }
}

/** Bounded command registry used by the native console and plugin adapters. */
export class WorkbenchCommandRegistry {
  private readonly commands = new Map<string, WorkbenchCommand>()
  private readonly names = new Map<string, string>()
  private readonly maxCommands: number
  private readonly maxArguments: number
  private readonly maxArgumentBytes: number

  constructor(options: WorkbenchCommandRegistryOptions = {}) {
    this.maxCommands = options.maxCommands ?? 256
    this.maxArguments = options.maxArguments ?? 64
    this.maxArgumentBytes = options.maxArgumentBytes ?? 4_096
    if (!Number.isSafeInteger(this.maxCommands) || this.maxCommands < 1 || this.maxCommands > 2_048 || !Number.isSafeInteger(this.maxArguments) || this.maxArguments < 1 || this.maxArguments > 256 || !Number.isSafeInteger(this.maxArgumentBytes) || this.maxArgumentBytes < 1 || this.maxArgumentBytes > 64 * 1024)
      throw new WorkbenchCommandError("WORKBENCH_COMMAND_LIMIT", "command limits are invalid")
  }

  get limits(): Required<WorkbenchCommandRegistryOptions> {
    return Object.freeze({
      maxCommands: this.maxCommands,
      maxArguments: this.maxArguments,
      maxArgumentBytes: this.maxArgumentBytes,
    })
  }

  register(command: WorkbenchCommand): this {
    validateCommand(command, this.maxArguments, this.maxArgumentBytes)
    if (this.commands.size >= this.maxCommands && !this.commands.has(command.id)) throw new WorkbenchCommandError("WORKBENCH_COMMAND_LIMIT", "command limit reached")
    const names = [command.id, ...(command.aliases ?? [])]
    if (names.some((name) => this.names.has(name) && this.names.get(name) !== command.id)) throw new WorkbenchCommandError("WORKBENCH_COMMAND_CONFLICT", "command name or alias is already registered")
    const previous = this.commands.get(command.id)
    if (previous !== undefined) for (const name of [previous.id, ...(previous.aliases ?? [])]) this.names.delete(name)
    const frozen = Object.freeze({ ...command, aliases: Object.freeze([...(command.aliases ?? [])]) })
    this.commands.set(command.id, frozen)
    for (const name of names) this.names.set(name, command.id)
    return this
  }

  unregister(id: string): boolean {
    const safeId = validateName(id, "command id")
    const command = this.commands.get(safeId)
    if (command === undefined) return false
    this.commands.delete(safeId)
    for (const name of [command.id, ...(command.aliases ?? [])]) this.names.delete(name)
    return true
  }

  get(name: string): WorkbenchCommand | undefined {
    const safeName = validateName(name, "command name")
    const id = this.names.get(safeName)
    return id === undefined ? undefined : this.commands.get(id)
  }

  list(): readonly WorkbenchCommandDescriptor[] {
    return Object.freeze([...this.commands.values()].sort((left, right) => left.id.localeCompare(right.id)).map((command) => Object.freeze({ id: command.id, aliases: Object.freeze([...command.aliases ?? []]), description: command.description })))
  }

  async dispatch(name: string, args: readonly string[] = [], signal?: AbortSignal): Promise<unknown> {
    const command = this.get(name)
    if (command === undefined) throw new WorkbenchCommandError("WORKBENCH_COMMAND_NOT_FOUND", "command is not registered")
    validateArguments(args, this.maxArguments, this.maxArgumentBytes)
    if (signal?.aborted) throw new WorkbenchCommandError("WORKBENCH_COMMAND_INVALID", "command was cancelled")
    return command.execute(Object.freeze({ args: Object.freeze([...args]), ...(signal === undefined ? {} : { signal }) }))
  }
}

/** Deterministic key-to-command bindings kept separate from terminal decoding. */
export class HotkeyRegistry {
  private readonly bindings = new Map<string, WorkbenchHotkeyBinding>()

  register(binding: WorkbenchHotkeyBinding): this {
    validateHotkey(binding)
    if (this.bindings.has(binding.key)) throw new WorkbenchCommandError("WORKBENCH_HOTKEY_CONFLICT", "hotkey is already registered")
    this.bindings.set(binding.key, Object.freeze({ ...binding, ...(binding.args === undefined ? {} : { args: Object.freeze([...binding.args]) }) }))
    return this
  }

  unregister(key: string): boolean {
    const safeKey = validateName(key, "hotkey")
    return this.bindings.delete(safeKey)
  }

  resolve(key: string): WorkbenchHotkeyBinding | undefined {
    return this.bindings.get(validateName(key, "hotkey"))
  }

  list(): readonly WorkbenchHotkeyBinding[] {
    return Object.freeze([...this.bindings.values()].sort((left, right) => left.key.localeCompare(right.key)))
  }
}

export function cloneWorkbenchCommandRegistry(source: WorkbenchCommandRegistry): WorkbenchCommandRegistry {
  const target = new WorkbenchCommandRegistry(source.limits)
  for (const descriptor of source.list()) {
    const command = source.get(descriptor.id)
    if (command !== undefined) target.register(command)
  }
  return target
}

export function cloneHotkeyRegistry(source: HotkeyRegistry): HotkeyRegistry {
  const target = new HotkeyRegistry()
  for (const binding of source.list()) target.register(binding)
  return target
}

function validateCommand(command: WorkbenchCommand, maxArguments: number, maxArgumentBytes: number): void {
  if (command === null || typeof command !== "object" || typeof command.execute !== "function") throw new WorkbenchCommandError("WORKBENCH_COMMAND_INVALID", "command shape is invalid")
  validateName(command.id, "command id")
  if (typeof command.description !== "string" || command.description.length === 0 || command.description.length > 512 || /[\r\n]/.test(command.description)) throw new WorkbenchCommandError("WORKBENCH_COMMAND_INVALID", "command description is invalid")
  if (command.aliases !== undefined) {
    if (!Array.isArray(command.aliases) || command.aliases.length > 16) throw new WorkbenchCommandError("WORKBENCH_COMMAND_INVALID", "command aliases are invalid")
    const aliases = new Set<string>()
    for (const alias of command.aliases) {
      validateName(alias, "command alias")
      if (alias === command.id || aliases.has(alias)) throw new WorkbenchCommandError("WORKBENCH_COMMAND_CONFLICT", "command aliases must be unique")
      aliases.add(alias)
    }
  }
  if (command.id.length > maxArgumentBytes || maxArguments < 1) throw new WorkbenchCommandError("WORKBENCH_COMMAND_INVALID", "command limits are invalid")
}

function validateArguments(args: readonly string[], maxArguments: number, maxArgumentBytes: number): void {
  if (!Array.isArray(args) || args.length > maxArguments || args.some((arg) => typeof arg !== "string" || arg.length > maxArgumentBytes || arg.includes("\0"))) throw new WorkbenchCommandError("WORKBENCH_COMMAND_INVALID", "command arguments are invalid")
}

function validateHotkey(binding: WorkbenchHotkeyBinding): void {
  if (binding === null || typeof binding !== "object") throw new WorkbenchCommandError("WORKBENCH_HOTKEY_INVALID", "hotkey binding is invalid")
  validateName(binding.key, "hotkey")
  validateName(binding.command, "hotkey command")
  if (binding.args !== undefined) validateArguments(binding.args, 64, 4_096)
}

function validateName(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new WorkbenchCommandError("WORKBENCH_COMMAND_INVALID", `${field} is invalid`)
  return value
}
