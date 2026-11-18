import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserRuntimeSessionStore } from "../src/services/runtime";

type RuntimeSession = {
  apiBaseUrl: string;
  runtimeBaseUrl: string;
  runtimeToken: string;
  backendToken: string;
};

const dumpRuntimeStoreSnapshot = (
  label: string,
  ctx: { storageKey?: string; storeRead?: RuntimeSession | null }
) => {
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
    console.error(`=== [runtime-store:${label}] snapshot ===`);
    console.error(`storageKey=${ctx.storageKey ?? "(unknown)"}`);
    console.error(`store.read()=${JSON.stringify(ctx.storeRead, null, 2)}`);
    console.error(`localStorage contents=${JSON.stringify(rawLocal, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("browser runtime session store", () => {
  console.info("[runtime-store:suite] starting browser runtime session store tests");

  beforeEach(() => {
    console.info("[runtime-store:setup] stubbing in-memory localStorage");
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
    console.info("[runtime-store:teardown] unstubbing globals");
    vi.unstubAllGlobals();
  });

  it("reads and writes validated runtime sessions", () => {
    const storageKey = "parrot.runtime.session";
    console.info(`[runtime-store:test] creating store with key=${storageKey}`);
    const store = createBrowserRuntimeSessionStore<RuntimeSession>({
      key: storageKey,
      validate: (value): value is RuntimeSession => {
        const input = value as Record<string, unknown>;
        return (
          typeof input?.apiBaseUrl === "string" &&
          typeof input?.runtimeBaseUrl === "string" &&
          typeof input?.runtimeToken === "string" &&
          typeof input?.backendToken === "string"
        );
      },
    });

    const payload: RuntimeSession = {
      apiBaseUrl: "https://api.spacebadger.io",
      runtimeBaseUrl: "http://127.0.0.1:3020",
      runtimeToken: "runtime",
      backendToken: "backend",
    };
    console.info(`[runtime-store:test] writing payload=${JSON.stringify(payload)}`);
    store.write(payload);

    const after = store.read();
    console.info(`[runtime-store:test] read after write=${JSON.stringify(after)}`);

    try {
      expect(after).toMatchObject({
        apiBaseUrl: "https://api.spacebadger.io",
        runtimeToken: "runtime",
      });
    } catch (err) {
      dumpRuntimeStoreSnapshot("write-read-fail", { storageKey, storeRead: after });
      throw err;
    }
  });
});
