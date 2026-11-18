// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryDb } from "../src/renderer/src/lib/libraryDb";

const getApiBaseUrlMock = vi.fn((..._args: unknown[]) => "http://api.test");
const getLibraryMetaMock = vi.fn();
const getMeMock = vi.fn();

vi.mock("@/api", () => {
  class TestApiError extends Error {
    status: number;

    constructor(status: number, payload: { error?: string } = {}) {
      super(payload.error ?? "request_failed");
      this.status = status;
    }
  }

  return {
    ApiError: TestApiError,
    getApiBaseUrl: (...args: unknown[]) => getApiBaseUrlMock(...args),
    getLibraryMeta: (...args: unknown[]) => getLibraryMetaMock(...args),
    getMe: (...args: unknown[]) => getMeMock(...args),
  };
});

type MockEventSourceListener = (event?: Event) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];

  url: string;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 1;
  closed = false;
  private listeners = new Map<string, MockEventSourceListener[]>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: MockEventSourceListener) {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  close() {
    this.closed = true;
    this.readyState = 2;
  }

  emit(type: string, event?: Event) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  emitError() {
    this.onerror?.();
  }
}

// Dump-on-failure helper: the domain state for these reconnect/debounce tests
// is the MockEventSource instance ledger + the refs the attach helper mutates +
// the getMe probe call count. Print all three so a timing regression is
// diagnosable from the log alone. Wrapped in try/catch so a dump error can't
// mask the real assertion.
const dumpStreamSnapshot = (
  label: string,
  refs: Record<string, { current: unknown }>,
  extra?: Record<string, unknown>,
) => {
  try {
    console.error(`=== [library-remote-sync-stream-integration:${label}] snapshot ===`);
    console.error(
      `MockEventSource.instances=${MockEventSource.instances.length} ` +
        `closedFlags=${JSON.stringify(MockEventSource.instances.map((i) => i.closed))} ` +
        `urls=${JSON.stringify(MockEventSource.instances.map((i) => i.url))}`,
    );
    console.error(`getMe.calls=${getMeMock.mock.calls.length} getLibraryMeta.calls=${getLibraryMetaMock.mock.calls.length}`);
    console.error(
      `refs: ${JSON.stringify(
        Object.fromEntries(Object.entries(refs).map(([k, v]) => [k, v.current])),
      )}`,
    );
    if (extra) console.error(`extra: ${JSON.stringify(extra)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("attachLibraryRemoteSyncStream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    MockEventSource.instances = [];
    getApiBaseUrlMock.mockReset().mockReturnValue("http://api.test");
    getLibraryMetaMock.mockReset().mockResolvedValue({ exists: true, version: 2 });
    getMeMock.mockReset().mockResolvedValue({ id: "user-1" });
    vi.stubGlobal("EventSource", MockEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const createDb = () =>
    ({
      syncFromRemoteIfNewer: vi.fn().mockResolvedValue(false),
      getVersion: vi.fn().mockResolvedValue(1),
      hasPendingSync: vi.fn().mockResolvedValue(false),
      flushPending: vi.fn().mockResolvedValue(undefined),
    }) as const;

  const createRefs = () => ({
    streamRef: { current: null as EventSource | null },
    streamTimerRef: { current: null as number | null },
    fallbackTimerRef: { current: null as number | null },
    lastStreamEventRef: { current: 0 },
    streamHealthTimerRef: { current: null as number | null },
    externalMpvSessionActiveRef: { current: false },
  });

  it("@bugfix @regression-proof disables stream reconnects after repeated quick failures", async () => {
    console.info("[library-remote-sync-stream-integration:quick-failures:setup] attaching stream, token=token-1");
    const { attachLibraryRemoteSyncStream } = await import("../src/renderer/src/lib/libraryRemoteSyncStream");
    const db = createDb();
    const refs = createRefs();
    const cleanup = attachLibraryRemoteSyncStream({
      db: db as never,
      token: "token-1",
      ...refs,
      refreshSnapshot: vi.fn(),
      syncClientConfigFromDb: vi.fn(),
      handleForcedLogout: vi.fn(),
      externalMpvSessionEvent: "sf:external-mpv-session",
    });

    if (MockEventSource.instances.length !== 1) dumpStreamSnapshot("quick-failures:after-attach", refs);
    expect(MockEventSource.instances).toHaveLength(1);

    console.info("[library-remote-sync-stream-integration:quick-failures] error #1 then advance 5000ms (expect reconnect → 2 instances)");
    MockEventSource.instances[0]?.emitError();
    await vi.advanceTimersByTimeAsync(5000);
    if (MockEventSource.instances.length !== 2) dumpStreamSnapshot("quick-failures:after-first-reconnect", refs);
    expect(MockEventSource.instances).toHaveLength(2);

    console.info("[library-remote-sync-stream-integration:quick-failures] error #2 (quick) then advance 60000ms (expect NO reconnect)");
    MockEventSource.instances[1]?.emitError();
    await vi.advanceTimersByTimeAsync(60_000);

    if (MockEventSource.instances.length !== 2 || refs.streamRef.current !== null) {
      dumpStreamSnapshot("quick-failures:final", refs);
    }
    expect(MockEventSource.instances).toHaveLength(2);
    expect(refs.streamRef.current).toBeNull();
    cleanup();
  });

  it("@bugfix @regression-proof pauses the stream during external mpv sessions and reconnects afterward", async () => {
    console.info("[library-remote-sync-stream-integration:mpv-pause:setup] attaching stream, token=token-1");
    const { attachLibraryRemoteSyncStream } = await import("../src/renderer/src/lib/libraryRemoteSyncStream");
    const db = createDb();
    const refs = createRefs();
    const cleanup = attachLibraryRemoteSyncStream({
      db: db as never,
      token: "token-1",
      ...refs,
      refreshSnapshot: vi.fn(),
      syncClientConfigFromDb: vi.fn(),
      handleForcedLogout: vi.fn(),
      externalMpvSessionEvent: "sf:external-mpv-session",
    });

    const first = MockEventSource.instances[0];
    if (!first) dumpStreamSnapshot("mpv-pause:after-attach", refs);
    expect(first).toBeTruthy();

    console.info("[library-remote-sync-stream-integration:mpv-pause] dispatch active=true (expect first stream closed + streamRef null)");
    window.dispatchEvent(new CustomEvent("sf:external-mpv-session", { detail: { active: true } }));
    if (first?.closed !== true || refs.streamRef.current !== null) {
      dumpStreamSnapshot("mpv-pause:after-active", refs, { firstClosed: first?.closed });
    }
    expect(first?.closed).toBe(true);
    expect(refs.streamRef.current).toBeNull();

    console.info("[library-remote-sync-stream-integration:mpv-pause] dispatch active=false (expect reconnect → 2 instances, streamRef=2nd)");
    window.dispatchEvent(new CustomEvent("sf:external-mpv-session", { detail: { active: false } }));
    if (MockEventSource.instances.length !== 2 || refs.streamRef.current !== (MockEventSource.instances[1] as unknown as EventSource)) {
      dumpStreamSnapshot("mpv-pause:after-resume", refs);
    }
    expect(MockEventSource.instances).toHaveLength(2);
    expect(refs.streamRef.current).toBe(MockEventSource.instances[1] as unknown as EventSource);

    cleanup();
  });

  it("@bugfix auth-me-flood-during-playback @regression-proof debounces /auth/me probes across repeated stream errors", async () => {
    // Non-zero baseline so markStreamEvent stores a truthy timestamp; otherwise the health
    // timer's `if (!lastStreamEventRef.current) return true` declares the stream stale and
    // forces a reconnect at the 10s tick, polluting the instances array.
    vi.setSystemTime(1_000_000);
    const { attachLibraryRemoteSyncStream, LIBRARY_STREAM_AUTH_PROBE_MIN_INTERVAL_MS } = await import(
      "../src/renderer/src/lib/libraryRemoteSyncStream"
    );
    const db = createDb();
    const refs = createRefs();
    getMeMock.mockResolvedValue({ user: { id: "user-1" } });

    const cleanup = attachLibraryRemoteSyncStream({
      db: db as never,
      token: "token-1",
      ...refs,
      refreshSnapshot: vi.fn(),
      syncClientConfigFromDb: vi.fn(),
      handleForcedLogout: vi.fn(),
      externalMpvSessionEvent: "sf:external-mpv-session",
    });

    MockEventSource.instances[0]?.emit("open");
    expect(MockEventSource.instances).toHaveLength(1);

    // First error: stream lived 20s before failing — not a "quick failure", so probe should fire.
    await vi.advanceTimersByTimeAsync(20_000);
    MockEventSource.instances[0]?.emitError();
    await Promise.resolve();
    expect(getMeMock).toHaveBeenCalledTimes(1);

    // Reconnect after 5s; mark new stream alive and live another 20s before failing.
    // Time since first probe is 25s — still inside the 30s debounce window.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(MockEventSource.instances).toHaveLength(2);
    MockEventSource.instances[1]?.emit("open");
    await vi.advanceTimersByTimeAsync(20_000);
    MockEventSource.instances[1]?.emitError();
    await Promise.resolve();
    expect(getMeMock).toHaveBeenCalledTimes(1);

    // Reconnect, then wait past the debounce window — next error must probe again.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(MockEventSource.instances).toHaveLength(3);
    MockEventSource.instances[2]?.emit("open");
    await vi.advanceTimersByTimeAsync(LIBRARY_STREAM_AUTH_PROBE_MIN_INTERVAL_MS);
    MockEventSource.instances[2]?.emitError();
    await Promise.resolve();
    expect(getMeMock).toHaveBeenCalledTimes(2);

    cleanup();
  });

  it("@bugfix @regression-proof logs the user out when fallback polling gets a 401", async () => {
    const api = await import("@/api");
    const { attachLibraryRemoteSyncStream, LIBRARY_STREAM_FALLBACK_INTERVAL_MS } = await import(
      "../src/renderer/src/lib/libraryRemoteSyncStream"
    );
    const db = createDb();
    const refs = createRefs();
    const handleForcedLogout = vi.fn().mockResolvedValue(undefined);
    getLibraryMetaMock.mockRejectedValue(new api.ApiError(401, { error: "unauthorized" }));

    const cleanup = attachLibraryRemoteSyncStream({
      db: db as never,
      token: "token-1",
      ...refs,
      refreshSnapshot: vi.fn(),
      syncClientConfigFromDb: vi.fn(),
      handleForcedLogout,
      externalMpvSessionEvent: "sf:external-mpv-session",
    });

    await vi.advanceTimersByTimeAsync(LIBRARY_STREAM_FALLBACK_INTERVAL_MS);
    await Promise.resolve();

    expect(handleForcedLogout).toHaveBeenCalledWith("fallback_401");
    cleanup();
  });

  it("@bugfix online-no-auto-offline-2026-06-04 @regression-proof fires onBackendUnreachable (NOT forced-logout) when the fallback poll fails with a NON-401 connection error", async () => {
    console.info(
      "[library-remote-sync-stream-integration:fallback-unreachable:setup] " +
        "attaching stream; fallback getLibraryMeta will reject with a connection error"
    );
    const { attachLibraryRemoteSyncStream, LIBRARY_STREAM_FALLBACK_INTERVAL_MS } = await import(
      "../src/renderer/src/lib/libraryRemoteSyncStream"
    );
    const db = createDb();
    const refs = createRefs();
    const handleForcedLogout = vi.fn().mockResolvedValue(undefined);
    const onBackendUnreachable = vi.fn();
    // navigator.onLine must be true: the hint only fires while the OS link is up
    // (a genuine OS-offline state is owned by load()'s !online branch).
    Object.defineProperty(window.navigator, "onLine", { value: true, configurable: true });
    // A backend-down rejection: bare fetch surfaces "fetch failed" / ECONNREFUSED.
    getLibraryMetaMock.mockRejectedValue(new Error("fetch failed"));

    const cleanup = attachLibraryRemoteSyncStream({
      db: db as never,
      token: "token-1",
      ...refs,
      refreshSnapshot: vi.fn(),
      syncClientConfigFromDb: vi.fn(),
      handleForcedLogout,
      onBackendUnreachable,
      externalMpvSessionEvent: "sf:external-mpv-session",
    });

    // The stream is fresh; lastStreamEventRef=0 → isStreamStale() true → the
    // fallback poll runs at the first interval tick.
    await vi.advanceTimersByTimeAsync(LIBRARY_STREAM_FALLBACK_INTERVAL_MS);
    await Promise.resolve();
    await Promise.resolve();

    if (onBackendUnreachable.mock.calls.length !== 1 || handleForcedLogout.mock.calls.length !== 0) {
      dumpStreamSnapshot("fallback-unreachable:final", refs, {
        onBackendUnreachableCalls: onBackendUnreachable.mock.calls,
        handleForcedLogoutCalls: handleForcedLogout.mock.calls,
      });
    }
    // A connection error is NOT an auth revocation: the forced-logout path stays
    // untouched, and the provider gets the hint to confirm + flip offline.
    expect(handleForcedLogout).not.toHaveBeenCalled();
    expect(onBackendUnreachable).toHaveBeenCalledTimes(1);
    expect(onBackendUnreachable).toHaveBeenCalledWith("fallback_poll_failed");
    cleanup();
  });

  // #25 M3-obs (ultimate x058): the SSE stream is closed for the whole external
  // mpv session, so the fallback poll runs every 30 s while the user watches. One
  // slow meta (ERR_EMPTY_RESPONSE on a loaded host) hinted an outage, the
  // provider's 5 s probe timed out, and its reload() closed the open library and
  // unmounted the playback controller under the still-playing mpv: the library
  // and the details dialog came back 20 s later (12 s after mpv exited). A failed
  // poll during the session must not hint; the first poll after it still does.
  it("@bugfix @regression-proof #25 M3-obs: no onBackendUnreachable hint while an external mpv session is active, hints again after it", async () => {
    const T = "[library-remote-sync-stream-integration:mpv-session-no-hint]";
    // Dynamic import like the sibling cases: beforeEach's vi.resetModules gives each case fresh module state.
    const { attachLibraryRemoteSyncStream, LIBRARY_STREAM_FALLBACK_INTERVAL_MS } = await import(
      "../src/renderer/src/lib/libraryRemoteSyncStream"
    );
    const db: LibraryDb = Object.assign(Object.create(null), createDb());
    const refs = createRefs();
    const handleForcedLogout = vi.fn().mockResolvedValue(undefined);
    const onBackendUnreachable = vi.fn();
    Object.defineProperty(window.navigator, "onLine", { value: true, configurable: true });
    getLibraryMetaMock.mockRejectedValue(new Error("Failed to fetch"));

    const cleanup = attachLibraryRemoteSyncStream({
      db,
      token: "token-1",
      ...refs,
      refreshSnapshot: vi.fn(),
      syncClientConfigFromDb: vi.fn(),
      handleForcedLogout,
      onBackendUnreachable,
      externalMpvSessionEvent: "sf:external-mpv-session",
    });

    console.info(`${T} dispatch active=true, then one failing fallback poll`);
    window.dispatchEvent(new CustomEvent("sf:external-mpv-session", { detail: { active: true } }));
    await vi.advanceTimersByTimeAsync(LIBRARY_STREAM_FALLBACK_INTERVAL_MS);
    const metaCallsDuringSession = getLibraryMetaMock.mock.calls.length;
    const hintsDuringSession = onBackendUnreachable.mock.calls.length;

    console.info(`${T} dispatch active=false, then one failing fallback poll`);
    window.dispatchEvent(new CustomEvent("sf:external-mpv-session", { detail: { active: false } }));
    await vi.advanceTimersByTimeAsync(LIBRARY_STREAM_FALLBACK_INTERVAL_MS);

    if (metaCallsDuringSession !== 1 || hintsDuringSession !== 0 || onBackendUnreachable.mock.calls.length !== 1) {
      dumpStreamSnapshot("mpv-session-no-hint:final", refs, {
        metaCallsDuringSession,
        hintsDuringSession,
        onBackendUnreachableCalls: onBackendUnreachable.mock.calls,
      });
    }
    // The poll itself keeps running during the session (it is the only sync path then).
    expect(metaCallsDuringSession).toBe(1);
    expect(hintsDuringSession).toBe(0);
    expect(onBackendUnreachable).toHaveBeenCalledTimes(1);
    expect(onBackendUnreachable).toHaveBeenCalledWith("fallback_poll_failed");
    expect(handleForcedLogout).not.toHaveBeenCalled();
    cleanup();
  });

  it("@regression-proof does NOT fire onBackendUnreachable on a 401 (forced-logout owns it)", async () => {
    const api = await import("@/api");
    const { attachLibraryRemoteSyncStream, LIBRARY_STREAM_FALLBACK_INTERVAL_MS } = await import(
      "../src/renderer/src/lib/libraryRemoteSyncStream"
    );
    const db = createDb();
    const refs = createRefs();
    const handleForcedLogout = vi.fn().mockResolvedValue(undefined);
    const onBackendUnreachable = vi.fn();
    Object.defineProperty(window.navigator, "onLine", { value: true, configurable: true });
    getLibraryMetaMock.mockRejectedValue(new api.ApiError(401, { error: "unauthorized" }));

    const cleanup = attachLibraryRemoteSyncStream({
      db: db as never,
      token: "token-1",
      ...refs,
      refreshSnapshot: vi.fn(),
      syncClientConfigFromDb: vi.fn(),
      handleForcedLogout,
      onBackendUnreachable,
      externalMpvSessionEvent: "sf:external-mpv-session",
    });

    await vi.advanceTimersByTimeAsync(LIBRARY_STREAM_FALLBACK_INTERVAL_MS);
    await Promise.resolve();
    await Promise.resolve();

    if (handleForcedLogout.mock.calls.length !== 1 || onBackendUnreachable.mock.calls.length !== 0) {
      dumpStreamSnapshot("fallback-401-no-hint:final", refs, {
        onBackendUnreachableCalls: onBackendUnreachable.mock.calls,
        handleForcedLogoutCalls: handleForcedLogout.mock.calls,
      });
    }
    expect(handleForcedLogout).toHaveBeenCalledWith("fallback_401");
    expect(onBackendUnreachable).not.toHaveBeenCalled();
    cleanup();
  });

  // #25 P11 (ultimate c070): after a relaunch the runtime spent ~62 s opening
  // the library while the SSE stream delivered a meta per version bump. Each
  // started its own syncFromRemoteIfNewer(meta) IPC → main → runtime and held
  // the (then tens-of-MB) meta in all three processes until the runtime got to
  // it: 135 in flight, renderer/main/runtime each grew ~2 GB in lockstep.
  it("@bugfix @regression-proof #25 P11: a burst of SSE metas runs ONE sync at a time, coalesced to the newest, without history arrays", async () => {
    const T = "[library-remote-sync-stream-integration:p11-coalesce]";
    const { attachLibraryRemoteSyncStream } = await import("../src/renderer/src/lib/libraryRemoteSyncStream");
    const db = createDb();
    const pending: Array<(changed: boolean) => void> = [];
    db.syncFromRemoteIfNewer.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          pending.push(resolve);
        })
    );
    const refs = createRefs();
    const refreshSnapshot = vi.fn().mockResolvedValue(undefined);
    const cleanup = attachLibraryRemoteSyncStream({
      db: db as never,
      token: "token-1",
      ...refs,
      refreshSnapshot,
      syncClientConfigFromDb: vi.fn().mockResolvedValue(undefined),
      handleForcedLogout: vi.fn(),
      externalMpvSessionEvent: "sf:external-mpv-session",
    });
    const es = MockEventSource.instances[0];
    expect(es?.onmessage).toBeTruthy();

    // A pre-fix API meta: every op since the last snapshot, ciphertext inlined.
    const OPS = 40;
    const fatHistory = Array.from({ length: OPS }, (_, i) => ({
      opId: `op-${i}`,
      objectKey: `library/badger/ops/op-${i}`,
      version: 100 + i,
      createdAt: "2026-10-06T00:00:00.000Z",
      size: 75_000,
      payloadCiphertext: "A".repeat(100_000),
    }));
    const BURST = 50;
    for (let i = 0; i < BURST; i += 1) {
      const meta = { exists: true, version: 200 + i, snapshotVersion: 99, opsHistory: fatHistory, snapshotHistory: [] };
      es!.onmessage!({ data: JSON.stringify(meta) } as MessageEvent<string>);
    }
    await Promise.resolve();

    const argBytes = (call: unknown[]) => JSON.stringify(call[0] ?? null).length;
    const inFlightBytes = db.syncFromRemoteIfNewer.mock.calls.reduce((sum, call) => sum + argBytes(call), 0);
    console.info(
      `${T} after burst of ${BURST} metas (${JSON.stringify({ version: 0, opsHistory: fatHistory }).length} B each): syncCalls=${db.syncFromRemoteIfNewer.mock.calls.length} hasPendingSyncCalls=${db.hasPendingSync.mock.calls.length} inFlightArgBytes=${inFlightBytes}`
    );
    const dump = () =>
      dumpStreamSnapshot("p11-coalesce", refs, {
        syncCalls: db.syncFromRemoteIfNewer.mock.calls.map((call) => ({
          version: (call[0] as { version?: number } | undefined)?.version,
          bytes: argBytes(call),
        })),
        pendingResolvers: pending.length,
      });
    try {
      expect(db.syncFromRemoteIfNewer).toHaveBeenCalledTimes(1);
      expect(db.hasPendingSync).toHaveBeenCalledTimes(1);
      const first = db.syncFromRemoteIfNewer.mock.calls[0]?.[0] as { version: number; opsHistory: unknown[] };
      expect(first.version).toBe(200);
      expect(first.opsHistory).toEqual([]);
      expect(inFlightBytes).toBeLessThan(4096);
    } catch (err) {
      dump();
      throw err;
    }

    console.info(`${T} resolving first sync (changed=true) → expect ONE drain sync at the newest version ${200 + BURST - 1}`);
    pending.shift()!(true);
    await vi.advanceTimersByTimeAsync(0);
    try {
      expect(db.syncFromRemoteIfNewer).toHaveBeenCalledTimes(2);
      const second = db.syncFromRemoteIfNewer.mock.calls[1]?.[0] as { version: number; snapshotHistory: unknown[] };
      expect(second.version).toBe(200 + BURST - 1);
      expect(second.snapshotHistory).toEqual([]);
      expect(refreshSnapshot).toHaveBeenCalledTimes(1);
    } catch (err) {
      dump();
      throw err;
    }

    console.info(`${T} resolving drain sync → queue empty, no further calls`);
    pending.shift()!(false);
    await vi.advanceTimersByTimeAsync(0);
    if (db.syncFromRemoteIfNewer.mock.calls.length !== 2) dump();
    expect(db.syncFromRemoteIfNewer).toHaveBeenCalledTimes(2);
    cleanup();
  });
});
