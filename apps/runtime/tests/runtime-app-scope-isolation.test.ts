/**
 * RT-SEC-03: a session scoped to one app cannot read or act on another app's
 * data on any runtime surface — the WebSocket event stream, the v2 SSE stream,
 * the v2 job routes, and the connections / modules / connect / disconnect routes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createApp } from "../src/app";
import { runtimeState } from "../src/runtime";
import { RuntimeState } from "../src/state";
import { __resetEngineV2BootStatusForTests, setEngineV2BootStatus } from "../src/core/jobs/engineV2BootStatus";
import { createRuntimeJobsV2Handler, registerRuntimeJobsV2Routes, type RuntimeJobsV2Handler } from "../src/routes/runtimeJobsV2";
import { createEventLog, type EventLogDeps, type EventRow } from "../src/core/jobs/eventLog";
import type { EngineV2, RuntimeJobEvent } from "../src/core/jobs/engineV2";
import { DEFAULT_LANE_CAPS } from "../src/core/jobs/engineV2Lanes";
import type { IngestJobRecord } from "@space/runtime-jobs";
import type { RuntimeEventFrame } from "../src/types";

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

// ---------------------------------------------------------------------------
// (a) WebSocket event stream — RuntimeState fan-out
// ---------------------------------------------------------------------------

describe("WebSocket event stream is scoped to the session's apps", () => {
  const newState = () => new RuntimeState(60_000, 50, "1", "/tmp/spacefleet-runtime-slices");

  it("delivers only in-scope apps even when the subscribe frame asks for more @req RT-SEC-03[runtime]", () => {
    const state = newState();
    const session = state.login("badger-only", ["badger"], "u1");
    const frames: RuntimeEventFrame[] = [];
    state.addSubscriber("s1", session.token, (frame) => frames.push(frame));
    state.applyClientFrame("s1", {
      type: "subscribe",
      apps: ["badger", "parrot"],
      channels: ["badger.library", "parrot.sync"],
    });

    state.publish("parrot", "sync", "sync.command_accepted", { requestId: "parrot-secret" });
    state.publish("badger", "library", "library.updated", { version: 1, reason: "x", mediaCount: 0, playlistCount: 0 });

    expect(frames.map((f) => f.app)).toEqual(["badger"]);
    expect(JSON.stringify(frames)).not.toContain("parrot-secret");
  });

  it("delivers nothing when the subscribe frame names no apps in scope @req RT-SEC-03[runtime]", () => {
    const state = newState();
    const session = state.login("parrot-only", ["parrot"], "u1");
    const frames: RuntimeEventFrame[] = [];
    state.addSubscriber("s1", session.token, (frame) => frames.push(frame));
    state.applyClientFrame("s1", { type: "subscribe", apps: ["badger"], channels: ["badger.library"] });
    state.publish("badger", "library", "library.updated", { version: 1, reason: "x", mediaCount: 0, playlistCount: 0 });
    expect(frames).toEqual([]);
  });

  it("filters the replay of past events by scope @req RT-SEC-03[runtime]", () => {
    const state = newState();
    const early = state.publish("badger", "library", "library.updated", { version: 1, reason: "x", mediaCount: 0, playlistCount: 0 });
    state.publish("parrot", "sync", "sync.command_accepted", { requestId: "parrot-secret" });
    state.publish("badger", "library", "library.updated", { version: 2, reason: "x", mediaCount: 0, playlistCount: 0 });

    const session = state.login("badger-only", ["badger"], "u1");
    state.addSubscriber("s1", session.token, () => undefined);
    state.applyClientFrame("s1", {
      type: "subscribe",
      apps: ["badger", "parrot"],
      channels: ["badger.library", "parrot.sync"],
    });
    const replay = state.applyClientFrame("s1", { type: "ack", lastEventId: early.eventId });

    expect(replay.map((f) => f.app)).toEqual(["badger"]);
    const full = state.applyClientFrame("s1", { type: "ack", lastEventId: "unknown-id" });
    expect(full.every((f) => f.app === "badger")).toBe(true);
  });

  it("stops delivering to a subscriber whose session was logged out or expired @req RT-SEC-03[runtime]", () => {
    const state = newState();
    const session = state.login("badger-only", ["badger"], "u1");
    const frames: RuntimeEventFrame[] = [];
    state.addSubscriber("s1", session.token, (frame) => frames.push(frame));
    state.applyClientFrame("s1", { type: "subscribe", apps: ["badger"], channels: ["badger.library"] });
    state.publish("badger", "library", "library.updated", { version: 1, reason: "x", mediaCount: 0, playlistCount: 0 });
    expect(frames).toHaveLength(1);

    state.logout(session.token);
    state.publish("badger", "library", "library.updated", { version: 2, reason: "x", mediaCount: 0, playlistCount: 0 });
    expect(frames).toHaveLength(1);
  });

  it("closes the socket of a subscriber dropped for a dead session, so its client reconnects @req RT-SEC-02[runtime]", () => {
    const state = newState();
    const closes: string[] = [];
    const frame = { type: "subscribe" as const, apps: ["badger" as const], channels: ["badger.library"] };

    // logout
    const a = state.login("t", ["badger"], "u");
    state.addSubscriber("a", a.token, () => undefined, () => closes.push("logout"));
    state.applyClientFrame("a", frame);
    state.logout(a.token);
    expect(closes).toEqual(["logout"]);

    // a token that never had a session, noticed on the next client frame
    state.addSubscriber("b", "rt_never_issued", () => undefined, () => closes.push("unknown"));
    state.applyClientFrame("b", frame);
    expect(closes).toEqual(["logout", "unknown"]);

    // an expired session, noticed on publish
    vi.useFakeTimers();
    try {
      const shortLived = new RuntimeState(1_000, 50, "1", "/tmp/spacefleet-runtime-slices");
      const c = shortLived.login("t", ["badger"], "u");
      shortLived.addSubscriber("c", c.token, () => undefined, () => closes.push("expired"));
      shortLived.applyClientFrame("c", frame);
      vi.advanceTimersByTime(1_001);
      shortLived.publish("badger", "library", "library.updated", { version: 1, reason: "x", mediaCount: 0, playlistCount: 0 });
      expect(closes).toEqual(["logout", "unknown", "expired"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a subscriber that was registered with a token that never had a session @req RT-SEC-03[runtime]", () => {
    const state = newState();
    const frames: RuntimeEventFrame[] = [];
    state.addSubscriber("s1", "rt_never_issued", (frame) => frames.push(frame));
    const replay = state.applyClientFrame("s1", { type: "subscribe", apps: ["badger"], channels: ["badger.library"] });
    state.publish("badger", "library", "library.updated", { version: 1, reason: "x", mediaCount: 0, playlistCount: 0 });
    expect(replay).toEqual([]);
    expect(frames).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (b) v2 SSE stream
// ---------------------------------------------------------------------------

const baseJob = (overrides: Partial<IngestJobRecord>): IngestJobRecord => ({
  jobId: "job",
  app: "badger",
  kind: "source",
  lane: "source",
  status: "queued",
  stageCode: "queued",
  stageLabel: "Queued",
  progress: { mode: "fraction", completed: 0, total: 100, unit: "percent" },
  progressPct: 0,
  payload: { userId: "u1" },
  outputs: {},
  errorCode: null,
  errorMessage: null,
  retryable: false,
  cancelRequested: false,
  priority: 0,
  dedupeKey: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  groupId: "g1",
  mediaId: "m1",
  variant: null,
  parentJobIds: [],
  dismissedAt: null,
  uploadSpeedBytesPerSec: null,
  ...overrides,
});

const memDeps = (): EventLogDeps & { rows: EventRow[] } => {
  const rows: EventRow[] = [];
  let nextId = 1;
  return {
    rows,
    insert(row) {
      const stored: EventRow = { ...row, eventId: nextId++ };
      rows.push(stored);
      return stored;
    },
    selectAfter: (lastEventId, limit) => rows.filter((r) => r.eventId > lastEventId).slice(0, limit),
    selectMaxEventId: () => (rows.length === 0 ? 0 : rows[rows.length - 1].eventId),
    trim: () => 0,
  };
};

const stubEngine = (jobs: IngestJobRecord[]) => {
  const subscribers = new Set<(e: RuntimeJobEvent) => void>();
  const engine: EngineV2 = {
    async start() {},
    async stop() {},
    async submit(job) {
      return { jobId: job.jobId };
    },
    async updateJobPayload(jobId) {
      return jobs.find((j) => j.jobId === jobId) ?? null;
    },
    async cancel(jobId) {
      return { cancelledIds: [jobId] };
    },
    async dismiss() {
      return { dismissed: true };
    },
    async retry() {
      return { retried: false };
    },
    async list(filter) {
      return { jobs: jobs.filter((j) => (filter?.groupId ? j.groupId === filter.groupId : true)), maxEventId: 0 };
    },
    async get(jobId) {
      const job = jobs.find((j) => j.jobId === jobId);
      return job ? { job, steps: [] } : null;
    },
    async getByDedupe() {
      return null;
    },
    registerHandler() {},
    subscribe(listener) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    setLaneCaps: () => ({ ...DEFAULT_LANE_CAPS }),
    schedulerStats: () => ({
      tickPasses: 0,
      coalescedTicks: 0,
      ready: { source: 0, format: 0, upload: 0, exempt: 0 },
      parked: 0,
      incoming: 0,
      lanesRunning: { source: 0, format: 0, upload: 0 },
    }),
    sessionChanged() {},
  };
  return {
    engine,
    emit: (event: RuntimeJobEvent) => {
      for (const sub of subscribers) sub(event);
    },
  };
};

const progressPayload = (jobId: string) => ({
  jobId,
  groupId: "g1",
  progressPct: 50,
  stageCode: "uploading",
  stageLabel: "Uploading",
  uploadSpeedBytesPerSec: 100,
});

// Lets every queued microtask (the handler's store lookups) run before asserting.
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("v2 SSE stream is scoped to the session's apps", () => {
  const badgerJob = baseJob({ jobId: "b1", app: "badger" });
  const parrotJob = baseJob({ jobId: "k1", app: "parrot" });

  const setup = () => {
    const deps = memDeps();
    const rig = stubEngine([badgerJob, parrotJob]);
    const handler = createRuntimeJobsV2Handler({
      engine: rig.engine,
      eventLog: createEventLog(deps),
      eventReplayLimit: 50,
    });
    const log = createEventLog(deps);
    const frames: string[] = [];
    const sink = {
      write: (frame: string) => void frames.push(frame),
      close: () => undefined,
    };
    return { handler, rig, log, frames, sink };
  };

  it("replays and forwards only events of in-scope jobs (jobId-only events resolved through the store) @req RT-SEC-03[runtime]", async () => {
    const { handler, rig, log, frames, sink } = setup();
    log.append("b1", "runtime.jobs.progress", progressPayload("b1"));
    log.append("k1", "runtime.jobs.progress", progressPayload("k1"));
    handler.handleSseSubscribe({ lastEventId: 0, scopes: ["badger"], ...sink });
    await settle();

    rig.emit({ eventId: 100, jobId: "k1", event: "runtime.jobs.progress", payload: progressPayload("k1"), createdAt: "2026-05-01T00:00:00.000Z" });
    rig.emit({ eventId: 101, jobId: "b1", event: "runtime.jobs.progress", payload: progressPayload("b1"), createdAt: "2026-05-01T00:00:00.000Z" });
    await settle();

    const joined = frames.join("");
    expect(joined).toContain('"jobId":"b1"');
    expect(joined).not.toContain('"jobId":"k1"');
    expect(frames.filter((f) => f.startsWith("id: "))).toHaveLength(2);
  });

  it("filters events that embed the job by the embedded app @req RT-SEC-03[runtime]", async () => {
    const { handler, rig, frames, sink } = setup();
    handler.handleSseSubscribe({ lastEventId: 0, scopes: ["parrot"], ...sink });
    rig.emit({
      eventId: 200,
      jobId: "new-badger",
      event: "runtime.jobs.created",
      payload: { jobId: "new-badger", job: baseJob({ jobId: "new-badger", app: "badger" }) },
      createdAt: "2026-05-01T00:00:00.000Z",
    });
    rig.emit({
      eventId: 201,
      jobId: "new-parrot",
      event: "runtime.jobs.created",
      payload: { jobId: "new-parrot", job: baseJob({ jobId: "new-parrot", app: "parrot" }) },
      createdAt: "2026-05-01T00:00:00.000Z",
    });
    await settle();
    const joined = frames.join("");
    expect(joined).toContain("new-parrot");
    expect(joined).not.toContain("new-badger");
  });

  it("drops events for a job the store does not know (fail closed) @req RT-SEC-03[runtime]", async () => {
    const { handler, rig, frames, sink } = setup();
    handler.handleSseSubscribe({ lastEventId: 0, scopes: ["badger", "parrot"], ...sink });
    rig.emit({ eventId: 300, jobId: "ghost", event: "runtime.jobs.progress", payload: progressPayload("ghost"), createdAt: "2026-05-01T00:00:00.000Z" });
    await settle();
    expect(frames.join("")).not.toContain("ghost");
  });

  it("an empty scope list sees no job events at all @req RT-SEC-03[runtime]", async () => {
    const { handler, rig, log, frames, sink } = setup();
    log.append("b1", "runtime.jobs.progress", progressPayload("b1"));
    handler.handleSseSubscribe({ lastEventId: 0, scopes: [], ...sink });
    rig.emit({ eventId: 400, jobId: "k1", event: "runtime.jobs.progress", payload: progressPayload("k1"), createdAt: "2026-05-01T00:00:00.000Z" });
    await settle();
    expect(frames.filter((f) => f.includes("runtime.jobs."))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (c) v2 job routes
// ---------------------------------------------------------------------------

describe("v2 job routes are scoped to the session's apps", () => {
  const jobs = [baseJob({ jobId: "b1", app: "badger", groupId: "gb" }), baseJob({ jobId: "k1", app: "parrot", groupId: "gk" })];
  type Call = { method: string; payload: unknown };

  const buildApp = () => {
    const calls: Call[] = [];
    const record = <T>(method: string, payload: unknown, result: T): T => {
      calls.push({ method, payload });
      return result;
    };
    const handler: RuntimeJobsV2Handler = {
      handleSseSubscribe: () => ({ unsubscribe: () => undefined }),
      getJobApp: async (jobId) => jobs.find((j) => j.jobId === jobId)?.app ?? null,
      getGroupApps: async (groupId) => [...new Set(jobs.filter((j) => j.groupId === groupId).map((j) => j.app))],
      handleSnapshot: async (_filter, scopes) =>
        record("handleSnapshot", scopes, { jobs: jobs.filter((j) => scopes.includes(j.app)), maxEventId: 0 }),
      handleCancelByGroup: async (input) => record("handleCancelByGroup", input, { cancelled: 1, dismissed: 0 }),
      handleCancel: async (input) => record("handleCancel", input, { cancelled: true }),
      handleDismiss: async (input) => record("handleDismiss", input, { dismissed: true }),
      handleRetry: async (input) => record("handleRetry", input, { retried: true }),
      handleAvailability: async (input) => record("handleAvailability", input, { jobs: [], keptBytesTotal: 0 }),
    };
    const app = new Hono();
    registerRuntimeJobsV2Routes(app, () => handler);
    return { app, calls };
  };

  const post = (app: Hono, path: string, token: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(token) },
      body: JSON.stringify(body),
    });

  beforeEach(() => {
    runtimeState.resetForTests();
    __resetEngineV2BootStatusForTests();
    setEngineV2BootStatus({ state: "ready" });
  });

  it("the snapshot lists only the session's apps @req RT-SEC-03[runtime]", async () => {
    const { app } = buildApp();
    const badger = runtimeState.login("t", ["badger"], "u");
    const res = await post(app, "/runtime/jobs/v2/list", badger.token, { filter: {} });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobs: Array<{ jobId: string }> };
    expect(body.jobs.map((j) => j.jobId)).toEqual(["b1"]);
  });

  for (const [path, handlerMethod] of [
    ["/runtime/jobs/v2/cancel", "handleCancel"],
    ["/runtime/jobs/v2/dismiss", "handleDismiss"],
    ["/runtime/jobs/v2/retry", "handleRetry"],
  ] as const) {
    it(`${path}: 403 forbidden_scope on another app's job, 200 on its own @req RT-SEC-03[runtime]`, async () => {
      const { app, calls } = buildApp();
      const badger = runtimeState.login("t", ["badger"], "u");
      const foreign = await post(app, path, badger.token, { jobId: "k1" });
      expect(foreign.status).toBe(403);
      expect(await foreign.json()).toEqual({ error: "forbidden_scope" });
      expect(calls).toEqual([]);

      const own = await post(app, path, badger.token, { jobId: "b1" });
      expect(own.status).toBe(200);
      expect(calls.map((c) => c.method)).toEqual([handlerMethod]);
    });
  }

  it("availability leaves out another app's jobs @req RT-SEC-03[runtime]", async () => {
    const { app, calls } = buildApp();
    const badger = runtimeState.login("t", ["badger"], "u");
    const res = await post(app, "/runtime/jobs/v2/availability", badger.token, { jobIds: ["k1", "b1"] });
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ method: "handleAvailability", payload: { jobIds: ["b1"] } }]);
  });

  it("cancel-by-group: 403 forbidden_scope on another app's group, 200 on its own @req RT-SEC-03[runtime]", async () => {
    const { app, calls } = buildApp();
    const badger = runtimeState.login("t", ["badger"], "u");
    const foreign = await post(app, "/runtime/jobs/v2/cancel-by-group", badger.token, { groupId: "gk" });
    expect(foreign.status).toBe(403);
    expect(calls).toEqual([]);
    const own = await post(app, "/runtime/jobs/v2/cancel-by-group", badger.token, { groupId: "gb" });
    expect(own.status).toBe(200);
    expect(calls.map((c) => c.method)).toEqual(["handleCancelByGroup"]);
  });

  it("a two-app session may act on both apps' jobs @req RT-SEC-03[runtime]", async () => {
    const { app } = buildApp();
    const both = runtimeState.login("t", ["badger", "parrot"], "u");
    expect((await post(app, "/runtime/jobs/v2/cancel", both.token, { jobId: "k1" })).status).toBe(200);
    expect((await post(app, "/runtime/jobs/v2/cancel", both.token, { jobId: "b1" })).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// (d) connections / modules / connect / disconnect
// ---------------------------------------------------------------------------

describe("connection and module routes are scoped to the session's apps", () => {
  beforeEach(() => {
    runtimeState.resetForTests();
  });

  const connect = (app: Hono, token: string, appName: string, pid: number) =>
    app.request("/runtime/connect", {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(token) },
      body: JSON.stringify({ appName, pid }),
    });

  it("connect refuses an app outside the session scope and registers nothing @req RT-SEC-03[runtime]", async () => {
    const app = createApp();
    const badger = runtimeState.login("t", ["badger"], "u");
    const res = await connect(app, badger.token, "parrot", 4242);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden_scope" });
    expect(runtimeState.getConnectionCount()).toBe(0);
  });

  it("connect, connections and the connectedApps list show only in-scope apps @req RT-SEC-03[runtime]", async () => {
    const app = createApp();
    const parrot = runtimeState.login("t", ["parrot"], "u");
    const badger = runtimeState.login("t", ["badger"], "u");
    expect((await connect(app, parrot.token, "parrot", 4243)).status).toBe(200);
    const badgerRes = await connect(app, badger.token, "badger", 4244);
    expect(badgerRes.status).toBe(200);
    const connectBody = (await badgerRes.json()) as { connectedApps: Array<{ appName: string }> };
    expect(connectBody.connectedApps.map((c) => c.appName)).toEqual(["badger"]);

    const list = await app.request("/runtime/connections", { headers: bearer(badger.token) });
    const listBody = (await list.json()) as { connections: Array<{ appName: string }> };
    expect(listBody.connections.map((c) => c.appName)).toEqual(["badger"]);
  });

  it("disconnect refuses another app's connection and leaves it registered @req RT-SEC-03[runtime]", async () => {
    const app = createApp();
    const parrot = runtimeState.login("t", ["parrot"], "u");
    const badger = runtimeState.login("t", ["badger"], "u");
    const connected = (await (await connect(app, parrot.token, "parrot", 4245)).json()) as { connectionId: string };

    const refused = await app.request("/runtime/disconnect", {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(badger.token) },
      body: JSON.stringify({ connectionId: connected.connectionId }),
    });
    expect(refused.status).toBe(403);
    expect(runtimeState.getConnectionCount()).toBe(1);

    const own = await app.request("/runtime/disconnect", {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(parrot.token) },
      body: JSON.stringify({ connectionId: connected.connectionId }),
    });
    expect(own.status).toBe(200);
    expect(runtimeState.getConnectionCount()).toBe(0);
  });

  it("modules lists only the session's apps @req RT-SEC-03[runtime]", async () => {
    const app = createApp();
    const badger = runtimeState.login("t", ["badger"], "u");
    const both = runtimeState.login("t", ["badger", "parrot"], "u");
    const scoped = (await (await app.request("/runtime/modules", { headers: bearer(badger.token) })).json()) as {
      modules: Array<{ app: string }>;
    };
    const full = (await (await app.request("/runtime/modules", { headers: bearer(both.token) })).json()) as {
      modules: Array<{ app: string }>;
    };
    expect(full.modules.map((m) => m.app).sort()).toEqual(["badger", "parrot"]);
    expect(scoped.modules.map((m) => m.app)).toEqual(["badger"]);
  });
});
