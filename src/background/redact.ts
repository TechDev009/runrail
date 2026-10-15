/**
 * Masks credentials in a command line or a one-line summary before it is shown. Best effort on
 * known shapes; callers still keep such text in memory only and never log it.
 */
const MASK = "***"
const SECRET_NAME = "(?:[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?|AUTH(?!OR))[A-Za-z0-9_]*)"

const RULES: readonly (readonly [RegExp, string])[] = [
  // `scheme://user:password@host`
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${MASK}@`],
  // `Authorization: Bearer x`, `Bearer x`, `Basic x`
  [/\b(authorization\s*:\s*)(?:bearer|basic|token)?\s*[^\s"']+/gi, `$1${MASK}`],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MASK}`],
  // `--token=x`, `--api-key x`, `-H "X-Api-Key: x"`
  [/(--?[a-z0-9-]*(?:token|secret|password|passwd|passphrase|api-?key|access-?key|auth(?!or)|credentials?)[a-z0-9-]*)(=|\s+)("[^"]*"|'[^']*'|[^\s"']+)/gi, `$1$2${MASK}`],
  [/\b((?:x-)?[a-z0-9-]*(?:api-?key|token|secret|password)\s*:\s*)[^\s"']+/gi, `$1${MASK}`],
  // `NAME=x` for secret-looking names, as in `API_KEY=x npm run dev`
  [new RegExp(`\\b(${SECRET_NAME})=("[^"]*"|'[^']*'|[^\\s"']+)`, "gi"), `$1=${MASK}`],
  // Well-known key shapes anywhere
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g, MASK],
  [/\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}\b/g, MASK],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MASK],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, MASK],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, MASK],
  [/\bnpm_[A-Za-z0-9]{30,}/g, MASK],
  [/\bAKIA[0-9A-Z]{16}\b/g, MASK],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MASK],
]

/** One line, credentials masked, at most `max` characters. */
export function redactCommandText(value: string, max = 200): string {
  let text = value.length > 8 * 1024 ? value.slice(0, 8 * 1024) : value
  text = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim()
  for (const [pattern, replacement] of RULES) text = text.replace(pattern, replacement)
  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}
