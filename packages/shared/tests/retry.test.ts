/**
 * @test-id SHARED-RETRY-001
 * @level unit
 * @req REL-FAM-03
 *
 * @why #3350 C10: every app retries through one loop. A failure worth another try waits the longer of the caller's
 *   backoff and the Retry-After it named, so a busy service is never asked again sooner than it said; a wait over the
 *   longest one either gives up at once or waits that longest one, as the caller chose.
 */
import { describe, expect, it } from "vitest";
import { retry } from "../src/retry";

const SUITE = "SHARED-RETRY-001";
const log = (phase: string, data?: unknown) =>
  console.info(`[${SUITE}] ${phase}`, data === undefined ? "" : JSON.stringify(data));

class Busy extends Error {
  constructor(readonly retryAfterSeconds?: number) {
    super("busy");
  }
}

const failingThen = <T>(failures: unknown[], value: T) => {
  const calls: number[] = [];
  const run = async (attempt: number) => {
    calls.push(attempt);
    const failure = failures[attempt - 1];
    if (failure !== undefined) throw failure;
    return value;
  };
  return { run, calls };
};

const recorder = () => {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
};

const busyOptions = { retryAfterSeconds: (error: unknown) => (error instanceof Busy ? error.retryAfterSeconds : undefined) };

describe("SHARED-RETRY-001 retry", () => {
  it("waits a Retry-After longer than the backoff, and the backoff when it is shorter", async () => {
    log("SHARED-RETRY-001 phase=long-and-short-retry-after");
    const { run, calls } = failingThen([new Busy(5), new Busy(1)], "ok");
    const { waits, sleep } = recorder();
    await expect(retry(run, { attempts: 3, backoffMs: () => 2000, sleep, ...busyOptions })).resolves.toBe("ok");
    expect(calls).toEqual([1, 2, 3]);
    expect(waits).toEqual([5000, 2000]);
  });

  it("gives up at once on a wait over the longest one by default", async () => {
    log("SHARED-RETRY-001 phase=give-up");
    const busy = new Busy(60);
    const { run, calls } = failingThen([busy], "ok");
    const { waits, sleep } = recorder();
    await expect(retry(run, { attempts: 3, maxWaitMs: 10_000, sleep, ...busyOptions })).rejects.toBe(busy);
    expect(calls).toEqual([1]);
    expect(waits).toEqual([]);
  });

  it("waits the longest wait and tries again when the caller caps", async () => {
    log("SHARED-RETRY-001 phase=cap");
    const { run } = failingThen([new Busy(60)], "ok");
    const { waits, sleep } = recorder();
    await expect(retry(run, { attempts: 3, maxWaitMs: 30_000, overMaxWait: "cap", sleep, ...busyOptions })).resolves.toBe("ok");
    expect(waits).toEqual([30_000]);
  });

  it("throws a failure that is not retryable at once, and the last try's failure as it came", async () => {
    log("SHARED-RETRY-001 phase=not-retryable-and-last");
    const fatal = new Error("fatal");
    const first = failingThen([fatal], "ok");
    const { waits, sleep } = recorder();
    await expect(retry(first.run, { attempts: 3, retryable: (e) => e !== fatal, sleep })).rejects.toBe(fatal);
    expect(first.calls).toEqual([1]);

    const last = new Busy();
    const exhausted = failingThen([new Busy(), new Busy(), last], "ok");
    await expect(retry(exhausted.run, { attempts: 3, sleep })).rejects.toBe(last);
    expect(exhausted.calls).toEqual([1, 2, 3]);
    // No backoff and no Retry-After: nothing to wait.
    expect(waits).toEqual([]);
  });

  it("tells onRetry of each wait before it, and hands the backoff the wait before", async () => {
    log("SHARED-RETRY-001 phase=on-retry-and-doubling");
    const { run } = failingThen([new Busy(), new Busy(), new Busy()], "ok");
    const { waits, sleep } = recorder();
    const told: Array<{ attempt: number; waitMs: number }> = [];
    await retry(run, {
      attempts: 4,
      backoffMs: (_attempt, previousWaitMs) => Math.max(1000, previousWaitMs * 2),
      onRetry: ({ attempt, waitMs }) => told.push({ attempt, waitMs }),
      sleep,
    });
    expect(told).toEqual([
      { attempt: 1, waitMs: 1000 },
      { attempt: 2, waitMs: 2000 },
      { attempt: 3, waitMs: 4000 },
    ]);
    expect(waits).toEqual([1000, 2000, 4000]);
    log("SHARED-RETRY-001 phase=done", { waits });
  });

  it("tries again on a result retryValue accepts, and returns the last try's result as it came", async () => {
    log("SHARED-RETRY-001 phase=retry-value");
    const answers = ["busy", "busy", "busy"];
    const calls: number[] = [];
    const { waits, sleep } = recorder();
    const told: Array<{ attempt: number; value: unknown; error: unknown }> = [];
    const run = async (attempt: number) => {
      calls.push(attempt);
      return answers[attempt - 1] ?? "ok";
    };
    const options = {
      retryValue: (value: string) => value === "busy",
      backoffMs: () => 500,
      onRetry: ({ attempt, value, error }: { attempt: number; value?: string; error?: unknown }) =>
        told.push({ attempt, value, error }),
      sleep,
    };
    await expect(retry(run, { attempts: 4, ...options })).resolves.toBe("ok");
    expect(calls).toEqual([1, 2, 3, 4]);
    expect(waits).toEqual([500, 500, 500]);
    expect(told[0]).toEqual({ attempt: 1, value: "busy", error: undefined });

    calls.length = 0;
    waits.length = 0;
    await expect(retry(run, { attempts: 2, ...options })).resolves.toBe("busy");
    expect(calls).toEqual([1, 2]);
    expect(waits).toEqual([500]);

    // A result's wait over the longest one returns that result at once, like a failure is thrown at once.
    calls.length = 0;
    await expect(retry(run, { attempts: 4, ...options, maxWaitMs: 100 })).resolves.toBe("busy");
    expect(calls).toEqual([1]);
    log("SHARED-RETRY-001 phase=retry-value-done", { told });
  });
});
