import { expect, test } from "bun:test"
import { answersMismatch, carriedQuestions, claudeAnsweredInput, claudeQuestions, claudeQuestionsTitle, claudeTakesFollowUp, codexAnswerResult, codexElicitationResult, codexQuestions, elicitationAnswer, elicitationMismatch, mcpElicitation, parseAnswers, parseFollowUp, questionsReason, recordedAnswers } from "../../src/harness/questions.ts"

test("Claude Code's questions take ids by position, always allow a written answer, and refuse what Claude Code could not key", () => {
  const questions = claudeQuestions({ questions: [{ question: " Which library? ", header: "Library", options: [{ label: "Luxon", description: "Zones" }, { label: "date-fns", description: "" }], multiSelect: false }, { question: "Checks?", header: "Checks", options: [], multiSelect: true }] })
  expect(questions).toEqual([
    { id: "q1", question: "Which library?", header: "Library", options: [{ label: "Luxon", description: "Zones" }, { label: "date-fns" }], other: true },
    { id: "q2", question: "Checks?", header: "Checks", options: [], multiSelect: true, other: true },
  ])
  expect(questionsReason(questions!)).toBe("Which library? (and 1 more)")
  // Claude Code keys answers by question text, so two alike cannot both be answered.
  expect(claudeQuestions({ questions: [{ question: "Same?", options: [] }, { question: "Same?", options: [] }] })).toBeUndefined()
  for (const input of [{}, { questions: [] }, { questions: Array.from({ length: 9 }, (_, index) => ({ question: `${index}?`, options: [] })) }, { questions: [{ question: "", options: [] }] }, { questions: [{ question: "x?", options: [{ label: "a" }, { label: "a" }] }] }, { questions: [{ question: "x".repeat(1_001), options: [] }] }])
    expect(claudeQuestions(input)).toBeUndefined()
  expect(claudeAnsweredInput({ questions: "kept" }, questions!, { q1: ["Luxon"], q2: ["Tests", "Lint"] })).toEqual({ questions: "kept", answers: { "Which library?": "Luxon", "Checks?": "Tests, Lint" } })
})

test("Codex's questions keep their ids and always take a written answer, which Codex leaves to the client; a secret stays secret", () => {
  expect(codexQuestions({ questions: [{ id: "env", header: "Target", question: "Where?", options: [{ label: "staging (Recommended)", description: "Safe" }, { label: "prod", description: "Live" }] }, { id: "token", header: "", question: "Token?", isSecret: true, options: null }] })).toEqual([
    { id: "env", question: "Where?", header: "Target", options: [{ label: "staging (Recommended)", description: "Safe", recommended: true }, { label: "prod", description: "Live" }], other: true },
    { id: "token", question: "Token?", options: [], other: true, secret: true },
  ])
  expect(codexQuestions({ questions: [{ id: "a", question: "?", options: null }, { id: "a", question: "?", options: null }] })).toBeUndefined()
  expect(codexQuestions({ questions: [{ id: "bad id", question: "?", options: null }] })).toBeUndefined()
  expect(codexAnswerResult({ env: ["staging"] })).toEqual({ answers: { env: { answers: ["staging"] } } })
})

test("answers are a bounded id-to-strings map that must fit their questions", () => {
  expect(parseAnswers({ q1: [" Luxon "] })).toEqual({ q1: ["Luxon"] })
  for (const value of [undefined, [], {}, { q1: "Luxon" }, { q1: [] }, { q1: [" "] }, { q1: ["a\0b"] }, { "bad id": ["x"] }, { q1: Array.from({ length: 10 }, () => "x") }]) expect(parseAnswers(value)).toBeUndefined()
  const questions = carriedQuestions([{ id: "env", question: "Where?", options: [{ label: "staging" }, { label: "prod" }] }, { id: "token", question: "Token?", options: [], other: true, secret: true }])!
  expect(answersMismatch(questions, { env: ["staging"], token: ["t"] })).toBeUndefined()
  expect(answersMismatch(questions, { env: ["dev"], token: ["t"] })).toBe("an answer is not one of the choices")
  expect(answersMismatch(questions, { env: ["staging", "prod"], token: ["t"] })).toBe("a single-choice question has more than one answer")
  expect(answersMismatch(questions, { env: ["staging"] })).toBe("every question needs an answer")
  expect(answersMismatch(questions, { env: ["staging"], token: ["t"], other: ["x"] })).toBe("an answer names no question")
  expect(recordedAnswers(questions, { env: ["staging"], token: ["t"] })).toEqual({ env: ["staging"] })
})

