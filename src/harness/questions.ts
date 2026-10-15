/**
 * Questions a coding tool asks the person: Claude Code's AskUserQuestion, Codex's
 * request_user_input, and an MCP server's form (an elicitation) that either one passes on. The
 * shared agent protocol has only yes/no approvals, so a question travels as an `approval.required`
 * that also carries `questions`, and its answers come back beside the approval (`approval.resolve`
 * with `answers`). A client that does not show questions sees a plain approval, and the coding tool
 * is told to ask in its reply instead.
 */

export const QUESTION_ACTION = "question"
export const QUESTION_CAPABILITY = "user.input"
/** A question is settled by the person's answers or their refusal, whatever the permission mode. */
export const QUESTION_NEEDS_ANSWERS = "a question needs the person's answers; answer it or decline it"
export const FOLLOW_UP_UNSUPPORTED = "this coding tool cannot be asked for more questions"

const MAX_QUESTIONS = 8
const MAX_OPTIONS = 8
const MAX_ID = 128
const MAX_QUESTION = 1_000
const MAX_HEADER = 64
const MAX_LABEL = 200
const MAX_DESCRIPTION = 500
const MAX_ANSWER = 2_000
const MAX_NOTE = 2_000
const MAX_PREVIEW = 8_000
const MAX_PLACEHOLDER = 200
const MAX_UNIT = 16
/** Claude Code and Codex both tell the model to mark its pick by ending that label so. */
const RECOMMENDED = /\(recommended\)\s*$/i
const NUMBER = /^-?\d+(\.\d+)?$/
const ID = /^[A-Za-z0-9._:-]{1,128}$/

export interface ApprovalQuestionOption {
  /** Also the answer, verbatim. */
  readonly label: string
  readonly description?: string
  /** The tool's own pick: its label ends in "(Recommended)". */
  readonly recommended?: true
  /** Markdown to compare choices by (Claude Code's option preview), on single-choice questions only. */
  readonly preview?: string
}

export interface ApprovalQuestion {
  readonly id: string
  readonly question: string
  /** A short tag for the question, e.g. "Library". */
  readonly header?: string
  /** One helper line under the question. */
  readonly description?: string
  /** A written answer only, or a quantity; a choice when absent. */
  readonly kind?: "text" | "number"
  /** Empty for a text or number question, and for a choice question that takes only a written answer. */
  readonly options: readonly ApprovalQuestionOption[]
  /** More than one choice may be picked. */
  readonly multiSelect?: true
  /** The person may write their own answer instead of a choice. */
  readonly other?: true
  /** The answer is a secret: typed masked, and never recorded or shown again. */
  readonly secret?: true
  /** A text question's empty box. */
  readonly placeholder?: string
  /** A number question's range, which it always has, and how its value moves and starts. */
  readonly min?: number
  readonly max?: number
  readonly step?: number
  readonly defaultValue?: number
  readonly unit?: string
}

/** Question id to the answers picked or written; one answer unless the question is multi-select. */
export type ApprovalAnswers = Readonly<Record<string, readonly string[]>>

/** The person asked for another round of questions, with any answers so far and what they wrote. */
export interface FollowUp {
  readonly note?: string
}

/**
 * Claude Code's AskUserQuestion input, its extended questions included (`kind` text or number, a
 * helper `description`). It always takes a written answer and keys answers by question text.
 */
export function claudeQuestions(input: unknown): readonly ApprovalQuestion[] | undefined {
  if (!isRecord(input) || !Array.isArray(input.questions) || input.questions.length === 0 || input.questions.length > MAX_QUESTIONS) return undefined
  const questions: ApprovalQuestion[] = []
  const texts = new Set<string>()
  for (const [index, value] of input.questions.entries()) {
    if (!isRecord(value)) return undefined
    const question = shapedQuestion(`q${index + 1}`, { ...value, other: value.kind !== "number", secret: false })
    if (question === undefined || texts.has(question.question)) return undefined
    texts.add(question.question)
    questions.push(question)
  }
  return Object.freeze(questions)
}

/** Claude Code takes a request for more questions only for extended questions, which name every question's kind. */
export function claudeTakesFollowUp(input: unknown): boolean {
  return isRecord(input) && Array.isArray(input.questions) && input.questions.length > 0 && input.questions.every((question) => isRecord(question) && typeof question.kind === "string")
}

