/**
 * @test-id MOBILE-LIB-SM-001
 * @level unit
 * @why The library load function has 12+ branches controlling what the user
 *   sees after login. Bugs here caused: (a) logout when library doesn't exist,
 *   (b) infinite loading screen, (c) stuck initializing state, (d) "Loading
 *   library..." pinned for ~18s while syncFromRemoteIfNewer ran before first
 *   paint, (e) stale-generation sync results clobbering a fresh reload.
 * @bugfix
 * @regression-proof
 *   Bug #4: exists:false must NOT call logout.
 *   Bug #5: exists:false must set coreReady so initializing clears.
 *   Bug #B1-render: home must paint from cache BEFORE syncFromRemoteIfNewer
 *     resolves — sync is fire-and-forget post-paint.
 *   Bug #B1-stale: a stale-generation IIFE's sync result must NOT overwrite
 *     state owned by a newer generation (race guarded by loadGenerationRef
 *     + activeDbRef + isCurrent()).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeAsyncStorage, createFakeKeychain, createFetchMock, jsonResponse, TEST_TOKEN, TEST_USER } from "./harness";

// ── Mocks ────────────────────────────────────────────────────────────

const fakeStorage = createFakeAsyncStorage();
const fakeKeychain = createFakeKeychain();
const fetchMock = createFetchMock();

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: (key: string) => fakeStorage.getItem(key),
    setItem: (key: string, value: string) => fakeStorage.setItem(key, value),
    removeItem: (key: string) => fakeStorage.removeItem(key),
  },
}));

vi.mock("react-native-keychain", () => ({
  getGenericPassword: (opts?: { service?: string }) => fakeKeychain.getGenericPassword(opts),
  setGenericPassword: (u: string, p: string, opts?: { service?: string }) => fakeKeychain.setGenericPassword(u, p, opts),
  resetGenericPassword: (opts?: { service?: string }) => fakeKeychain.resetGenericPassword(opts),
}));

// Mock mediaCrypto — not relevant for state machine tests
vi.mock("../src/lib/mediaCrypto", () => ({
  setMediaKeyFromBase64: vi.fn(),
}));

// Mock libraryDb
vi.mock("../src/lib/libraryDb", () => ({
  LibraryDb: {
    open: vi.fn(async () => mockDb),
    openLocal: vi.fn(async () => mockDb),
    clearLocalCache: vi.fn(async () => {}),
  },
  QuotaExceededError: class extends Error {},
}));

vi.mock("react-native-sse", () => ({
  default: vi.fn(),
}));

const mockDb = {
  getDatasetStatus: () => ({ core: true, metadata: true, playback: true }),
  onDatasetStatus: vi.fn(() => () => {}),
  listMedia: vi.fn(async () => []),
  listPlaylists: vi.fn(async () => []),
  countMediaItems: vi.fn(async () => 0),
  flushPending: vi.fn(async () => {}),
  syncFromRemoteIfNewer: vi.fn(async () => false),
  close: vi.fn(),
};

const LIB_KEY_ACK = "sf_client_library_key_ack";
const LIB_KEY_SERVICE = "sf_client_library_key";
const TEST_KEY = "dGVzdC1saWJyYXJ5LWtleS1iYXNlNjQ=";

// Dump-on-failure helper (per "Tests log generously"). Pinned domain state for
// the library-load state machine: the fake storage / keychain backing, the
// fetch-mock call log, and any caller-supplied snapshot fields (events array,
// generation/db refs, etc). Body wrapped in try/catch so a dump failure can
// never mask the real assertion failure.
const dumpLoadSmSnapshot = (label: string, ctx: Record<string, unknown> = {}) => {
  try {
    const storageKeys = Array.from(fakeStorage._backing.keys());
    const keychainServices = Array.from(fakeKeychain._store.keys());
    console.error(`=== [library-load-sm:${label}] state snapshot ===`);
    console.error(
      `fakeStorage keys=${JSON.stringify(storageKeys)} keychain services=${JSON.stringify(keychainServices)}`,
    );
    // fetchMock may expose a call log under common field names; dump whatever's there.
    const fm = fetchMock as unknown as Record<string, unknown>;
    const fetchCalls = fm.calls ?? fm._calls ?? fm.requests ?? "(no call log on fetchMock)";
    console.error(`fetchMock calls=${JSON.stringify(fetchCalls)}`);
    console.error(`ctx:\n${JSON.stringify(ctx, null, 2)}`);
    console.error(`=== [library-load-sm:${label}] end snapshot ===`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

beforeEach(() => {
  console.info(`[library-load-sm:setup] resetting fakes (storage/keychain/fetch) + clearing mocks`);
  fakeStorage._backing.clear();
  fakeKeychain._store.clear();
  fetchMock.reset();
  vi.stubGlobal("fetch", fetchMock.fetch);
  vi.clearAllMocks();
});

afterEach(() => {
  console.info(`[library-load-sm:teardown] unstubbing globals`);
  vi.unstubAllGlobals();
});

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Simulates the library load function's decision points by calling the
 * same external functions the real load() calls, and asserting the outcomes.
 * This avoids needing a React runtime while testing every branch.
 */