test("questions read back from a transcript are checked again", () => {
  const carried = [{ id: "q1", question: "Which?", options: [{ label: "a" }], multiSelect: true, other: true, secret: true, extra: "dropped" }]
  expect(carriedQuestions(carried)).toEqual([{ id: "q1", question: "Which?", options: [{ label: "a" }], multiSelect: true, other: true, secret: true }])
  for (const value of [undefined, [], [{ question: "no id", options: [] }], [{ id: "q1", question: "?", options: "x" }]]) expect(carriedQuestions(value)).toBeUndefined()
})

test("an MCP server's form maps text, single choices, and yes/no to questions, and declines the rest with why", () => {
  const form = (properties: Record<string, unknown>) => mcpElicitation({ serverName: "linear", message: "  File\nthe issue? ", mode: "form", requestedSchema: { type: "object", properties } })
  // Parsed, as a request arrives: "__proto__" is then a field of its own.
  const asked = form(JSON.parse('{"__proto__": {"type": "string", "title": "Team", "enum": ["eng", "ops"]}, "due": {"type": "string", "format": "date", "maxLength": 10}, "urgent": {"type": "boolean"}}') as Record<string, unknown>)
  expect(asked.approval).toEqual({
    action: "question",
    capability: "user.input",
    reason: "linear: File the issue?",
    questions: [
      { id: "q1", question: "Team", header: "linear", options: [{ label: "eng" }, { label: "ops" }] },
      { id: "q2", question: "due", header: "linear", options: [], other: true },
      { id: "q3", question: "urgent", header: "linear", options: [{ label: "Yes" }, { label: "No" }] },
    ],
  })
  const fields = asked.form!
  expect(elicitationMismatch(fields, { q1: ["ops"], q2: ["2026-13-45"], q3: ["Yes"] })).toBe("an answer is not a date (YYYY-MM-DD)")
  expect(elicitationMismatch(fields, { q1: ["ops"], q2: ["2026-10-09"], q3: ["Yes"] })).toBeUndefined()
  const accepted = elicitationAnswer(fields, true, { q1: ["ops"], q2: ["2026-10-09"], q3: ["Yes"] })
  expect(Object.hasOwn(accepted.content ?? {}, "__proto__")).toBe(true)
  expect(JSON.stringify(codexElicitationResult(accepted))).toBe('{"action":"accept","content":{"__proto__":"ops","due":"2026-10-09","urgent":true},"_meta":null}')
  expect(elicitationAnswer(fields, false, undefined)).toEqual({ action: "decline" })
  expect(elicitationAnswer(fields, true, undefined)).toEqual({ action: "cancel" })
  expect(codexElicitationResult({ action: "cancel" })).toEqual({ action: "cancel", content: null, _meta: null })

  const declined = (properties: Record<string, unknown>) => form(properties).declined
  expect(declined({ tags: { type: "array", items: { type: "object" } } })).toBe("\"tags\" lists something other than choices")
  expect(declined({ pick: { type: "string", enum: Array.from({ length: 9 }, (_, index) => `v${index}`) } })).toBe("\"pick\" offers more than 8 choices")
  expect(declined({ pick: { type: "string", oneOf: [{ const: "a", title: "Same" }, { const: "b", title: "Same" }] } })).toBe("\"pick\" has malformed choices")
  expect(declined({ blob: { type: "object" } })).toBe("\"blob\" is not text, a number, a choice, or yes/no")
  expect(declined({ tags: { type: "array", title: "t".repeat(200) } })?.length).toBeLessThanOrEqual(256)
  expect(declined(Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`f${index}`, { type: "string" }])))).toBe("Its form asks for more than 8 answers")
  expect(mcpElicitation({ serverName: "linear", message: "Hi", requestedSchema: { type: "array" } }).declined).toBe("Its form is malformed")
  expect(mcpElicitation({ serverName: "linear", message: "Sign in", mode: "url", url: "https://linear.app" })).toMatchObject({ approval: { action: "Sign in", reason: "linear: Sign in" }, declined: "It asks you to open a web page, which Runrail cannot show yet" })
  expect(mcpElicitation({ serverName: "linear", message: "Hi", mode: "openai/form", requestedSchema: {} }).declined).toBe("Runrail cannot show this kind of MCP request")

  // No fields: a plain yes/no approval, accepted with empty content.
  const confirm = mcpElicitation({ serverName: "linear", message: "Run it?", requestedSchema: { type: "object", properties: {} } })
  expect(confirm.approval).toEqual({ action: "Run it?", capability: "user.input", reason: "linear: Run it?" })
  expect(elicitationAnswer(confirm.form!, true, undefined)).toEqual({ action: "accept", content: {} })
})

