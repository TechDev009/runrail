import { isIP } from "node:net"

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308])

export class RedirectRefusedError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = "RedirectRefusedError"
  }
}

/**
 * Follows redirects one hop at a time, asking `allow` about every address before anything is sent
 * there. `fetch`'s own following would carry the request's headers, credentials included, to
 * wherever the first server points.
 */
export async function fetchCheckingRedirects(
  url: string | URL,
  init: RequestInit,
  allow: (next: URL, from: URL) => boolean,
  options: { readonly maxHops?: number; readonly fetch?: (input: string, init: RequestInit) => Promise<Response> } = {},
): Promise<Response> {
  const send = options.fetch ?? ((input: string, request: RequestInit) => fetch(input, request))
  let current = new URL(url)
  let request: RequestInit = { ...init, redirect: "manual" }
  for (let hop = 0; ; hop += 1) {
    const response = await send(current.toString(), request)
    if (!REDIRECT_STATUSES.has(response.status)) return response
    const location = response.headers.get("location")
    await response.body?.cancel().catch(() => undefined)
    if (location === null || hop >= (options.maxHops ?? 3)) throw new RedirectRefusedError("too many redirects")
    let next: URL
    try {
      next = new URL(location, current)
    } catch {
      throw new RedirectRefusedError("redirect address is invalid")
    }
    if ((next.protocol !== "https:" && next.protocol !== "http:") || next.username !== "" || next.password !== "" || !allow(next, current))
      throw new RedirectRefusedError("redirect to another address was refused")
    // 303, and 301/302 after a POST, continue as a GET without the body, as browsers do.
    const method = (request.method ?? "GET").toUpperCase()
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      const { body: _body, ...rest } = request
      request = { ...rest, method: "GET" }
    }
    current = next
  }
}

export function sameOrigin(next: URL, from: URL): boolean {
  return next.origin === from.origin
}

/**
 * A name or literal address on this machine, a private network, or a range no public server uses
 * (link-local, carrier-grade NAT, benchmarking, multicast, reserved, NAT64, 6to4). Names are not resolved,
 * so a public name that points at a private address still passes; callers that must stop that pin the address.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "")
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true
  const kind = isIP(host)
  if (kind === 4) {
    const [a = 0, b = 0, c = 0] = host.split(".").map(Number)
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && c === 0) || (a === 198 && (b === 18 || b === 19)) || (a === 100 && b >= 64 && b <= 127)
  }
  if (kind === 6) return host === "::1" || host === "::" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith("ff") || host.startsWith("::ffff:") || host.startsWith("64:ff9b:") || host.startsWith("2002:")
  // A single label ("intranet") resolves only inside a network.
  return !host.includes(".")
}