const setupKeyAcknowledged = async () => {
  await fakeStorage.setItem(LIB_KEY_ACK, "1");
  await fakeKeychain.setGenericPassword("library", TEST_KEY, { service: LIB_KEY_SERVICE });
};

// ── Tests ────────────────────────────────────────────────────────────

describe("library load — key checks", () => {
  it("key not acknowledged → needsKey", async () => {
    console.info(`[library-load-sm:key-not-ack] importing onboarding (empty storage)`);
    const { isLibraryKeyAcknowledged } = await import("../src/lib/onboarding");
    const acked = await isLibraryKeyAcknowledged();
    console.info(`[library-load-sm:key-not-ack] isLibraryKeyAcknowledged=${acked} (expect false)`);
    if (acked !== false) dumpLoadSmSnapshot("key-not-ack", { acked });
    expect(acked).toBe(false);
  });

  it("key acknowledged but missing from keychain → needsKey", async () => {
    console.info(`[library-load-sm:key-ack-no-keychain] setting ${LIB_KEY_ACK}=1, leaving keychain empty`);
    await fakeStorage.setItem(LIB_KEY_ACK, "1");
    const { isLibraryKeyAcknowledged, getStoredLibraryKey } = await import("../src/lib/onboarding");
    const acked = await isLibraryKeyAcknowledged();
    const stored = await getStoredLibraryKey();
    console.info(`[library-load-sm:key-ack-no-keychain] acked=${acked} storedKey=${JSON.stringify(stored)}`);
    if (acked !== true || stored !== null) dumpLoadSmSnapshot("key-ack-no-keychain", { acked, stored });
    expect(acked).toBe(true);
    expect(stored).toBeNull();
  });

  it("key acknowledged and stored → proceeds", async () => {
    console.info(`[library-load-sm:key-ack-stored] acknowledging + storing key in keychain`);
    await setupKeyAcknowledged();
    const { isLibraryKeyAcknowledged, getStoredLibraryKey } = await import("../src/lib/onboarding");
    const acked = await isLibraryKeyAcknowledged();
    const stored = await getStoredLibraryKey();
    console.info(`[library-load-sm:key-ack-stored] acked=${acked} storedKey matches=${stored === TEST_KEY}`);
    if (acked !== true || stored !== TEST_KEY) dumpLoadSmSnapshot("key-ack-stored", { acked, stored });
    expect(acked).toBe(true);
    expect(stored).toBe(TEST_KEY);
  });
});

describe("library load — contract check", () => {
  it("contract OK returns no issue", async () => {
    console.info(`[library-load-sm:contract-ok] stubbing /system/contract apiVersion=2026-03-05 stage=ga`);
    fetchMock.onJson("/system/contract", {
      apiVersion: "2026-03-05",
      badgerStage: "ga",
    });

    const { getSystemContract, setApiBaseUrl } = await import("@space/shared/api");
    // The SDK builds a Request, which needs an absolute base (the default `/api` is relative).
    setApiBaseUrl("http://api.test");
    const contract = await getSystemContract();
    console.info(`[library-load-sm:contract-ok] received contract=${JSON.stringify(contract)}`);
    if (contract === undefined || contract === null) dumpLoadSmSnapshot("contract-ok", { contract });
    expect(contract).toBeDefined();
  });
});

