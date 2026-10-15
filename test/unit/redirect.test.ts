import { expect, test } from "bun:test"
import { fetchCheckingRedirects, isPrivateHost, RedirectRefusedError, sameOrigin } from "../../src/net/redirect.ts"

test("a redirect is followed only where the caller allows, and never carries the request on unasked", async () => {
  const seen: { url: string; authorization: string | null; method: string | undefined }[] = []
  const answers: Record<string, Response> = {
    "https://api.example.com/a": new Response(null, { status: 301, headers: { location: "/b" } }),
    "https://api.example.com/b": new Response("ok"),
    "https://api.example.com/off": new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } }),
    "https://api.example.com/loop": new Response(null, { status: 307, headers: { location: "/loop" } }),
  }
  const fake = async (input: string, init: RequestInit) => {
    seen.push({ url: input, authorization: new Headers(init.headers).get("authorization"), method: init.method })
    return answers[input]?.clone() ?? new Response("missing", { status: 404 })
  }
  const init = { headers: { authorization: "Bearer secret" } }
  expect(await (await fetchCheckingRedirects("https://api.example.com/a", init, sameOrigin, { fetch: fake })).text()).toBe("ok")
  await expect(fetchCheckingRedirects("https://api.example.com/off", init, sameOrigin, { fetch: fake })).rejects.toBeInstanceOf(RedirectRefusedError)
  expect(seen.some((request) => request.url.startsWith("https://evil.example"))).toBe(false)
  await expect(fetchCheckingRedirects("https://api.example.com/loop", init, sameOrigin, { fetch: fake, maxHops: 3 })).rejects.toThrow("too many redirects")
})

test("private and loopback addresses are recognised", () => {
  for (const host of ["localhost", "127.0.0.1", "10.1.2.3", "192.168.0.1", "172.20.0.1", "169.254.169.254", "[::1]", "fd00::1", "printer.local"]) expect([host, isPrivateHost(host)]).toEqual([host, true])
  for (const host of ["example.com", "8.8.8.8", "172.32.0.1"]) expect([host, isPrivateHost(host)]).toEqual([host, false])
})