/** A request for more questions from its wire parts: `followUp` true, and an optional bounded note. */
export function parseFollowUp(followUp: unknown, note: unknown): FollowUp | undefined | "invalid" {
  if (followUp === undefined || followUp === false) return note === undefined ? undefined : "invalid"
  if (followUp !== true) return "invalid"
  if (note === undefined) return Object.freeze({})
  if (typeof note !== "string" || note.length > MAX_NOTE || note.includes("\0")) return "invalid"
  const text = note.trim()
  return Object.freeze(text.length === 0 ? {} : { note: text })
}

/** The one line an extended AskUserQuestion may show above its questions. */
export function claudeQuestionsTitle(input: unknown): string | undefined {
  return isRecord(input) ? bounded(input.title, MAX_QUESTION) : undefined
}

/** Codex's request_user_input params. Codex leaves "Other" to the client, so every question takes a written answer. */
export function codexQuestions(params: unknown): readonly ApprovalQuestion[] | undefined {
  if (!isRecord(params) || !Array.isArray(params.questions) || params.questions.length === 0 || params.questions.length > MAX_QUESTIONS) return undefined
  const questions: ApprovalQuestion[] = []
  const ids = new Set<string>()
  for (const value of params.questions) {
    if (!isRecord(value) || typeof value.id !== "string" || !ID.test(value.id) || ids.has(value.id)) return undefined
    ids.add(value.id)
    const question = bounded(value.question, MAX_QUESTION)
    const options = value.options === null || value.options === undefined ? Object.freeze([]) : optionsOf(value.options)
    if (question === undefined || options === undefined) return undefined
    const header = bounded(value.header, MAX_HEADER)
    questions.push(Object.freeze({ id: value.id, question, ...(header === undefined ? {} : { header }), options, other: true as const, ...(value.isSecret === true ? { secret: true as const } : {}) }))
  }
  return Object.freeze(questions)
}

/** Questions as an `approval.required` carries them, read back from a transcript; undefined when malformed. */
export function carriedQuestions(value: unknown): readonly ApprovalQuestion[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_QUESTIONS) return undefined
  const questions: ApprovalQuestion[] = []
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== "string" || !ID.test(item.id)) return undefined
    const question = shapedQuestion(item.id, item)
    if (question === undefined) return undefined
    questions.push(question)
  }
  return Object.freeze(questions)
}

/**
 * A question from its parts, as Claude Code's extended input or a recorded question names them.
 * A field that does not fit its kind makes the whole question unreadable, as Claude Code itself
 * refuses one.
 */
function shapedQuestion(id: string, value: Record<string, unknown>): ApprovalQuestion | undefined {
  const question = bounded(value.question, MAX_QUESTION)
  if (question === undefined) return undefined
  const kind = value.kind === undefined || value.kind === "choice" ? undefined : value.kind === "text" || value.kind === "number" ? value.kind : "invalid"
  if (kind === "invalid") return undefined
  const multiSelect = kind === undefined && value.multiSelect === true
  const options = kind === undefined ? optionsOf(value.options ?? [], !multiSelect) : Array.isArray(value.options) && value.options.length > 0 ? undefined : Object.freeze([])
  if (options === undefined) return undefined
  const header = bounded(value.header, MAX_HEADER)
  const description = bounded(value.description, MAX_DESCRIPTION)
  const range = kind === "number" ? numberRange(value) : undefined
  if (kind === "number" && range === undefined) return undefined
  const placeholder = kind === "text" ? bounded(value.placeholder, MAX_PLACEHOLDER) : undefined
  return Object.freeze({
    id,
    question,
    ...(header === undefined ? {} : { header }),
    ...(description === undefined ? {} : { description }),
    ...(kind === undefined ? {} : { kind }),
    options,
    ...(multiSelect ? { multiSelect: true as const } : {}),
    ...(value.other === true && kind !== "number" ? { other: true as const } : {}),
    ...(value.secret === true ? { secret: true as const } : {}),
    ...(placeholder === undefined ? {} : { placeholder }),
    ...range,
  })
}

/** A number question's bounds: min below max, a positive step, and a start inside them. */
function numberRange(value: Record<string, unknown>): Pick<ApprovalQuestion, "min" | "max" | "step" | "defaultValue" | "unit"> | undefined {
  const finite = (number: unknown): number | undefined => (typeof number === "number" && Number.isFinite(number) ? number : undefined)
  const min = finite(value.min)
  const max = finite(value.max)
  if (min === undefined || max === undefined || min >= max) return undefined
  const step = finite(value.step)
  if (value.step !== undefined && (step === undefined || step <= 0)) return undefined
  const start = finite(value.defaultValue)
  if (value.defaultValue !== undefined && (start === undefined || start < min || start > max)) return undefined
  const unit = bounded(value.unit, MAX_UNIT)
  return Object.freeze({ min, max, ...(step === undefined ? {} : { step }), ...(start === undefined ? {} : { defaultValue: start }), ...(unit === undefined ? {} : { unit }) })
}