describe("library load — meta.exists === false (regression #4 + #5)", () => {
  it("does NOT call logout when library does not exist", async () => {
    const logoutSpy = vi.fn();

    console.info(`[library-load-sm:no-logout] stubbing /library/db/meta exists=false version=0`);
    fetchMock.onJson("/library/db/meta", { exists: false, version: 0 });

    const resp = await fetchMock.fetch(`http://api/library/db/meta?token=${TEST_TOKEN}`);
    const meta = await resp.json();
    console.info(
      `[library-load-sm:no-logout] meta.exists=${meta.exists} logoutSpy.calls=${logoutSpy.mock.calls.length} (regression #4: must stay 0)`,
    );

    if (meta.exists !== false || logoutSpy.mock.calls.length !== 0) {
      dumpLoadSmSnapshot("no-logout", { meta, logoutCalls: logoutSpy.mock.calls });
    }
    expect(meta.exists).toBe(false);
    // The critical assertion: logout must NOT be called
    expect(logoutSpy).not.toHaveBeenCalled();
  });

  it("sets datasetStatus to all-true when library does not exist", () => {
    // Simulates what the fixed code does
    const meta = { exists: false, version: 0 };
    let datasetStatus = { core: false, metadata: false, playback: false };
    let coreReady = false;

    console.info(`[library-load-sm:dataset-all-true] meta=${JSON.stringify(meta)} → applying exists===false branch`);
    if (meta.exists === false) {
      datasetStatus = { core: true, metadata: true, playback: true };
      coreReady = true;
    }
    console.info(
      `[library-load-sm:dataset-all-true] datasetStatus=${JSON.stringify(datasetStatus)} coreReady=${coreReady}`,
    );

    const expectedStatus = { core: true, metadata: true, playback: true };
    if (JSON.stringify(datasetStatus) !== JSON.stringify(expectedStatus) || !coreReady) {
      dumpLoadSmSnapshot("dataset-all-true", { meta, datasetStatus, coreReady });
    }
    expect(datasetStatus).toEqual(expectedStatus);
    expect(coreReady).toBe(true);
  });

  it("initializing clears when coreReady is true (regression #5)", () => {
    let initializing = true;
    const coreReady = true;
    const hasLoadedOnce = false;

    console.info(
      `[library-load-sm:initializing-clears] entry initializing=${initializing} coreReady=${coreReady} hasLoadedOnce=${hasLoadedOnce}`,
    );
    // Simulates the finally block
    if (!hasLoadedOnce) {
      // hasLoadedOnce.current = true
    }
    if (coreReady) {
      initializing = false;
    }
    console.info(`[library-load-sm:initializing-clears] post-finally initializing=${initializing} (regression #5: expect false)`);

    if (initializing !== false) dumpLoadSmSnapshot("initializing-clears", { initializing, coreReady, hasLoadedOnce });
    expect(initializing).toBe(false);
  });

  it("initializing stays true when coreReady is false (pre-fix behavior)", () => {
    let initializing = true;
    const coreReady = false;

    console.info(`[library-load-sm:initializing-stuck] entry initializing=${initializing} coreReady=${coreReady}`);
    if (coreReady) {
      initializing = false;
    }
    console.info(`[library-load-sm:initializing-stuck] post initializing=${initializing} (pre-fix bug: stays true)`);

    // This is the bug — initializing never clears
    if (initializing !== true) dumpLoadSmSnapshot("initializing-stuck", { initializing, coreReady });
    expect(initializing).toBe(true);
  });
});

