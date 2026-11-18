/**
 * @bugfix @regression-proof — #25 ultimate stress P1 (runtime guardian kill loop).
 *
 * 1. Event-loop stall reporting: the runtime stopped answering /runtime/health
 *    at ~0 % CPU and its log said nothing. The monitor must log a stall with
 *    its lag and the work that was in flight across it.
 * 2. Shutdown deadline: SIGTERM ran `await engineV2.stop()` with no timer
 *    (despite the comment promising one), so a drain stuck behind a slow
 *    fsync outlived the guardian's 5 s grace and got SIGKILLed — logged as
 *    "runtime child ignored SIGTERM". The drain must exit by its deadline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventLoopMonitor } from "../src/core/eventLoopMonitor";
import { runShutdownDrain } from "../src/core/shutdown";

const SUITE = "event-loop-monitor-shutdown";

type Logged = { message: string; data: Record<string, unknown> };

describe("@bugfix @regression-proof runtime event-loop stall log (#25 P1)", () => {
  it("logs a stall with its lag and the in-flight commands, and exposes it in the snapshot", () => {
    let now = 1_000;
    const logs: Logged[] = [];
    const monitor = new EventLoopMonitor({
      intervalMs: 500,
      stallLogMs: 1_000,
      now: () => now,
      log: (message, data) => {
        logs.push({ message, data });
        console.info(`[${SUITE}:stall] ${message} ${JSON.stringify(data)}`);
      },
    });
    // start() arms the drift baseline; the timer itself is not used here.
    monitor.start();
    monitor.stop();
    now = 1_500;
    monitor.tick(); // on time
    const settleFast = monitor.track("badger:badger.db.get_media");
    settleFast();
    const settleSlow = monitor.track("badger:badger.db.snapshot");
    // The loop is blocked 4 s inside the snapshot command (e.g. fsync).
    now = 6_000;
    monitor.tick();
    settleSlow();
    const snap = monitor.snapshot();
    console.info(`[${SUITE}:stall] snapshot=${JSON.stringify(snap)}`);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.message).toBe("event-loop stall");
    expect(logs[0]?.data.lagMs).toBe(4_000);
    expect(logs[0]?.data.inflight).toEqual([{ label: "badger:badger.db.snapshot", ageMs: 4_500 }]);
    expect(snap.stalls).toBe(1);
    expect(snap.maxLagMs).toBe(4_000);
    expect(snap.lastStall?.lagMs).toBe(4_000);
    expect(snap.inflight).toBe(0);
  });

  it("stays quiet when the loop runs on time", () => {
    let now = 0;
    const log = vi.fn();
    const monitor = new EventLoopMonitor({ intervalMs: 500, stallLogMs: 1_000, now: () => now, log });
    monitor.start();
    monitor.stop();
    for (let i = 1; i <= 10; i += 1) {
      now = i * 500 + 40;
      monitor.tick();
    }
    console.info(`[${SUITE}:quiet] snapshot=${JSON.stringify(monitor.snapshot())}`);
    expect(log).not.toHaveBeenCalled();
    expect(monitor.snapshot().stalls).toBe(0);
  });
});

describe("@bugfix @regression-proof runtime shutdown drain deadline (#25 P1)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("exits by the deadline when a drain step hangs", async () => {
    const exit = vi.fn();
    const logs: Logged[] = [];
    const ran: string[] = [];
    void runShutdownDrain(
      [
        { name: "engineV2.stop", run: () => new Promise(() => { ran.push("engineV2.stop"); }) },
        { name: "v2EventLogStore.close", run: () => { ran.push("close"); } },
      ],
      {
        signal: "SIGTERM",
        deadlineMs: 3_500,
        exit,
        log: (message, data) => {
          logs.push({ message, data });
          console.info(`[${SUITE}:deadline] ${message} ${JSON.stringify(data)}`);
        },
      },
    );
    await vi.advanceTimersByTimeAsync(3_499);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(ran).toEqual(["engineV2.stop"]);
    expect(logs.find((l) => l.message.startsWith("shutdown drain exceeded deadline"))?.data.stuckStep).toBe("engineV2.stop");
  });

  it("exits 0 right after a clean drain, running every step once and in order", async () => {
    const exit = vi.fn();
    const ran: string[] = [];
    await runShutdownDrain(
      [
        { name: "a", run: async () => { ran.push("a"); } },
        { name: "b", run: () => { throw new Error("boom"); } },
        { name: "c", run: () => { ran.push("c"); } },
      ],
      { signal: "SIGTERM", deadlineMs: 3_500, exit, log: (m, d) => console.info(`[${SUITE}:clean] ${m} ${JSON.stringify(d)}`) },
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ran).toEqual(["a", "c"]);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  // #25 P4: a synchronous step (a SQLite close fsyncing the WAL) blocks the
  // main thread, so the deadline timer cannot fire during it. The stress
  // baseline's runtime then logged `reason: "drained"` 8 s past its 3.5 s
  // deadline, hiding the stall.
  it("@bugfix @regression-proof reports a deadline exit, not a clean drain, when a synchronous step overran the deadline (#25 P4)", async () => {
    const exit = vi.fn();
    const logs: Logged[] = [];
    let clock = 0;
    const ran: string[] = [];
    await runShutdownDrain(
      [
        { name: "engineV2.stop", run: () => { ran.push("engineV2.stop"); clock += 100; } },
        // Blocks past the deadline without yielding: no timer can run inside.
        { name: "v2EventLogStore.close", run: () => { ran.push("close"); clock += 8_000; } },
        { name: "releaseRuntimePidFile", run: () => { ran.push("release"); } },
      ],
      {
        signal: "SIGTERM",
        deadlineMs: 3_500,
        exit,
        now: () => clock,
        log: (message, data) => {
          logs.push({ message, data });
          console.info(`[${SUITE}:sync-overrun] ${message} ${JSON.stringify(data)}`);
        },
      },
    );
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    const exitLog = logs.find((l) => l.message === "shutdown exit");
    expect(exitLog?.data).toMatchObject({ reason: "deadline", code: 1, elapsedMs: 8_100 });
    expect(logs.find((l) => l.message.startsWith("shutdown drain exceeded deadline"))?.data).toMatchObject({ stuckStep: "v2EventLogStore.close" });
    // The budget is spent: exit now, like the timer path, skipping later steps.
    expect(ran).toEqual(["engineV2.stop", "close"]);
  });
});

describe("@bugfix @regression-proof drain step limit: a step queued behind unbounded work cannot spend the whole drain (#671 R2)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const logTo = (logs: Logged[], label: string) => (message: string, data: Record<string, unknown>) => {
    logs.push({ message, data });
    console.info(`[${SUITE}:${label}] ${message} ${JSON.stringify(data)}`);
  };

  it("moves on at the step limit, runs the later steps and exits 0 inside the deadline @req RT-LIFE-04", async () => {
    const exit = vi.fn();
    const logs: Logged[] = [];
    const ran: string[] = [];
    let limitSeenRemaining = -1;
    void runShutdownDrain(
      [
        { name: "engineV2.stop", run: () => new Promise<void>((r) => setTimeout(r, 500)) },
        {
          name: "badgerModule.shutdown",
          run: () => new Promise(() => { ran.push("badger.close started"); }),
          limitMs: (remaining) => {
            limitSeenRemaining = remaining;
            return remaining - 1_500;
          },
        },
        { name: "listener.stop", run: () => { ran.push("listener"); } },
      ],
      { signal: "SIGTERM", deadlineMs: 3_500, exit, log: logTo(logs, "limit") },
    );
    await vi.advanceTimersByTimeAsync(499);
    expect(ran).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    // The step got the time left (3500 - 500) minus the 1500 reserve.
    expect(limitSeenRemaining).toBe(3_000);
    expect(ran).toEqual(["badger.close started"]);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(ran).not.toContain("listener");
    await vi.advanceTimersByTimeAsync(1);
    expect(ran).toEqual(["badger.close started", "listener"]);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(logs.find((l) => l.message === "shutdown step exceeded its limit; continuing the drain")?.data).toMatchObject({
      step: "badgerModule.shutdown",
      limitMs: 1_500,
    });
    expect(logs.find((l) => l.message === "shutdown step done" && l.data.step === "badgerModule.shutdown")?.data.timedOut).toBe(true);
    // The elapsed time never reaches the 3.5 s deadline.
    expect(logs.find((l) => l.message === "shutdown exit")?.data.elapsedMs as number).toBeLessThan(3_500);
  });

  it("clamps the limit at 0 when the earlier steps already spent the reserve, and still starts the step @req RT-LIFE-04", async () => {
    const exit = vi.fn();
    const ran: string[] = [];
    let clock = 0;
    void runShutdownDrain(
      [
        { name: "engineV2.stop", run: () => { clock += 3_000; } },
        {
          name: "badgerModule.shutdown",
          run: () => new Promise(() => { ran.push("badger.close started"); }),
          limitMs: (remaining) => remaining - 1_500,
        },
        { name: "listener.stop", run: () => { ran.push("listener"); } },
      ],
      { signal: "SIGTERM", deadlineMs: 3_500, exit, now: () => clock, log: () => {} },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(ran).toEqual(["badger.close started", "listener"]);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("a step that finishes inside its limit is not reported as timed out, and its timer is cleared @req RT-LIFE-04", async () => {
    const exit = vi.fn();
    const logs: Logged[] = [];
    void runShutdownDrain(
      [{ name: "badgerModule.shutdown", run: () => new Promise<void>((r) => setTimeout(r, 100)), limitMs: () => 1_000 }],
      { signal: "SIGTERM", deadlineMs: 3_500, exit, log: logTo(logs, "in-time") },
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(exit).toHaveBeenCalledWith(0);
    expect(logs.some((l) => l.message.includes("exceeded its limit"))).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a step that fails inside its limit is logged as failed and the drain goes on @req RT-LIFE-04", async () => {
    const exit = vi.fn();
    const logs: Logged[] = [];
    const ran: string[] = [];
    await runShutdownDrain(
      [
        { name: "badgerModule.shutdown", run: async () => { throw new Error("close boom"); }, limitMs: () => 1_000 },
        { name: "listener.stop", run: () => { ran.push("listener"); } },
      ],
      { signal: "SIGTERM", deadlineMs: 3_500, exit, log: logTo(logs, "fail-in-time") },
    );
    expect(logs.find((l) => l.message === "shutdown step failed")?.data).toMatchObject({ step: "badgerModule.shutdown", error: "close boom" });
    expect(ran).toEqual(["listener"]);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("a step that fails after its limit is logged, with no unhandled rejection @req RT-LIFE-04", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const exit = vi.fn();
      const logs: Logged[] = [];
      void runShutdownDrain(
        [
          {
            name: "badgerModule.shutdown",
            run: () => new Promise<void>((_, reject) => setTimeout(() => reject(new Error("late close boom")), 800)),
            limitMs: () => 300,
          },
        ],
        { signal: "SIGTERM", deadlineMs: 3_500, exit, log: logTo(logs, "fail-late") },
      );
      await vi.advanceTimersByTimeAsync(300);
      expect(exit).toHaveBeenCalledWith(0);
      await vi.advanceTimersByTimeAsync(600);
      // unhandledRejection is reported on a real macrotask turn.
      vi.useRealTimers();
      await new Promise((r) => setTimeout(r, 10));
      expect(logs.find((l) => l.message === "shutdown step failed after its limit")?.data).toMatchObject({
        step: "badgerModule.shutdown",
        error: "late close boom",
      });
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
