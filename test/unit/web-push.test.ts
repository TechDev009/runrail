import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { base64url, encrypt, fromBase64url, parseContact, parseMessage, parseSubscription, PushError, sendPush, vapidKeys, vapidToken, type PushSubscription } from "../../src/push/web-push"

/** Web Push for phone access: RFC 8291 encryption and RFC 8292 VAPID. */

const dirs: string[] = []
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rr-push-"))
  dirs.push(dir)
  return dir
}

/** A phone's side: its key pair and auth secret, and the subscription it would send. */
async function phone(endpoint = "https://web.push.apple.com/QGuQyavXutnMH8eFmz8"): Promise<{ readonly subscription: PushSubscription; readonly privateKey: CryptoKey; readonly auth: Uint8Array<ArrayBuffer> }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair
  const auth = crypto.getRandomValues(new Uint8Array(16))
  const p256dh = base64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)))
  return { subscription: { endpoint, keys: { p256dh, auth: base64url(auth) } }, privateKey: pair.privateKey, auth }
}

async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: string | Uint8Array<ArrayBuffer>, bytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: typeof info === "string" ? new TextEncoder().encode(info) : info }, key, bytes * 8))
}

/** What the phone's browser does with a message (RFC 8291 section 3.4), written out separately. */
async function decrypt(body: Uint8Array<ArrayBuffer>, side: Awaited<ReturnType<typeof phone>>): Promise<string> {
  const salt = body.slice(0, 16)
  const idLength = body[20] ?? 0
  const serverPublic = body.slice(21, 21 + idLength)
  const sealed = body.slice(21 + idLength)
  const server = await crypto.subtle.importKey("raw", serverPublic, { name: "ECDH", namedCurve: "P-256" }, false, [])
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: server }, side.privateKey, 256))
  const clientPublic = fromBase64url(side.subscription.keys.p256dh)
  const info = new Uint8Array([...new TextEncoder().encode("WebPush: info\0"), ...clientPublic, ...serverPublic])
  const ikm = await hkdf(side.auth, shared, info, 32)
  const cek = await crypto.subtle.importKey("raw", await hkdf(salt, ikm, "Content-Encoding: aes128gcm\0", 16), "AES-GCM", false, ["decrypt"])
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: await hkdf(salt, ikm, "Content-Encoding: nonce\0", 12) }, cek, sealed))
  expect(plain.at(-1)).toBe(2)
  return new TextDecoder().decode(plain.slice(0, -1))
}

