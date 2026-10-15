import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { join } from "node:path"

/**
 * Web Push (RFC 8030) for the desktop's phone access: each message is encrypted for
 * the phone that subscribed (RFC 8291, aes128gcm), so its push service cannot read it, and signed
 * with this computer's VAPID key (RFC 8292), which stays in `~/.runrail/push`. Only the browsers'
 * own push services are sent to.
 */

export class PushError extends Error {
  constructor(
    readonly code: "PUSH_INVALID" | "PUSH_FAILED",
    message: string,
  ) {
    super(message)
  }
}

export interface PushSubscription {
  readonly endpoint: string
  readonly keys: { readonly p256dh: string; readonly auth: string }
}

export interface PushMessage {
  readonly title: string
  readonly body: string
  /** Where on the phone page a tap goes, such as `/#t=<thread>`. */
  readonly url?: string
  /** Replaces an earlier notification with the same tag. */
  readonly tag?: string
  readonly urgency?: "normal" | "high"
}

export interface PushResult {
  readonly delivered: boolean
  /** The phone unsubscribed or the subscription expired; it should be forgotten. */
  readonly gone?: true
}

/** Apple's, Google's, Mozilla's and Microsoft's push services; nothing else is posted to. */
const PUSH_HOSTS = ["web.push.apple.com", "fcm.googleapis.com", "updates.push.services.mozilla.com"]
const PUSH_HOST_SUFFIXES = [".notify.windows.com", ".push.apple.com"]
const RECORD_SIZE = 4096
/** A record holds 4096 bytes: the header, the tag, and the delimiter leave this much for the message. */
const MAX_PAYLOAD = 3_800
const TTL_SECONDS = 24 * 60 * 60
const JWT_SECONDS = 12 * 60 * 60

const encoder = new TextEncoder()

/** Bytes WebCrypto takes: backed by a plain ArrayBuffer. */
type Bytes = Uint8Array<ArrayBuffer>

export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url")
}

export function fromBase64url(text: string): Bytes {
  return new Uint8Array(Buffer.from(text, "base64url"))
}

function concat(...parts: readonly Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

function pushHost(host: string): boolean {
  return PUSH_HOSTS.includes(host) || PUSH_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length)
}

/** A subscription as the phone's `PushSubscription.toJSON()` gives it, checked. */
export function parseSubscription(value: unknown): PushSubscription {
  const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
  const keys = typeof record.keys === "object" && record.keys !== null ? (record.keys as Record<string, unknown>) : {}
  const { endpoint } = record
  if (typeof endpoint !== "string" || endpoint.length > 2_048) throw new PushError("PUSH_INVALID", "subscription endpoint is invalid")
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new PushError("PUSH_INVALID", "subscription endpoint is invalid")
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "" || !pushHost(url.hostname)) throw new PushError("PUSH_INVALID", "subscription endpoint is not a known push service")
  const { p256dh, auth } = keys
  if (typeof p256dh !== "string" || !/^[A-Za-z0-9_-]{86,88}={0,2}$/.test(p256dh) || fromBase64url(p256dh).length !== 65 || fromBase64url(p256dh)[0] !== 4) throw new PushError("PUSH_INVALID", "subscription key is invalid")
  if (typeof auth !== "string" || !/^[A-Za-z0-9_-]{22,24}={0,2}$/.test(auth) || fromBase64url(auth).length !== 16) throw new PushError("PUSH_INVALID", "subscription secret is invalid")
  return { endpoint: url.href, keys: { p256dh, auth } }
}

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, bytes: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8))
}

/**
 * Encrypts `payload` for one subscription as one aes128gcm record (RFC 8291 section 3). `fixed`
 * pins the salt and this side's key pair, which only the RFC's worked example needs.
 */
export async function encrypt(payload: Uint8Array, subscription: PushSubscription, fixed: { readonly salt?: Bytes; readonly local?: CryptoKeyPair } = {}): Promise<Bytes> {
  if (payload.length > MAX_PAYLOAD) throw new PushError("PUSH_INVALID", "push message is too large")
  const clientPublic = fromBase64url(subscription.keys.p256dh)
  const authSecret = fromBase64url(subscription.keys.auth)
  const salt = fixed.salt ?? new Uint8Array(randomBytes(16))
  const local = fixed.local ?? ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair)
  const localPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey))
  const client = await crypto.subtle.importKey("raw", clientPublic, { name: "ECDH", namedCurve: "P-256" }, false, [])
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: client }, local.privateKey, 256))
  const ikm = await hkdf(authSecret, shared, concat(encoder.encode("WebPush: info\0"), clientPublic, localPublic), 32)
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16)
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12)
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"])
  // One record, so it is the last: the delimiter is 2 and no padding follows.
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(payload, new Uint8Array([2]))))
  const header = new Uint8Array(16 + 4 + 1)
  header.set(salt, 0)
  new DataView(header.buffer).setUint32(16, RECORD_SIZE)
  header[20] = localPublic.length
  return concat(header, localPublic, sealed)
}

