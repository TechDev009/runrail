export interface WorkbenchThemeTokens {
  readonly foreground: string
  readonly background: string
  readonly accent: string
  readonly muted: string
  readonly positive: string
  readonly warning: string
  readonly danger: string
}

export interface WorkbenchTheme {
  readonly name: string
  readonly revision: string
  readonly tokens: WorkbenchThemeTokens
}

export interface ThemeReloadResult {
  readonly revision: string
  readonly active: readonly WorkbenchTheme[]
  readonly rolledBack: boolean
  readonly error?: string
}

export type ThemeErrorCode = "THEME_INVALID" | "THEME_LIMIT"

export class ThemeError extends Error {
  constructor(readonly code: ThemeErrorCode, reason: string) {
    super(`workbench theme: ${reason}`)
    this.name = "ThemeError"
  }
}

/** Data-only theme registry. Rendering is owned by the terminal/workbench shell. */
export class WorkbenchThemeHost {
  private active: readonly WorkbenchTheme[]
  private revision = "0"
  private readonly maxThemes: number

  constructor(options: { readonly maxThemes?: number } = {}) {
    this.maxThemes = options.maxThemes ?? 32
    if (!Number.isSafeInteger(this.maxThemes) || this.maxThemes < 1 || this.maxThemes > 128)
      throw new ThemeError("THEME_LIMIT", "maxThemes is invalid")
    this.active = Object.freeze([defaultWorkbenchTheme()])
  }

  get themes(): readonly WorkbenchTheme[] {
    return this.active
  }

  get currentRevision(): string {
    return this.revision
  }

  preview(input: unknown): ThemeReloadResult {
    try {
      const themes = parseThemes(input, this.maxThemes)
      return Object.freeze({ revision: digestThemes(themes), active: themes, rolledBack: false })
    } catch (error) {
      return Object.freeze({
        revision: this.revision,
        active: this.active,
        rolledBack: true,
        error: error instanceof Error ? error.message.slice(0, 512) : "theme graph is invalid",
      })
    }
  }

  reload(input: unknown): ThemeReloadResult {
    const result = this.preview(input)
    if (result.rolledBack) return result
    this.active = result.active
    this.revision = result.revision
    return result
  }

  select(name: string): WorkbenchTheme {
    if (typeof name !== "string" || name.length === 0 || name.length > 128)
      throw new ThemeError("THEME_INVALID", "theme name is invalid")
    const theme = this.active.find((candidate) => candidate.name === name)
    if (theme === undefined) throw new ThemeError("THEME_INVALID", "theme is not active")
    return theme
  }
}

export function parseWorkbenchTheme(value: unknown): WorkbenchTheme {
  if (!isRecord(value)) throw new ThemeError("THEME_INVALID", "theme must be an object")
  const name = boundedString(value.name, 1, 128, "name")
  const revision = boundedString(value.revision, 1, 128, "revision")
  if (!isRecord(value.tokens)) throw new ThemeError("THEME_INVALID", "theme tokens are invalid")
  const tokenNames: readonly (keyof WorkbenchThemeTokens)[] = ["foreground", "background", "accent", "muted", "positive", "warning", "danger"]
  const tokens: Record<keyof WorkbenchThemeTokens, string> = {
    foreground: "",
    background: "",
    accent: "",
    muted: "",
    positive: "",
    warning: "",
    danger: "",
  }
  for (const tokenName of tokenNames) {
    const token = value.tokens[tokenName]
    if (typeof token !== "string" || token.length === 0 || token.length > 32 || !isColorToken(token))
      throw new ThemeError("THEME_INVALID", `theme token '${tokenName}' is invalid`)
    tokens[tokenName] = token
  }
  return Object.freeze({ name, revision, tokens: Object.freeze(tokens) })
}

export function defaultWorkbenchTheme(): WorkbenchTheme {
  return Object.freeze({
    name: "default",
    revision: "1",
    tokens: Object.freeze({
      foreground: "ansi:15",
      background: "ansi:0",
      accent: "ansi:14",
      muted: "ansi:8",
      positive: "ansi:10",
      warning: "ansi:11",
      danger: "ansi:9",
    }),
  })
}

function parseThemes(value: unknown, maxThemes: number): readonly WorkbenchTheme[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxThemes)
    throw new ThemeError("THEME_LIMIT", "theme list is invalid")
  const result: WorkbenchTheme[] = []
  const names = new Set<string>()
  for (const item of value) {
    const theme = parseWorkbenchTheme(item)
    if (names.has(theme.name)) throw new ThemeError("THEME_INVALID", "theme names must be unique")
    names.add(theme.name)
    result.push(theme)
  }
  return Object.freeze(result)
}

function digestThemes(themes: readonly WorkbenchTheme[]): string {
  let hash = 2166136261
  for (const theme of themes) {
    for (const character of JSON.stringify(theme)) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

/** `text` in a theme colour, as a terminal foreground escape; a token the terminal cannot show leaves it plain. */
export function themeColor(token: string, text: string): string {
  const ansi = /^ansi:([0-9]{1,3})$/.exec(token)
  if (ansi !== null) return Number(ansi[1]) > 255 ? text : `\x1b[38;5;${ansi[1]}m${text}\x1b[39m`
  const hex = /^#([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})$/.exec(token)
  if (hex === null) return text
  return `\x1b[38;2;${parseInt(hex[1]!, 16)};${parseInt(hex[2]!, 16)};${parseInt(hex[3]!, 16)}m${text}\x1b[39m`
}

function isColorToken(value: string): boolean {
  return /^#[0-9A-Fa-f]{6}$/.test(value) || /^ansi:[0-9]{1,3}$/.test(value)
}

function boundedString(value: unknown, min: number, max: number, name: string): string {
  if (typeof value !== "string" || value.length < min || value.length > max)
    throw new ThemeError("THEME_INVALID", `theme ${name} is invalid`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