/** Whether a number answer fits its question: in range, and on the step from min. */
function fitsNumber(question: ApprovalQuestion, answer: string): boolean {
  if (!NUMBER.test(answer)) return false
  const value = Number(answer)
  if (!Number.isFinite(value) || (question.min !== undefined && value < question.min) || (question.max !== undefined && value > question.max)) return false
  if (question.step === undefined) return true
  const steps = (value - (question.min ?? 0)) / question.step
  return Math.abs(steps - Math.round(steps)) < 1e-9
}

/** Recorded answers read back from a transcript; empty when every answer was a secret. */
export function carriedAnswers(value: unknown): ApprovalAnswers | undefined {
  return isRecord(value) && Object.keys(value).length === 0 ? Object.freeze({}) : parseAnswers(value)
}

/** Answers as a client sends them; undefined when they are not a bounded id-to-strings map. */
export function parseAnswers(value: unknown): ApprovalAnswers | undefined {
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value)
  if (entries.length === 0 || entries.length > MAX_QUESTIONS) return undefined
  const answers: Record<string, readonly string[]> = {}
  for (const [id, list] of entries) {
    if (id.length > MAX_ID || !ID.test(id) || !Array.isArray(list) || list.length === 0 || list.length > MAX_OPTIONS + 1) return undefined
    const texts: string[] = []
    for (const item of list) {
      if (typeof item !== "string" || item.length > MAX_ANSWER || item.includes("\0") || item.trim().length === 0) return undefined
      texts.push(item.trim())
    }
    answers[id] = Object.freeze(texts)
  }
  return Object.freeze(answers)
}

/** Why the answers do not fit the questions, or undefined when every question has a fitting answer. */
/** `partial` when the person asked for more questions: any question may be left unanswered, but each answer given must fit. */
export function answersMismatch(questions: readonly ApprovalQuestion[], answers: ApprovalAnswers, partial = false): string | undefined {
  const known = new Set(questions.map((question) => question.id))
  if (Object.keys(answers).some((id) => !known.has(id))) return "an answer names no question"
  for (const question of questions) {
    const picked = Object.hasOwn(answers, question.id) ? answers[question.id] : undefined
    if (picked === undefined || picked.length === 0) {
      if (partial) continue
      return "every question needs an answer"
    }
    if (picked.length > 1 && question.multiSelect !== true) return "a single-choice question has more than one answer"
    if (question.kind === "number") {
      if (!fitsNumber(question, picked[0] ?? "")) return `an answer is not a number from ${String(question.min)} to ${String(question.max)}${question.step === undefined ? "" : ` in steps of ${String(question.step)}`}`
      continue
    }
    if (question.kind === "text") continue
    if (question.other !== true && picked.some((answer) => !question.options.some((option) => option.label === answer))) return "an answer is not one of the choices"
  }
  return undefined
}

/**
 * Claude Code reads answers from its own input, keyed by question text; several picks join with
 * commas. The preview of a picked choice goes with it, as Claude Code's own form sends it. A
 * request for more questions sends only the answers given, and the note as the person's response.
 */
export function claudeAnsweredInput(input: Readonly<Record<string, unknown>>, questions: readonly ApprovalQuestion[], answers: ApprovalAnswers, followUp?: FollowUp): Record<string, unknown> {
  const byText: Record<string, string> = {}
  const annotations: Record<string, { readonly preview: string }> = {}
  for (const question of questions) {
    const picked = answers[question.id] ?? []
    if (followUp !== undefined && picked.length === 0) continue
    byText[question.question] = picked.join(", ")
    const preview = picked.length === 1 ? question.options.find((option) => option.label === picked[0])?.preview : undefined
    if (preview !== undefined) annotations[question.question] = { preview }
  }
  const asked = followUp === undefined ? {} : { followUp: true, ...(followUp.note === undefined ? {} : { response: followUp.note }) }
  return { ...input, answers: byText, ...(Object.keys(annotations).length === 0 ? {} : { annotations }), ...asked }
}

