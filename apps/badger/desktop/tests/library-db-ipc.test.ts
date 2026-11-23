import { beforeEach, describe, expect, it, vi } from "vitest";

const openMock = vi.hoisted(() => vi.fn());
const openLocalMock = vi.hoisted(() => vi.fn());
const sealLocalCacheForRotationMock = vi.hoisted(() => vi.fn());
const hasLocalCacheMock = vi.hoisted(() => vi.fn());
const clearLocalCacheMock = vi.hoisted(() => vi.fn());
const loggerInfoMock = vi.hoisted(() => vi.fn());
const loggerWarnMock = vi.hoisted(() => vi.fn());
const loggerErrorMock = vi.hoisted(() => vi.fn());
const fetchMock = vi.hoisted(() => vi.fn());
/** What `LibraryDb.sealLocalCacheForRotation` answers (PRIV-KEY-13). */
const SEALED = {
  manifestBase64: "bWFuaWZlc3Q=",
  snapshotId: "own-1",
  chunkSize: 4194304,
  chunkRefs: ["c0ffee01"],
  chunkRefsSource: { client: "desktop-runtime", refsVersion: 1 },
  storageFormatVersion: 2,
  opStreamVersion: 3,
};

vi.mock("@space/library-db-runtime", () => ({
  LibraryDb: {
    open: (...args: unknown[]) => openMock(...args),
    openLocal: (...args: unknown[]) => openLocalMock(...args),
    sealLocalCacheForRotation: (...args: unknown[]) => sealLocalCacheForRotationMock(...args),
    hasLocalCache: (...args: unknown[]) => hasLocalCacheMock(...args),
    clearLocalCache: (...args: unknown[]) => clearLocalCacheMock(...args),
  },
}));

vi.mock("../src/main/logger", () => ({
  scopeLogger: () => ({
    info: (...args: unknown[]) => loggerInfoMock(...args),
    warn: (...args: unknown[]) => loggerWarnMock(...args),
    error: (...args: unknown[]) => loggerErrorMock(...args),
  }),
}));

vi.stubGlobal("fetch", fetchMock);
// The SDK calls fetch with one Request; the runtime clients pass a URL string.
const fetchedUrl = (input: unknown) => (input instanceof Request ? input.url : String(input));

import { registerLibraryDbIpc, resetLibraryDbIpcForTests } from "../src/main/libraryDbIpc";
import { BETTER_SQLITE_NATIVE_LOAD_GUIDANCE } from "../src/main/nativeDeps";
import { getActivePlaybackProfileId } from "../src/main/activePlaybackProfile";

// =========================================================================
// Diagnostic logging helpers — per "Tests log generously" rule.
// =========================================================================

const SUITE = "library-db-ipc";

// LIB-STORE-06: the library opens only for a signed-in account, so every open carries one.
const USER_ID = "user-1";
const jsonReplacer = (_key: string, value: unknown) => {
  if (value instanceof Uint8Array) {
    return `<Uint8Array bytes=${value.byteLength}>`;
  }
  if (value instanceof Buffer) {
    return `<Buffer bytes=${value.byteLength}>`;
  }
  return value;
};

