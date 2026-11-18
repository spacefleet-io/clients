/**
 * @test-id MOBILE-PLATFORM-001
 * @level integration
 * @why The platform bridge connects the app to AsyncStorage for API host
 *   persistence. If the bridge doesn't read/write correctly, the app can't
 *   reach the API after restart. Tests use a fake AsyncStorage to verify
 *   the full round-trip.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeAsyncStorage, createFetchMock } from "./harness";

const SUITE_ID = "mobile-platform-bridge-integration";

const fakeStorage = createFakeAsyncStorage();
const fetchMock = createFetchMock();

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: (key: string) => fakeStorage.getItem(key),
    setItem: (key: string, value: string) => fakeStorage.setItem(key, value),
    removeItem: (key: string) => fakeStorage.removeItem(key),
  },
}));
// apiConfig reads Platform.isTV and the LibrarySync store version; the real react-native entry is Flow source vitest
// cannot parse.
vi.mock("react-native", () => ({ Platform: { OS: "android", isTV: false }, NativeModules: {} }));

beforeEach(() => {
  console.info(
    `[${SUITE_ID}:setup] clearing fake AsyncStorage (previous size=${fakeStorage._backing.size}) and resetting fetchMock`,
  );
  fakeStorage._backing.clear();
  fetchMock.reset();
  vi.stubGlobal("fetch", fetchMock.fetch);
});

afterEach(() => {
  console.info(
    `[${SUITE_ID}:teardown] storage size=${fakeStorage._backing.size} fetch calls=${fetchMock.calls.length}`,
  );
  vi.unstubAllGlobals();
  vi.resetModules();
});

/**
 * State dumper: snapshot of fake AsyncStorage backing, recorded fetch calls, and any extra
 * call ctx the test supplies. Wrapped in try/catch so it can never mask the real assertion.
 */
const dumpBridgeSnapshot = (
  label: string,
  ctx: { key?: string; expected?: unknown; actual?: unknown } = {},
) => {
  try {
    const storageDump = Object.fromEntries(fakeStorage._backing.entries());
    const fetchCalls = fetchMock.calls.map((c, idx) => ({
      idx,
      url: c.url,
      method: c.init?.method ?? "GET",
    }));
    console.error(`=== [${SUITE_ID}:${label}] snapshot ===`);
    console.error(`ctx: ${JSON.stringify(ctx, null, 2)}`);
    console.error(
      `AsyncStorage backing (size=${fakeStorage._backing.size}):\n${JSON.stringify(storageDump, null, 2)}`,
    );
    console.error(
      `fetch calls (count=${fetchMock.calls.length}):\n${JSON.stringify(fetchCalls, null, 2)}`,
    );
  } catch (err) {
    console.error(
      `(${SUITE_ID}:${label} snapshot failed: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
};

describe("platform bridge — apiConfig", () => {
  it("getStoredApiHost returns null when no host stored", async () => {
    console.info(`[${SUITE_ID}:get-null] importing apiConfig with empty backing`);
    const { getStoredApiHost } = await import("../src/lib/apiConfig");
    const result = await getStoredApiHost();
    console.info(`[${SUITE_ID}:get-null] getStoredApiHost returned=${String(result)}`);
    try {
      expect(result).toBeNull();
    } catch (err) {
      dumpBridgeSnapshot("get-null", { expected: null, actual: result });
      throw err;
    }
  });

  it("setStoredApiHost persists and can be read back", async () => {
    console.info(`[${SUITE_ID}:set-and-get] importing apiConfig`);
    const { setStoredApiHost, getStoredApiHost } = await import("../src/lib/apiConfig");
    console.info(`[${SUITE_ID}:set-and-get] writing host=https://custom.api.test`);
    await setStoredApiHost("https://custom.api.test");

    const result = await getStoredApiHost();
    console.info(`[${SUITE_ID}:set-and-get] read back host=${String(result)}`);
    try {
      expect(result).toBe("https://custom.api.test");
    } catch (err) {
      dumpBridgeSnapshot("set-and-get", {
        expected: "https://custom.api.test",
        actual: result,
      });
      throw err;
    }
  });

  it("setStoredApiHost trims trailing slashes", async () => {
    console.info(`[${SUITE_ID}:trim-slashes] importing apiConfig`);
    const { setStoredApiHost, getStoredApiHost } = await import("../src/lib/apiConfig");
    console.info(`[${SUITE_ID}:trim-slashes] writing host with trailing slashes`);
    await setStoredApiHost("https://custom.api.test///");

    const result = await getStoredApiHost();
    console.info(`[${SUITE_ID}:trim-slashes] read back host=${String(result)}`);
    try {
      expect(result).toBe("https://custom.api.test");
    } catch (err) {
      dumpBridgeSnapshot("trim-slashes", {
        expected: "https://custom.api.test",
        actual: result,
      });
      throw err;
    }
  });

  it("initApiConfig loads stored host on startup", async () => {
    console.info(`[${SUITE_ID}:init-load] seeding backing with sf_api_host=https://stored.test`);
    fakeStorage._backing.set("sf_api_host", "https://stored.test");

    const { initApiConfig, getStoredApiHost } = await import("../src/lib/apiConfig");
    console.info(`[${SUITE_ID}:init-load] invoking initApiConfig`);
    await initApiConfig();

    const result = await getStoredApiHost();
    console.info(`[${SUITE_ID}:init-load] post-init getStoredApiHost=${String(result)}`);
    try {
      expect(result).toBe("https://stored.test");
    } catch (err) {
      dumpBridgeSnapshot("init-load", {
        key: "sf_api_host",
        expected: "https://stored.test",
        actual: result,
      });
      throw err;
    }
  });
});