export function codexAnswerResult(answers: ApprovalAnswers): Record<string, unknown> {
  return { answers: Object.fromEntries(Object.entries(answers).map(([id, list]) => [id, { answers: [...list] }])) }
}

/** Codex's elicitation response: content and metadata are null unless accepted with content. */
export function codexElicitationResult(answer: ElicitationAnswer): Record<string, unknown> {
  return { action: answer.action, content: answer.content ?? null, _meta: null }
}

/** The answers that may be recorded and shown again: a secret's answer is left out. */
export function recordedAnswers(questions: readonly ApprovalQuestion[], answers: ApprovalAnswers): ApprovalAnswers {
  const secret = new Set(questions.filter((question) => question.secret === true).map((question) => question.id))
  return Object.freeze(Object.fromEntries(Object.entries(answers).filter(([id]) => !secret.has(id))))
}

/** One line for clients that show the question as a plain approval. */
export function questionsReason(questions: readonly ApprovalQuestion[]): string {
  const [first] = questions
  const lead = first === undefined ? "A question for you" : first.question.replace(/\s+/g, " ")
  return questions.length > 1 ? `${lead} (and ${questions.length - 1} more)` : lead
}

const YES = "Yes"
const NO = "No"
const FORMATS: ReadonlyMap<string, { readonly name: string; readonly fits: (answer: string) => boolean }> = new Map([
  ["email", { name: "an email address", fits: (answer: string) => /^[^\s@]+@[^\s@]+$/.test(answer) }],
  ["uri", { name: "a URL", fits: (answer: string) => URL.canParse(answer) }],
  ["date", { name: "a date (YYYY-MM-DD)", fits: (answer: string) => /^\d{4}-\d{2}-\d{2}$/.test(answer) && !Number.isNaN(Date.parse(answer)) }],
  ["date-time", { name: "a date and time (YYYY-MM-DDTHH:MM:SSZ)", fits: (answer: string) => /^\d{4}-\d{2}-\d{2}T/.test(answer) && !Number.isNaN(Date.parse(answer)) }],
])

/** One field of an MCP server's form: the question that asks it, and how its answer goes back. */
interface ElicitationField {
  readonly id: string
  readonly key: string
  readonly kind: "text" | "choice" | "choices" | "boolean" | "number"
  /** A number field whose value must be whole. */
  readonly integer?: true
  /** How many a list of choices takes. */
  readonly minItems?: number
  readonly maxItems?: number
  /** A choice's label to the value the form names it by. */
  readonly values?: ReadonlyMap<string, string>
  readonly minLength?: number
  readonly maxLength?: number
  readonly format?: string
}

export interface ElicitationForm {
  readonly questions: readonly ApprovalQuestion[]
  readonly fields: readonly ElicitationField[]
}

/** An MCP server's request as the person sees it, and the form behind it unless Runrail declined it unasked. */
export interface McpElicitation {
  /** A form with fields is a question; a bare confirmation, or a declined request, a plain approval. */
  readonly approval: { readonly action: string; readonly capability: string; readonly reason: string; readonly questions?: readonly ApprovalQuestion[] }
  readonly form?: ElicitationForm
  readonly declined?: string
}

/** The MCP answer: `decline` is the person's no, `cancel` that nobody answered. */
export interface ElicitationAnswer {
  readonly action: "accept" | "decline" | "cancel"
  readonly content?: Readonly<Record<string, string | number | boolean | readonly string[]>>
}

/**
 * An MCP server's elicitation (`serverName`, `message`, `mode`, `requestedSchema`, as Codex and
 * Claude Code both pass it on). A text field takes a written answer, a list its choices (several
 * for an array of them), a number a value in its range, and a boolean yes or no; any other form
 * is declined with why. Every field is asked, since a question cannot be left blank.
 */
export function mcpElicitation(request: unknown): McpElicitation {
  const input = isRecord(request) ? request : {}
  const server = clipped(input.serverName, MAX_HEADER)
  const message = clipped(input.message, MAX_QUESTION) ?? "An MCP server asks for input"
  const plain = { action: message, capability: QUESTION_CAPABILITY, reason: server === undefined ? message : `${server}: ${message}` }
  const form = input.mode === undefined || input.mode === "form" ? elicitationForm(input.requestedSchema, server, message) : input.mode === "url" ? "It asks you to open a web page, which Runrail cannot show yet" : "Runrail cannot show this kind of MCP request"
  if (typeof form === "string") return Object.freeze({ approval: Object.freeze(plain), declined: form })
  const approval = form.questions.length === 0 ? plain : { ...plain, action: QUESTION_ACTION, questions: form.questions }
  return Object.freeze({ approval: Object.freeze(approval), form })
}