describe("web push", () => {
  test("a message opens only with the phone's own key and secret", async () => {
    const side = await phone()
    const body = await encrypt(new TextEncoder().encode("When I grow up, I want to be a watermelon"), side.subscription)
    expect(new DataView(body.buffer).getUint32(16)).toBe(4096)
    expect(body[20]).toBe(65)
    expect(await decrypt(body, side)).toBe("When I grow up, I want to be a watermelon")
    const other = await phone()
    await expect(decrypt(body, { ...other, subscription: side.subscription })).rejects.toThrow()
  })

  test("matches the worked example in RFC 8291 section 5", async () => {
    const point = (text: string) => ({ x: base64url(fromBase64url(text).slice(1, 33)), y: base64url(fromBase64url(text).slice(33)) })
    const serverPublic = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"
    const local = {
      publicKey: await crypto.subtle.importKey("raw", fromBase64url(serverPublic), { name: "ECDH", namedCurve: "P-256" }, true, []),
      privateKey: await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", ...point(serverPublic), d: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw" }, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]),
    }
    const subscription = { endpoint: "https://push.example.net/push/JzLQ3raZJfFBR0aqvOMsLrt54w4rJUsV", keys: { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" } } // gitleaks:allow
    const body = await encrypt(new TextEncoder().encode("When I grow up, I want to be a watermelon"), subscription, { salt: fromBase64url("DGv6ra1nlYgDCS1FRnbzlw"), local })
    expect(base64url(body)).toBe("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN")
  })

  test("goes only to a browser's push service, with a well-formed key", async () => {
    const { subscription } = await phone()
    expect(parseSubscription(subscription).endpoint).toBe(subscription.endpoint)
    for (const endpoint of ["https://fcm.googleapis.com/fcm/send/abc", "https://updates.push.services.mozilla.com/wpush/v2/x", "https://wns2-par02p.notify.windows.com/w/?token=x"]) expect(parseSubscription({ ...subscription, endpoint }).endpoint).toBe(endpoint)
    for (const endpoint of ["http://web.push.apple.com/x", "https://127.0.0.1/x", "https://evil.example/x", "https://web.push.apple.com.evil.example/x", "https://user@web.push.apple.com/x", "https://web.push.apple.com:8443/x", "not a url"])
      expect(() => parseSubscription({ ...subscription, endpoint })).toThrow(PushError)
    expect(() => parseSubscription({ ...subscription, keys: { ...subscription.keys, p256dh: "AAAA" } })).toThrow("key")
    expect(() => parseSubscription({ ...subscription, keys: { ...subscription.keys, auth: base64url(new Uint8Array(8)) } })).toThrow("secret")
  })

  test("signs for the push service's origin with a key kept owner-only", async () => {
    const dir = await tempDir()
    const vapid = await vapidKeys(dir)
    expect((await stat(join(dir, "vapid.json"))).mode & 0o777).toBe(0o600)
    expect((await vapidKeys(dir)).publicKey).toBe(vapid.publicKey)
    expect(fromBase64url(vapid.publicKey)).toHaveLength(65)
    const now = 1_790_000_000_000
    const token = await vapidToken(vapid, "https://web.push.apple.com/QGuQyavXutnMH8eFmz8", "https://mac.tail1.ts.net:8443", now)
    const [header, claims, signature] = token.split(".") as [string, string, string]
    expect(JSON.parse(new TextDecoder().decode(fromBase64url(claims)))).toEqual({ aud: "https://web.push.apple.com", exp: now / 1000 + 12 * 3600, sub: "https://mac.tail1.ts.net:8443" })
    const key = await crypto.subtle.importKey("raw", fromBase64url(vapid.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"])
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, fromBase64url(signature), new TextEncoder().encode(`${header}.${claims}`))).toBe(true)
  })

  test("posts the sealed message with VAPID, and a gone subscription says so", async () => {
    const vapid = await vapidKeys(await tempDir())
    const side = await phone()
    const sent: { url: string; init: RequestInit }[] = []
    const answering = (status: number) =>
      (async (url: string | URL | Request, init?: RequestInit) => {
        sent.push({ url: String(url), init: init ?? {} })
        return new Response(null, { status })
      }) as typeof fetch
    const message = parseMessage({ title: "Fix the parser", body: "Needs your approval", url: "/#t=th-1", tag: "th-1", urgency: "high" })
    expect(await sendPush({ vapid, subscription: side.subscription, contact: "https://mac.tail1.ts.net:8443", message, fetch: answering(201) })).toEqual({ delivered: true })
    const headers = sent[0]?.init.headers as Record<string, string>
    expect(headers.Authorization).toStartWith("vapid t=")
    expect(headers.Authorization).toEndWith(`, k=${vapid.publicKey}`)
    expect(headers).toMatchObject({ "Content-Encoding": "aes128gcm", TTL: "86400", Urgency: "high" })
    expect(JSON.parse(await decrypt(sent[0]?.init.body as Uint8Array<ArrayBuffer>, side))).toEqual({ title: "Fix the parser", body: "Needs your approval", url: "/#t=th-1", tag: "th-1" })
    expect(await sendPush({ vapid, subscription: side.subscription, contact: "https://mac.tail1.ts.net:8443", message, fetch: answering(410) })).toEqual({ delivered: false, gone: true })
    await expect(sendPush({ vapid, subscription: side.subscription, contact: "https://mac.tail1.ts.net:8443", message, fetch: answering(500) })).rejects.toThrow("answered 500")
  })

  test("takes a short message, a path on the phone page, and an https sender", () => {
    expect(parseMessage({ title: "a\nb", body: "x".repeat(400) })).toEqual({ title: "a b", body: "x".repeat(300) })
    expect(() => parseMessage({ title: "", body: "" })).toThrow(PushError)
    expect(() => parseMessage({ title: "t", body: "b", url: "https://evil.example" })).toThrow("path")
    expect(parseContact("https://mac.tail1.ts.net:8443/phone.html")).toBe("https://mac.tail1.ts.net:8443")
    expect(() => parseContact("http://mac.tail1.ts.net")).toThrow(PushError)
  })
})
