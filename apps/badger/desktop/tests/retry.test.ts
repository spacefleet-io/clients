import { describe, expect, it } from "vitest";
import { runWithRetries } from "../src/main/retry";

// On assertion failure, dump the observed call-count / result / error so a CI
// failure is diagnosable without a local repro (per "Tests log generously").
const dumpRetrySnapshot = (
  label: string,
  ctx: { calls?: number; result?: unknown; error?: unknown; opts?: unknown }
) => {
  try {
    console.error(`=== [retry:${label}] snapshot ===`);
    console.error(`opts=${JSON.stringify(ctx.opts)}`);
    console.error(`calls=${JSON.stringify(ctx.calls)}`);
    console.error(`result=${JSON.stringify(ctx.result)}`);
    console.error(
      `error=${ctx.error instanceof Error ? ctx.error.message : JSON.stringify(ctx.error)}`
    );
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("runWithRetries", () => {
  it("returns on first success", async () => {
    let calls = 0;
    const opts = { attempts: 3 };
    console.info(`[retry:first-success] invoking runWithRetries opts=${JSON.stringify(opts)}`);
    const result = await runWithRetries(async () => {
      calls += 1;
      return "ok";
    }, opts);
    console.info(`[retry:first-success] resolved result=${JSON.stringify(result)} calls=${calls}`);
    if (result !== "ok" || calls !== 1) dumpRetrySnapshot("first-success", { calls, result, opts });
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries failures and eventually succeeds", async () => {
    let calls = 0;
    const opts = { attempts: 3, baseDelayMs: 0 };
    console.info(`[retry:retry-then-succeed] invoking runWithRetries opts=${JSON.stringify(opts)}`);
    const result = await runWithRetries(async () => {
      calls += 1;
      console.info(`[retry:retry-then-succeed] body invoked, calls=${calls}`);
      if (calls < 3) throw new Error("boom");
      return 42;
    }, opts);
    console.info(`[retry:retry-then-succeed] resolved result=${JSON.stringify(result)} calls=${calls}`);
    if (result !== 42 || calls !== 3)
      dumpRetrySnapshot("retry-then-succeed", { calls, result, opts });
    expect(result).toBe(42);
    expect(calls).toBe(3);
  });

  it("throws after all attempts are exhausted", async () => {
    let calls = 0;
    const opts = { attempts: 2, baseDelayMs: 0 };
    console.info(`[retry:exhaust] invoking runWithRetries opts=${JSON.stringify(opts)}`);
    let caught: unknown = null;
    try {
      await runWithRetries(async () => {
        calls += 1;
        console.info(`[retry:exhaust] body invoked, calls=${calls}`);
        throw new Error("still-broken");
      }, opts);
    } catch (err) {
      caught = err;
    }
    console.info(
      `[retry:exhaust] settled calls=${calls} caught=${caught instanceof Error ? caught.message : JSON.stringify(caught)}`
    );
    if (!(caught instanceof Error) || !/still-broken/.test(caught.message))
      dumpRetrySnapshot("exhaust", { calls, error: caught, opts });
    await expect(
      runWithRetries(async () => {
        throw new Error("still-broken");
      }, opts)
    ).rejects.toThrow("still-broken");
  });

  it("stops retrying immediately when shouldRetry says the error is final (402 subscription_unpaid, #145)", async () => {
    let calls = 0;
    const unpaid = Object.assign(new Error("subscription_unpaid"), { status: 402 });
    const opts = { attempts: 5, baseDelayMs: 0, shouldRetry: (error: unknown) => (error as { status?: number }).status !== 402 };
    console.info(`[retry:final-error] invoking runWithRetries attempts=${opts.attempts}`);
    await expect(
      runWithRetries(async () => {
        calls += 1;
        throw unpaid;
      }, opts)
    ).rejects.toBe(unpaid);
    console.info(`[retry:final-error] calls=${calls}`);
    if (calls !== 1) dumpRetrySnapshot("final-error", { calls, opts: { attempts: opts.attempts } });
    expect(calls).toBe(1);
  });
});
