import { describe, expect, it, vi } from "vitest";
import { AdaptivePool } from "../src/storageTransport/adaptivePool";
import { StorageTunnelError } from "../../shared/src/storageTunnel";

// On assertion failure, dump pool stats + task call count so a retry/circuit
// mismatch is diagnosable offline. try/catch so a dump failure can't mask the
// real assertion.
const dumpPoolSnapshot = (
  label: string,
  ctx: { pool?: { getStats: () => unknown }; task?: { mock?: { calls: unknown[] } } },
) => {
  try {
    console.error(`=== [adaptive-pool:${label}] snapshot ===`);
    if (ctx.pool) {
      console.error(`pool stats=${JSON.stringify(ctx.pool.getStats(), null, 2)}`);
    }
    if (ctx.task?.mock) {
      console.error(`task callCount=${ctx.task.mock.calls.length}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("AdaptivePool", () => {
  it("does not retry or open circuit on non-retryable 4xx upload errors", async () => {
    console.info(`[adaptive-pool:setup] non-retryable-4xx case: initialConcurrency=2 maxRetries=3`);
    const pool = new AdaptivePool({ initialConcurrency: 2, maxRetries: 3 });
    const task = vi.fn(async () => {
      throw new Error("CHUNK_UPLOAD_FAILED_411");
    });

    await expect(pool.run(task)).rejects.toThrow("CHUNK_UPLOAD_FAILED_411");
    console.info(
      `[adaptive-pool:non-retryable-4xx] taskCalls=${task.mock.calls.length} circuitOpen=${pool.getStats().circuitOpen}`,
    );
    try {
      expect(task).toHaveBeenCalledTimes(1);
      expect(pool.getStats().circuitOpen).toBe(false);
    } catch (err) {
      dumpPoolSnapshot("non-retryable-4xx", { pool, task });
      throw err;
    }
  });

  it("@bugfix @regression-proof does not retry terminal storage tunnel 4xx errors", async () => {
    console.info(`[adaptive-pool:setup] terminal-tunnel-4xx case: StorageTunnelError(409 upload_quota_exceeded)`);
    const pool = new AdaptivePool({ initialConcurrency: 2, maxRetries: 3 });
    const task = vi.fn(async () => {
      throw new StorageTunnelError(409, { error: "upload_quota_exceeded" });
    });

    await expect(pool.run(task)).rejects.toThrow("upload_quota_exceeded");
    console.info(
      `[adaptive-pool:terminal-tunnel-4xx] taskCalls=${task.mock.calls.length} circuitOpen=${pool.getStats().circuitOpen}`,
    );
    try {
      expect(task).toHaveBeenCalledTimes(1);
      expect(pool.getStats().circuitOpen).toBe(false);
    } catch (err) {
      dumpPoolSnapshot("terminal-tunnel-4xx", { pool, task });
      throw err;
    }
  });

  it("retries retryable 5xx upload errors", async () => {
    console.info(`[adaptive-pool:setup] retryable-5xx case: maxRetries=1, fail once on 500 then ok (fake timers)`);
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    const pool = new AdaptivePool({ initialConcurrency: 1, maxRetries: 1 });
    let attempts = 0;
    const task = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("CHUNK_UPLOAD_FAILED_500");
      }
      return "ok";
    });

    const promise = pool.run(task);
    console.info(`[adaptive-pool:retryable-5xx] advancing fake timers 1100ms to clear backoff`);
    await vi.advanceTimersByTimeAsync(1_100);
    await expect(promise).resolves.toBe("ok");
    console.info(`[adaptive-pool:retryable-5xx] resolved attempts=${attempts} taskCalls=${task.mock.calls.length}`);
    try {
      expect(task).toHaveBeenCalledTimes(2);
    } catch (err) {
      dumpPoolSnapshot("retryable-5xx", { pool, task });
      throw err;
    }

    randomSpy.mockRestore();
    vi.useRealTimers();
  });

  it("does not retry or open circuit on local ENOENT file race errors", async () => {
    console.info(`[adaptive-pool:setup] enoent-race case: local ENOENT should be terminal (no retry, no circuit)`);
    const pool = new AdaptivePool({ initialConcurrency: 2, maxRetries: 3 });
    const task = vi.fn(async () => {
      throw new Error("ENOENT: no such file or directory, stat '/tmp/seg-00032.m4s'");
    });

    await expect(pool.run(task)).rejects.toThrow("ENOENT");
    console.info(
      `[adaptive-pool:enoent-race] taskCalls=${task.mock.calls.length} circuitOpen=${pool.getStats().circuitOpen}`,
    );
    try {
      expect(task).toHaveBeenCalledTimes(1);
      expect(pool.getStats().circuitOpen).toBe(false);
    } catch (err) {
      dumpPoolSnapshot("enoent-race", { pool, task });
      throw err;
    }
  });

  it("does not emit noisy debug warning for CANCELLED by default", async () => {
    // NOTE: this case spies/silences console.warn + console.info, so phase
    // markers + the dump here use console.error (unspied) to stay visible.
    console.error(`[adaptive-pool:setup] cancelled-quiet case: debug=true, expect no warn for CANCELLED`);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const pool = new AdaptivePool({ initialConcurrency: 2, maxRetries: 1, debug: true });
    const task = vi.fn(async () => {
      throw new Error("CANCELLED");
    });

    await expect(pool.run(task)).rejects.toThrow("CANCELLED");
    try {
      expect(task).toHaveBeenCalledTimes(1);
      expect(pool.getStats().circuitOpen).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
    } catch (err) {
      console.error(
        `=== [adaptive-pool:cancelled-quiet] snapshot === taskCalls=${task.mock.calls.length} circuitOpen=${pool.getStats().circuitOpen} warnCalls=${warnSpy.mock.calls.length} warnArgs=${JSON.stringify(warnSpy.mock.calls)}`,
      );
      throw err;
    } finally {
      warnSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });
});
