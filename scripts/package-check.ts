import { resolve } from "node:path"

const packagePath = resolve("package.json")
const manifestValue: unknown = await Bun.file(packagePath).json()
if (!isRecord(manifestValue)) throw new Error("package manifest must be an object")

if (manifestValue.name !== "runrail") throw new Error("package name must be runrail")
if (manifestValue.private !== false) throw new Error("package must be publishable")
if (typeof manifestValue.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifestValue.version)) throw new Error("package version is invalid")
if (!isRecord(manifestValue.bin) || manifestValue.bin.runrail !== "./src/cli.ts") throw new Error("runrail CLI bin is invalid")
// npm and Bun installs run the bin through its shebang; this sh launcher keeps the current folder's bunfig.toml and .env out of Runrail.
const launcher = '#!/bin/sh\n// 2>/dev/null; exec bun --env-file=/dev/null --config=/dev/null "$0" "$@"\n'
if (!(await Bun.file(resolve("src/cli.ts")).text()).startsWith(launcher)) throw new Error("runrail CLI bin must start Bun without the current folder's bunfig.toml and .env")
if (!isRecord(manifestValue.exports) || manifestValue.exports["."] !== "./src/index.ts") throw new Error("package exports are invalid")

const files = manifestValue.files
if (!Array.isArray(files) || !files.includes("src") || !files.includes("docs") || !files.includes("scripts/source-boundary-check.ts") || !files.includes("examples/external-harness-adapter")) throw new Error("package file allowlist is incomplete")

for (const required of ["src/cli.ts", "src/index.ts", "scripts/source-boundary-check.ts", "examples/external-harness-adapter/index.ts", "README.md", "LICENSE", "SECURITY.md"]) {
  if (!(await Bun.file(resolve(required)).exists())) throw new Error(`required package file is missing: ${required}`)
}

console.log(`package metadata passed (${manifestValue.name}@${manifestValue.version})`)

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
