import { mkdir, rm } from "node:fs/promises"

const args = process.argv.slice(2)
if (args.includes("missing-revision")) process.exit(128)
const operation = args.includes("add") ? "add" : args.includes("remove") ? "remove" : "unknown"
const marker = operation === "add" ? "--detach" : "--force"
const markerIndex = args.indexOf(marker)
const target = markerIndex >= 0 ? args[markerIndex + 1] : undefined
if (target === undefined) process.exit(2)
if (operation === "add") await mkdir(target, { recursive: true })
else if (operation === "remove") await rm(target, { recursive: true, force: true })
else process.exit(2)
