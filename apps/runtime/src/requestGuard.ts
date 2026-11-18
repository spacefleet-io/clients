import { isIP } from "node:net";
import { getRuntimeConfig } from "./config";

/**
 * Browser / DNS-rebinding lockdown for every runtime entry point (Hono routes,
 * the legacy WebSocket upgrade and the v2 SSE stream).
 *
 * Two independent checks, both answered with HTTP 403 before any route runs:
 *
 *  1. `Host` must name this machine (`127.0.0.1`, `localhost`, `[::1]`, any
 *     port, or the configured bind host). A DNS-rebinding page reaches the
 *     loopback listener under its own hostname, so its `Host` is foreign.
 *  2. A request that carries an `Origin` header must come from a trusted
 *     origin. Browsers always send `Origin` on cross-origin requests (and on
 *     every POST and WebSocket upgrade), whereas the CLI and the desktop main
 *     processes send none and stay allowed. Refusing the request outright,
 *     instead of only withholding the CORS headers, also stops "simple"
 *     cross-site POSTs, which are executed even when the page cannot read the
 *     answer.
 */

const LOOPBACK_HOSTNAMES: Record<string, true> = { "127.0.0.1": true, localhost: true, "[::1]": true };

/**
 * Origins the packaged desktop renderers send: the desktop apps load their UI
 * with `loadFile()`, so a `fetch()` to the runtime carries `Origin: null`
 * (some Chromium builds serialize it as `file://`). Dev servers run on
 * `http://localhost:<port>` and are covered by the loopback rule.
 *
 * Known limit: a web page can also produce `Origin: null` (sandboxed iframe),
 * so these two origins are NOT a boundary against hostile pages. The boundary
 * is the owner secret the login requires (RT-SEC-05, `core/ownerSecret.ts`): a
 * page cannot read the file it lives in.
 */
const DESKTOP_RENDERER_ORIGINS: Record<string, true> = { null: true, "file://": true };

const WILDCARD_BIND_HOSTS: Record<string, true> = { "0.0.0.0": true, "::": true, "[::]": true, "": true };

const HOST_HEADER = /^(\[[0-9a-f:.]+\]|[^\s:[\]/@?#\\]+)(?::(\d{1,5}))?$/i;

/** `localhost` / `127.0.0.1` / `[::1]`, i.e. the names a local client uses. */
export const isLoopbackHostname = (hostname: string) => Object.hasOwn(LOOPBACK_HOSTNAMES, hostname.toLowerCase());

export const isAllowedHost = (hostHeader: string | null, configuredHost: string = getRuntimeConfig().host): boolean => {
  if (!hostHeader) return false;
  const match = HOST_HEADER.exec(hostHeader.trim());
  if (!match) return false;
  const hostname = match[1]!.toLowerCase();
  if (isLoopbackHostname(hostname)) return true;
  const configured = configuredHost.trim().toLowerCase();
  if (Object.hasOwn(WILDCARD_BIND_HOSTS, configured)) {
    // Listening on every interface: the Host is whatever address the peer
    // used. A DNS-rebinding attack needs a hostname, never an IP literal.
    return isIP(hostname.replace(/^\[|\]$/g, "")) !== 0;
  }
  return hostname === (configured.includes(":") && !configured.startsWith("[") ? `[${configured}]` : configured);
};

/**
 * A web page's origin the runtime trusts: an http(s) loopback origin or one
 * listed in `RUNTIME_ALLOWED_ORIGINS`. Never the opaque `null` nor `file://`.
 */
export const isAllowedWebOrigin = (origin: string): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if ((parsed.protocol === "http:" || parsed.protocol === "https:") && isLoopbackHostname(parsed.hostname)) return true;
  return getRuntimeConfig().corsOrigins.includes(origin.replace(/\/+$/, ""));
};

export const isAllowedOrigin = (origin: string | null): boolean => {
  if (!origin) return true;
  if (Object.hasOwn(DESKTOP_RENDERER_ORIGINS, origin)) return true;
  return isAllowedWebOrigin(origin);
};

/**
 * The `Access-Control-Allow-Origin` value to echo for `origin`: the origin
 * itself when trusted, `null` (no header) when absent or untrusted.
 */
export const resolveCorsAcaoOrigin = (origin: string | null): string | null =>
  origin && isAllowedOrigin(origin) ? origin : null;

const forbidden = (error: "forbidden_host" | "forbidden_origin") =>
  new Response(JSON.stringify({ error }), {
    status: 403,
    headers: { "content-type": "application/json" },
  });

/**
 * Returns the 403 answer for a request that fails the Host or Origin policy,
 * or `null` when the request may proceed. The Host comes from the header when
 * present, else from the request URL (in-process `app.request()` calls carry
 * no header).
 */
export const guardRequest = (request: Request): Response | null => {
  const hostHeader = request.headers.get("host") ?? new URL(request.url).host;
  if (!isAllowedHost(hostHeader)) return forbidden("forbidden_host");
  if (!isAllowedOrigin(request.headers.get("origin"))) return forbidden("forbidden_origin");
  return null;
};
