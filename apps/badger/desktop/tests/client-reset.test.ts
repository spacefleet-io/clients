import { beforeEach, describe, expect, it, vi } from "vitest";

const acknowledgeLibraryKeyMock = vi.hoisted(() => vi.fn());
const clearLibraryKeyMock = vi.hoisted(() => vi.fn());
const getStoredLibraryKeyMock = vi.hoisted(() => vi.fn());
const getStoredLibraryKeyWordsMock = vi.hoisted(() => vi.fn());
const isLibraryKeyAcknowledgedMock = vi.hoisted(() => vi.fn());
const storeLibraryKeyMock = vi.hoisted(() => vi.fn());
const clearLocalCacheMock = vi.hoisted(() => vi.fn());
const idbResetMock = vi.hoisted(() => vi.fn());
const logged = vi.hoisted(() => [] as { level: string; fields: Record<string, unknown>; msg: unknown }[]);

vi.mock("../src/renderer/src/lib/onboarding", () => ({
  acknowledgeLibraryKey: (...args: unknown[]) => acknowledgeLibraryKeyMock(...args),
  clearLibraryKey: (...args: unknown[]) => clearLibraryKeyMock(...args),
  getStoredLibraryKey: (...args: unknown[]) => getStoredLibraryKeyMock(...args),
  getStoredLibraryKeyWords: (...args: unknown[]) => getStoredLibraryKeyWordsMock(...args),
  isLibraryKeyAcknowledged: (...args: unknown[]) => isLibraryKeyAcknowledgedMock(...args),
  storeLibraryKey: (...args: unknown[]) => storeLibraryKeyMock(...args),
}));

vi.mock("../src/renderer/src/lib/libraryDb", () => ({
  LibraryDb: {
    clearLocalCache: (...args: unknown[]) => clearLocalCacheMock(...args),
  },
}));

vi.mock("../src/renderer/src/lib/idb", () => ({
  idbReset: (...args: unknown[]) => idbResetMock(...args),
}));

vi.mock("@/logger", () => {
  const at = (level: string) => (fields: Record<string, unknown>, msg?: unknown) => {
    logged.push({ level, fields, msg });
  };
  const log = { info: at("info"), warn: at("warn"), error: at("error"), debug: at("debug") };
  return { rendererLogger: { child: () => log, ...log } };
});

import { resetClientStorage } from "../src/renderer/src/lib/clientReset";
import { LOGOUT_STEP_TIMEOUT_MS } from "../src/renderer/src/lib/logoutStep";