/** Why the answers do not fit the form, or undefined when they do. */
export function elicitationMismatch(form: ElicitationForm, answers: ApprovalAnswers): string | undefined {
  const mismatch = answersMismatch(form.questions, answers)
  if (mismatch !== undefined) return mismatch
  for (const field of form.fields) {
    const picked = answers[field.id] ?? []
    if (field.minItems !== undefined && picked.length < field.minItems) return `an answer picks fewer than ${field.minItems}`
    if (field.maxItems !== undefined && picked.length > field.maxItems) return `an answer picks more than ${field.maxItems}`
    const answer = picked[0] ?? ""
    if (field.kind === "number" && (!NUMBER.test(answer) || (field.integer === true && !Number.isSafeInteger(Number(answer))))) return field.integer === true ? "an answer is not a whole number" : "an answer is not a number"
    if (field.minLength !== undefined && answer.length < field.minLength) return `an answer is shorter than ${field.minLength} characters`
    if (field.maxLength !== undefined && answer.length > field.maxLength) return `an answer is longer than ${field.maxLength} characters`
    const format = field.format === undefined ? undefined : FORMATS.get(field.format)
    if (format !== undefined && !format.fits(answer)) return `an answer is not ${format.name}`
  }
  return undefined
}

/** The MCP answer to a form: declined, accepted with the content its answers fill in, or cancelled when nobody filled it in. */
export function elicitationAnswer(form: ElicitationForm, approved: boolean, answers: ApprovalAnswers | undefined): ElicitationAnswer {
  if (!approved) return Object.freeze({ action: "decline" })
  const content: [string, string | number | boolean | readonly string[]][] = []
  for (const field of form.fields) {
    const picked = answers?.[field.id]
    const answer = picked?.[0]
    // Approved without answers, by a client that shows no questions.
    if (picked === undefined || answer === undefined) return Object.freeze({ action: "cancel" })
    const value = field.kind === "boolean" ? answer === YES : field.kind === "number" ? Number(answer) : field.kind === "choices" ? Object.freeze(picked.map((label) => field.values?.get(label) ?? label)) : field.values?.get(answer) ?? answer
    content.push([field.key, value])
  }
  // fromEntries keeps a key such as "__proto__" the form's own.
  return Object.freeze({ action: "accept", content: Object.freeze(Object.fromEntries(content)) })
}

