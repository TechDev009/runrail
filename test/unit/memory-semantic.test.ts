import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { codeDistance, embedTexts, meaningFloor, NOISE_TEXTS, parseEmbeddingModels, signCode, similarity, type Embed } from "../../src/memory/embeddings.ts"
import { LocalMemory } from "../../src/memory/local.ts"
import { MemoryService } from "../../src/memory/service.ts"
import { MemoryError } from "../../src/memory/types.ts"
import type { ProviderDiscoveryOptions } from "../../src/providers/types.ts"

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

async function scratch(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "runrail-memory-semantic-"))
  cleanup.push(() => rm(path, { recursive: true, force: true }))
  return path
}

// Words that mean the same thing share an axis, so a paraphrase with no word in common still lands close.
const CONCEPTS: readonly (readonly string[])[] = [
  ["deploy", "deploys", "ship", "release", "production", "prod", "staging"],
  ["database", "postgres", "sql", "migration", "migrations"],
  ["test", "tests", "spec", "specs", "bun"],
  ["style", "tabs", "spaces", "indent", "format"],
]
const DIMENSIONS = CONCEPTS.length + 8

function vectorFor(text: string): Float32Array {
  const vector = new Float32Array(DIMENSIONS)
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    const concept = CONCEPTS.findIndex((words) => words.includes(word))
    if (concept >= 0) vector[concept]! += 1
    else vector[CONCEPTS.length + (word.length % 8)]! += 0.15
  }
  const norm = Math.hypot(...vector) || 1
  return vector.map((value) => value / norm)
}

function fakeEmbed(calls: string[][] = []): Embed {
  return async (_choice, texts) => {
    calls.push([...texts])
    return texts.map(vectorFor)
  }
}

async function until(check: () => Promise<boolean> | boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting")
    await Bun.sleep(10)
  }
}