test("Claude Code's extended questions: choices with a recommended pick and previews, several picks, a text box, and a number", () => {
  const input = {
    title: "Set up the deck",
    questions: [
      { question: "Which layout?", header: "Layout", description: "Shown on every slide", options: [{ label: "Grid (Recommended)", description: "Even", preview: "| a | b |\n| c | d |" }, { label: "Stack", description: "One column", preview: "a\nb" }] },
      { question: "Which checks?", header: "Checks", multiSelect: true, options: [{ label: "Tests", description: "", preview: "dropped: several picks show no preview" }, { label: "Lint", description: "" }] },
      { question: "What should the title say?", header: "Title", kind: "text", placeholder: "A short title" },
      { question: "How many slides?", header: "Slides", kind: "number", min: 1, max: 20, step: 1, defaultValue: 5, unit: "slides" },
    ],
  }
  const questions = claudeQuestions(input)!
  expect(claudeQuestionsTitle(input)).toBe("Set up the deck")
  expect(questions).toEqual([
    { id: "q1", question: "Which layout?", header: "Layout", description: "Shown on every slide", options: [{ label: "Grid (Recommended)", description: "Even", recommended: true, preview: "| a | b |\n| c | d |" }, { label: "Stack", description: "One column", preview: "a\nb" }], other: true },
    { id: "q2", question: "Which checks?", header: "Checks", options: [{ label: "Tests" }, { label: "Lint" }], multiSelect: true, other: true },
    { id: "q3", question: "What should the title say?", header: "Title", kind: "text", options: [], other: true, placeholder: "A short title" },
    { id: "q4", question: "How many slides?", header: "Slides", kind: "number", options: [], min: 1, max: 20, step: 1, defaultValue: 5, unit: "slides" },
  ])
  // The person's own words stand in for any choice; a number must be in range and on the step.
  expect(answersMismatch(questions, { q1: ["Something else entirely"], q2: ["Tests", "my own check"], q3: ["Q3 review"], q4: ["7"] })).toBeUndefined()
  for (const count of ["0", "21", "7.5", "seven", ""]) expect(answersMismatch(questions, { q1: ["Stack"], q2: ["Lint"], q3: ["t"], q4: [count] })).toBe("an answer is not a number from 1 to 20 in steps of 1")
  expect(answersMismatch(questions, { q1: ["Stack"], q2: ["Lint"], q3: ["a", "b"], q4: ["7"] })).toBe("a single-choice question has more than one answer")
  // Claude Code gets the answers by question text, and the picked choice's preview beside them.
  expect(claudeAnsweredInput(input, questions, { q1: ["Grid (Recommended)"], q2: ["Tests", "Lint"], q3: ["Q3 review"], q4: ["7"] })).toEqual({
    ...input,
    answers: { "Which layout?": "Grid (Recommended)", "Which checks?": "Tests, Lint", "What should the title say?": "Q3 review", "How many slides?": "7" },
    annotations: { "Which layout?": { preview: "| a | b |\n| c | d |" } },
  })
  // What Claude Code itself refuses is not shown either.
  for (const question of [
    { question: "?", kind: "slider", options: [] },
    { question: "?", kind: "text", options: [{ label: "a" }] },
    { question: "?", kind: "number", min: 5, max: 5 },
    { question: "?", kind: "number", min: 1, max: 9, defaultValue: 10 },
    { question: "?", kind: "number", min: 1, max: 9, step: 0 },
  ]) expect(claudeQuestions({ questions: [question] })).toBeUndefined()
  // Read back from a transcript, a question keeps all of it.
  expect(carriedQuestions(questions)).toEqual(questions)
})

