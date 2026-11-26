/**
 * @bugfix @regression-proof
 *
 * Round-13 #4 (a): the legacy WebSocket transport at
 * `/runtime/events/jobs/v2` was removed in favour of the SSE channel at
 * `/runtime/events/jobs/v2/stream` (round-6 SSE migration). This test pins
 * the surface so a future commit can't quietly resurrect the WS endpoint
 * without anyone noticing.
 *
 * Pre-fix state (would FAIL these assertions):
 *   - `createRuntimeJobsV2Handler` returned a `handleSubscribe(ws)` method
 *     accepting a `ServerWebSocketLike`.
 *   - `routes/runtimeJobsV2.ts` exported `WsClientHandle` and
 *     `ServerWebSocketLike` types.
 *   - `registerRuntimeJobsV2Routes` registered a `GET /runtime/events/jobs/v2`
 *     stub route returning `426 Upgrade Required`.
 *   - `apps/runtime/src/index.ts` imported `WsClientHandle` and dispatched a
 *     `kind: "jobsV2"` branch in the Bun `websocket` handler.
 *
 * Post-fix state (this test asserts):
 *   - Handler exposes `handleSseSubscribe`, `handleSnapshot`, plus the
 *     mutation methods. NO `handleSubscribe`.
 *   - Source files no longer reference `WsClientHandle`/`ServerWebSocketLike`/
 *     `handleSubscribe`/`/runtime/events/jobs/v2` (without the `/stream`
 *     suffix).
 *   - The Hono GET stub is gone — a request to `/runtime/events/jobs/v2`
 *     (no `/stream`) reaches the catch-all v2 route and returns its
 *     `unknown_v2_endpoint` envelope, not the legacy 426.
 */
import { readFileSync } from "node:fs";
import { dirname, join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  createRuntimeJobsV2Handler,
  registerRuntimeJobsV2Routes,
  type RuntimeJobsV2Handler,
} from "../src/routes/runtimeJobsV2";
import { createEventLog, type EventLogDeps, type EventRow } from "@space/runtime-jobs-engine/eventLog";
import type { EngineV2 } from "@space/runtime-jobs-engine/engineV2";
import { DEFAULT_LANE_CAPS } from "@space/runtime-jobs-engine/engineV2Lanes";
import type { IngestJobRecord } from "@space/runtime-jobs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = joinPath(HERE, "..", "..", "..");

// ---------------------------------------------------------------------------
// In-memory rigs (mirror the SSE unit-test rigs).
// ---------------------------------------------------------------------------

