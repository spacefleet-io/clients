/**
 * @test-id PROXY-STARTUP-GATE-001
 * @level unit
 * @issue #928 (low-end Windows: window no longer waits for the runtime spawn)
 * @why The main window now opens while the guardian is still spawning the
 *      runtime (~17 s on a 2-core Celeron). A library open or runtime call made
 *      in that window must wait for the guardian's first "ready" instead of
 *      failing with `fetch failed`, and must be released at once on "lost".
 * @covers apps/badger/desktop/src/main/libraryDbRuntimeProxy.ts
 *         (`noteRuntimeStarting`, `waitForGuardianRuntime`, gate takeover,
 *         `sf-library-db-open` waiting before send)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock("../src/main/libraryDbAccessor", () => ({ setLibraryDbAccessorToken: vi.fn() }));
const proxyLog = vi.hoisted(() => {
  const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const record = (args: unknown[]) => {
    const fields = (args[0] ?? {}) as Record<string, unknown>;
    if (typeof fields.event === "string") events.push({ event: fields.event, fields });
  };
  return { events, record };
});
vi.mock("../src/main/logger", () => ({
  scopeLogger: () => ({
    info: (...args: unknown[]) => proxyLog.record(args),
    warn: (...args: unknown[]) => proxyLog.record(args),
    error: (...args: unknown[]) => proxyLog.record(args),
    debug: vi.fn(),
  }),
}));

process.env.SF_RUNTIME_BASE_URL = "http://mock-runtime:3020";

import {
  noteRuntimeLost,
  noteRuntimeRestarting,
  noteRuntimeStarting,
  registerLibraryDbRuntimeProxy,
  reopenAfterRuntimeReady,
  resetLibraryDbRuntimeProxyForTests,
  waitForGuardianRuntime,
} from "../src/main/libraryDbRuntimeProxy";

type IpcHandler = (event: unknown, payload: unknown) => Promise<unknown>;

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

const createRuntime = () => {
  const commands: string[] = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    const body = init?.body ? (JSON.parse(String(init.body)) as { command?: string }) : {};
    if (urlStr.includes("/runtime/session/login")) {
      return json({ ok: true, token: "rt", expiresAt: new Date(Date.now() + 60_000).toISOString(), capabilities: { apps: ["badger"] } });
    }
    if (!urlStr.includes("/modules/badger/commands")) return new Response("not found", { status: 404 });
    commands.push(body.command ?? "");
    if (body.command === "badger.db.snapshot") {
      return json({ requestId: "r", ok: true, result: { media: [], mediaDetails: [], playlists: [], version: 1 }, error: null });
    }
    if (body.command === "badger.db.status") {
      return json({ requestId: "r", ok: true, result: { open: true, version: 1, datasetStatus: { core: true } }, error: null });
    }
    return json({ requestId: "r", ok: true, result: {}, error: null });
  });
  return { fetchMock, commands };
};

/** Zero-delay event-loop turns (no wall clock): an unheld call reaches the fake runtime within a few. */
const drain = async () => {
  for (let turn = 0; turn < 50; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

/** Records when a promise settles, so a test can assert it is still pending after a drain. */
const track = <T,>(promise: Promise<T>) => {
  const state = { settled: false };
  void promise.then(
    () => { state.settled = true; },
    () => { state.settled = true; },
  );
  return state;
};

describe("library DB runtime proxy: startup gate while the runtime spawns (#928)", () => {
  let handlers: Map<string, IpcHandler>;
  let runtime: ReturnType<typeof createRuntime>;

  beforeEach(async () => {
    proxyLog.events.length = 0;
    await resetLibraryDbRuntimeProxyForTests().catch(() => {});
    handlers = new Map();
    runtime = createRuntime();
    vi.stubGlobal("fetch", runtime.fetchMock);
    registerLibraryDbRuntimeProxy({
      handle: (channel: string, handler: IpcHandler) => handlers.set(channel, handler),
    } as unknown as Parameters<typeof registerLibraryDbRuntimeProxy>[0]);
  });

  afterEach(async () => {
    await resetLibraryDbRuntimeProxyForTests().catch(() => {});
    vi.unstubAllGlobals();
  });

  it("an open made before the first ready is held, then sent once the guardian reports ready", async () => {
    noteRuntimeStarting();
    const open = handlers.get("sf-library-db-open")!({}, { token: "backend-A", keyBase64: "key-A" });
    const openState = track(open);
    await drain();
    expect(openState.settled).toBe(false);
    expect(runtime.commands.filter((c) => c === "badger.db.open")).toHaveLength(0);

    // Guardian "ready": no library was open yet, so the re-open just releases the gate.
    await expect(reopenAfterRuntimeReady()).resolves.toEqual({ reopened: false, reason: "no_cached_payload" });
    await expect(open).resolves.toEqual({ handle: "default" });
    expect(runtime.commands.filter((c) => c === "badger.db.open")).toHaveLength(1);
  });

  it("an offline open is held the same way", async () => {
    noteRuntimeStarting();
    const open = handlers.get("sf-library-db-open-local")!({}, { token: "backend-A", keyBase64: "key-A" });
    await drain();
    expect(runtime.commands.filter((c) => c === "badger.db.open_local")).toHaveLength(0);
    await reopenAfterRuntimeReady();
    await open;
    expect(runtime.commands.filter((c) => c === "badger.db.open_local")).toHaveLength(1);
  });

  it("a runtime call waiting on the start is released on ready", async () => {
    noteRuntimeStarting();
    const waiting = waitForGuardianRuntime("runtime-jobs");
    const state = track(waiting);
    await drain();
    expect(state.settled).toBe(false);
    await reopenAfterRuntimeReady();
    await expect(waiting).resolves.toBeUndefined();
  });

  it("a lost runtime releases the start gate at once instead of holding calls for minutes", async () => {
    noteRuntimeStarting();
    const waiting = waitForGuardianRuntime("keys-set");
    await drain();
    noteRuntimeLost();
    await expect(waiting).resolves.toBeUndefined();
    const released = proxyLog.events.find((e) => e.event === "library_call_waited_for_runtime");
    expect(released?.fields.releaseOutcome).toBe("guardian-lost");
  });

  it("a first spawn that fails over to the restart loop keeps the gate (starting -> restarting)", async () => {
    noteRuntimeStarting();
    const waiting = waitForGuardianRuntime("runtime-jobs");
    const state = track(waiting);
    noteRuntimeRestarting();
    await drain();
    expect(state.settled).toBe(false);
    const takeover = proxyLog.events.find((e) => e.event === "runtime_restart_gate_taken_over");
    expect(takeover?.fields).toMatchObject({ from: "guardian-starting", to: "guardian-restarting" });
    await reopenAfterRuntimeReady();
    await expect(waiting).resolves.toBeUndefined();
  });

  it("with no guardian gate open, waiting resolves immediately and an open goes straight out", async () => {
    await expect(waitForGuardianRuntime("runtime-jobs")).resolves.toBeUndefined();
    await handlers.get("sf-library-db-open")!({}, { token: "backend-A", keyBase64: "key-A" });
    expect(runtime.commands.filter((c) => c === "badger.db.open")).toHaveLength(1);
    expect(proxyLog.events.some((e) => e.event === "library_call_waited_for_runtime")).toBe(false);
  });
});
