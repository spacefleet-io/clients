/**
 * @test-id PROXY-RESTART-RETRY-001
 * @bugfix
 * @regression-proof
 * @level unit
 * @issue #25 (ultimate stress run, finding P2)
 * @why After any runtime restart, opening a title failed with
 *      `Error invoking remote method 'sf-library-db-call': TypeError: fetch failed`
 *      (c039, c041, c059, c062). The proxy sent each library call exactly once,
 *      with no wait for the guardian's "ready" and the library re-open, so a call
 *      that raced the respawn surfaced the connection error to the renderer.
 *      Calls must now wait for the restart and retry once when that is safe:
 *      reads and absolute setters always, other writes only when the runtime
 *      provably never executed them (connect refused / LIBRARY_DB_NOT_OPEN).
 * @covers apps/badger/desktop/src/main/libraryDbRuntimeProxy.ts
 *         (`sf-library-db-call`, `noteRuntimeRestarting`, `noteRuntimeLost`,
 *         `classifyLibraryCallFailure`, gate release in `reopenAfterRuntimeRespawn`)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock("../src/main/libraryDbAccessor", () => ({ setLibraryDbAccessorToken: vi.fn() }));
// Proxy log events double as the test's synchronisation signal: instead of
// sleeping, a test awaits the event the proxy logs right before it parks a
// call on the restart gate.
const proxyLog = vi.hoisted(() => {
  const events: string[] = [];
  const waiters: Array<{ event: string; resolve: () => void }> = [];
  const record = (level: string, args: unknown[]) => {
    const fields = (args[0] ?? {}) as { event?: string };
    console.info(`[proxy:${level}]`, JSON.stringify(args[0]), args[1] ?? "");
    if (!fields.event) return;
    events.push(fields.event);
    for (const waiter of waiters.filter((w) => w.event === fields.event)) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  };
  const next = (event: string): Promise<void> =>
    new Promise((resolve) => {
      waiters.push({ event, resolve });
    });
  return { events, waiters, record, next };
});
vi.mock("../src/main/logger", () => ({
  scopeLogger: () => ({
    info: (...args: unknown[]) => proxyLog.record("info", args),
    warn: (...args: unknown[]) => proxyLog.record("warn", args),
    error: (...args: unknown[]) => proxyLog.record("error", args),
    debug: vi.fn(),
  }),
}));

process.env.SF_RUNTIME_BASE_URL = "http://mock-runtime:3020";

import {
  classifyLibraryCallFailure,
  noteRuntimeLost,
  noteRuntimeRestarting,
  registerLibraryDbRuntimeProxy,
  reopenAfterRuntimeReady,
  resetLibraryDbRuntimeProxyForTests,
  RESTART_PROBE_INTERVAL_MS,
  RUNTIME_GUARDIAN_RESTART_WAIT_MS,
  RUNTIME_RESTART_WAIT_MS,
} from "../src/main/libraryDbRuntimeProxy";

const TAG = "[proxy-restart-retry]";

type IpcHandler = (event: unknown, payload: unknown) => Promise<unknown>;
type Failure = "refused" | "dropped" | "not-open";
type CommandCall = { command: string; method?: string; at: number };

const refusedError = () =>
  Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3020"), { code: "ECONNREFUSED" }),
  });
const droppedError = () =>
  Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
  });
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/**
 * Fake runtime. `failNextDbCalls(n, kind)` makes the next n `badger.db.call`s fail
 * the way the respawning runtime did; `setDown` makes every request refuse.
 */