interface VapidFile {
  readonly version: 1
  readonly publicKey: string
  readonly privateKey: JsonWebKey
}

export interface Vapid {
  /** The uncompressed P-256 point, base64url: a phone's `applicationServerKey`. */
  readonly publicKey: string
  readonly privateKey: CryptoKey
}

/** This computer's VAPID key pair, made on first use and kept owner-only in `dir`. */
export async function vapidKeys(dir: string): Promise<Vapid> {
  const file = join(dir, "vapid.json")
  const saved = await readFile(file, "utf8").then(
    (text) => JSON.parse(text) as Partial<VapidFile>,
    () => undefined,
  )
  if (saved?.version === 1 && typeof saved.publicKey === "string" && typeof saved.privateKey === "object") {
    try {
      return { publicKey: saved.publicKey, privateKey: await crypto.subtle.importKey("jwk", saved.privateKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]) }
    } catch {
      // A damaged file gets a new key; phones subscribe again with it.
    }
  }
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair
  const publicKey = base64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)))
  const privateKey = await crypto.subtle.exportKey("jwk", pair.privateKey)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`
  await writeFile(temporary, `${JSON.stringify({ version: 1, publicKey, privateKey } satisfies VapidFile)}\n`, { mode: 0o600 })
  await rename(temporary, file)
  return { publicKey, privateKey: pair.privateKey }
}

/** The VAPID token for one push service (RFC 8292): its origin, a 12-hour expiry, and who sends. */
export async function vapidToken(vapid: Vapid, endpoint: string, contact: string, now = Date.now()): Promise<string> {
  const header = base64url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })))
  const claims = base64url(encoder.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + JWT_SECONDS, sub: contact })))
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, vapid.privateKey, encoder.encode(`${header}.${claims}`)))
  return `${header}.${claims}.${base64url(signature)}`
}

/** Who sends, as push services ask: the phone page's own https address. */
export function parseContact(value: unknown): string {
  if (typeof value !== "string" || value.length > 300) throw new PushError("PUSH_INVALID", "contact must be an https address")
  try {
    const url = new URL(value)
    if (url.protocol === "https:" && url.username === "" && url.password === "") return url.origin
  } catch {
    // Refused below.
  }
  throw new PushError("PUSH_INVALID", "contact must be an https address")
}

export function parseMessage(value: unknown): PushMessage {
  const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
  const text = (field: unknown, max: number): string | undefined => (typeof field === "string" ? field.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max) : undefined)
  const title = text(record.title, 120)
  const body = text(record.body, 300)
  if (title === undefined || title.trim().length === 0 || body === undefined) throw new PushError("PUSH_INVALID", "a push needs a title and a body")
  const url = text(record.url, 200)
  const tag = text(record.tag, 64)
  if (url !== undefined && !url.startsWith("/")) throw new PushError("PUSH_INVALID", "url must be a path on the phone page")
  if (record.urgency !== undefined && record.urgency !== "normal" && record.urgency !== "high") throw new PushError("PUSH_INVALID", "urgency must be normal or high")
  return { title, body, ...(url === undefined ? {} : { url }), ...(tag === undefined ? {} : { tag }), ...(record.urgency === undefined ? {} : { urgency: record.urgency }) }
}

/** Sends one message to one phone. */
export async function sendPush(input: { readonly vapid: Vapid; readonly subscription: PushSubscription; readonly contact: string; readonly message: PushMessage; readonly fetch?: typeof fetch }): Promise<PushResult> {
  const { title, body, url, tag } = input.message
  const payload = encoder.encode(JSON.stringify({ title, body, ...(url === undefined ? {} : { url }), ...(tag === undefined ? {} : { tag }) }))
  const sealed = await encrypt(payload, input.subscription)
  const token = await vapidToken(input.vapid, input.subscription.endpoint, input.contact)
  let response: Response
  try {
    response = await (input.fetch ?? fetch)(input.subscription.endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `vapid t=${token}, k=${input.vapid.publicKey}`,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(TTL_SECONDS),
        Urgency: input.message.urgency ?? "normal",
      },
      body: sealed,
    })
  } catch {
    throw new PushError("PUSH_FAILED", "the push service could not be reached")
  }
  await response.body?.cancel().catch(() => undefined)
  if (response.status === 404 || response.status === 410) return { delivered: false, gone: true }
  if (response.status >= 200 && response.status < 300) return { delivered: true }
  throw new PushError("PUSH_FAILED", `the push service answered ${String(response.status)}`)
}
