/**
 * Shared test mocking utilities for the badger mobile app.
 *
 * Provides in-memory substitutes for AsyncStorage, Keychain, and fetch so that
 * auth/library state machine tests can run as pure-logic vitest tests without
 * any React Native runtime.
 */

// ── Fake AsyncStorage ────────────────────────────────────────────────

export const createFakeAsyncStorage = () => {
  const backing = new Map<string, string>();
  return {
    getItem: async (key: string) => backing.get(key) ?? null,
    setItem: async (key: string, value: string) => { backing.set(key, value); },
    removeItem: async (key: string) => { backing.delete(key); },
    clear: async () => { backing.clear(); },
    getAllKeys: async () => [...backing.keys()],
    multiGet: async (keys: string[]) => keys.map((k) => [k, backing.get(k) ?? null] as [string, string | null]),
    multiSet: async (pairs: [string, string][]) => { for (const [k, v] of pairs) backing.set(k, v); },
    multiRemove: async (keys: string[]) => { for (const k of keys) backing.delete(k); },
    /** Direct access for assertions. */
    _backing: backing,
  };
};

// ── Fake Keychain ────────────────────────────────────────────────────

export const createFakeKeychain = () => {
  const store = new Map<string, { username: string; password: string }>();
  return {
    getGenericPassword: async (opts?: { service?: string }) => {
      const entry = store.get(opts?.service ?? "__default__");
      return entry ? { username: entry.username, password: entry.password, service: opts?.service ?? "__default__", storage: "memory" } : false;
    },
    setGenericPassword: async (username: string, password: string, opts?: { service?: string }) => {
      store.set(opts?.service ?? "__default__", { username, password });
    },
    resetGenericPassword: async (opts?: { service?: string }) => {
      store.delete(opts?.service ?? "__default__");
    },
    _store: store,
  };
};

// ── Fetch Mock ───────────────────────────────────────────────────────

type RouteHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;

export const createFetchMock = () => {
  const routes = new Map<string, RouteHandler>();
  const calls: Array<{ url: string; init?: RequestInit }> = [];

  const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (input instanceof Request && !init) {
      // The generated SDK calls fetch(Request): read method/headers/body off the Request so
      // handlers and call logs keep seeing the (url, init) shape.
      const body = await input.clone().text();
      init = {
        method: input.method,
        headers: Object.fromEntries(input.headers),
        ...(body ? { body } : {}),
      };
    }
    calls.push({ url, init });

    for (const [pattern, handler] of routes) {
      if (url.includes(pattern)) {
        return handler(url, init);
      }
    }

    return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
  };

  return {
    fetch: fetchFn as typeof globalThis.fetch,
    /** Register a route handler. Pattern is a substring match on the URL. */
    on: (urlPattern: string, handler: RouteHandler) => {
      routes.set(urlPattern, handler);
    },
    /** Shorthand: respond with JSON and status. */
    onJson: (urlPattern: string, body: unknown, status = 200) => {
      routes.set(urlPattern, () => new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }));
    },
    /** All recorded calls. */
    calls,
    /** Clear routes and call history. */
    reset: () => { routes.clear(); calls.length = 0; },
  };
};

// ── JSON response helper ─────────────────────────────────────────────

export const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

// ── Test user fixtures ───────────────────────────────────────────────

export const TEST_USER = {
  id: "u-test-1",
  email: "test@spacefleet.test",
  emailVerified: true,
  isAdmin: false,
  plan: "free" as const,
  createdAt: "2026-01-01T00:00:00Z",
};

export const TEST_TOKEN = "test-token-abc123";

export const TEST_ADMIN_USER = {
  ...TEST_USER,
  id: "u-admin-1",
  email: "admin@spacefleet.test",
  isAdmin: true,
};
