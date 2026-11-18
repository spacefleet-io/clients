import { RUNTIME_OWNER_HEADER, runtimeLoginResponseSchema } from "@space/runtime-contracts/lifecycle";
import type { RuntimeFetch } from "./fetch";

export type OwnerSecretProvider = () => Promise<string | null | undefined> | string | null | undefined;

export type RuntimeSessionConfig = {
  runtimeBaseUrl: string;
  backendToken: string;
  apps?: string[];
  userId?: string;
  fetchImpl?: RuntimeFetch;
  onTokenChange?: (token: string | null) => void;
  /**
   * The runtime's owner secret (RT-SEC-05), sent as `X-Runtime-Owner` on login.
   * A function, never a value: it is called on every login and again when the
   * runtime refuses one (401), so a runtime that restarted with a new secret
   * works without a restart of the app. Node callers use
   * `ownerSecretFileProvider` from `@space/runtime-client/ownerSecretFile`;
   * renderers get it from their main process over IPC.
   */
  ownerSecret?: OwnerSecretProvider;
  /**
   * Clock seam — defaults to `Date.now`. Tests override to drive expiry
   * windows without `vi.useFakeTimers()` polluting the rest of the suite.
   */
  clock?: () => number;
};

export type RuntimeSessionHandle = {
  getToken(): Promise<string>;
  invalidate(): void;
  reset(): void;
  setBackendToken(token: string): void;
  getBackendToken(): string;
};

const normalizeUrl = (url: string) => url.trim().replace(/\/+$/, "");

/**
 * Safety window subtracted from the server-issued `expiresAt` before the
 * cached token is considered usable. The runtime's session TTL is 60 min
 * (`RUNTIME_TOKEN_TTL_MS` default), so 30s leaves >59 min of normal use
 * AND guarantees we never hand out a token that the runtime is about to
 * silently invalidate mid-flight. Tied to the runtime's
 * security defaults — if the server-side TTL ever drops to single
 * digits this margin must drop with it.
 */
const EXPIRY_REFRESH_MARGIN_MS = 30_000;

export const createRuntimeSession = (config: RuntimeSessionConfig): RuntimeSessionHandle => {
  const fetchImpl = config.fetchImpl ?? fetch;
  const apps = config.apps ?? [];
  const runtimeBaseUrl = normalizeUrl(config.runtimeBaseUrl);
  const clock = config.clock ?? (() => Date.now());

  let backendToken = config.backendToken;
  let cachedToken: string | null = null;
  let cachedForBackend: string | null = null;
  // Server-issued absolute expiry timestamp (ms since epoch). null until the
  // first successful login. A token is fresh only when `clock() < cachedExpiresAtMs - EXPIRY_REFRESH_MARGIN_MS`.
  let cachedExpiresAtMs: number | null = null;
  let loginInFlight: Promise<string> | null = null;

  const readOwnerSecret = async (): Promise<string | null> => {
    if (!config.ownerSecret) return null;
    try {
      const value = await config.ownerSecret();
      return value?.trim() || null;
    } catch {
      // No secret to read (runtime not started yet, file unreadable): log in without one and let the runtime's answer speak.
      return null;
    }
  };

  const postLogin = (ownerSecret: string | null) =>
    fetchImpl(`${runtimeBaseUrl}/runtime/session/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(ownerSecret ? { [RUNTIME_OWNER_HEADER]: ownerSecret } : {}),
      },
      body: JSON.stringify({ backendToken, apps, ...(config.userId ? { userId: config.userId } : {}) }),
    });

  const login = async (): Promise<string> => {
    const ownerSecret = await readOwnerSecret();
    let response = await postLogin(ownerSecret);
    if (response.status === 401) {
      // A runtime that restarted holds a new secret: read it again (never cached) and retry once.
      const fresh = await readOwnerSecret();
      if (fresh && fresh !== ownerSecret) response = await postLogin(fresh);
    }
    if (!response.ok) {
      throw new Error(`runtime_login_http_${response.status}`);
    }
    const body = await response.json();
    const parsed = runtimeLoginResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new Error(`runtime_login_invalid_response: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    }
    cachedToken = parsed.data.token;
    cachedForBackend = backendToken;
    // expiresAt is ISO-8601 per the schema. Parse defensively — a malformed
    // date should not poison the cache forever (treat as "expires now" so
    // the next getToken() re-logs).
    const parsedExpiry = Date.parse(parsed.data.expiresAt);
    cachedExpiresAtMs = Number.isFinite(parsedExpiry) ? parsedExpiry : 0;
    config.onTokenChange?.(cachedToken);
    return cachedToken;
  };

  const isCachedTokenFresh = (): boolean => {
    if (!cachedToken) return false;
    if (cachedForBackend !== backendToken) return false;
    if (cachedExpiresAtMs === null) return false;
    return clock() < cachedExpiresAtMs - EXPIRY_REFRESH_MARGIN_MS;
  };

  return {
    async getToken() {
      if (isCachedTokenFresh()) {
        return cachedToken!;
      }
      // Cache miss OR token within EXPIRY_REFRESH_MARGIN_MS of TTL — proactive
      // re-login. Coalesced via `loginInFlight` so a burst of getToken() calls
      // landing on a stale cache produces a single network round-trip.
      if (loginInFlight) return loginInFlight;
      loginInFlight = login().finally(() => {
        loginInFlight = null;
      });
      return loginInFlight;
    },

    invalidate() {
      cachedToken = null;
      cachedForBackend = null;
      cachedExpiresAtMs = null;
      config.onTokenChange?.(null);
    },

    reset() {
      cachedToken = null;
      cachedForBackend = null;
      cachedExpiresAtMs = null;
      loginInFlight = null;
      config.onTokenChange?.(null);
    },

    setBackendToken(token: string) {
      if (token === backendToken) return;
      backendToken = token;
      cachedToken = null;
      cachedForBackend = null;
      cachedExpiresAtMs = null;
      config.onTokenChange?.(null);
    },

    getBackendToken() {
      return backendToken;
    },
  };
};
