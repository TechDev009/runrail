import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { parseConnectionSettings } from "../../src/accounts/connection-settings.ts"
import { ImageError, generateImage, imageSize, sniffImage } from "../../src/images/generate.ts"
import { IMAGES_MCP_ALLOWED_TOOLS, runImagesMcpServer } from "../../src/images/mcp.ts"
import { parseImageModels } from "../../src/images/models.ts"
import { ImageService } from "../../src/images/service.ts"
import { describeToolCall } from "../../src/tools/presentation.ts"
import type { ProviderDiscoveryOptions } from "../../src/providers/types.ts"
import { createWorkspacePolicy } from "../../src/workspace/policy.ts"

/** Image models from the person's own connections, and how each is asked. */

const PNG = Buffer.from("89504e470d0a1a0a0000000d494844520000040000000300080600000000000000", "hex")
const JPEG = Buffer.from("ffd8ffe000104a46494600010100000100010000ffc0001108020001800301220002110103110100", "hex")
const cleanup: (() => Promise<unknown> | unknown)[] = []

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

describe("which models make pictures", () => {
  test("an OpenAI-style list: the id decides, and readers and media models stay out", () => {
    const list = { data: ["gpt-4o", "gpt-image-1", "dall-e-3", "text-embedding-3-small", "whisper-1", "sora-2", "grok-2-image-1212", "qwen-vl-max", "black-forest-labs/FLUX.1-schnell"].map((id) => ({ id, object: "model" })) }
    expect(parseImageModels(list, { presetId: "openai", protocol: "openai-responses" }).map((model) => model.id)).toEqual(["black-forest-labs/FLUX.1-schnell", "dall-e-3", "gpt-image-1", "grok-2-image-1212"])
  })

  test("a list that says what each model outputs is believed, and OpenRouter's are asked through chat", () => {
    const list = { data: [
      { id: "google/gemini-2.5-flash-image", name: "Gemini Image", architecture: { output_modalities: ["image", "text"] } },
      { id: "openai/gpt-image-looking-but-text", architecture: { output_modalities: ["text"] } },
    ] }
    expect(parseImageModels(list, { presetId: "openrouter", protocol: "openai-chat" })).toEqual([{ id: "google/gemini-2.5-flash-image", name: "Gemini Image", route: "chat" }])
    const together = [{ id: "black-forest-labs/FLUX.1-pro", type: "image" }, { id: "meta-llama/image-captioner", type: "chat" }]
    expect(parseImageModels(together, { presetId: "togetherai", protocol: "openai-chat" })).toEqual([{ id: "black-forest-labs/FLUX.1-pro", route: "images" }])
  })

  test("Messages endpoints have none, and Google's images API takes only Imagen", () => {
    expect(parseImageModels({ data: [{ id: "dall-e-3" }] }, { presetId: "anthropic", protocol: "anthropic-messages" })).toEqual([])
    expect(parseImageModels({ data: [{ id: "models/imagen-4.0-generate-001" }, { id: "models/gemini-2.5-flash-image" }] }, { presetId: "google", protocol: "openai-chat" }).map((model) => model.id)).toEqual(["models/imagen-4.0-generate-001"])
  })

  test("the choice is kept with its route, and a bad one is refused", () => {
    const settings = parseConnectionSettings({ providers: {}, tools: [], image: { connectionId: "conn-1", model: "gpt-image-1", route: "images" } })
    expect(settings.image).toEqual({ connectionId: "conn-1", model: "gpt-image-1", route: "images" })
    expect(() => parseConnectionSettings({ providers: {}, tools: [], image: { connectionId: "conn-1", model: "gpt-image-1", route: "fax" } })).toThrow("route")
  })
})

interface Seen {
  readonly path: string
  readonly contentType: string | null
  readonly text: string
}

function provider(answer: (path: string, body: string, attempt: number) => Response) {
  const seen: Seen[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(incoming) {
      const text = await incoming.text()
      const path = new URL(incoming.url).pathname
      seen.push({ path, contentType: incoming.headers.get("content-type"), text })
      return answer(path, text, seen.length)
    },
  })
  cleanup.push(() => server.stop(true))
  const options: ProviderDiscoveryOptions = {
    provider: "custom-openai-chat",
    endpoint: `http://127.0.0.1:${server.port}/v1`,
    allowedHosts: ["127.0.0.1"],
    credential: { kind: "caller", account: "conn-1" },
    credentialResolver: { resolve: () => "sk-test" },
  }
  return { seen, options }
}