test("an MCP server's form asks a ranged number as one, any other number as written text, and a list of choices as several picks", () => {
  const asked = mcpElicitation({ serverName: "deploys", message: "Scale it", requestedSchema: { type: "object", properties: {
    replicas: { type: "integer", title: "Replicas", minimum: 1, maximum: 10, default: 3 },
    budget: { type: "number", title: "Budget" },
    regions: { type: "array", title: "Regions", minItems: 1, maxItems: 2, items: { type: "string", anyOf: [{ const: "us", title: "US (Recommended)" }, { const: "eu", title: "EU" }, { const: "ap", title: "Asia" }] } },
  } } })
  expect(asked.approval.questions).toEqual([
    { id: "q1", question: "Replicas", header: "deploys", kind: "number", options: [], min: 1, max: 10, step: 1, defaultValue: 3 },
    { id: "q2", question: "Budget", header: "deploys", kind: "text", placeholder: "A number", options: [], other: true },
    { id: "q3", question: "Regions", header: "deploys", options: [{ label: "US (Recommended)", recommended: true }, { label: "EU" }, { label: "Asia" }], multiSelect: true },
  ])
  const form = asked.form!
  expect(elicitationMismatch(form, { q1: ["4"], q2: ["12.5"], q3: ["US (Recommended)", "Asia"] })).toBeUndefined()
  expect(elicitationMismatch(form, { q1: ["4"], q2: ["lots"], q3: ["EU"] })).toBe("an answer is not a number")
  expect(elicitationMismatch(form, { q1: ["4"], q2: ["1"], q3: ["EU", "US (Recommended)", "Asia"] })).toBe("an answer picks more than 2")
  expect(elicitationMismatch(form, { q1: ["11"], q2: ["1"], q3: ["EU"] })).toBe("an answer is not a number from 1 to 10 in steps of 1")
  expect(elicitationAnswer(form, true, { q1: ["4"], q2: ["12.5"], q3: ["US (Recommended)", "Asia"] })).toEqual({ action: "accept", content: { replicas: 4, budget: 12.5, regions: ["us", "ap"] } })
})

test("a request for more questions: only for Claude Code's extended questions, with any answers so far and a note", () => {
  const input = { questions: [{ question: "Which layout?", kind: "choice", options: [{ label: "Grid" }, { label: "Stack" }] }, { question: "How many?", kind: "number", min: 1, max: 9 }] }
  expect(claudeTakesFollowUp(input)).toBe(true)
  expect(claudeTakesFollowUp({ questions: [{ question: "Which layout?", options: [{ label: "Grid" }, { label: "Stack" }] }] })).toBe(false)
  expect(claudeTakesFollowUp({ questions: [] })).toBe(false)

  expect(parseFollowUp(undefined, undefined)).toBeUndefined()
  expect(parseFollowUp(false, undefined)).toBeUndefined()
  expect(parseFollowUp(true, undefined)).toEqual({})
  expect(parseFollowUp(true, "  colours too ")).toEqual({ note: "colours too" })
  expect(parseFollowUp(true, "   ")).toEqual({})
  for (const [followUp, note] of [[undefined, "a note alone"], ["yes", undefined], [true, 7], [true, "x".repeat(2_001)], [true, "a\0b"]]) expect(parseFollowUp(followUp, note)).toBe("invalid")

  const questions = claudeQuestions(input) ?? []
  expect(answersMismatch(questions, {}, true)).toBeUndefined()
  expect(answersMismatch(questions, { q2: ["12"] }, true)).toContain("from 1 to 9")
  expect(answersMismatch(questions, { q1: ["Grid"] })).toBe("every question needs an answer")
  expect(claudeAnsweredInput(input, questions, { q1: ["Grid"] }, { note: "colours too" })).toEqual({ ...input, answers: { "Which layout?": "Grid" }, followUp: true, response: "colours too" })
  expect(claudeAnsweredInput(input, questions, {}, {})).toEqual({ ...input, answers: {}, followUp: true })
})
