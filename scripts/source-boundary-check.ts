import { readdir, readFile } from "node:fs/promises"
import { relative, resolve } from "node:path"

const repositoryRoot = resolve(".")
const scanRoots = ["src", "scripts", "examples"] as const
const textExtensions = new Set([".cjs", ".js", ".json", ".jsonc", ".mjs", ".ts", ".tsx", ".yaml", ".yml"])
const moduleSpecifierPattern = /(?:from\s*|import\s*\(?\s*|require\s*\(\s*|export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s+from\s*)["'`]([^"'`]+)["'`]/g
const nifraCheckoutPathPattern = /(?:^|[\\/])(?:nifra|nifrajs)[\\/](?:src|packages|apps|private|internal)(?:[\\/]|$)/i
// An allowlist, so a private scope is refused without this public file having to name it.
const publicScopes: ReadonlySet<string> = new Set(["@anthropic-ai", "@nifrajs", "@tanstack", "@types", "@vitejs"])
const issues: string[] = []

for (const root of scanRoots) {
  await scanDirectory(resolve(root))
}

await scanPackageMetadata(resolve("package.json"))

if (issues.length > 0) {
  throw new Error(["source boundary check failed:", ...issues.sort()].join("\n"))
}

console.log(`source boundary passed (${scanRoots.join(", ")})`)

async function scanDirectory(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      await scanDirectory(path)
      continue
    }
    if (!entry.isFile() || !textExtensions.has(extensionOf(entry.name))) continue
    await scanTextFile(path)
    if (entry.name === "package.json") await scanPackageMetadata(path)
  }
}

async function scanTextFile(path: string): Promise<void> {
  const source = await readFile(path, "utf8")
  const relativePath = relative(repositoryRoot, path)
  for (const match of source.matchAll(moduleSpecifierPattern)) {
    const specifier = match[1]
    if (specifier === undefined) continue
    if (specifier.startsWith("workspace:") || specifier.startsWith("link:")) {
      issues.push(`${relativePath}: workspace/link dependency alias '${specifier}' is not publishable`)
      continue
    }
    if (!isPublicScope(specifier)) {
      issues.push(`${relativePath}: import '${specifier}' is not from a public package scope`)
      continue
    }
    if (/^@nifrajs\/[^/]+\/(?:src|packages|internal|private)(?:\/|$)/.test(specifier)) {
      issues.push(`${relativePath}: direct Nifra source/private import '${specifier}' is not allowed`)
      continue
    }
    if (nifraCheckoutPathPattern.test(specifier)) {
      issues.push(`${relativePath}: Nifra checkout import '${specifier}' is not allowed`)
    }
  }

  if (nifraCheckoutPathPattern.test(source)) {
    issues.push(`${relativePath}: source contains a direct Nifra checkout path`)
  }
}

async function scanPackageMetadata(path: string): Promise<void> {
  let value: unknown
  try {
    value = await Bun.file(path).json()
  } catch {
    issues.push(`${relative(repositoryRoot, path)}: package metadata is not valid JSON`)
    return
  }
  if (!isRecord(value)) {
    issues.push(`${relative(repositoryRoot, path)}: package metadata must be an object`)
    return
  }
  for (const sectionName of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const) {
    const section = value[sectionName]
    if (!isRecord(section)) continue
    for (const [name, specifier] of Object.entries(section)) {
      if (typeof specifier !== "string") {
        issues.push(`${relative(repositoryRoot, path)}: dependency '${name}' has a non-string version`)
        continue
      }
      if (specifier.startsWith("workspace:") || specifier.startsWith("link:")) {
        issues.push(`${relative(repositoryRoot, path)}: dependency '${name}' uses a workspace/link alias`)
      }
      if (/^@nifrajs\//.test(name) && /^(?:file:|link:|workspace:)/.test(specifier)) {
        issues.push(`${relative(repositoryRoot, path)}: Nifra dependency '${name}' must resolve from a published version`)
      }
      if (!isPublicScope(name)) {
        issues.push(`${relative(repositoryRoot, path)}: dependency '${name}' is not from a public package scope`)
      }
    }
  }
}

function isPublicScope(name: string): boolean {
  const scope = /^(@[^/]+)\//.exec(name)?.[1]
  return scope === undefined || publicScopes.has(scope)
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf(".")
  return index < 0 ? "" : name.slice(index).toLowerCase()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