function elicitationForm(schema: unknown, server: string | undefined, message: string): ElicitationForm | string {
  if (!isRecord(schema) || schema.type !== "object" || (schema.properties !== undefined && !isRecord(schema.properties))) return "Its form is malformed"
  const entries = Object.entries(schema.properties ?? {})
  if (entries.length > MAX_QUESTIONS) return `Its form asks for more than ${MAX_QUESTIONS} answers`
  const questions: ApprovalQuestion[] = []
  const fields: ElicitationField[] = []
  for (const [index, [key, property]] of entries.entries()) {
    if (!isRecord(property)) return "Its form is malformed"
    const id = `q${index + 1}`
    const label = clipped(property.title, MAX_LABEL) ?? clipped(key, MAX_LABEL) ?? id
    // Short in a refusal, which must fit an approval's reason.
    const named = `"${clipped(label, MAX_HEADER) ?? id}"`
    const listed = property.type === "array" ? (isRecord(property.items) ? choicesOf(property.items) : undefined) : undefined
    if (property.type === "array" && (listed === undefined || typeof listed === "string")) return `${named} ${listed ?? "lists something other than choices"}`
    const choices = property.type === "boolean" ? new Map([[YES, YES], [NO, NO]]) : property.type === "string" ? choicesOf(property) : listed
    if (typeof choices === "string") return `${named} ${choices}`
    const numeric = property.type === "number" || property.type === "integer"
    if (property.type !== "string" && property.type !== "boolean" && property.type !== "array" && !numeric) return `${named} is not text, a number, a choice, or yes/no`
    const description = clipped(property.description, MAX_QUESTION - label.length - 2)
    // One field is the server's message; several are each named, the message kept in the approval's reason.
    const question = entries.length === 1 ? message : description === undefined ? label : `${label}: ${description}`
    const options = choices === undefined ? [] : [...choices.keys()].map((choice) => Object.freeze({ label: choice, ...(RECOMMENDED.test(choice) ? { recommended: true as const } : {}) }))
    // A number with a range is asked as one; without, as a written answer that must read as a number.
    const range = numeric ? numberRange({ min: property.minimum, max: property.maximum, ...(property.type === "integer" ? { step: 1 } : {}), ...(typeof property.default === "number" ? { defaultValue: property.default } : {}) }) : undefined
    const placeholder = numeric && range === undefined ? (property.type === "integer" ? "A whole number" : "A number") : undefined
    const multiSelect = property.type === "array"
    questions.push(Object.freeze({ id, question, ...(server === undefined ? {} : { header: server }), ...(range === undefined ? {} : { kind: "number" as const }), ...(placeholder === undefined ? {} : { kind: "text" as const, placeholder }), options: Object.freeze(options), ...(multiSelect ? { multiSelect: true as const } : {}), ...(choices === undefined && range === undefined ? { other: true as const } : {}), ...range }))
    const kind = property.type === "boolean" ? "boolean" : numeric ? "number" : multiSelect ? "choices" : choices === undefined ? "text" : "choice"
    const minLength = kind === "text" ? lengthOf(property.minLength) : undefined
    const maxLength = kind === "text" ? lengthOf(property.maxLength) : undefined
    const minItems = kind === "choices" ? lengthOf(property.minItems) : undefined
    const maxItems = kind === "choices" ? lengthOf(property.maxItems) : undefined
    const format = kind === "text" && typeof property.format === "string" ? property.format : undefined
    fields.push(Object.freeze({ id, key, kind, ...(property.type === "integer" ? { integer: true as const } : {}), ...(kind === "choice" || kind === "choices" ? { values: choices } : {}), ...(minLength === undefined ? {} : { minLength }), ...(maxLength === undefined ? {} : { maxLength }), ...(minItems === undefined ? {} : { minItems }), ...(maxItems === undefined ? {} : { maxItems }), ...(format === undefined ? {} : { format }) }))
  }
  return Object.freeze({ questions: Object.freeze(questions), fields: Object.freeze(fields) })
}

/** A string field's choices by label (`enum`, with `enumNames`, or `oneOf`/`anyOf` const/title), none for free text, or what is wrong with them. */
function choicesOf(property: Record<string, unknown>): ReadonlyMap<string, string> | string | undefined {
  const titled = Array.isArray(property.oneOf) ? property.oneOf : Array.isArray(property.anyOf) ? property.anyOf : undefined
  const listed = Array.isArray(property.enum) ? property.enum.map((value, index) => ({ value, title: Array.isArray(property.enumNames) ? property.enumNames[index] : undefined })) : titled !== undefined ? titled.map((option) => (isRecord(option) ? { value: option.const, title: option.title } : { value: undefined, title: undefined })) : undefined
  if (listed === undefined) return undefined
  if (listed.length > MAX_OPTIONS) return `offers more than ${MAX_OPTIONS} choices`
  const choices = new Map<string, string>()
  for (const { value, title } of listed) {
    const label = bounded(title, MAX_LABEL) ?? bounded(value, MAX_LABEL)
    if (typeof value !== "string" || label === undefined || choices.has(label)) return "has malformed choices"
    choices.set(label, value)
  }
  return choices.size === 0 ? "has malformed choices" : choices
}

function lengthOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** One line, cut to fit: an MCP server's words may run long. */
function clipped(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || max < 4) return undefined
  const text = value.replace(/[\s\0-\x1f\x7f]+/g, " ").trim()
  if (text.length === 0) return undefined
  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}

function optionsOf(value: unknown, previews = false): readonly ApprovalQuestionOption[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_OPTIONS) return undefined
  const options: ApprovalQuestionOption[] = []
  const labels = new Set<string>()
  for (const item of value) {
    if (!isRecord(item)) return undefined
    const label = bounded(item.label, MAX_LABEL)
    if (label === undefined || labels.has(label)) return undefined
    labels.add(label)
    const description = bounded(item.description, MAX_DESCRIPTION)
    const preview = previews ? bounded(item.preview, MAX_PREVIEW) : undefined
    options.push(Object.freeze({ label, ...(description === undefined ? {} : { description }), ...(RECOMMENDED.test(label) ? { recommended: true as const } : {}), ...(preview === undefined ? {} : { preview }) }))
  }
  return Object.freeze(options)
}

function bounded(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || value.includes("\0")) return undefined
  const text = value.trim()
  return text.length === 0 || text.length > max ? undefined : text
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
