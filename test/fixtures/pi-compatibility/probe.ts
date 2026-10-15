export {}

const mode = process.argv[2]

if (mode === "pass") {
  console.log(JSON.stringify({ type: "rpc.ready", payload: "fixture payload is never returned" }))
  console.log(JSON.stringify({ type: "rpc.event", payload: { secret: "fixture secret" } }))
  process.exit(0)
}

if (mode === "refuse") {
  console.log(JSON.stringify({ type: "rpc.refused", reason: "unsupported protocol" }))
  process.exit(78)
}

if (mode === "malformed") {
  console.log("not-json")
  process.exit(0)
}

if (mode === "fail") {
  process.exit(7)
}

if (mode === "huge") {
  process.stdout.write(JSON.stringify({ type: "rpc.event", value: "x".repeat(128 * 1024) }))
  process.exit(0)
}

if (mode === "wait") {
  await new Promise(() => undefined)
}

process.exit(2)