const sampleJob = (overrides: Partial<IngestJobRecord> = {}): IngestJobRecord => ({
  jobId: "src1",
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

const memDeps = (): EventLogDeps => {
  const rows: EventRow[] = [];
  let nextId = 1;
  return {
    insert(row) {
      const stored: EventRow = { ...row, eventId: nextId++ };
      rows.push(stored);
      return stored;
    },
    selectAfter(lastEventId, limit) {
      return rows.filter((r) => r.eventId > lastEventId).slice(0, limit);
    },
    selectMaxEventId() {
      return rows.length === 0 ? 0 : rows[rows.length - 1].eventId;
    },
    trim() {
      return 0;
    },
  };
};

const stubEngine = (initialJobs: IngestJobRecord[] = []): EngineV2 => {
  let jobs = [...initialJobs];
  return {
    async start() {},
    async stop() {},
    async submit(job) {
      jobs = [...jobs, job];
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
    async list() {
      return { jobs, maxEventId: 0 };
    },
    async get() {
      return null;
    },
    async getByDedupe() {
      return null;
    },
    registerHandler() {},
    subscribe() {
      return () => {};
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
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const buildHandler = (): RuntimeJobsV2Handler =>
  createRuntimeJobsV2Handler({
    engine: stubEngine([sampleJob()]),
    eventLog: createEventLog(memDeps()),
  });

// ---------------------------------------------------------------------------
// Diagnostic snapshot — dumps handler surface keys + source-file extracts on
// assertion failure. Wrapped in try/catch.
// ---------------------------------------------------------------------------
const dumpWsRemovalSnapshot = (
  label: string,
  ctx: {
    handler?: RuntimeJobsV2Handler;
    response?: Response;
    sourcePath?: string;
    sourceMatches?: Array<{ pattern: string; matches: string[] }>;
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [runtime-jobs-v2-ws-removal:${label}] snapshot ===`);
    if (ctx.handler) {
      const keys = Object.keys(ctx.handler as unknown as Record<string, unknown>);
      console.error(`handler.keys=\n${JSON.stringify(keys, null, 2)}`);
    }
    if (ctx.response) {
      const headersOut: Record<string, string> = {};
      ctx.response.headers.forEach((value, key) => {
        headersOut[key] = value;
      });
      console.error(
        `response.status=${ctx.response.status} response.headers=${JSON.stringify(headersOut)}`,
      );
    }
    if (ctx.sourcePath) {
      console.error(`sourcePath=${ctx.sourcePath}`);
    }
    if (ctx.sourceMatches) {
      console.error(`sourceMatches=\n${JSON.stringify(ctx.sourceMatches, null, 2)}`);
    }
    if (ctx.extra) {
      console.error(`extra=\n${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("@bugfix @regression-proof Round-13 #4 (a) — WS transport for /runtime/events/jobs/v2 is fully removed", () => {
  it("RuntimeJobsV2Handler does NOT expose `handleSubscribe` (legacy WS entrypoint)", () => {
    console.info(`[runtime-jobs-v2-ws-removal:handler-surface-no-handleSubscribe] building handler`);
    const handler = buildHandler();
    try {
      // Cast to a permissive shape so the property access compiles; the
      // assertion proves the WS subscribe surface is gone at runtime.
      const asRecord = handler as unknown as Record<string, unknown>;
      console.info(`[runtime-jobs-v2-ws-removal:handler-surface-no-handleSubscribe] handleSubscribe type=${typeof asRecord.handleSubscribe}`);
      expect(asRecord.handleSubscribe).toBeUndefined();
    } catch (err) {
      dumpWsRemovalSnapshot("handler-surface-no-handleSubscribe", { handler });
      throw err;
    }
  });

  it("RuntimeJobsV2Handler exposes `handleSseSubscribe` and the mutation methods", () => {
    console.info(`[runtime-jobs-v2-ws-removal:handler-surface-sse] building handler`);
    const handler = buildHandler();
    try {
      expect(typeof handler.handleSseSubscribe).toBe("function");
      expect(typeof handler.handleSnapshot).toBe("function");
      expect(typeof handler.handleCancel).toBe("function");
      expect(typeof handler.handleCancelByGroup).toBe("function");
      expect(typeof handler.handleDismiss).toBe("function");
      expect(typeof handler.handleRetry).toBe("function");
    } catch (err) {
      dumpWsRemovalSnapshot("handler-surface-sse", { handler });
      throw err;
    }
  });

  it("registerRuntimeJobsV2Routes does NOT register a `GET /runtime/events/jobs/v2` stub", async () => {
    console.info(`[runtime-jobs-v2-ws-removal:hono-no-stub] firing GET /runtime/events/jobs/v2`);
    // Pre-fix the route returned 426 Upgrade Required. Post-fix the only
    // matcher for this exact path is the `app.all("/runtime/jobs/v2/*")`
    // catch-all… but note `/runtime/events/jobs/v2` is NOT under
    // `/runtime/jobs/v2/*`, so there is no Hono handler at all — Hono
    // returns a default 404. (The SSE branch lives in
    // `apps/runtime/src/index.ts` outside the Hono app and is not exercised
    // through `app.fetch`.)
    const app = new Hono();
    const handler = buildHandler();
    registerRuntimeJobsV2Routes(app, () => handler);
    const res = await app.fetch(
      new Request("http://localhost/runtime/events/jobs/v2", { method: "GET" })
    );
    console.info(`[runtime-jobs-v2-ws-removal:hono-no-stub] response.status=${res.status}`);
    try {
      expect(res.status).not.toBe(426); // Pre-fix value — must be gone.
      // Default Hono 404 for an unregistered path.
      expect(res.status).toBe(404);
    } catch (err) {
      dumpWsRemovalSnapshot("hono-no-stub-failure", { response: res });
      throw err;
    }
  });

  it("apps/runtime/src/routes/runtimeJobsV2.ts no longer imports WS-only types", () => {
    const filePath = joinPath(
      REPO_ROOT,
      "apps/runtime/src/routes/runtimeJobsV2.ts"
    );
    console.info(`[runtime-jobs-v2-ws-removal:source-no-ws-types] reading ${filePath}`);
    const source = readFileSync(filePath, "utf8");
    try {
      // The `export interface WsClientHandle {` and
      // `export interface ServerWebSocketLike {` declarations are gone.
      expect(source).not.toMatch(/export interface WsClientHandle/);
      expect(source).not.toMatch(/export interface ServerWebSocketLike/);
      // The factory does NOT define a `const handleSubscribe = (ws:`
      // closure (the WS implementation). Comments mentioning the removed
      // surface for explanatory/historical reasons are allowed.
      expect(source).not.toMatch(/const handleSubscribe = \(ws:/);
    } catch (err) {
      const matches: Array<{ pattern: string; matches: string[] }> = [
        { pattern: "export interface WsClientHandle", matches: source.match(/export interface WsClientHandle.*/gm) ?? [] },
        { pattern: "export interface ServerWebSocketLike", matches: source.match(/export interface ServerWebSocketLike.*/gm) ?? [] },
        { pattern: "const handleSubscribe = (ws:", matches: source.match(/const handleSubscribe = \(ws:.*/gm) ?? [] },
      ];
      dumpWsRemovalSnapshot("source-no-ws-types-failure", { sourcePath: filePath, sourceMatches: matches });
      throw err;
    }
  });

  it("apps/runtime/src/index.ts no longer imports `WsClientHandle` or wires a `kind: \"jobsV2\"` WS branch", () => {
    const filePath = joinPath(REPO_ROOT, "apps/runtime/src/index.ts");
    console.info(`[runtime-jobs-v2-ws-removal:index-no-jobsV2-branch] reading ${filePath}`);
    const source = readFileSync(filePath, "utf8");
    try {
      // The import line is gone (we deleted it from the named imports).
      expect(source).not.toMatch(/^\s*type WsClientHandle,?$/m);
      // The WS upgrade branch for `/runtime/events/jobs/v2` (without
      // `/stream`) is gone — only `/runtime/events/jobs/v2/stream` remains.
      expect(source).not.toMatch(
        /url\.pathname === "\/runtime\/events\/jobs\/v2"\s*\)/
      );
      // The data variant `{ kind: "jobsV2", handle: ... }` is gone.
      expect(source).not.toMatch(/kind:\s*"jobsV2"/);
    } catch (err) {
      const matches: Array<{ pattern: string; matches: string[] }> = [
        { pattern: "type WsClientHandle import", matches: source.match(/^\s*type WsClientHandle,?$/gm) ?? [] },
        { pattern: "/runtime/events/jobs/v2 branch", matches: source.match(/url\.pathname === "\/runtime\/events\/jobs\/v2".*/gm) ?? [] },
        { pattern: 'kind: "jobsV2"', matches: source.match(/kind:\s*"jobsV2".*/gm) ?? [] },
      ];
      dumpWsRemovalSnapshot("index-no-jobsV2-branch-failure", { sourcePath: filePath, sourceMatches: matches });
      throw err;
    }
  });
});