const createRuntime = () => {
  const commands: CommandCall[] = [];
  let down = false;
  let dbCallFailures: Failure[] = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    const body = init?.body ? (JSON.parse(String(init.body)) as { command?: string; payload?: { method?: string } }) : {};
    if (urlStr.includes("/modules/badger/commands")) {
      commands.push({ command: body.command ?? "", method: body.payload?.method, at: Date.now() });
    }
    if (down) throw refusedError();
    if (urlStr.includes("/runtime/session/login")) {
      return json({ ok: true, token: "rt", expiresAt: new Date(Date.now() + 60_000).toISOString(), capabilities: { apps: ["badger"] } });
    }
    if (!urlStr.includes("/modules/badger/commands")) return new Response("not found", { status: 404 });
    if (body.command === "badger.db.call" && dbCallFailures.length > 0) {
      const failure = dbCallFailures.shift();
      if (failure === "refused") throw refusedError();
      if (failure === "dropped") throw droppedError();
      return json({
        requestId: "r",
        ok: false,
        result: null,
        error: { code: "internal_error", message: "LIBRARY_DB_NOT_OPEN", retryable: false, details: {} },
      });
    }
    if (body.command === "badger.db.snapshot") {
      return json({ requestId: "r", ok: true, result: { media: [], mediaDetails: [], playlists: [], version: 1 }, error: null });
    }
    if (body.command === "badger.db.status") {
      return json({ requestId: "r", ok: true, result: { open: true, version: 1, datasetStatus: { core: true } }, error: null });
    }
    if (body.command === "badger.db.call") {
      return json({ requestId: "r", ok: true, result: { method: body.payload?.method, served: true }, error: null });
    }
    return json({ requestId: "r", ok: true, result: {}, error: null });
  });
  return {
    fetchMock,
    commands,
    setDown: (value: boolean) => {
      down = value;
    },
    failNextDbCalls: (n: number, kind: Failure) => {
      dbCallFailures = Array.from({ length: n }, () => kind);
    },
    dbCalls: (method: string) => commands.filter((c) => c.command === "badger.db.call" && c.method === method),
    dump: (label: string) =>
      console.error(`${TAG}[${label}] command ledger=${JSON.stringify(commands.map((c) => `${c.command}:${c.method ?? ""}`))}`),
  };
};

