/**
 * RT-JOBS-07 — a queued job runs only while its account's session (account + API server) is the active one.
 *
 * Before the fix the engine ran every queued job with whatever token and library key the runtime held: a job queued
 * by account A, still in the queue when B signed in on the same computer, uploaded A's media into B's account.
 *
 * @bugfix @regression-proof @req RT-JOBS-07
 */
import { afterEach, describe, expect, it } from "vitest";
import type { IngestJobRecord } from "@space/runtime-jobs";
import { createEngineV2, type EngineV2, type RuntimeJobEvent } from "../src/core/jobs/engineV2";

const ts = "2026-01-01T00:00:00.000Z";
const T = "jobs-engine-v2-session-gate";
const SERVER = "https://api.example.test";
const STEP_KINDS = ["probe", "identify", "extract", "upload", "commit"] as const;

const makeJob = (jobId: string, payload: Record<string, unknown>): IngestJobRecord => ({
  jobId,
  app: "badger",
  kind: "source",
  lane: "source",
  status: "queued",
  stageCode: "queued",
  stageLabel: "Queued",
  progress: { mode: "fraction", completed: 0, total: 100, unit: "percent" },
  progressPct: 0,
  payload,
  outputs: {},
  errorCode: null,
  errorMessage: null,
  retryable: false,
  cancelRequested: false,
  priority: 0,
  dedupeKey: null,
  createdAt: ts,
  updatedAt: ts,
  startedAt: null,
  finishedAt: null,
  groupId: `g-${jobId}`,
  mediaId: `m-${jobId}`,
  variant: null,
  parentJobIds: [],
  dismissedAt: null,
  uploadSpeedBytesPerSec: null,
});

/**
 * Real macrotask turns, no fake timers: the passes that submit()/sessionChanged() start and the step handlers they run
 * are promise chains the engine does not expose, so the test lets the loop drain a few turns before it looks.
 */
const settle = async () => {
  for (let i = 0; i < 5; i += 1) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
};

describe("engineV2 runs a job only for the active session (RT-JOBS-07)", () => {
  let engine: EngineV2 | null = null;

  afterEach(async () => {
    if (engine) await engine.stop().catch(() => {});
    engine = null;
  });

  const startEngine = async (session: { userId: string | null; apiOrigin: string }) => {
    const e = createEngineV2({
      dbPath: ":memory:",
      progressThrottleMs: 0,
      session: { activeUserId: () => session.userId, apiOrigin: () => session.apiOrigin },
    });
    await e.start();
    const ranSteps: string[] = [];
    for (const kind of STEP_KINDS) {
      e.registerHandler(kind, async (ctx) => {
        ranSteps.push(`${ctx.job.jobId}:${kind}`);
      });
    }
    const started: string[] = [];
    e.subscribe((event: RuntimeJobEvent) => {
      if (event.event === "runtime.jobs.started") started.push(event.jobId);
    });
    engine = e;
    return { engine: e, ranSteps, started };
  };

  // @bugfix @regression-proof @req RT-JOBS-07
  it("keeps another account's job queued until that account's session is active again", async () => {
    const session = { userId: "user-b" as string | null, apiOrigin: SERVER };
    const { engine: e, ranSteps, started } = await startEngine(session);

    console.info(`[${T}:other-account] phase=submit active=${session.userId} job.userId=user-a`);
    await e.submit(makeJob("job-a", { userId: "user-a" }));
    await settle();
    const parked = await e.get("job-a");
    console.info(
      `[${T}:other-account] phase=parked status=${parked?.job.status} started=${JSON.stringify(started)} steps=${JSON.stringify(ranSteps)}`
    );
    expect(started).not.toContain("job-a");
    expect(ranSteps).toEqual([]);
    expect(parked?.job.status).toBe("queued");
    expect(parked?.job.payload.apiOrigin).toBe(SERVER);

    console.info(`[${T}:other-account] phase=switch active=user-a`);
    session.userId = "user-a";
    e.sessionChanged();
    await settle();
    const after = await e.get("job-a");
    console.info(`[${T}:other-account] phase=resumed status=${after?.job.status} steps=${JSON.stringify(ranSteps)}`);
    expect(started).toContain("job-a");
    expect(ranSteps[0]).toBe("job-a:probe");
  });

  // @bugfix @regression-proof @req RT-JOBS-07
  it("keeps a job queued against another API server parked even for the same account id", async () => {
    const session = { userId: "user-a" as string | null, apiOrigin: SERVER };
    const { engine: e, ranSteps, started } = await startEngine(session);

    console.info(`[${T}:other-server] phase=submit job.apiOrigin=http://127.0.0.1:3000 active=${SERVER}`);
    await e.submit(makeJob("job-dev", { userId: "user-a", apiOrigin: "http://127.0.0.1:3000" }));
    await settle();
    console.info(`[${T}:other-server] phase=parked started=${JSON.stringify(started)} steps=${JSON.stringify(ranSteps)}`);
    expect(started).not.toContain("job-dev");
    expect(ranSteps).toEqual([]);

    session.apiOrigin = "http://127.0.0.1:3000";
    e.sessionChanged();
    await settle();
    console.info(`[${T}:other-server] phase=resumed started=${JSON.stringify(started)}`);
    expect(started).toContain("job-dev");
  });

  // @req RT-JOBS-07
  it("holds every user job while nobody is signed in, and still runs jobs that carry no user", async () => {
    const session = { userId: null as string | null, apiOrigin: SERVER };
    const { engine: e, started } = await startEngine(session);

    await e.submit(makeJob("job-user", { userId: "user-a" }));
    await e.submit(makeJob("job-system", {}));
    await settle();
    console.info(`[${T}:signed-out] phase=parked started=${JSON.stringify(started)}`);
    expect(started).toContain("job-system");
    expect(started).not.toContain("job-user");

    session.userId = "user-a";
    e.sessionChanged();
    await settle();
    console.info(`[${T}:signed-out] phase=signed-in started=${JSON.stringify(started)}`);
    expect(started).toContain("job-user");
  });
});