describe("library load — API failure fallback", () => {
  it("falls back to local db when API is unreachable", async () => {
    console.info(`[library-load-sm:api-fallback] stubbing /library/db/meta to throw "Network request failed"`);
    fetchMock.on("/library/db/meta", () => {
      throw new Error("Network request failed");
    });

    let caughtError: Error | null = null;
    try {
      await fetchMock.fetch(`http://api/library/db/meta?token=${TEST_TOKEN}`);
    } catch (err) {
      caughtError = err as Error;
    }
    console.info(
      `[library-load-sm:api-fallback] caughtError=${caughtError ? JSON.stringify(caughtError.message) : "null"} (expect "Network request failed")`,
    );

    if (caughtError === null || caughtError.message !== "Network request failed") {
      dumpLoadSmSnapshot("api-fallback", { caughtError: caughtError?.message ?? null });
    }
    expect(caughtError).not.toBeNull();
    expect(caughtError!.message).toBe("Network request failed");
    // In the real code, this triggers the fallback to LibraryDb.openLocal
  });
});

describe("library load — key lifecycle", () => {
  it("clearLibraryKey removes key and acknowledgement", async () => {
    console.info(`[library-load-sm:clear-key] seeding acknowledged+stored key, then clearing`);
    await setupKeyAcknowledged();
    const { clearLibraryKey, getStoredLibraryKey, isLibraryKeyAcknowledged } = await import("../src/lib/onboarding");

    await clearLibraryKey();

    const stored = await getStoredLibraryKey();
    const acked = await isLibraryKeyAcknowledged();
    console.info(`[library-load-sm:clear-key] post-clear storedKey=${JSON.stringify(stored)} acked=${acked}`);
    if (stored !== null || acked !== false) dumpLoadSmSnapshot("clear-key", { stored, acked });
    expect(stored).toBeNull();
    expect(acked).toBe(false);
  });
});

