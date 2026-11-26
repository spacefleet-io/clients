/**
 * @bugfix @regression-proof NEW-runtime-silent-lifecycle-exit (issue #25,
 * ultimate stress run seed 1791422679313: 7 of 45 app-kills — S1 c053, x041,
 * x042, x052, x077; S2 c059, x035 — runtime-died-on-app-kill + orphan-ffmpeg).
 *
 * Symptom: the connection sweep saw every app pid dead, waited the 10 s
 * grace, then runtime.ts called a bare `process.exit(0)`. That skipped the
 * runtime's shutdown() drain, so engineV2.stop() never ran: in-flight jobs
 * were not requeued, child encoders were orphaned, and nothing was logged.
 *
 * Fix: the grace expiry logs the decision (app pids + active job ids) and
 * calls the bound runtime shutdown('lifecycle-orphaned'), the same drain as
 * SIGTERM. No bare exit.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { LifecycleManager, LIFECYCLE_ORPHANED_REASON } from "../src/lifecycle";
import { RuntimeState } from "../src/state";
import { createEngineV2, type EngineV2 } from "@space/runtime-jobs-engine/engineV2";
import type { IngestJobRecord } from "@space/runtime-jobs";

const SUITE = "runtime-lifecycle-orphan-shutdown";
const GRACE_MS = 10_000;
const SWEEP_MS = 1_000;
const ts = "2026-01-01T00:00:00.000Z";
const STEP_KINDS = ["probe", "identify", "extract", "upload", "commit"] as const;

const makeJob = (jobId: string): IngestJobRecord => ({
  jobId,
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
  createdAt: ts,
  updatedAt: ts,
  startedAt: null,
  finishedAt: null,
  groupId: "g1",
  mediaId: "m1",
  variant: null,
  parentJobIds: [],
  dismissedAt: null,
  uploadSpeedBytesPerSec: null,
});

type LogEntry = { message: string; data: Record<string, unknown> };

const makeManager = (alive: Set<number>, logs: LogEntry[]) =>
  new LifecycleManager({
    shutdownGraceMs: GRACE_MS,
    sweepIntervalMs: SWEEP_MS,
    publishEvent: () => {},
    isPidAlive: (pid) => alive.has(pid),
    log: (message, data) => {
      console.info(`[${SUITE}] log ${message} ${JSON.stringify(data)}`);
      logs.push({ message, data });
    },
  });

describe(`[${SUITE}] orphaned runtime drains through shutdown()`, () => {
  let tmp = "";
  let engine: EngineV2 | null = null;
  let manager: LifecycleManager | null = null;

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    manager?.stopConnectionSweep();
    manager?.cancelGrace();
    manager = null;
    if (engine) await engine.stop().catch(() => {});
    engine = null;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = "";
  });

  it("dead app pids + active job → shutdown('lifecycle-orphaned'), no bare exit, job requeued @req RT-LIFE-03 @req RT-LIFE-04", async () => {
    // Real engine with a step hung mid-encode, like a transcode in flight.
    tmp = mkdtempSync(path.join(tmpdir(), "lifecycle-orphan-"));
    engine = createEngineV2({ dbPath: path.join(tmp, "jobs.db"), progressThrottleMs: 0 });
    await engine.start();
    const encoderAborted = vi.fn();
    for (const kind of STEP_KINDS) {
      engine.registerHandler(kind, async ({ signal, reportProgress }) => {
        if (kind !== "extract") return;
        reportProgress(40, "Transcoding", "transcoding");
        const hung = Promise.withResolvers<void>();
        signal.addEventListener("abort", () => {
          encoderAborted();
          hung.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
        await hung.promise;
      });
    }
    await engine.submit(makeJob("j-orphan"));
    await vi.waitFor(async () => expect((await engine!.get("j-orphan"))?.job.status).toBe("running"), {
      timeout: 3000,
    });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const runningEngine = engine;
    let drain: Promise<void> | null = null;
    const shutdown = vi.fn((reason: string) => {
      console.info(`[${SUITE}] shutdown(${reason}) → engine.stop()`);
      drain = runningEngine.stop();
    });

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const alive = new Set([4242]);
    const logs: LogEntry[] = [];
    manager = makeManager(alive, logs);
    manager.bindShutdown({
      shutdown,
      getActiveJobIds: async () => (await runningEngine.list({ status: ["running"] })).jobs.map((j) => j.jobId),
    });
    const state = new RuntimeState(60_000, 50, "1", tmp);
    manager.onAppConnected(state, "token", "badger", 4242);
    manager.startConnectionSweep(state);

    // App is killed (kill -9: no HTTP disconnect).
    alive.delete(4242);
    await vi.advanceTimersByTimeAsync(SWEEP_MS);
    expect(state.getConnectionCount()).toBe(0);
    expect(manager.isGracePending).toBe(true);

    // The 10 s grace holds: nothing happens before it expires.
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1);
    expect(shutdown).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1 + 200);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledWith(LIFECYCLE_ORPHANED_REASON);
    expect(exitSpy).not.toHaveBeenCalled();

    const decision = logs.find((l) => l.data.reason === LIFECYCLE_ORPHANED_REASON);
    expect(decision?.data).toMatchObject({
      decision: "shutdown",
      graceMs: GRACE_MS,
      appPids: [4242],
      activeJobIds: ["j-orphan"],
    });

    vi.useRealTimers();
    expect(drain).not.toBeNull();
    await drain;
    engine = null;
    expect(encoderAborted).toHaveBeenCalledTimes(1);

    // The job is requeued on disk, so the next runtime boot resumes it.
    const reopened = createEngineV2({ dbPath: path.join(tmp, "jobs.db"), progressThrottleMs: 0 });
    for (const kind of STEP_KINDS) reopened.registerHandler(kind, async () => {});
    engine = reopened;
    await reopened.start();
    await vi.waitFor(async () => expect((await reopened.get("j-orphan"))?.job.status).toBe("succeeded"), {
      timeout: 3000,
    });
  });

  it("app reconnecting inside the grace cancels the shutdown @req RT-LIFE-03", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const alive = new Set([1]);
    const logs: LogEntry[] = [];
    manager = makeManager(alive, logs);
    const shutdown = vi.fn();
    manager.bindShutdown({ shutdown });
    const state = new RuntimeState(60_000, 50, "1", (tmp = mkdtempSync(path.join(tmpdir(), "lifecycle-orphan-"))));
    manager.onAppConnected(state, "token", "badger", 1);
    manager.startConnectionSweep(state);
    alive.delete(1);
    await vi.advanceTimersByTimeAsync(SWEEP_MS);
    expect(manager.isGracePending).toBe(true);

    alive.add(2);
    manager.onAppConnected(state, "token", "badger", 2);
    await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
    expect(shutdown).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
  });

  it("without a bound shutdown path it logs and stays up instead of exiting", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const alive = new Set<number>();
    const logs: LogEntry[] = [];
    manager = makeManager(alive, logs);
    const state = new RuntimeState(60_000, 50, "1", (tmp = mkdtempSync(path.join(tmpdir(), "lifecycle-orphan-"))));
    const { connectionId } = manager.onAppConnected(state, "token", "badger", 77);
    manager.onAppDisconnected(state, connectionId);
    await vi.advanceTimersByTimeAsync(GRACE_MS + 200);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(logs[0]?.data).toMatchObject({
      reason: LIFECYCLE_ORPHANED_REASON,
      decision: "stay-up-no-shutdown-binding",
      appPids: [77],
    });
  });
});