describe("resetClientStorage", () => {
  const localStorageMap = new Map<string, string>();

  // On assertion failure, dump every mock's call args + the localStorage map so
  // a key-preservation / clear-order regression is diagnosable from CI logs.
  const dumpClientResetSnapshot = (label: string) => {
    try {
      console.error(`=== [client-reset:${label}] snapshot ===`);
      console.error(
        `mock calls: clearLibraryKey=${JSON.stringify(clearLibraryKeyMock.mock.calls)} storeLibraryKey=${JSON.stringify(storeLibraryKeyMock.mock.calls)} acknowledgeLibraryKey=${JSON.stringify(acknowledgeLibraryKeyMock.mock.calls)}`,
      );
      console.error(
        `mock calls: getStoredLibraryKey=${JSON.stringify(getStoredLibraryKeyMock.mock.calls)} isLibraryKeyAcknowledged=${JSON.stringify(isLibraryKeyAcknowledgedMock.mock.calls)}`,
      );
      console.error(
        `mock calls: clearLocalCache=${JSON.stringify(clearLocalCacheMock.mock.calls)} idbReset=${JSON.stringify(idbResetMock.mock.calls)}`,
      );
      console.error(`localStorageMap: ${JSON.stringify([...localStorageMap.entries()], null, 2)}`);
      console.error(`=== [client-reset:${label}] end ===`);
    } catch (err) {
      console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
    }
  };

  beforeEach(() => {
    acknowledgeLibraryKeyMock.mockReset();
    clearLibraryKeyMock.mockReset();
    getStoredLibraryKeyMock.mockReset();
    isLibraryKeyAcknowledgedMock.mockReset();
    storeLibraryKeyMock.mockReset();
    getStoredLibraryKeyWordsMock.mockReset();
    getStoredLibraryKeyWordsMock.mockResolvedValue(null);
    clearLocalCacheMock.mockReset();
    idbResetMock.mockReset();
    logged.length = 0;
    vi.useRealTimers();
    localStorageMap.clear();
    storeLibraryKeyMock.mockResolvedValue(undefined);
    acknowledgeLibraryKeyMock.mockResolvedValue(undefined);
    vi.stubGlobal("window", {
      sf: { clearExternalMpvSubtitleCache: vi.fn(async () => undefined) },
      localStorage: {
        clear: vi.fn(() => localStorageMap.clear()),
        getItem: vi.fn((key: string) => localStorageMap.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => {
          localStorageMap.set(String(key), String(value));
        }),
      },
    });
  });

  it("preserves library key when requested", async () => {
    console.info("[client-reset:preserve-key] resetClientStorage({ preserveLibraryKey: true }) with stored base64-key + acknowledged=true");
    getStoredLibraryKeyMock.mockResolvedValue("base64-key");
    getStoredLibraryKeyWordsMock.mockResolvedValue(["abandon", "ability"]);
    isLibraryKeyAcknowledgedMock.mockResolvedValue(true);
    clearLocalCacheMock.mockResolvedValue(undefined);
    idbResetMock.mockResolvedValue(undefined);

    await resetClientStorage({ preserveLibraryKey: true });
    console.info(
      `[client-reset:preserve-key] post-reset: clearLibraryKey.calls=${clearLibraryKeyMock.mock.calls.length} storeLibraryKey.calls=${JSON.stringify(storeLibraryKeyMock.mock.calls)} acknowledgeLibraryKey.calls=${acknowledgeLibraryKeyMock.mock.calls.length}`,
    );

    try {
      expect(clearLibraryKeyMock).not.toHaveBeenCalled();
      expect(storeLibraryKeyMock).toHaveBeenCalledWith("base64-key", ["abandon", "ability"]);
      expect(acknowledgeLibraryKeyMock).toHaveBeenCalledTimes(1);
    } catch (err) {
      dumpClientResetSnapshot("preserve-key");
      throw err;
    }
  });

  it("clears library key when preserve flag is not set", async () => {
    console.info("[client-reset:clear-key] resetClientStorage() with no preserve flag");
    clearLocalCacheMock.mockResolvedValue(undefined);
    idbResetMock.mockResolvedValue(undefined);

    await resetClientStorage();
    console.info(
      `[client-reset:clear-key] post-reset: clearLibraryKey.calls=${clearLibraryKeyMock.mock.calls.length} storeLibraryKey.calls=${storeLibraryKeyMock.mock.calls.length}`,
    );

    try {
      expect(clearLibraryKeyMock).toHaveBeenCalledTimes(1);
      expect(storeLibraryKeyMock).not.toHaveBeenCalled();
    } catch (err) {
      dumpClientResetSnapshot("clear-key");
      throw err;
    }
  });

  it("preserves selected localStorage keys across reset", async () => {
    console.info("[client-reset:preserve-localstorage] seeding sf-api-base-url + sf_client_token, preserving only sf-api-base-url");
    clearLocalCacheMock.mockResolvedValue(undefined);
    idbResetMock.mockResolvedValue(undefined);
    localStorageMap.set("sf-api-base-url", "https://api.dev.spacebadger.io");
    localStorageMap.set("sf_client_token", "secret");

    await resetClientStorage({ preserveLocalStorageKeys: ["sf-api-base-url"] });
    console.info(
      `[client-reset:preserve-localstorage] post-reset map: sf-api-base-url=${JSON.stringify(localStorageMap.get("sf-api-base-url"))} sf_client_token=${JSON.stringify(localStorageMap.get("sf_client_token"))}`,
    );

    try {
      expect(localStorageMap.get("sf-api-base-url")).toBe("https://api.dev.spacebadger.io");
      expect(localStorageMap.get("sf_client_token")).toBeUndefined();
    } catch (err) {
      dumpClientResetSnapshot("preserve-localstorage");
      throw err;
    }
  });

  // @bugfix @regression-proof — badger-desktop 0.1.16 release smoke, run 38822: sign-out's two
  // clear-local-cache calls never answered, so nothing after them ran. A clear that never answers
  // must not keep the user's key on the computer, nor the session in localStorage.
  it("a cache clear that never answers is passed after the bound, and the key is still forgotten", async () => {
    vi.useFakeTimers();
    console.info(`[client-reset:hung-clear] LibraryDb.clearLocalCache never settles; bound ${LOGOUT_STEP_TIMEOUT_MS} ms`);
    clearLocalCacheMock.mockImplementation(() => Promise.withResolvers<undefined>().promise);
    idbResetMock.mockResolvedValue(undefined);
    localStorageMap.set("sf_client_token", "tok-1");
    let done = false;
    const run = resetClientStorage().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(LOGOUT_STEP_TIMEOUT_MS - 1);
    console.info(`[client-reset:hung-clear] just before the bound: done=${done} clearLibraryKey.calls=${clearLibraryKeyMock.mock.calls.length}`);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await run;
    console.info(
      `[client-reset:hung-clear] after the bound: done=${done} clearLibraryKey.calls=${clearLibraryKeyMock.mock.calls.length} idbReset.calls=${idbResetMock.mock.calls.length} localStorage=${JSON.stringify([...localStorageMap.entries()])} logged=${JSON.stringify(logged)}`,
    );
    try {
      expect(done).toBe(true);
      expect(clearLibraryKeyMock).toHaveBeenCalledTimes(1);
      expect(idbResetMock).toHaveBeenCalledTimes(1);
      expect(localStorageMap.has("sf_client_token")).toBe(false);
      const timedOut = logged.filter((l) => l.msg === "logout step did not finish in time; signing out without it");
      expect(timedOut.map((l) => l.fields.step)).toEqual(["LibraryDb.clearLocalCache"]);
    } catch (err) {
      dumpClientResetSnapshot("hung-clear");
      throw err;
    }
  });
});
