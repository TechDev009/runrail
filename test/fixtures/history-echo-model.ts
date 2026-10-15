// A command model that answers with every user message it was sent, so a test sees the history a session restored.
const request = JSON.parse((await Bun.stdin.text()).split("\n")[0] ?? "{}") as { readonly messages?: readonly { readonly role: string; readonly text: string }[] }
const heard = (request.messages ?? []).filter((message) => message.role === "user").map((message) => message.text)
console.log(JSON.stringify({ type: "text", text: `heard: ${heard.join(" | ")}` }))

export {}