function provider(answer: (body: Record<string, unknown>, attempt: number) => Response) {
  const seen: { readonly path: string; readonly authorization: string | null; readonly body: Record<string, unknown> }[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(incoming) {
      const body = (await incoming.json()) as Record<string, unknown>
      seen.push({ path: new URL(incoming.url).pathname, authorization: incoming.headers.get("authorization"), body })
      return answer(body, seen.length)
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

describe("embedding models a connection lists", () => {
  test("ids that name an embedder, a listing's own type, and output modalities; never on a Messages endpoint", () => {
    const openai = { data: [{ id: "text-embedding-3-small" }, { id: "gpt-5.5" }, { id: "text-embedding-3-large" }, { id: "omni-moderation-latest" }] }
    expect(parseEmbeddingModels(openai, { protocol: "openai-responses" }).map((model) => model.id)).toEqual(["text-embedding-3-large", "text-embedding-3-small"])
    const ollama = { models: [{ name: "nomic-embed-text:latest" }, { name: "llama3.2:latest" }, { name: "mxbai-embed-large" }, { name: "bge-m3" }] }
    expect(parseEmbeddingModels(ollama, { protocol: "openai-chat" }).map((model) => model.id)).toEqual(["bge-m3", "mxbai-embed-large", "nomic-embed-text:latest"])
    const typed = { data: [{ id: "voyage-3", type: "embedding" }, { id: "embed-looking-chat", type: "chat" }, { id: "a/b", architecture: { output_modalities: ["embeddings"] } }, { id: "c/embed", architecture: { output_modalities: ["text"] } }] }
    expect(parseEmbeddingModels(typed, { protocol: "openai-chat" }).map((model) => model.id)).toEqual(["a/b", "voyage-3"])
    expect(parseEmbeddingModels(openai, { protocol: "anthropic-messages" })).toEqual([])
  })
})

describe("asking for embeddings", () => {
  test("one batch to the connection's own embeddings address, answered as unit vectors in the order asked", async () => {
    const { seen, options } = provider(() => Response.json({ data: [{ index: 1, embedding: [0, 2] }, { index: 0, embedding: [3, 4] }] }))
    const vectors = await embedTexts(options, "text-embedding-3-small", ["first", "second"])
    expect(seen[0]).toEqual({ path: "/v1/embeddings", authorization: "Bearer sk-test", body: { model: "text-embedding-3-small", input: ["first", "second"], encoding_format: "float" } })
    expect([...vectors[0]!].map((value) => Number(value.toFixed(3)))).toEqual([0.6, 0.8])
    expect([...vectors[1]!]).toEqual([0, 1])
  })

  test("a provider that refuses the float format is asked again without it", async () => {
    const { seen, options } = provider((body) =>
      body.encoding_format === undefined ? Response.json({ data: [{ embedding: [1, 0] }] }) : Response.json({ error: { message: "unknown field encoding_format" } }, { status: 400 }),
    )
    expect((await embedTexts(options, "nomic-embed-text", ["one"])).length).toBe(1)
    expect(seen.map((entry) => entry.body.encoding_format)).toEqual(["float", undefined])
  })

  test("a refusal reads in Runrail's words, and an answer of the wrong shape is refused", async () => {
    const refused = provider(() => Response.json({ error: { message: "secret-looking provider text" } }, { status: 401 }))
    const error = await embedTexts(refused.options, "m", ["one"]).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(MemoryError)
    expect((error as MemoryError).message).not.toContain("secret-looking")
    const short = provider(() => Response.json({ data: [{ embedding: [1, 0] }] }))
    await expect(embedTexts(short.options, "m", ["one", "two"])).rejects.toThrow("could not be read")
    const ragged = provider(() => Response.json({ data: [{ embedding: [1, 0] }, { embedding: [1, 0, 0] }] }))
    await expect(embedTexts(ragged.options, "m", ["one", "two"])).rejects.toThrow("could not be read")
    const zero = provider(() => Response.json({ data: [{ embedding: [0, 0] }] }))
    await expect(embedTexts(zero.options, "m", ["one"])).rejects.toThrow("empty vector")
  })
})

describe("vectors in local memory", () => {
  test("a vector is kept only for the text it was made from, and goes when its memory changes or goes", async () => {
    const memory = new LocalMemory(":memory:")
    cleanup.push(() => memory.close())
    const kept = await memory.add({ scope: "person", text: "Deploys go to staging first." })
    const edited = await memory.add({ scope: "person", text: "Tests run with bun test." })
    expect(memory.unembedded("m1", 10).map((entry) => entry.id).sort()).toEqual([kept.id, edited.id].sort())
    expect(memory.storeVectors("m1", [
      { id: kept.id, text: kept.text, vector: vectorFor(kept.text) },
      { id: edited.id, text: "an older text", vector: vectorFor(edited.text) },
    ])).toBe(1)
    expect(memory.embedded("m1")).toEqual({ indexed: 1, pending: 1 })
    expect(memory.unembedded("m2", 10).length).toBe(2)
    await memory.update(kept.id, "Deploys go to staging, then production.")
    expect(memory.embedded("m1")).toEqual({ indexed: 0, pending: 2 })
    memory.storeVectors("m1", memory.unembedded("m1", 10).map((entry) => ({ ...entry, vector: vectorFor(entry.text) })))
    await memory.forget(kept.id)
    expect(memory.embedded("m1")).toEqual({ indexed: 1, pending: 0 })
  })

  test("the closest memories in the scopes asked, most similar first, and another process's vectors are seen", async () => {
    const dir = await scratch()
    const first = new LocalMemory(join(dir, "memory.db"))
    const second = new LocalMemory(join(dir, "memory.db"))
    cleanup.push(() => first.close(), () => second.close())
    const ship = await first.add({ scope: "project:a", text: "Deploys go to staging first." })
    const db = await first.add({ scope: "project:a", text: "Migrations run against postgres." })
    const other = await first.add({ scope: "project:b", text: "Release to production on Fridays." })
    first.storeVectors("m", [ship, db, other].map((entry) => ({ id: entry.id, text: entry.text, vector: vectorFor(entry.text) })))
    const query = vectorFor("how do we ship to prod")
    expect(first.similar("m", query, ["project:a"], 5).map((hit) => hit.memory.id)).toEqual([ship.id, db.id])
    const specs = vectorFor("where do the specs go")
    expect(first.similar("m", specs, ["project:a"], 1)[0]?.memory.text).not.toBe("Tests run with bun test.")
    const late = await second.add({ scope: "project:a", text: "Tests run with bun test." })
    second.storeVectors("m", [{ id: late.id, text: late.text, vector: vectorFor(late.text) }])
    expect(first.similar("m", specs, ["project:a"], 1).map((hit) => hit.memory.id)).toEqual([late.id])
  })
})

// Unit vectors around `clusters` random directions, from a fixed seed: shaped like real embeddings, which bunch by topic.
function clustered(count: number, clusters: number, dims: number, seed = 1): Float32Array[] {
  let state = seed
  const random = () => {
    state = (state * 1_103_515_245 + 12_345) & 0x7fffffff
    return state / 0x7fffffff - 0.5
  }
  const unit = (vector: Float32Array) => {
    const norm = Math.hypot(...vector) || 1
    return vector.map((value) => value / norm)
  }
  const centers = Array.from({ length: clusters }, () => unit(Float32Array.from({ length: dims }, random)))
  return Array.from({ length: count }, (_, index) => unit(centers[index % clusters]!.map((value) => value + random() * 0.12)))
}

async function remember(memory: LocalMemory, scope: string, vectors: readonly Float32Array[], model = "m"): Promise<string[]> {
  const ids: string[] = []
  for (let start = 0; start < vectors.length; start += 64) {
    const batch = await Promise.all(vectors.slice(start, start + 64).map(async (vector, index) => ({ ...(await memory.add({ scope, text: `memory ${String(start + index)}` })), vector })))
    memory.storeVectors(model, batch.map((entry) => ({ id: entry.id, text: entry.text, vector: entry.vector })))
    ids.push(...batch.map((entry) => entry.id))
  }
  return ids
}

function exactNearest(query: Float32Array, vectors: readonly Float32Array[], ids: readonly string[], count: number): string[] {
  return vectors.map((vector, index) => ({ id: ids[index]!, near: similarity(query, vector) })).sort((a, b) => b.near - a.near).slice(0, count).map((hit) => hit.id)
}

describe("sign codes", () => {
  test("a code has one bit per dimension, set where the vector is positive, and counts the bits two codes differ in", () => {
    const code = signCode(Float32Array.from({ length: 40 }, (_, index) => (index % 3 === 0 ? 0.1 : -0.1)))
    expect(code.length).toBe(2)
    expect([...Array.from({ length: 40 }, (_, index) => (code[index >>> 5]! >>> (index & 31)) & 1)]).toEqual(Array.from({ length: 40 }, (_, index) => (index % 3 === 0 ? 1 : 0)))
    expect(codeDistance(Uint32Array.of(0b1011, 0), Uint32Array.of(0b0001, 0xffffffff))).toBe(34)
    expect(codeDistance(Uint32Array.of(7), Uint32Array.of(0, 0, 7), 2)).toBe(0)
  })

  test("the closest by code are compared in full, finding what comparing every vector finds", async () => {
    const memory = new LocalMemory(":memory:", { closestByCode: 100 })
    cleanup.push(() => memory.close())
    // The last 60 are held out as queries: near some memories, as a real question is.
    const all = clustered(1_560, 40, 256)
    const vectors = all.slice(0, 1_500)
    const ids = await remember(memory, "project:a", vectors)
    let found = 0
    for (const query of all.slice(1_500)) {
      const hits = memory.similar("m", query, ["project:a"], 10)
      expect(hits.map((hit) => hit.similarity)).toEqual([...hits.map((hit) => hit.similarity)].sort((a, b) => b - a))
      const exact = exactNearest(query, vectors, ids, 10)
      found += hits.filter((hit) => exact.includes(hit.memory.id)).length
    }
    expect(found / 600).toBeGreaterThan(0.95)
  })

  test("only the scopes asked are scanned, so a busy scope never crowds out a quiet one", async () => {
    const memory = new LocalMemory(":memory:", { closestByCode: 8 })
    cleanup.push(() => memory.close())
    const busy = clustered(600, 12, 256)
    await remember(memory, "project:busy", busy)
    const quiet = clustered(31, 3, 256, 7)
    const mine = quiet.slice(0, 30)
    const ids = await remember(memory, "project:quiet", mine)
    const hits = memory.similar("m", quiet[30]!, ["project:quiet"], 3)
    expect(hits.map((hit) => hit.memory.id)).toEqual(exactNearest(quiet[30]!, mine, ids, 3))
    expect(memory.similar("m", mine[4]!, ["project:quiet"], 1)[0]?.memory.id).toBe(ids[4])
  })

  test("vectors from a file written before codes get their scope and code once, and are found", async () => {
    const path = join(await scratch(), "memory.db")
    const old = new Database(path, { create: true })
    old.run("CREATE TABLE memories (id TEXT PRIMARY KEY, scope TEXT NOT NULL, text TEXT NOT NULL, source_kind TEXT NOT NULL, source_id TEXT, source_ref TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)")
    old.run("CREATE TABLE memory_vectors (memory_id TEXT NOT NULL, model TEXT NOT NULL, vector BLOB NOT NULL, PRIMARY KEY (memory_id, model))")
    const vectors = clustered(50, 5, 24)
    vectors.forEach((vector, index) => {
      old.query("INSERT INTO memories VALUES (?, 'person', ?, 'manual', NULL, NULL, 1, 1)").run(`mem-${String(index)}`, `memory ${String(index)}`)
      old.query("INSERT INTO memory_vectors VALUES (?, 'm', ?)").run(`mem-${String(index)}`, new Uint8Array(vector.buffer))
    })
    old.close()

    const memory = new LocalMemory(path, { closestByCode: 10 })
    cleanup.push(() => memory.close())
    expect(memory.similar("m", vectors[17]!, ["person"], 1)[0]?.memory.id).toBe("mem-17")
    const raw = new Database(path, { readonly: true })
    expect(raw.query<{ readonly n: number }, []>("SELECT count(*) AS n FROM memory_vectors WHERE scope = 'person' AND length(code) = 4").get()?.n).toBe(50)
    raw.close()
  })
})

describe("recall by meaning", () => {
  async function service(embed: Embed | "none" = fakeEmbed()) {
    const dir = await scratch()
    const memory = new MemoryService({ dir, root: "/work/example-app", ...(embed === "none" ? {} : { embed }) })
    cleanup.push(() => memory.close())
    return { dir, memory }
  }

  test("off until a model is picked; picking one checks it answers, measures its floor, embeds every memory, and is kept", async () => {
    const calls: string[][] = []
    const { dir, memory } = await service(fakeEmbed(calls))
    const scope = memory.projectScope ?? ""
    await memory.local.add({ scope, text: "Deploys go to staging first." })
    await memory.local.add({ scope: "person", text: "I indent with tabs." })
    expect(await memory.semanticStatus()).toBeUndefined()
    expect(calls).toEqual([])
    await memory.saveSettings({ embeddings: { connectionId: "conn-1", model: "m" } })
    expect(calls[0]).toEqual([...NOISE_TEXTS])
    await until(async () => (await memory.semanticStatus())?.pending === 0)
    expect(await memory.semanticStatus()).toMatchObject({ connectionId: "conn-1", model: "m", indexed: 2, pending: 0 })
    const floor = meaningFloor(NOISE_TEXTS.map(vectorFor))
    expect(JSON.parse(await readFile(join(dir, "settings.json"), "utf8"))).toEqual({ version: 1, provider: "local", embeddings: { connectionId: "conn-1", model: "m", floor } })
    // Picking the same model again keeps its floor without asking it again.
    await memory.saveSettings({ embeddings: { connectionId: "conn-1", model: "m" } })
    expect(calls.filter((batch) => batch[0] === NOISE_TEXTS[0])).toHaveLength(1)
    expect((await memory.settings()).embeddings?.floor).toBe(floor)
    await memory.local.add({ scope, text: "Specs live next to the code." })
    await until(async () => (await memory.semanticStatus())?.pending === 0)
  })

  test("a message with no word in common recalls a memory by meaning; one sharing words is found both ways", async () => {
    const { memory } = await service()
    const scope = memory.projectScope ?? ""
    await memory.local.add({ scope, text: "Deploys go to staging first." })
    await memory.local.add({ scope, text: "Migrations run against postgres." })
    await memory.saveSettings({ embeddings: { connectionId: "conn-1", model: "m" } })
    await until(async () => (await memory.semanticStatus())?.pending === 0)
    const paraphrase = await memory.recallForMessage("how do we ship to prod?")
    expect(paraphrase.hits.map((hit) => [hit.text, hit.match])).toEqual([["Deploys go to staging first.", "meaning"]])
    const shared = await memory.recall("which postgres migrations run", memory.scopes(undefined), 3)
    expect(shared.hits[0]).toMatchObject({ text: "Migrations run against postgres.", match: "both" })
  })

  test("a model that stops answering leaves recall by keyword, and says why in the status", async () => {
    let failing = false
    const embed: Embed = async (choice, texts, signal) => {
      if (failing) throw new MemoryError("MEMORY_UNAVAILABLE", "The embedding model did not answer in time.")
      return fakeEmbed()(choice, texts, signal)
    }
    const { memory } = await service(embed)
    const scope = memory.projectScope ?? ""
    await memory.local.add({ scope, text: "Deploys go to staging first." })
    await memory.saveSettings({ embeddings: { connectionId: "conn-1", model: "m" } })
    await until(async () => (await memory.semanticStatus())?.pending === 0)
    failing = true
    expect((await memory.recallForMessage("how do we ship to prod?")).hits).toEqual([])
    expect((await memory.recallForMessage("where do deploys go first?")).hits.map((hit) => hit.match)).toEqual(["keyword"])
    expect((await memory.semanticStatus())?.problem).toBe("The embedding model did not answer in time.")
  })

  test("a model that fails its check is not kept; turning recall by meaning off forgets the vectors", async () => {
    const { memory } = await service(async () => {
      throw new MemoryError("MEMORY_UNAVAILABLE", "This connection does not serve embeddings with this model.")
    })
    await expect(memory.saveSettings({ embeddings: { connectionId: "conn-1", model: "chat-model" } })).rejects.toThrow("does not serve embeddings")
    expect((await memory.settings()).embeddings).toBeUndefined()

    const working = await service()
    await working.memory.local.add({ scope: "person", text: "I indent with tabs." })
    await working.memory.saveSettings({ embeddings: { connectionId: "conn-1", model: "m" } })
    await until(async () => (await working.memory.semanticStatus())?.pending === 0)
    await working.memory.saveSettings({ embeddings: null })
    expect(await working.memory.semanticStatus()).toBeUndefined()
    expect(working.memory.local.embedded("m").indexed).toBe(0)
    expect((await working.memory.settings()).provider).toBe("local")
  })

  test("an engine that cannot ask an embedding model refuses to pick one", async () => {
    const { memory } = await service("none")
    await expect(memory.saveSettings({ embeddings: { connectionId: "conn-1", model: "m" } })).rejects.toThrow("cannot ask an embedding model")
    await expect(memory.saveSettings({})).rejects.toThrow("must name a provider or an embedding model")
  })
  test("recall uses the floor measured for the model that was picked", async () => {
    const { dir, memory } = await service()
    const scope = memory.projectScope ?? ""
    await memory.local.add({ scope, text: "Deploys go to staging first." })
    await memory.saveSettings({ embeddings: { connectionId: "conn-1", model: "m" } })
    await until(async () => (await memory.semanticStatus())?.pending === 0)
    expect((await memory.recallForMessage("how do we ship to prod?")).hits).toHaveLength(1)
    const settings = JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as { embeddings: Record<string, unknown> }
    await writeFile(join(dir, "settings.json"), JSON.stringify({ ...settings, embeddings: { ...settings.embeddings, floor: 0.9999 } }))
    expect((await memory.recallForMessage("how do we ship to prod?")).hits).toEqual([])
  })
})

describe("the floor a memory must reach by meaning", () => {
  const unit = (...values: number[]): Float32Array => {
    const norm = Math.hypot(...values)
    return Float32Array.from(values.map((value) => value / norm))
  }

  test("sits above the model's noise by its spread, within bounds", () => {
    // Pairwise similarities 0.6, 0.6 and 0.36: mean 0.52, spread about 0.113.
    expect(meaningFloor([unit(1, 0, 0), unit(0.6, 0.8, 0), unit(0.6, 0, 0.8)])).toBe(0.831)
    // A model that finds everything alike still recalls something; one that finds nothing alike still asks for a little.
    expect(meaningFloor([unit(1, 0), unit(1, 0), unit(1, 0)])).toBe(0.9)
    expect(meaningFloor([unit(1, 0, 0), unit(0, 1, 0), unit(0, 0, 1)])).toBe(0.2)
  })

})