const dumpLibraryDbIpcSnapshot = (
  label: string,
  ctx: {
    channel?: string;
    method?: string;
    payload?: unknown;
    args?: unknown;
    result?: unknown;
    expected?: unknown;
    actual?: unknown;
    handlers?: string[];
    openMockCalls?: unknown;
    openLocalMockCalls?: unknown;
    sealLocalCacheForRotationCalls?: unknown;
    hasLocalCacheCalls?: unknown;
    clearLocalCacheCalls?: unknown;
    fetchMockCalls?: unknown;
    fetchUrls?: string[];
    loggerInfoCalls?: unknown;
    loggerWarnCalls?: unknown;
    loggerErrorCalls?: unknown;
    sendCalls?: unknown;
    nativeMismatch?: boolean;
    recoverResult?: boolean;
    runtimeCommandBodies?: unknown;
    runtimeCommandCount?: number;
    contractFetchCount?: number;
    loginFetchCount?: number;
    extra?: Record<string, unknown>;
    error?: unknown;
  } = {}
) => {
  try {
    console.error(`=== [${SUITE}:${label}] library-db-ipc snapshot ===`);
    if (ctx.channel !== undefined) console.error(`channel: ${ctx.channel}`);
    if (ctx.method !== undefined) console.error(`method: ${ctx.method}`);
    if (ctx.payload !== undefined) {
      console.error(`payload:\n${JSON.stringify(ctx.payload, jsonReplacer, 2)}`);
    }
    if (ctx.args !== undefined) {
      console.error(`args:\n${JSON.stringify(ctx.args, jsonReplacer, 2)}`);
    }
    if (ctx.result !== undefined) {
      console.error(`result:\n${JSON.stringify(ctx.result, jsonReplacer, 2)}`);
    }
    if (ctx.expected !== undefined) {
      console.error(`expected:\n${JSON.stringify(ctx.expected, jsonReplacer, 2)}`);
    }
    if (ctx.actual !== undefined) {
      console.error(`actual:\n${JSON.stringify(ctx.actual, jsonReplacer, 2)}`);
    }
    if (ctx.handlers !== undefined) {
      console.error(`handlers (registered channels):\n${JSON.stringify(ctx.handlers, jsonReplacer, 2)}`);
    }
    if (ctx.openMockCalls !== undefined) {
      console.error(`openMock.calls:\n${JSON.stringify(ctx.openMockCalls, jsonReplacer, 2)}`);
    }
    if (ctx.openLocalMockCalls !== undefined) {
      console.error(`openLocalMock.calls:\n${JSON.stringify(ctx.openLocalMockCalls, jsonReplacer, 2)}`);
    }
    if (ctx.sealLocalCacheForRotationCalls !== undefined) {
      console.error(`sealLocalCacheForRotationMock.calls:\n${JSON.stringify(ctx.sealLocalCacheForRotationCalls, jsonReplacer, 2)}`);
    }
    if (ctx.hasLocalCacheCalls !== undefined) {
      console.error(`hasLocalCacheMock.calls:\n${JSON.stringify(ctx.hasLocalCacheCalls, jsonReplacer, 2)}`);
    }
    if (ctx.clearLocalCacheCalls !== undefined) {
      console.error(`clearLocalCacheMock.calls:\n${JSON.stringify(ctx.clearLocalCacheCalls, jsonReplacer, 2)}`);
    }
    if (ctx.fetchMockCalls !== undefined) {
      console.error(`fetchMock.calls:\n${JSON.stringify(ctx.fetchMockCalls, jsonReplacer, 2)}`);
    }
    if (ctx.fetchUrls !== undefined) {
      console.error(`fetchUrls:\n${JSON.stringify(ctx.fetchUrls, jsonReplacer, 2)}`);
    }
    if (ctx.loggerInfoCalls !== undefined) {
      console.error(`loggerInfoMock.calls:\n${JSON.stringify(ctx.loggerInfoCalls, jsonReplacer, 2)}`);
    }
    if (ctx.loggerWarnCalls !== undefined) {
      console.error(`loggerWarnMock.calls:\n${JSON.stringify(ctx.loggerWarnCalls, jsonReplacer, 2)}`);
    }
    if (ctx.loggerErrorCalls !== undefined) {
      console.error(`loggerErrorMock.calls:\n${JSON.stringify(ctx.loggerErrorCalls, jsonReplacer, 2)}`);
    }
    if (ctx.sendCalls !== undefined) {
      console.error(`win.webContents.send.calls:\n${JSON.stringify(ctx.sendCalls, jsonReplacer, 2)}`);
    }
    if (ctx.nativeMismatch !== undefined) console.error(`nativeMismatch: ${ctx.nativeMismatch}`);
    if (ctx.recoverResult !== undefined) console.error(`recoverResult: ${ctx.recoverResult}`);
    if (ctx.runtimeCommandBodies !== undefined) {
      console.error(`runtimeCommandBodies:\n${JSON.stringify(ctx.runtimeCommandBodies, jsonReplacer, 2)}`);
    }
    if (ctx.runtimeCommandCount !== undefined) console.error(`runtimeCommandCount: ${ctx.runtimeCommandCount}`);
    if (ctx.contractFetchCount !== undefined) console.error(`contractFetchCount: ${ctx.contractFetchCount}`);
    if (ctx.loginFetchCount !== undefined) console.error(`loginFetchCount: ${ctx.loginFetchCount}`);
    if (ctx.extra !== undefined) {
      console.error(`extra:\n${JSON.stringify(ctx.extra, jsonReplacer, 2)}`);
    }
    if (ctx.error !== undefined) {
      const e = ctx.error;
      console.error(`error: ${e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ""}` : String(e)}`);
    }
    console.error(`=== [${SUITE}:${label}] end snapshot ===`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

type Handler = (_event: unknown, payload?: any) => unknown | Promise<unknown>;

const createIpcHarness = () => {
  const handlers = new Map<string, Handler>();
  const ipc = {
    handle: vi.fn((channel: string, handler: Handler) => {
      handlers.set(channel, handler);
    }),
  };
  return { ipc, handlers };
};

const createWindowHarness = () => {
  const send = vi.fn();
  const win = {
    isDestroyed: () => false,
    webContents: { send },
  };
  return { win, send };
};

describe("libraryDbIpc integration", () => {
  beforeEach(() => {
    resetLibraryDbIpcForTests();
    openMock.mockReset();
    openLocalMock.mockReset();
    sealLocalCacheForRotationMock.mockReset();
    hasLocalCacheMock.mockReset();
    clearLocalCacheMock.mockReset();
    loggerInfoMock.mockReset();
    loggerWarnMock.mockReset();
    loggerErrorMock.mockReset();
    fetchMock.mockReset();
  });

  /**
   * @test-id DESKTOP-IPC-001
   * @level integration
   * @why Ensure renderer IPC can open library db handles and receive dataset-status events.
   */
  it("opens db, emits dataset updates, and forwards calls", async () => {
    const label = "open-emit-forward";
    console.info(`[${SUITE}:${label}] setting up ipc harness + window harness`);
    const { ipc, handlers } = createIpcHarness();
    const { win, send } = createWindowHarness();
    const close = vi.fn();
    const unsubscribe = vi.fn();
    const dataset: { listener: ((status: unknown) => void) | null } = { listener: null };
    const ping = vi.fn(async (value: string) => ({ ok: value }));
    const replaceSkipMarkers = vi.fn(async () => undefined);

    openMock.mockResolvedValue({
      close,
      ping,
      replaceSkipMarkers,
      onDatasetStatus: (listener: (status: unknown) => void) => {
        dataset.listener = listener;
        return unsubscribe;
      },
    });

    console.info(`[${SUITE}:${label}] registering library-db ipc handlers`);
    registerLibraryDbIpc(ipc as any, () => win as any);
    console.info(`[${SUITE}:${label}] registered channels: ${JSON.stringify(Array.from(handlers.keys()))}`);

    console.info(`[${SUITE}:${label}] invoking sf-library-db-open`);
    const opened = await handlers.get("sf-library-db-open")?.(null, {
      token: "token",
      keyBase64: "key",
      userId: USER_ID,
    });
    console.info(`[${SUITE}:${label}] open returned ${JSON.stringify(opened)} openMock.calls=${openMock.mock.calls.length}`);
    try {
      expect(opened).toEqual({ handle: "default" });
      expect(openMock).toHaveBeenCalledWith("token", "key", { userId: USER_ID });
    } catch (err) {
      dumpLibraryDbIpcSnapshot(label, {
        channel: "sf-library-db-open",
        payload: { token: "token", keyBase64: "key", userId: USER_ID },
        result: opened,
        expected: { handle: "default" },
        actual: opened,
        openMockCalls: openMock.mock.calls,
        handlers: Array.from(handlers.keys()),
        error: err,
      });
      throw err;
    }

    console.info(`[${SUITE}:${label}] firing datasetStatusListener phase=syncing progress=12`);
    dataset.listener?.({ phase: "syncing", progress: 12 });
    console.info(`[${SUITE}:${label}] send.calls=${send.mock.calls.length}`);
    try {
      expect(send).toHaveBeenCalledWith("sf-library-db-dataset-status", {
        phase: "syncing",
        progress: 12,
      });
    } catch (err) {
      dumpLibraryDbIpcSnapshot(label, {
        channel: "sf-library-db-dataset-status",
        sendCalls: send.mock.calls,
        expected: ["sf-library-db-dataset-status", { phase: "syncing", progress: 12 }],
        actual: send.mock.calls,
        error: err,
      });
      throw err;
    }

    console.info(`[${SUITE}:${label}] invoking sf-library-db-call method=ping args=[hello]`);
    const result = await handlers.get("sf-library-db-call")?.(null, {
      method: "ping",
      args: ["hello"],
    });
    console.info(`[${SUITE}:${label}] ping result=${JSON.stringify(result)} ping.calls=${ping.mock.calls.length}`);
    try {
      expect(result).toEqual({ ok: "hello" });
      expect(ping).toHaveBeenCalledWith("hello");
    } catch (err) {
      dumpLibraryDbIpcSnapshot(label, {
        channel: "sf-library-db-call",
        method: "ping",
        args: ["hello"],
        result,
        expected: { ok: "hello" },
        actual: result,
        extra: { pingCalls: ping.mock.calls },
        error: err,
      });
      throw err;
    }

    console.info(`[${SUITE}:${label}] invoking sf-library-db-call method=replaceSkipMarkers`);
    await handlers.get("sf-library-db-call")?.(null, {
      method: "replaceSkipMarkers",
      args: [
        "media-1",
        null,
        [{ type: "intro", startSeconds: 12, endSeconds: 42, source: "internal", confidence: 0.9 }],
      ],
    });
    console.info(`[${SUITE}:${label}] replaceSkipMarkers.calls=${replaceSkipMarkers.mock.calls.length}`);
    try {
      expect(replaceSkipMarkers).toHaveBeenCalledWith("media-1", null, [
        { type: "intro", startSeconds: 12, endSeconds: 42, source: "internal", confidence: 0.9 },
      ]);
    } catch (err) {
      dumpLibraryDbIpcSnapshot(label, {
        channel: "sf-library-db-call",
        method: "replaceSkipMarkers",
        args: [
          "media-1",
          null,
          [{ type: "intro", startSeconds: 12, endSeconds: 42, source: "internal", confidence: 0.9 }],
        ],
        expected: [
          "media-1",
          null,
          [{ type: "intro", startSeconds: 12, endSeconds: 42, source: "internal", confidence: 0.9 }],
        ],
        actual: replaceSkipMarkers.mock.calls,
        error: err,
      });
      throw err;
    }

    console.info(`[${SUITE}:${label}] invoking sf-library-db-clear-local-cache`);
    await handlers.get("sf-library-db-clear-local-cache")?.(null);
    console.info(
      `[${SUITE}:${label}] close.calls=${close.mock.calls.length} unsubscribe.calls=${unsubscribe.mock.calls.length} clearLocalCacheMock.calls=${clearLocalCacheMock.mock.calls.length}`
    );
    try {
      expect(close).toHaveBeenCalledTimes(1);
      expect(unsubscribe).toHaveBeenCalledTimes(1);
      expect(clearLocalCacheMock).toHaveBeenCalledTimes(1);
    } catch (err) {
      dumpLibraryDbIpcSnapshot(label, {
        channel: "sf-library-db-clear-local-cache",
        expected: { closeCalls: 1, unsubscribeCalls: 1, clearLocalCacheCalls: 1 },
        actual: {
          closeCalls: close.mock.calls.length,
          unsubscribeCalls: unsubscribe.mock.calls.length,
          clearLocalCacheCalls: clearLocalCacheMock.mock.calls.length,
        },
        clearLocalCacheCalls: clearLocalCacheMock.mock.calls,
        error: err,
      });
      throw err;
    }
    console.info(`[${SUITE}:${label}] done`);
  });

  /**
   * @test-id DESKTOP-IPC-002
   * @level integration
   * @why Prevent silent IPC misuse by rejecting unknown methods while preserving cache helper behavior.
   */
  it("rejects unknown db method and proxies static cache helpers", async () => {
    const label = "reject-unknown-proxy-cache";
    console.info(`[${SUITE}:${label}] setting up cache mocks (bytes/hasLocal/openLocal)`);
    const { ipc, handlers } = createIpcHarness();
    const { win } = createWindowHarness();

    sealLocalCacheForRotationMock.mockResolvedValue(SEALED);
    hasLocalCacheMock.mockResolvedValue(true);
    openLocalMock.mockResolvedValue({
      close: vi.fn(),
      onDatasetStatus: () => () => undefined,
    });

    console.info(`[${SUITE}:${label}] registering library-db ipc handlers`);
    registerLibraryDbIpc(ipc as any, () => win as any);

    console.info(`[${SUITE}:${label}] invoking sf-library-db-open-local`);
    const local = await handlers.get("sf-library-db-open-local")?.(null, {
      token: "token",
      keyBase64: "key",
      userId: USER_ID,
    });
    console.info(`[${SUITE}:${label}] open-local returned ${JSON.stringify(local)}`);
    try {
      expect(local).toEqual({ handle: "default" });
    } catch (err) {
      dumpLibraryDbIpcSnapshot(label, {
        channel: "sf-library-db-open-local",
        payload: { token: "token", keyBase64: "key", userId: USER_ID },
        result: local,
        expected: { handle: "default" },
        actual: local,
        openLocalMockCalls: openLocalMock.mock.calls,
        error: err,
      });
      throw err;
    }

    console.info(`[${SUITE}:${label}] invoking sf-library-db-seal-local-cache-for-rotation`);
    const sealed = await handlers.get("sf-library-db-seal-local-cache-for-rotation")?.(null, { token: "token", newKeyBase64: "new" });
    console.info(
      `[${SUITE}:${label}] sealed received: ${JSON.stringify(sealed)} sealLocalCacheForRotationMock.calls=${sealLocalCacheForRotationMock.mock.calls.length}`
    );
    try {
      expect(sealed).toEqual(SEALED);
      expect(sealLocalCacheForRotationMock).toHaveBeenCalledWith("token", "new");
    } catch (err) {
      dumpLibraryDbIpcSnapshot(label, {
        channel: "sf-library-db-seal-local-cache-for-rotation",
        args: { token: "token", newKeyBase64: "new" },
        result: sealed,
        expected: SEALED,
        actual: sealed,
        sealLocalCacheForRotationCalls: sealLocalCacheForRotationMock.mock.calls,
        error: err,
      });
      throw err;
    }

    console.info(`[${SUITE}:${label}] invoking sf-library-db-has-local-cache`);
    const hasCache = await handlers.get("sf-library-db-has-local-cache")?.(null);
    console.info(`[${SUITE}:${label}] hasCache=${hasCache} hasLocalCacheMock.calls=${hasLocalCacheMock.mock.calls.length}`);
    try {
      expect(hasCache).toBe(true);
      expect(hasLocalCacheMock).toHaveBeenCalledTimes(1);
    } catch (err) {
      dumpLibraryDbIpcSnapshot(label, {
        channel: "sf-library-db-has-local-cache",
        result: hasCache,
        expected: true,
        actual: hasCache,
        hasLocalCacheCalls: hasLocalCacheMock.mock.calls,
        error: err,
      });
      throw err;
    }

    console.info(`[${SUITE}:${label}] invoking sf-library-db-call with unknown method=missingMethod`);
    try {
      await expect(
        handlers.get("sf-library-db-call")?.(null, { method: "missingMethod" })
      ).rejects.toThrow("UNKNOWN_METHOD:missingMethod");
    } catch (err) {
      dumpLibraryDbIpcSnapshot(label, {
        channel: "sf-library-db-call",
        method: "missingMethod",
        expected: { rejection: "UNKNOWN_METHOD:missingMethod" },
        loggerWarnCalls: loggerWarnMock.mock.calls,
        loggerErrorCalls: loggerErrorMock.mock.calls,
        error: err,
      });
      throw err;
    }
    console.info(`[${SUITE}:${label}] done`);
  });

  /**
   * @test-id DESKTOP-IPC-005
   * @level integration
   * @bugfix
   * @why Avoid noisy Electron handler errors during auth/open transitions by returning a structured not-ready response.
   * @regression-proof Forces a closed DB state first; pre-fix handler threw in this state instead of returning not-ready.
   */
  it("returns not-ready response when db call arrives before open", async () => {
    const label = "not-ready-before-open";
    console.info(`[${SUITE}:${label}] registering handlers + forcing closed state via clear-local-cache`);
    const { ipc, handlers } = createIpcHarness();
    const { win } = createWindowHarness();
    registerLibraryDbIpc(ipc as any, () => win as any);
    await handlers.get("sf-library-db-clear-local-cache")?.(null);

    console.info(`[${SUITE}:${label}] invoking sf-library-db-call before any open`);
    const result = await handlers.get("sf-library-db-call")?.(null, { method: "getSnapshot" });
    console.info(
      `[${SUITE}:${label}] result=${JSON.stringify(result)} loggerWarnMock.calls=${loggerWarnMock.mock.calls.length}`
    );
    try {
      expect(result).toEqual({ __sfIpcError: "LIBRARY_DB_NOT_READY" });
      expect(loggerWarnMock).toHaveBeenCalledWith(
        expect.objectContaining({ method: "getSnapshot" })
      );
    } catch (err) {
      dumpLibraryDbIpcSnapshot(label, {
        channel: "sf-library-db-call",
        method: "getSnapshot",
        result,
        expected: { __sfIpcError: "LIBRARY_DB_NOT_READY" },
        actual: result,
        loggerWarnCalls: loggerWarnMock.mock.calls,
        error: err,
      });
      throw err;
    }
    console.info(`[${SUITE}:${label}] done`);
  });

  // @req ACCT-SQUAD-02[badger-desktop]
  it("@bugfix refuses a profile id that is empty or holds ':', keeping the current playback profile", async () => {
    const label = "set-active-profile-refused";
    const { ipc, handlers } = createIpcHarness();
    // The harness fakes only `handle`; registerLibraryDbIpc uses nothing else of ipcMain.
    const fakeIpc = ipc as unknown as Parameters<typeof registerLibraryDbIpc>[0];
    registerLibraryDbIpc(fakeIpc, () => null);
    const setActive = handlers.get("sf-library-db-set-active-profile");
    await setActive?.(null, { id: "prof-kids", isMain: false });
    const results: Array<{ bad: unknown; result: unknown; active: string | null }> = [];
    for (const bad of [{ id: "" }, { id: "  " }, { id: "prof-kids:evil" }, "prof-kids"]) {
      results.push({ bad, result: await setActive?.(null, bad), active: getActivePlaybackProfileId() });
    }
    console.info(`[${SUITE}:${label}] results=${JSON.stringify(results)}`);
    const refusals = loggerWarnMock.mock.calls.filter(
      ([entry]) => typeof entry === "object" && entry !== null && "event" in entry && entry.event === "active_profile_refused",
    );
    try {
      expect(results.map((r) => r.active)).toEqual(Array(4).fill("prof-kids"));
      expect(refusals).toHaveLength(4);
    } catch (err) {
      dumpLibraryDbIpcSnapshot(label, { result: results, loggerWarnCalls: loggerWarnMock.mock.calls, error: err });
      throw err;
    } finally {
      await setActive?.(null, null);
    }
  });

  /**
   * @test-id DESKTOP-IPC-006
   * @level integration
   * @bugfix
   * @why Surface root-cause details in terminal when library db open fails so renderer-side not-ready errors are diagnosable.
   * @regression-proof Forces open() to throw and asserts error log content; pre-fix there was no structured open-failure log.
   */
  it("logs structured context when open fails", async () => {
    const label = "logs-open-failure";
    console.info(`[${SUITE}:${label}] setting up openMock to reject with sync_broken`);
    const { ipc, handlers } = createIpcHarness();
    const { win } = createWindowHarness();
    openMock.mockRejectedValue(new Error("sync_broken"));

    registerLibraryDbIpc(ipc as any, () => win as any);

    console.info(`[${SUITE}:${label}] invoking sf-library-db-open — expecting rejection`);
    try {
      await expect(
        handlers.get("sf-library-db-open")?.(null, {
          token: "token",
          keyBase64: "key",
          userId: USER_ID,
        })
      ).rejects.toThrow("sync_broken");
    } catch (err) {
      dumpLibraryDbIpcSnapshot(label, {
        channel: "sf-library-db-open",
        payload: { token: "token", keyBase64: "key", userId: USER_ID },
        expected: { rejection: "sync_broken" },
        openMockCalls: openMock.mock.calls,
        loggerErrorCalls: loggerErrorMock.mock.calls,
        nativeMismatch: false,
        error: err,
      });
      throw err;
    }

    console.info(
      `[${SUITE}:${label}] post-open loggerErrorMock.calls=${loggerErrorMock.mock.calls.length}: ${JSON.stringify(loggerErrorMock.mock.calls)}`
    );
    try {
      expect(loggerErrorMock).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "open_failed",
          channel: "sf-library-db-open",
          message: "sync_broken",
        })
      );
    } catch (err) {
      dumpLibraryDbIpcSnapshot(label, {
        channel: "sf-library-db-open",
        expected: { event: "open_failed", channel: "sf-library-db-open", message: "sync_broken" },
        actual: loggerErrorMock.mock.calls,
        loggerErrorCalls: loggerErrorMock.mock.calls,
        loggerInfoCalls: loggerInfoMock.mock.calls,
        loggerWarnCalls: loggerWarnMock.mock.calls,
        error: err,
      });
      throw err;
    }
    console.info(`[${SUITE}:${label}] done`);
  });

  // @req LIB-STORE-06[badger-desktop]
  it("refuses to open the library without a signed-in account and never touches a shared dir", async () => {
    const label = "open-without-account";
    const { ipc, handlers } = createIpcHarness();
    const { win } = createWindowHarness();
    openMock.mockResolvedValue({ subscribe: () => () => undefined });
    registerLibraryDbIpc(ipc as any, () => win as any);

    for (const userId of [undefined, "  "]) {
      console.info(`[${SUITE}:${label}] invoking sf-library-db-open with userId=${JSON.stringify(userId)}`);
      try {
        await expect(handlers.get("sf-library-db-open")?.(null, { token: "token", keyBase64: "key", userId })).rejects.toThrow(
          "LIBRARY_USER_ID_MISSING"
        );
        expect(openMock).not.toHaveBeenCalled();
      } catch (err) {
        dumpLibraryDbIpcSnapshot(label, {
          channel: "sf-library-db-open",
          payload: { token: "token", keyBase64: "key", userId },
          expected: { rejection: "LIBRARY_USER_ID_MISSING", openMockCalls: 0 },
          openMockCalls: openMock.mock.calls,
          error: err,
        });
        throw err;
      }
    }
    console.info(`[${SUITE}:${label}] done`);
  });

  /**
   * @test-id DESKTOP-IPC-007
   * @level integration
   * @bugfix
   * @why Prevent startup races where renderer calls arrive while open is still in flight.
   * @regression-proof Pre-fix this returned LIBRARY_DB_NOT_READY; now call waits for open to resolve.
   */
  it("waits for in-flight open before serving db calls", async () => {
    const label = "wait-for-in-flight-open";
    console.info(`[${SUITE}:${label}] setting up deferred open promise + getSnapshot mock`);
    const { ipc, handlers } = createIpcHarness();
    const { win } = createWindowHarness();
    const deferred = Promise.withResolvers<{
      close: () => void;
      onDatasetStatus: (listener: (status: unknown) => void) => () => void;
      getSnapshot: () => { media: never[]; playlists: never[] };
    }>();
    const getSnapshot = vi.fn(() => ({ media: [], playlists: [] }));

    openMock.mockReturnValue(deferred.promise);
    registerLibraryDbIpc(ipc as any, () => win as any);

    console.info(`[${SUITE}:${label}] firing sf-library-db-open (deferred) + sf-library-db-call concurrently`);
    const openPromise = handlers.get("sf-library-db-open")?.(null, {
      token: "token",
      keyBase64: "key",
      userId: USER_ID,
    });
    const callPromise = handlers.get("sf-library-db-call")?.(null, {
      method: "getSnapshot",
      args: [],
    });

    console.info(`[${SUITE}:${label}] resolving deferred open`);
    deferred.resolve({
      close: vi.fn(),
      onDatasetStatus: () => () => undefined,
      getSnapshot,
    });

    try {
      await expect(openPromise).resolves.toEqual({ handle: "default" });
    } catch (err) {
      dumpLibraryDbIpcSnapshot(label, {
        channel: "sf-library-db-open",
        expected: { handle: "default" },
        openMockCalls: openMock.mock.calls,
        extra: { stage: "openPromise resolution" },
        error: err,
      });
      throw err;
    }
    try {
      await expect(callPromise).resolves.toEqual({ media: [], playlists: [] });
      expect(getSnapshot).toHaveBeenCalledTimes(1);
    } catch (err) {
      dumpLibraryDbIpcSnapshot(label, {
        channel: "sf-library-db-call",
        method: "getSnapshot",
        expected: { media: [], playlists: [] },
        actual: { getSnapshotCalls: getSnapshot.mock.calls.length, getSnapshotResults: getSnapshot.mock.results },
        extra: { stage: "callPromise resolution" },
        error: err,
      });
      throw err;
    }
    console.info(
      `[${SUITE}:${label}] done — getSnapshot.calls=${getSnapshot.mock.calls.length}`
    );
  });

  /**
   * @test-id DESKTOP-IPC-008
   * @level integration
   * @bugfix
   * @why Enforce backend compatibility contract at main-process IPC boundary so renderer bypasses cannot mutate local library state.
   * @regression-proof Forces supported db write method with unsupported contract response; pre-fix write proceeded.
   */
  it("blocks write methods when system contract marks app unsupported", async () => {
    const label = "blocks-writes-when-unsupported";
    console.info(`[${SUITE}:${label}] setting up createPlaylist mock + contract fetch returning supported=false`);
    const { ipc, handlers } = createIpcHarness();
    const { win } = createWindowHarness();
    const createPlaylist = vi.fn(async () => undefined);
    openMock.mockResolvedValue({
      close: vi.fn(),
      onDatasetStatus: () => () => undefined,
      createPlaylist,
    });
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          apps: {
            badger: { supported: false, migrationRequired: false, migrationReason: "maintenance_window" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    registerLibraryDbIpc(ipc as any, () => win as any);
    console.info(`[${SUITE}:${label}] opening db with empty token`);
    await handlers.get("sf-library-db-open")?.(null, {
      token: "",
      keyBase64: "key",
      userId: USER_ID,
    });

    console.info(`[${SUITE}:${label}] invoking sf-library-db-call createPlaylist — expecting LIBRARY_WRITE_BLOCKED`);
    try {
      await expect(
        handlers.get("sf-library-db-call")?.(null, {
          method: "createPlaylist",
          args: ["Blocked playlist"],
        })
      ).rejects.toThrow("LIBRARY_WRITE_BLOCKED:maintenance_window");
      expect(createPlaylist).not.toHaveBeenCalled();
    } catch (err) {
      dumpLibraryDbIpcSnapshot(label, {
        channel: "sf-library-db-call",
        method: "createPlaylist",
        args: ["Blocked playlist"],
        expected: { rejection: "LIBRARY_WRITE_BLOCKED:maintenance_window", createPlaylistCalls: 0 },
        actual: { createPlaylistCalls: createPlaylist.mock.calls.length },
        fetchMockCalls: fetchMock.mock.calls,
        fetchUrls: fetchMock.mock.calls.map((c) => fetchedUrl(c[0])),
        loggerErrorCalls: loggerErrorMock.mock.calls,
        loggerWarnCalls: loggerWarnMock.mock.calls,
        error: err,
      });
      throw err;
    }
    console.info(`[${SUITE}:${label}] done — createPlaylist not called as expected`);
  });

  /**
   * @test-id DESKTOP-IPC-009
   * @level integration
   * @bugfix
   * @why Ensure runtime-first bridge mirrors local library state to runtime on open and subsequent writes.
   * @regression-proof Forces open + write flow and asserts runtime login/upsert command requests; pre-fix no runtime mirror calls existed.
   */
  it("mirrors badger library snapshots to runtime — coalesces write bursts via debounce", async () => {
    // History: previously mirror called db.getSnapshot() (full library walk
    // with N+1 getMediaDetails) on every write, blocking the main process
    // event loop for 5–10s. Fix: cheap getCountSummary() + 250ms debounce
    // that coalesces a burst of writes into one mirror RPC. This test
    // verifies the cheap-call contract AND the burst coalescing — if a
    // future refactor reverts to getSnapshot or removes debouncing, this
    // test breaks loudly.
    const { ipc, handlers } = createIpcHarness();
    const { win } = createWindowHarness();
    const createPlaylist = vi.fn(async () => undefined);
    const getVersion = vi.fn(() => 12);
    const getCountSummary = vi.fn(() => ({ mediaCount: 1, playlistCount: 1 }));
    const getSnapshot = vi.fn(() => {
      throw new Error("getSnapshot must NOT be called by the runtime mirror — use getCountSummary");
    });

    openMock.mockResolvedValue({
      close: vi.fn(),
      onDatasetStatus: () => () => undefined,
      createPlaylist,
      getVersion,
      getCountSummary,
      getSnapshot,
    });

    // With debounced mirror, the contract fetch (write-guard) lands first
    // — during the createPlaylist call, before the debounce timer fires.
    // Then 250ms later the coalesced mirror runner does its lazy
    // runtime-session login + the mirror RPC.
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = fetchedUrl(input);
      if (url === "https://api.spacefleet.io/system/contract") {
        return new Response(
          JSON.stringify({
            apps: {
              badger: { supported: true, migrationRequired: false, migrationReason: null },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url === "http://127.0.0.1:3020/runtime/session/login") {
        return new Response(
          JSON.stringify({
            ok: true,
            token: "runtime-session-token",
            expiresAt: "2099-01-01T00:00:00Z",
            capabilities: { apps: ["badger"] },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url === "http://127.0.0.1:3020/modules/badger/commands") {
        return new Response(
          JSON.stringify({
            requestId: "mock-1",
            ok: true,
            result: {
              snapshotId: "s1",
              version: 12,
              isHead: true,
              totalSnapshots: 1,
              updatedAt: new Date().toISOString(),
            },
            error: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("not-mocked", { status: 500 });
    });

    const label = "runtime-mirror-debounced";
    registerLibraryDbIpc(ipc as any, () => win as any);
    console.info(`[${SUITE}:${label}] opening db with backend-token`);
    await handlers.get("sf-library-db-open")?.(null, {
      token: "backend-token",
      keyBase64: "key",
      userId: USER_ID,
    });
    console.info(`[${SUITE}:${label}] invoking createPlaylist (triggers mirror+debounce)`);
    await handlers.get("sf-library-db-call")?.(null, {
      method: "createPlaylist",
      args: ["Runtime mirrored playlist"],
    });

    // open + write together = one coalesced mirror RPC (debounced), plus
    // a runtime login (lazy in the mirror runner) and the write-guard
    // contract fetch. 3 fetches total — NOT 4.
    console.info(`[${SUITE}:${label}] waiting for fetchMock to have 3 calls (debounce coalesce)`);
    try {
      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(3);
      }, { timeout: 2000 });
    } catch (err) {
      dumpLibraryDbIpcSnapshot(label, {
        channel: "sf-library-db-call",
        method: "createPlaylist",
        expected: { fetchMockCalls: 3 },
        actual: { fetchMockCalls: fetchMock.mock.calls.length },
        fetchMockCalls: fetchMock.mock.calls,
        fetchUrls: fetchMock.mock.calls.map((c) => fetchedUrl(c[0])),
        extra: { stage: "waitFor 3 fetches" },
        error: err,
      });
      throw err;
    }
    console.info(
      `[${SUITE}:${label}] post-debounce createPlaylist.calls=${createPlaylist.mock.calls.length} getCountSummary.calls=${getCountSummary.mock.calls.length} getSnapshot.calls=${getSnapshot.mock.calls.length}`
    );
    try {
      expect(createPlaylist).toHaveBeenCalledWith("Runtime mirrored playlist");
      // The expensive getSnapshot must not be called by the mirror; only
      // the cheap COUNT(*) helper should.
      expect(getSnapshot).not.toHaveBeenCalled();
      expect(getCountSummary).toHaveBeenCalled();
    } catch (err) {
      dumpLibraryDbIpcSnapshot(label, {
        channel: "sf-library-db-call",
        method: "createPlaylist",
        expected: {
          createPlaylistCalledWith: "Runtime mirrored playlist",
          getSnapshotCalls: 0,
          getCountSummaryCallsGt: 0,
        },
        actual: {
          createPlaylistCalls: createPlaylist.mock.calls,
          getSnapshotCalls: getSnapshot.mock.calls.length,
          getCountSummaryCalls: getCountSummary.mock.calls.length,
        },
        error: err,
      });
      throw err;
    }

    const urls = fetchMock.mock.calls.map((entry) => fetchedUrl(entry[0]));
    const contractCount = urls.filter((url) => url === "https://api.spacefleet.io/system/contract").length;
    const loginCount = urls.filter((url) => url === "http://127.0.0.1:3020/runtime/session/login").length;
    const cmdCount = urls.filter((url) => url === "http://127.0.0.1:3020/modules/badger/commands").length;
    console.info(
      `[${SUITE}:${label}] fetch urls breakdown: contract=${contractCount} login=${loginCount} commands=${cmdCount} all=${JSON.stringify(urls)}`
    );
    try {
      expect(urls.filter((url) => url === "http://127.0.0.1:3020/runtime/session/login")).toHaveLength(1);
      expect(urls.filter((url) => url === "https://api.spacefleet.io/system/contract")).toHaveLength(1);
      expect(urls.filter((url) => url === "http://127.0.0.1:3020/modules/badger/commands")).toHaveLength(1);
    } catch (err) {
      dumpLibraryDbIpcSnapshot(label, {
        expected: {
          contractFetchCount: 1,
          loginFetchCount: 1,
          runtimeCommandCount: 1,
        },
        actual: {
          contractFetchCount: contractCount,
          loginFetchCount: loginCount,
          runtimeCommandCount: cmdCount,
        },
        fetchUrls: urls,
        contractFetchCount: contractCount,
        loginFetchCount: loginCount,
        runtimeCommandCount: cmdCount,
        error: err,
      });
      throw err;
    }

    const runtimeCommandBodies = fetchMock.mock.calls
      .filter((entry) => String(entry[0]) === "http://127.0.0.1:3020/modules/badger/commands")
      .map((entry) =>
        JSON.parse(String((entry[1] as { body?: unknown } | undefined)?.body ?? "{}")) as {
          command?: string;
          payload?: { snapshotId?: string; mediaCount?: number; playlistCount?: number };
        }
      );
    console.info(
      `[${SUITE}:${label}] runtimeCommandBodies=${JSON.stringify(runtimeCommandBodies)}`
    );
    try {
      expect(runtimeCommandBodies).toHaveLength(1);
      expect(runtimeCommandBodies[0]?.command).toBe("badger.library.upsert_snapshot");
      expect(runtimeCommandBodies[0]?.payload).toEqual(
        expect.objectContaining({
          snapshotId: "desktop-12",
          mediaCount: 1,
          playlistCount: 1,
        })
      );
    } catch (err) {
      dumpLibraryDbIpcSnapshot(label, {
        expected: {
          length: 1,
          command: "badger.library.upsert_snapshot",
          payload: { snapshotId: "desktop-12", mediaCount: 1, playlistCount: 1 },
        },
        actual: runtimeCommandBodies,
        runtimeCommandBodies,
        runtimeCommandCount: runtimeCommandBodies.length,
        fetchUrls: urls,
        error: err,
      });
      throw err;
    }
    console.info(`[${SUITE}:${label}] done`);
  });

  /**
   * @test-id DESKTOP-IPC-004
   * @level integration
   * @why Give users actionable guidance when the better-sqlite3 native binding cannot load.
   *      better-sqlite3 13 is N-API with prebuilds, so there is no rebuild to run: the
   *      guidance must point at reinstalling, never at the retired `rebuild:electron`.
   */
  it("@bugfix @regression-proof throws actionable reinstall guidance when the native binding fails to load", async () => {
    const label = "native-load-guidance";
    console.info(`[${SUITE}:${label}] simulating ERR_DLOPEN_FAILED from LibraryDb.open`);
    const { ipc, handlers } = createIpcHarness();
    const { win } = createWindowHarness();
    const nativeError = new Error("ERR_DLOPEN_FAILED: Module did not self-register");

    openMock.mockRejectedValueOnce(nativeError);

    registerLibraryDbIpc(ipc as any, () => win as any);

    console.info(`[${SUITE}:${label}] invoking sf-library-db-open — expecting guidance throw`);
    try {
      await expect(
        handlers.get("sf-library-db-open")?.(null, {
          token: "token",
          keyBase64: "key",
          userId: USER_ID,
        })
      ).rejects.toThrow(BETTER_SQLITE_NATIVE_LOAD_GUIDANCE);
      expect(openMock).toHaveBeenCalledTimes(1);
    } catch (err) {
      dumpLibraryDbIpcSnapshot(label, {
        channel: "sf-library-db-open",
        payload: { token: "token", keyBase64: "key", userId: USER_ID },
        expected: { rejection: BETTER_SQLITE_NATIVE_LOAD_GUIDANCE },
        openMockCalls: openMock.mock.calls,
        loggerErrorCalls: loggerErrorMock.mock.calls,
        loggerWarnCalls: loggerWarnMock.mock.calls,
        error: err,
      });
      throw err;
    }
    console.info(`[${SUITE}:${label}] done`);
  });
});
