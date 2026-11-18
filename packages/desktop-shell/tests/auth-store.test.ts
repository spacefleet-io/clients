import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserAuthSessionStore } from "../src/services/auth";

type AuthSessionStore = ReturnType<typeof createBrowserAuthSessionStore>;

const dumpAuthStoreSnapshot = (label: string, ctx: { storageKey?: string; store?: AuthSessionStore }) => {
  try {
    const rawLocal: Record<string, string> = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k !== null) rawLocal[k] = localStorage.getItem(k) ?? "";
      }
    } catch (innerErr) {
      console.error(`(localStorage iteration failed: ${innerErr instanceof Error ? innerErr.message : String(innerErr)})`);
    }
    const current = ctx.store ? ctx.store.read() : "(no store handle)";
    console.error(`=== [auth-store:${label}] snapshot ===`);
    console.error(`storageKey=${ctx.storageKey ?? "(unknown)"}`);
    console.error(`store.read()=${JSON.stringify(current, null, 2)}`);
    console.error(`localStorage contents=${JSON.stringify(rawLocal, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("browser auth session store", () => {
  console.info("[auth-store:suite] starting browser auth session store tests");

  beforeEach(() => {
    console.info("[auth-store:setup] stubbing in-memory localStorage");
    const backing = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => {
        backing.set(key, value);
      },
      removeItem: (key: string) => {
        backing.delete(key);
      },
      clear: () => backing.clear(),
      get length() {
        return backing.size;
      },
      key: (index: number) => Array.from(backing.keys())[index] ?? null,
    });
    // length + key added solely so dump-helpers can iterate localStorage on failure;
    // production reads/writes use only get/setItem so behavior is unchanged.
  });

  afterEach(() => {
    console.info("[auth-store:teardown] unstubbing globals");
    vi.unstubAllGlobals();
  });

  it("writes and reads valid session values", () => {
    const key = `test-auth-store-${Math.random().toString(16).slice(2)}`;
    console.info(`[auth-store:test] creating store with key=${key}`);
    const store = createBrowserAuthSessionStore({ key });

    const payload = {
      token: "token-1",
      user: { id: "u1", email: "u1@example.com", emailVerified: true },
    };
    console.info(`[auth-store:test] writing payload=${JSON.stringify(payload)}`);
    store.write(payload);

    const after = store.read();
    console.info(`[auth-store:test] read after write=${JSON.stringify(after)}`);

    try {
      expect(after).toMatchObject({
        token: "token-1",
        user: { id: "u1", email: "u1@example.com", emailVerified: true },
      });
    } catch (err) {
      dumpAuthStoreSnapshot("write-read-fail", { storageKey: key, store });
      throw err;
    }

    console.info("[auth-store:test] clearing session via write(null)");
    store.write(null);
    const afterClear = store.read();
    console.info(`[auth-store:test] read after clear=${JSON.stringify(afterClear)}`);

    try {
      expect(afterClear).toBeNull();
    } catch (err) {
      dumpAuthStoreSnapshot("clear-fail", { storageKey: key, store });
      throw err;
    }
  });

  it("returns null for malformed JSON payload", () => {
    const key = `test-auth-store-malformed-${Math.random().toString(16).slice(2)}`;
    console.info(`[auth-store:test] seeding malformed JSON at key=${key}`);
    localStorage.setItem(key, "{not-json");
    const store = createBrowserAuthSessionStore({ key });
    const result = store.read();
    console.info(`[auth-store:test] read of malformed payload=${JSON.stringify(result)}`);
    try {
      expect(result).toBeNull();
    } catch (err) {
      dumpAuthStoreSnapshot("malformed-read-fail", { storageKey: key, store });
      throw err;
    }
  });
});
