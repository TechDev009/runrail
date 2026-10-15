import type { SignInNotice } from "./signin-types.ts"

/**
 * What the sign-in made of one request to the callback address.
 * - `accepted`: it carried what the sign-in needs.
 * - `refused`: it did not (wrong state, no code); the sign-in keeps waiting.
 * - `ended`: the vendor said the sign-in was not granted.
 * - `duplicate`: an earlier request was already accepted.
 */
export type RedirectVerdict = "accepted" | "refused" | "ended" | "duplicate"

export interface LoopbackListener {
  readonly port: number
  /** Stops listening and drops every open connection, including idle ones a browser opened ahead of time. */
  close(): Promise<void>
}

export interface LoopbackListenerOptions {
  /** A fixed port the vendor has registered, or `0` for any free port. */
  readonly port: number
  /** The exact path the vendor sends the browser back to. */
  readonly path: string
  onRedirect(params: URLSearchParams): RedirectVerdict
}

const PAGE_TEXT: Readonly<Record<RedirectVerdict, readonly [number, string, string]>> = {
  accepted: [200, "Sign-in received", "Runrail received the sign-in. You can close this tab and return to Runrail."],
  refused: [400, "Sign-in not recognised", "This page was not opened by the sign-in Runrail is waiting for. Return to Runrail and try again."],
  ended: [400, "Sign-in not completed", "The sign-in was not completed. Return to Runrail to try again."],
  duplicate: [409, "Sign-in already received", "Runrail already received this sign-in. You can close this tab."],
}

/**
 * Listens on this machine for the browser coming back from a vendor's sign-in page.
 *
 * Returns a notice instead of a listener when the port cannot be opened; the sign-in then continues
 * with the user pasting the address they landed on.
 */
export function openLoopbackListener(options: LoopbackListenerOptions): { readonly listener: LoopbackListener } | { readonly notice: SignInNotice } {
  let server: ReturnType<typeof Bun.serve>
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: options.port,
      fetch(request) {
        const url = new URL(request.url)
        // A page on another site can make the browser call this port, but not under this name.
        const host = request.headers.get("host")
        if (host !== `127.0.0.1:${server.port}` && host !== `localhost:${server.port}`) return page(400, "Not found", "Nothing here.")
        if (url.pathname !== options.path) return page(404, "Not found", "Nothing here.")
        if (request.method !== "GET") return page(405, "Not found", "Nothing here.")
        const [status, title, text] = PAGE_TEXT[options.onRedirect(url.searchParams)]
        return page(status, title, text)
      },
      error() {
        return page(500, "Sign-in failed", "Return to Runrail and try again.")
      },
    })
  } catch (error) {
    return { notice: isAddressInUse(error) ? "AUTH_PORT_BUSY" : "AUTH_LISTENER_FAILED" }
  }
  let closing: Promise<void> | undefined
  const port = server.port ?? options.port
  return {
    listener: {
      port,
      close() {
        closing ??= (async () => {
          // Let the answer to the accepted request leave, then cut everything that is still attached.
          await Promise.race([server.stop(), new Promise((resolve) => setTimeout(resolve, 250))])
          await server.stop(true)
        })()
        return closing
      },
    },
  }
}

// Fixed text only: nothing from the request is echoed, so the page cannot be made to run anything.
function page(status: number, title: string, text: string): Response {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>${text}</p></body></html>\n`, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'",
      connection: "close",
    },
  })
}

function isAddressInUse(error: unknown): boolean {
  return error !== null && typeof error === "object" && (error as { code?: unknown }).code === "EADDRINUSE"
}