describe("asking for a picture", () => {
  test("a change goes to images/edits as a form carrying the picture", async () => {
    const { seen, options } = provider(() => Response.json({ data: [{ b64_json: PNG.toString("base64") }] }))
    const made = await generateImage(options, { model: "gpt-image-1", route: "images", prompt: "make it blue", shape: "portrait", input: { mediaType: "image/jpeg", bytes: new Uint8Array(JPEG) } })
    expect(made.mediaType).toBe("image/png")
    expect(seen[0]?.path).toBe("/v1/images/edits")
    expect(seen[0]?.contentType).toStartWith("multipart/form-data; boundary=runrail-")
    expect(seen[0]?.text).toContain('name="prompt"\r\n\r\nmake it blue')
    expect(seen[0]?.text).toContain('name="size"\r\n\r\n1024x1536')
    expect(seen[0]?.text).toContain('name="image"; filename="image.jpg"\r\ncontent-type: image/jpeg')
  })

  test("the chat route asks for an image and reads it from the message", async () => {
    const { seen, options } = provider(() => Response.json({ choices: [{ message: { role: "assistant", content: "here", images: [{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${JPEG.toString("base64")}` } }] } }] }))
    const made = await generateImage(options, { model: "google/gemini-2.5-flash-image", route: "chat", prompt: "a fox", shape: "landscape" })
    expect(made.mediaType).toBe("image/jpeg")
    expect(JSON.parse(seen[0]!.text)).toEqual({ model: "google/gemini-2.5-flash-image", messages: [{ role: "user", content: [{ type: "text", text: "a fox" }] }], modalities: ["image", "text"], stream: false, image_config: { aspect_ratio: "3:2" } })
  })

  test("a size the model refuses is dropped once; a content refusal is not passed on word for word", async () => {
    const sized = provider((_path, body) => (JSON.parse(body).size !== undefined ? Response.json({ error: { message: "Invalid value for size" } }, { status: 400 }) : Response.json({ data: [{ b64_json: PNG.toString("base64") }] })))
    await generateImage(sized.options, { model: "gpt-image-1", route: "images", prompt: "a fox", shape: "landscape" })
    expect(sized.seen.map((entry) => JSON.parse(entry.text).size)).toEqual(["1536x1024", undefined])
    const refused = provider(() => Response.json({ error: { message: "Your request was rejected by our safety system. secret-detail" } }, { status: 400 }))
    const error = await generateImage(refused.options, { model: "gpt-image-1", route: "images", prompt: "a fox" }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ImageError)
    expect(error).toMatchObject({ code: "IMAGE_REFUSED", message: "The provider refused this prompt under its content rules." })
    expect(refused.seen).toHaveLength(1)
  })

  test("an address on this machine or its network is never fetched", async () => {
    const { options } = provider(() => Response.json({ data: [{ url: "https://169.254.169.254/latest/meta-data" }] }))
    await expect(generateImage(options, { model: "dall-e-3", route: "images", prompt: "a fox" })).rejects.toMatchObject({ code: "IMAGE_FAILED", message: "The model answered with a picture address Runrail will not fetch." })
  })

  test("the picture's type and size come from its own bytes", () => {
    expect(sniffImage(new Uint8Array(PNG))).toBe("image/png")
    expect(imageSize(new Uint8Array(PNG), "image/png")).toEqual({ width: 1024, height: 768 })
    expect(sniffImage(new Uint8Array(JPEG))).toBe("image/jpeg")
    expect(imageSize(new Uint8Array(JPEG), "image/jpeg")).toEqual({ width: 384, height: 512 })
    expect(sniffImage(new Uint8Array(Buffer.from("<svg/>")))).toBeUndefined()
  })
})

describe("saving it", () => {
  async function service(made: Buffer) {
    const root = await mkdtemp("/tmp/runrail-images-unit-")
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const policy = await createWorkspacePolicy(root)
    const asked: unknown[] = []
    const images = new ImageService(async (_options, request) => {
      asked.push(request)
      return { mediaType: sniffImage(new Uint8Array(made))!, bytes: new Uint8Array(made) }
    })
    images.bind({
      choice: async () => ({ connectionId: "conn-1", model: "gpt-image-1", route: "images" }),
      connection: async () => ({ name: "OpenAI", options: { provider: "openai", credential: { kind: "caller", account: "conn-1" } } }),
      workspace: () => policy,
    })
    return { root, images, asked }
  }

  test("a JPEG asked for as .png keeps its real type in its name", async () => {
    const { root, images } = await service(JPEG)
    const result = await images.request({ prompt: "a fox", path: "public/fox.png" })
    expect(result.text).toBe("Saved a 384x512 JPEG to public/fox.jpg (the model made a JPEG, so the name ends in .jpg), made by gpt-image-1 through OpenAI.")
    expect(result.image?.mediaType).toBe("image/jpeg")
    expect(await readdir(join(root, "public"))).toEqual(["fox.jpg"])
  })

  test("a picture to change is read from the workspace, and must be one", async () => {
    const { root, images, asked } = await service(PNG)
    await writeFile(join(root, "logo.png"), PNG)
    await writeFile(join(root, "notes.txt"), "not a picture")
    await images.request({ prompt: "make it blue", path: "logo-blue.png", from: "logo.png" })
    expect(asked[0]).toMatchObject({ input: { mediaType: "image/png" } })
    expect(Buffer.from(await readFile(join(root, "logo-blue.png")))).toEqual(PNG)
    await expect(images.request({ prompt: "make it blue", path: "x.png", from: "notes.txt" })).rejects.toMatchObject({ code: "IMAGE_INVALID_INPUT" })
    await expect(images.request({ prompt: "make it blue", path: "x.png", from: "../elsewhere.png" })).rejects.toMatchObject({ code: "IMAGE_INVALID_INPUT" })
  })

  test("the call is checked before anything is asked", async () => {
    const { images, asked } = await service(PNG)
    await expect(images.request({ prompt: "", path: "a.png" })).rejects.toMatchObject({ code: "IMAGE_INVALID_INPUT" })
    await expect(images.request({ prompt: "a fox", path: "a.gif" })).rejects.toMatchObject({ code: "IMAGE_INVALID_INPUT" })
    await expect(images.request({ prompt: "a fox", path: "a.png", shape: "round" })).rejects.toMatchObject({ code: "IMAGE_INVALID_INPUT" })
    expect(asked).toEqual([])
  })
})

test("the transcript names the file a picture goes to, never the prompt", () => {
  expect(describeToolCall("mcp__runrail_images__image_generate", { prompt: "a secret plan", path: "/repo/public/hero.png" }, { root: "/repo" })).toEqual({ kind: "other", path: "public/hero.png", title: "Make a picture: public/hero.png", truncated: false })
  expect(describeToolCall("image_generate", { prompt: "x", path: "a.png", from: "b.png" }).title).toBe("Change a picture: a.png")
})

test("the MCP server forwards a call with its token and hands back the picture", async () => {
  const directory = await mkdtemp("/tmp/runrail-images-mcp-")
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, "endpoint.json")
  await writeFile(file, JSON.stringify({ version: 1, url: "http://127.0.0.1:4555", token: "d".repeat(64) }), { mode: 0o600 })
  const calls: { url: string; authorization: string | null; body: unknown }[] = []
  const out: Record<string, any>[] = []
  await runImagesMcpServer({
    endpointFile: file,
    input: (async function* () {
      yield `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "image_generate", arguments: { prompt: "a fox", path: "fox.png" } } })}\n`
      yield `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "image_generate", arguments: { prompt: "a cat", path: "cat.png" } } })}\n`
    })(),
    write: (line) => out.push(JSON.parse(line) as Record<string, unknown>),
    fetch: async (url, init) => {
      const body = JSON.parse(String(init.body)) as { input: { prompt: string } }
      calls.push({ url, authorization: new Headers(init.headers).get("authorization"), body })
      return new Response(JSON.stringify(body.input.prompt === "a fox" ? { ok: true, result: { text: "Saved a PNG to fox.png", image: { mediaType: "image/png", dataBase64: "iVBORw0K" } } } : { ok: false, error: { code: "IMAGE_NO_MODEL", message: "No image model is chosen." } }))
    },
  })
  expect(calls.find((call) => (call.body as { input: { prompt: string } }).input.prompt === "a fox")).toEqual({ url: "http://127.0.0.1:4555/images", authorization: `Bearer ${"d".repeat(64)}`, body: { input: { prompt: "a fox", path: "fox.png" } } })
  expect(out.find((line) => line.id === 1)?.result).toEqual({ content: [{ type: "text", text: "Saved a PNG to fox.png" }, { type: "image", data: "iVBORw0K", mimeType: "image/png" }] })
  expect(out.find((line) => line.id === 2)?.result).toEqual({ content: [{ type: "text", text: "No image model is chosen." }], isError: true })
  expect(IMAGES_MCP_ALLOWED_TOOLS).toBe("mcp__runrail_images")
})