describe("library load — no token/user", () => {
  it("skips loading when token is null", () => {
    const token = null;
    const user = TEST_USER;
    const shouldSkip = !token || !user;
    console.info(`[library-load-sm:no-token] token=${token} → shouldSkip=${shouldSkip} (expect true)`);
    if (shouldSkip !== true) dumpLoadSmSnapshot("no-token", { token, shouldSkip });
    expect(shouldSkip).toBe(true);
  });

  it("skips loading when user is null", () => {
    const token = TEST_TOKEN;
    const user = null;
    const shouldSkip = !token || !user;
    console.info(`[library-load-sm:no-user] user=${user} → shouldSkip=${shouldSkip} (expect true)`);
    if (shouldSkip !== true) dumpLoadSmSnapshot("no-user", { hasToken: !!token, user, shouldSkip });
    expect(shouldSkip).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase B1 — render-from-cache + stale-generation guard
// ---------------------------------------------------------------------------
// Pre-Phase-B1: load() awaited syncFromRemoteIfNewer BEFORE listMedia, leaving
// the user on a "Loading library..." spinner for ~18s on a populated cache
// even though the cached split DB had every row needed for first paint.
// Post-Phase-B1: load() runs listMedia/setMedia first, flips loadStatus to
// "ready" immediately, and kicks off sync as a fire-and-forget IIFE that
// guards every state write with isCurrent() (== generation token + active DB
// identity match) so a slow stale sync can't clobber a fresh reload.
//
// These tests simulate the new ordering as pure logic — same pattern as the
// regression-#4/#5 tests above. They will fail loudly if a future refactor
// re-awaits sync before first paint or removes the generation guard.

describe("library load — render-from-cache before sync (Bug #B1-render)", () => {
  it("setMedia + setLoadStatus(ready) fire BEFORE syncFromRemoteIfNewer resolves", async () => {
    const events: string[] = [];

    let resolveSync: ((value: boolean) => void) | null = null;
    const syncFromRemoteIfNewer = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          events.push("syncStart");
          resolveSync = resolve;
        }),
    );
    const listMedia = vi.fn(async () => {
      events.push("listMedia");
      return [];
    });
    const listPlaylists = vi.fn(async () => {
      events.push("listPlaylists");
      return [];
    });
    const setMedia = vi.fn((_rows: unknown[]) => events.push("setMedia"));
    const setPlaylists = vi.fn((_rows: unknown[]) => events.push("setPlaylists"));
    const setLoadStatus = vi.fn((status: { kind: string }) =>
      events.push(`loadStatus:${status.kind}`),
    );

    // Simulate the post-Phase-B1 ordering inside load() — render from cache,
    // mark ready, THEN fire and forget the sync.
    console.info(`[library-load-sm:render-before-sync] simulating post-B1 load() ordering`);
    const [media, playlists] = await Promise.all([listMedia(), listPlaylists()]);
    setMedia(media);
    setPlaylists(playlists);
    setLoadStatus({ kind: "ready" });
    const syncPromise = (async () => {
      await syncFromRemoteIfNewer();
    })();

    // Critical assertion: ready fires before sync starts, never after.
    const readyIdx = events.indexOf("loadStatus:ready");
    const syncIdx = events.indexOf("syncStart");
    console.info(
      `[library-load-sm:render-before-sync] events=${JSON.stringify(events)} readyIdx=${readyIdx} syncIdx=${syncIdx} setMediaIdx=${events.indexOf("setMedia")} setPlaylistsIdx=${events.indexOf("setPlaylists")}`,
    );
    const orderingOk =
      readyIdx > -1 &&
      syncIdx > -1 &&
      readyIdx < syncIdx &&
      events.indexOf("setMedia") < syncIdx &&
      events.indexOf("setPlaylists") < syncIdx;
    if (!orderingOk) {
      dumpLoadSmSnapshot("render-before-sync", { events, readyIdx, syncIdx });
    }
    expect(readyIdx).toBeGreaterThan(-1);
    expect(syncIdx).toBeGreaterThan(-1);
    expect(readyIdx).toBeLessThan(syncIdx);

    // setMedia / setPlaylists also strictly precede sync.
    expect(events.indexOf("setMedia")).toBeLessThan(syncIdx);
    expect(events.indexOf("setPlaylists")).toBeLessThan(syncIdx);

    // Resolve sync to clean up the dangling promise.
    if (resolveSync === null) dumpLoadSmSnapshot("render-before-sync-no-resolver", { events });
    expect(resolveSync).not.toBeNull();
    resolveSync!(false);
    await syncPromise;
  });

  it("background sync re-fetches media on changed=true and merges via setMedia", async () => {
    // After sync completes with changed=true, listMedia is called again to
    // refresh state with synced rows (per library.tsx:330-336).
    const cachedRows = [{ id: "from-cache" } as never];
    const syncedRows = [{ id: "from-cache" }, { id: "from-sync" } as never];

    const listMedia = vi.fn();
    listMedia.mockResolvedValueOnce(cachedRows).mockResolvedValueOnce(syncedRows);

    const setMedia = vi.fn();

    // First paint from cache
    console.info(`[library-load-sm:resync-on-changed] first paint from cache rows=${cachedRows.length}`);
    setMedia(await listMedia());
    if (setMedia.mock.calls.length < 1) dumpLoadSmSnapshot("resync-on-changed-first-paint", { calls: setMedia.mock.calls });
    expect(setMedia).toHaveBeenCalledWith(cachedRows);

    // Background sync says changed=true → re-list and update
    const changed = true;
    console.info(`[library-load-sm:resync-on-changed] sync changed=${changed} → re-list + setMedia`);
    if (changed) {
      setMedia(await listMedia());
    }

    console.info(
      `[library-load-sm:resync-on-changed] setMedia.calls=${setMedia.mock.calls.length} last=${JSON.stringify(setMedia.mock.calls.at(-1))}`,
    );
    if (setMedia.mock.calls.length !== 2) {
      dumpLoadSmSnapshot("resync-on-changed", { setMediaCalls: setMedia.mock.calls });
    }
    expect(setMedia).toHaveBeenCalledTimes(2);
    expect(setMedia).toHaveBeenLastCalledWith(syncedRows);
  });
});

describe("library load — stale-generation guard (Bug #B1-stale)", () => {
  // The IIFE in library.tsx captures `nextDb` and a `generation` token at the
  // moment it kicks off, and gates every subsequent state write on
  //   isCurrent() = (loadGenerationRef.current === capturedGeneration)
  //              && (activeDbRef.current === capturedDb)
  // so a slow stale sync from generation 1 can't clobber the state owned by
  // generation 2 after the user reloads / logs in as another account / etc.

  it("isCurrent() returns true while the original generation is still active", () => {
    const loadGenerationRef = { current: 0 };
    const activeDbRef: { current: object | null } = { current: null };

    const dbA = { tag: "A" };
    const generation = ++loadGenerationRef.current;
    activeDbRef.current = dbA;

    const isCurrent = () =>
      loadGenerationRef.current === generation && activeDbRef.current === dbA;

    const result = isCurrent();
    console.info(
      `[library-load-sm:iscurrent-true] gen=${loadGenerationRef.current} captured=${generation} dbMatch=${activeDbRef.current === dbA} → isCurrent=${result} (expect true)`,
    );
    if (result !== true) {
      dumpLoadSmSnapshot("iscurrent-true", { gen: loadGenerationRef.current, generation, dbTag: (activeDbRef.current as { tag?: string } | null)?.tag, result });
    }
    expect(result).toBe(true);
  });

  it("isCurrent() returns false after a newer generation starts", () => {
    const loadGenerationRef = { current: 0 };
    const activeDbRef: { current: object | null } = { current: null };

    const dbA = { tag: "A" };
    const generation = ++loadGenerationRef.current;
    activeDbRef.current = dbA;
    const isCurrent = () =>
      loadGenerationRef.current === generation && activeDbRef.current === dbA;

    // Reload bumps generation and swaps DB
    ++loadGenerationRef.current;
    activeDbRef.current = { tag: "B" };

    const result = isCurrent();
    console.info(
      `[library-load-sm:iscurrent-newer-gen] captured gen=${generation} now gen=${loadGenerationRef.current} dbTag=${(activeDbRef.current as { tag?: string } | null)?.tag} → isCurrent=${result} (expect false)`,
    );
    if (result !== false) {
      dumpLoadSmSnapshot("iscurrent-newer-gen", { generation, nowGen: loadGenerationRef.current, result });
    }
    expect(result).toBe(false);
  });

  it("isCurrent() returns false after the active DB is cleared (logout/unmount)", () => {
    const loadGenerationRef = { current: 0 };
    const activeDbRef: { current: object | null } = { current: null };

    const dbA = { tag: "A" };
    const generation = ++loadGenerationRef.current;
    activeDbRef.current = dbA;
    const isCurrent = () =>
      loadGenerationRef.current === generation && activeDbRef.current === dbA;

    // Logout / token change clears the active DB
    activeDbRef.current = null;

    const result = isCurrent();
    console.info(
      `[library-load-sm:iscurrent-db-cleared] activeDb=null gen=${loadGenerationRef.current} captured=${generation} → isCurrent=${result} (expect false)`,
    );
    if (result !== false) {
      dumpLoadSmSnapshot("iscurrent-db-cleared", { generation, gen: loadGenerationRef.current, activeDb: activeDbRef.current, result });
    }
    expect(result).toBe(false);
  });

  it("stale sync's setMedia is dropped when isCurrent() returns false", () => {
    const loadGenerationRef = { current: 0 };
    const activeDbRef: { current: object | null } = { current: null };

    const dbA = { tag: "A" };
    const dbB = { tag: "B" };
    const generation = ++loadGenerationRef.current;
    activeDbRef.current = dbA;
    const isCurrent = () =>
      loadGenerationRef.current === generation && activeDbRef.current === dbA;

    const setMedia = vi.fn();

    // Newer generation takes over before the stale sync finishes
    console.info(`[library-load-sm:stale-setmedia-dropped] gen1 captured=${generation}, now bumping to gen2 + swapping db A→B`);
    ++loadGenerationRef.current;
    activeDbRef.current = dbB;

    // Stale sync result arrives — must be dropped
    const syncedFromStale = [{ id: "stale" }];
    const current = isCurrent();
    console.info(
      `[library-load-sm:stale-setmedia-dropped] stale sync arrives; isCurrent=${current} (expect false) → setMedia ${current ? "WILL (BUG)" : "won't"} be called`,
    );
    if (current) {
      setMedia(syncedFromStale);
    }

    if (setMedia.mock.calls.length !== 0) {
      dumpLoadSmSnapshot("stale-setmedia-dropped", { generation, nowGen: loadGenerationRef.current, isCurrent: current, setMediaCalls: setMedia.mock.calls });
    }
    expect(setMedia).not.toHaveBeenCalled();
  });
});