describe("[@bugfix][@regression-proof] library DB runtime proxy: calls survive a runtime restart (#25 P2)", () => {
  let handlers: Map<string, IpcHandler>;
  let runtime: ReturnType<typeof createRuntime>;

  const call = (method: string, args: unknown[] = []) => handlers.get("sf-library-db-call")!({}, { method, args });

  /** Guardian "ready" after the runtime came back: re-open, which releases the restart gate. */
  const respawn = async (why: string) => {
    console.info(`${TAG} runtime back (${why}); guardian ready -> reopenAfterRuntimeReady`);
    runtime.setDown(false);
    const result = await reopenAfterRuntimeReady();
    console.info(`${TAG} reopen result=${JSON.stringify(result)}`);
  };
  /** Respawn once the proxy has parked a failed call for its retry. */
  const respawnWhenRetryParked = async () => {
    await proxyLog.next("library_call_retrying_after_restart");
    await respawn("call parked for retry");
  };

  beforeEach(async () => {
    proxyLog.events.length = 0;
    proxyLog.waiters.length = 0;
    await resetLibraryDbRuntimeProxyForTests().catch(() => {});
    handlers = new Map();
    runtime = createRuntime();
    vi.stubGlobal("fetch", runtime.fetchMock);
    registerLibraryDbRuntimeProxy({
      handle: (channel: string, handler: IpcHandler) => handlers.set(channel, handler),
    } as unknown as Parameters<typeof registerLibraryDbRuntimeProxy>[0]);
    await handlers.get("sf-library-db-open")!({}, { token: "backend-A", keyBase64: "key-A" });
    console.info(`${TAG} setup: library open, commands so far=${runtime.commands.length}`);
  });

  afterEach(async () => {
    await resetLibraryDbRuntimeProxyForTests().catch(() => {});
    vi.unstubAllGlobals();
  });

  it("a read that hits a refused connection waits for the re-open and succeeds", async () => {
    runtime.setDown(true);
    const pending = call("getMediaDetails", ["m1"]);
    const respawned = respawnWhenRetryParked();
    try {
      await expect(pending).resolves.toEqual({ method: "getMediaDetails", served: true });
      await respawned;
      expect(runtime.dbCalls("getMediaDetails")).toHaveLength(2);
    } catch (err) {
      runtime.dump("read-refused");
      throw err;
    }
  });

  it("while the guardian reports restarting, a call is held and sent once after the re-open", async () => {
    noteRuntimeRestarting();
    runtime.setDown(true);
    const pending = call("getMediaDetails", ["m1"]);
    // Drain the event loop (zero-delay turns, no wall-clock wait): an unheld
    // call reaches the (down) runtime within a few turns.
    for (let turn = 0; turn < 50; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    const sentWhileDown = runtime.dbCalls("getMediaDetails").length;
    console.info(`${TAG} held call: getMediaDetails sent while restarting=${sentWhileDown}`);
    await respawn("guardian ready after restarting");
    try {
      expect(sentWhileDown).toBe(0);
      await expect(pending).resolves.toEqual({ method: "getMediaDetails", served: true });
      expect(runtime.dbCalls("getMediaDetails")).toHaveLength(1);
    } catch (err) {
      runtime.dump("held-while-restarting");
      throw err;
    }
  });

  it("an absolute setter whose connection dropped mid-request is replayed once", async () => {
    runtime.failNextDbCalls(1, "dropped");
    runtime.setDown(false);
    const pending = call("setProgress", ["m1", 42, null, null]);
    await respawnWhenRetryParked();
    try {
      await expect(pending).resolves.toEqual({ method: "setProgress", served: true });
      expect(runtime.dbCalls("setProgress")).toHaveLength(2);
    } catch (err) {
      runtime.dump("setter-dropped");
      throw err;
    }
  });

  it("a drop with no guardian restart (transient, or after the re-open) is retried once the probe sees the library open", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      runtime.failNextDbCalls(1, "dropped");
      const pending = call("getMediaDetails", ["m1"]);
      await proxyLog.next("library_call_retrying_after_restart");
      console.info(`${TAG} transient: call parked, advancing ${RESTART_PROBE_INTERVAL_MS} ms to the first probe`);
      await vi.advanceTimersByTimeAsync(RESTART_PROBE_INTERVAL_MS);
      await expect(pending).resolves.toEqual({ method: "getMediaDetails", served: true });
      expect(proxyLog.events).toContain("runtime_restart_probe_ok");
      expect(runtime.dbCalls("getMediaDetails")).toHaveLength(2);
    } catch (err) {
      runtime.dump("transient-probe");
      throw err;
    } finally {
      vi.useRealTimers();
    }
  });

  // #25 P20 / P2 residual (confirm run S1): 278 setProgress calls failed twice
  // because the 20 s wait expired while the guardian was still respawning.
  it("@bugfix @regression-proof a call waits past RUNTIME_RESTART_WAIT_MS once the guardian owns the restart (#25 P20)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      runtime.setDown(true);
      const pending = call("setProgress", ["m1", 42, null, null]);
      await proxyLog.next("library_call_retrying_after_restart");
      console.info(`${TAG} guardian-wait: call parked; guardian reports restarting`);
      noteRuntimeRestarting();
      const outageMs = RUNTIME_RESTART_WAIT_MS + 25_000;
      await vi.advanceTimersByTimeAsync(outageMs);
      const sentDuringOutage = runtime.dbCalls("setProgress").length;
      console.info(
        `${TAG} guardian-wait: after ${outageMs} ms sent=${sentDuringOutage} events=${JSON.stringify(proxyLog.events.slice(-6))}`,
      );
      expect(sentDuringOutage).toBe(1);
      expect(outageMs).toBeLessThan(RUNTIME_GUARDIAN_RESTART_WAIT_MS);
      await respawn("guardian ready after a long respawn");
      // A write then awaits its snapshot frame (bounded by a fake timer): drive it.
      const settled = expect(pending).resolves.toEqual({ method: "setProgress", served: true });
      await vi.advanceTimersByTimeAsync(5_000);
      await settled;
      expect(runtime.dbCalls("setProgress")).toHaveLength(2);
      expect(proxyLog.events).not.toContain("library_call_retry_failed");
    } catch (err) {
      runtime.dump("guardian-owned-wait");
      throw err;
    } finally {
      vi.useRealTimers();
    }
  });

  it("a non-idempotent write whose connection dropped mid-request is NOT replayed", async () => {
    runtime.failNextDbCalls(1, "dropped");
    const pending = call("addMediaFormat", ["m1", { quality: "720p" }]);
    try {
      await expect(pending).rejects.toThrow(/fetch failed/);
      expect(runtime.dbCalls("addMediaFormat")).toHaveLength(1);
    } catch (err) {
      runtime.dump("insert-dropped");
      throw err;
    }
  });

  it("a write the fresh runtime rejected with LIBRARY_DB_NOT_OPEN is retried after the re-open", async () => {
    runtime.failNextDbCalls(1, "not-open");
    const pending = call("addMediaFormat", ["m1", { quality: "720p" }]);
    await respawnWhenRetryParked();
    try {
      await expect(pending).resolves.toEqual({ method: "addMediaFormat", served: true });
      expect(runtime.dbCalls("addMediaFormat")).toHaveLength(2);
    } catch (err) {
      runtime.dump("not-open");
      throw err;
    }
  });

  // The gate's own bound is RUNTIME_GUARDIAN_RESTART_WAIT_MS (120 s), far above the test
  // timeout: settling at all proves "lost" released the call.
  it("guardian 'lost' releases held calls so they fail fast instead of hanging", async () => {
    noteRuntimeRestarting();
    runtime.setDown(true);
    const pending = call("getMediaDetails", ["m1"]);
    noteRuntimeLost();
    await expect(pending).rejects.toThrow(/fetch failed/);
    expect(runtime.dbCalls("getMediaDetails")).toHaveLength(1);
    expect(proxyLog.events).toContain("library_call_failed_no_retry");
  });

  // run 7903 runtime-crash-recovery: external runtime (SF_RUNTIME_BASE_URL) means
  // no guardian, so nothing but the probe can release a call-opened gate. When the
  // probe window expired without recovery the gate stayed open forever and every
  // later call paid RUNTIME_RESTART_WAIT_MS before-send + RUNTIME_RESTART_WAIT_MS
  // before-retry (~40 s) instead of one bounded wait.
  it("[@bugfix][@regression-proof] a call-opened gate is released when the probe window expires with no guardian", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const T = `${TAG}[probe-timeout]`;
    try {
      runtime.setDown(true);
      console.info(`${T} phase=A-send runtime down, no guardian notes`);
      let aSettledAt: number | null = null;
      const a = call("getMediaDetails", ["a"]).then(
        () => {
          aSettledAt = Date.now();
          return "resolved" as const;
        },
        (err: unknown) => {
          aSettledAt = Date.now();
          console.info(`${T} A rejected: ${err instanceof Error ? err.message : String(err)}`);
          return "rejected" as const;
        },
      );
      await proxyLog.next("library_call_retrying_after_restart");
      const aStart = Date.now();
      await vi.advanceTimersByTimeAsync(RUNTIME_RESTART_WAIT_MS + RESTART_PROBE_INTERVAL_MS);
      console.info(`${T} phase=A-settle outcome=${await a} afterMs=${aSettledAt === null ? "pending" : aSettledAt - aStart}`);
      expect(await a).toBe("rejected");
      expect(proxyLog.events).toContain("runtime_restart_gate_released");

      console.info(`${T} phase=B-send events so far=${JSON.stringify(proxyLog.events)}`);
      let bOutcome: "pending" | "resolved" | "rejected" = "pending";
      const bStart = Date.now();
      const b = call("getMediaDetails", ["b"]).then(
        () => {
          console.info(`${T} B resolved`);
          bOutcome = "resolved";
        },
        (err: unknown) => {
          console.info(`${T} B rejected: ${err instanceof Error ? err.message : String(err)}`);
          bOutcome = "rejected";
        },
      );
      await vi.advanceTimersByTimeAsync(RUNTIME_RESTART_WAIT_MS + RESTART_PROBE_INTERVAL_MS);
      console.info(`${T} phase=B-check outcome=${bOutcome} elapsedMs=${Date.now() - bStart}`);
      if (bOutcome === "pending") {
        console.error(`${T} B still pending: events=${JSON.stringify(proxyLog.events)}`);
        runtime.dump("probe-timeout");
      }
      expect(bOutcome).toBe("rejected");
      // B went straight to the runtime: only A's and B's before-retry waits, no
      // before-send wait behind A's stale gate.
      expect(proxyLog.events.filter((e) => e === "library_call_waited_for_runtime")).toHaveLength(2);
      expect(proxyLog.events).toContain("runtime_restart_probe_timeout");
      // Drain B's handlers; the afterEach reset releases any gate B opened.
      await vi.advanceTimersByTimeAsync(RUNTIME_RESTART_WAIT_MS + RESTART_PROBE_INTERVAL_MS);
      await b;
    } finally {
      vi.useRealTimers();
    }
  });

  // run 7950 runtime-crash-recovery: the probe-timeout release above fired, but a
  // call that was already parked before-send behind the dying gate then sent,
  // failed not-delivered, opened a FRESH gate and waited RUNTIME_RESTART_WAIT_MS
  // again before its retry: ~2 x RUNTIME_RESTART_WAIT_MS for one call, over the
  // e2e test's 30 s budget. A gate released because the runtime did NOT recover
  // must end the call's waiting: send once, fail fast.
  it("[@bugfix][@regression-proof] a call parked behind a gate released by probe-timeout fails within one RUNTIME_RESTART_WAIT_MS", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const T = `${TAG}[parked-probe-timeout]`;
    const B_START_OFFSET_MS = 3_000;
    try {
      runtime.setDown(true);
      const t0 = Date.now();
      console.info(`${T} phase=A-send runtime down, no guardian notes`);
      const a = call("getMediaDetails", ["a"]).then(
        () => "resolved" as const,
        () => "rejected" as const,
      );
      await proxyLog.next("library_call_retrying_after_restart");
      await vi.advanceTimersByTimeAsync(B_START_OFFSET_MS);

      console.info(`${T} phase=B-send at t0+${Date.now() - t0}ms (gate still held)`);
      let bOutcome: "pending" | "resolved" | "rejected" = "pending";
      let bSettledAt: number | null = null;
      const b = call("getMediaDetails", ["b"]).then(
        () => {
          bOutcome = "resolved";
          bSettledAt = Date.now();
        },
        (err: unknown) => {
          console.info(`${T} B rejected: ${err instanceof Error ? err.message : String(err)}`);
          bOutcome = "rejected";
          bSettledAt = Date.now();
        },
      );
      // epsilon = one probe interval past A's gate deadline (t0 + RUNTIME_RESTART_WAIT_MS).
      await vi.advanceTimersByTimeAsync(RUNTIME_RESTART_WAIT_MS - B_START_OFFSET_MS + RESTART_PROBE_INTERVAL_MS);
      console.info(
        `${T} phase=B-check at t0+${Date.now() - t0}ms outcome=${bOutcome} settledAt=${bSettledAt === null ? "pending" : `t0+${bSettledAt - t0}ms`}`,
      );
      if (bOutcome === "pending") {
        console.error(`${T} B still pending: events=${JSON.stringify(proxyLog.events)}`);
        runtime.dump("parked-probe-timeout");
      }
      expect(proxyLog.events).toContain("runtime_restart_probe_timeout");
      expect(bOutcome).toBe("rejected");
      expect(bSettledAt! - t0).toBeLessThanOrEqual(RUNTIME_RESTART_WAIT_MS + RESTART_PROBE_INTERVAL_MS);
      // A send + A retry + B's single send: B never re-waits for a retry.
      expect(runtime.dbCalls("getMediaDetails")).toHaveLength(3);
      expect(await a).toBe("rejected");
      await vi.advanceTimersByTimeAsync(RUNTIME_RESTART_WAIT_MS + RESTART_PROBE_INTERVAL_MS);
      await b;
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies connection failures by whether the runtime could have executed the call", () => {
    expect(classifyLibraryCallFailure(refusedError())).toBe("not-delivered");
    expect(
      classifyLibraryCallFailure(
        Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
        }),
      ),
    ).toBe("not-delivered");
    expect(classifyLibraryCallFailure(droppedError())).toBe("connection-dropped");
    expect(
      classifyLibraryCallFailure(
        Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) }),
      ),
    ).toBe("connection-dropped");
    expect(classifyLibraryCallFailure(new Error("LIBRARY_DB_NOT_OPEN"))).toBe("library-not-open");
    expect(classifyLibraryCallFailure(new Error("decrypt failed"))).toBe("other");
  });
});
