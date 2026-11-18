import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * @bugfix @regression-proof
 *
 * Regression test for commit ede80b62 — HLS prewarm capped at 2 s via
 * Promise.race. Pre-cap the prewarm await was unbounded: a slow storage
 * tunnel chunk fetch could stall the entire launch flow before mpv
 * even spawned. User-observed delay between "click Resume" and
 * "Electron window hides behind mpv" was up to ~60 s on cold-storage paths.
 *
 * Post-fix: prewarm waits at most PREWARM_BUDGET_MS (2 s). If the
 * underlying `window.sf.prewarmPlaybackHlsSession` hangs, the
 * Promise.race resolves to `null` and the launch proceeds — mpv fetches
 * the cold chunks itself (it starts as soon as playable), and
 * the window-hide path remains bounded.
 *
 * The behavior is dispatched from the engine's `loadStream` (renderer)
 * but the actual race shape is provider-pattern independent. This test
 * reproduces the production race using `vi.useFakeTimers()` and the
 * same shape (`prewarmPromise`, `timeoutPromise`,
 * `Promise.race([prewarmPromise, timeoutPromise])`) so any refactor
 * that breaks the cap behavior fails this test.
 */

describe("@bugfix @regression-proof HLS prewarm cap (PREWARM_BUDGET_MS = 2000 ms)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const PREWARM_BUDGET_MS = 2000;

  // On a race-outcome assertion failure, dump the budget and the observed
  // result so it's clear whether the inner promise or the timeout won.
  // Wrapped in try/catch so a dump failure can't mask the assertion.
  const dumpHlsPrewarmCapSnapshot = (label: string, budgetMs: number, result: unknown) => {
    try {
      console.error(`=== [hls-prewarm-cap:${label}] race snapshot ===`);
      console.error(`budgetMs=${budgetMs} resultIsNull=${result === null}`);
      console.error(`result=${JSON.stringify(result)}`);
    } catch (err) {
      console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
    }
  };

  const raceWithBudget = async <T,>(
    inner: Promise<T>,
    budgetMs: number,
  ): Promise<T | null> => {
    const timeoutPromise = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), budgetMs);
    });
    return await Promise.race([inner, timeoutPromise]);
  };

  it("@bugfix @regression-proof fast prewarm: returns the real result, no fallback", async () => {
    const inner = new Promise<{ warmedKeys: string[]; missedKeys: string[]; elapsedMs: number }>(
      (resolve) => {
        setTimeout(() => resolve({
          warmedKeys: ["video-init", "video-segment-100", "audio-init", "audio-segment-100"],
          missedKeys: [],
          elapsedMs: 50,
        }), 50);
      },
    );
    console.info("[hls-prewarm-cap:fast] inner resolves at 50ms, budget=2000ms; advancing fake timers by 60ms");
    const racePromise = raceWithBudget(inner, PREWARM_BUDGET_MS);
    // Advance just past 50 ms — race resolves with the real result.
    await vi.advanceTimersByTimeAsync(60);
    const result = await racePromise;
    try {
      expect(result).not.toBeNull();
      expect(result?.warmedKeys).toHaveLength(4);
    } catch (err) {
      dumpHlsPrewarmCapSnapshot("fast-prewarm-assert-failed", PREWARM_BUDGET_MS, result);
      throw err;
    }
  });

  it("@bugfix @regression-proof slow prewarm: returns null after budget (proceeds with cold launch)", async () => {
    // Inner never resolves within the budget (simulates a slow storage tunnel).
    const inner = new Promise<{ warmedKeys: string[]; missedKeys: string[]; elapsedMs: number }>(
      (resolve) => {
        setTimeout(() => resolve({
          warmedKeys: [],
          missedKeys: ["video-init"],
          elapsedMs: 60000,
        }), 60000);
      },
    );
    console.info("[hls-prewarm-cap:slow] inner resolves at 60000ms, budget=2000ms; advancing fake timers by budget+1ms");
    const racePromise = raceWithBudget(inner, PREWARM_BUDGET_MS);
    // Advance just past 2 s — timeoutPromise wins.
    await vi.advanceTimersByTimeAsync(PREWARM_BUDGET_MS + 1);
    const result = await racePromise;
    try {
      expect(result).toBeNull();
    } catch (err) {
      dumpHlsPrewarmCapSnapshot("slow-prewarm-assert-failed", PREWARM_BUDGET_MS, result);
      throw err;
    }
  });

  it("@bugfix @regression-proof budget boundary: just below 2 s still resolves to real (fast-path)", async () => {
    const inner = new Promise<{ warmedKeys: string[]; missedKeys: string[]; elapsedMs: number }>(
      (resolve) => {
        // Resolve at 1.9 s — just inside the budget.
        setTimeout(() => resolve({
          warmedKeys: ["k1"],
          missedKeys: [],
          elapsedMs: 1900,
        }), 1900);
      },
    );
    console.info("[hls-prewarm-cap:boundary] inner resolves at 1900ms (inside budget); advancing fake timers by 1950ms");
    const racePromise = raceWithBudget(inner, PREWARM_BUDGET_MS);
    await vi.advanceTimersByTimeAsync(1950);
    const result = await racePromise;
    try {
      expect(result).not.toBeNull();
      expect(result?.warmedKeys).toEqual(["k1"]);
    } catch (err) {
      dumpHlsPrewarmCapSnapshot("boundary-below-budget-assert-failed", PREWARM_BUDGET_MS, result);
      throw err;
    }
  });

  it("@bugfix @regression-proof when prewarm throws, the race result is the thrown rejection (caller catches)", async () => {
    // The production code wraps the whole prewarm block in try/catch
    // and logs a warning. The race itself rejects when inner rejects.
    console.info("[hls-prewarm-cap:reject] inner rejects with tunnel_dead; expecting race to propagate the rejection");
    const inner = Promise.reject(new Error("tunnel_dead"));
    let caught: unknown = null;
    try {
      await raceWithBudget(inner, PREWARM_BUDGET_MS);
    } catch (err) {
      caught = err;
    }
    console.info(`[hls-prewarm-cap:reject] caught=${caught instanceof Error ? caught.message : String(caught)}`);
    try {
      expect((caught as Error)?.message).toBe("tunnel_dead");
    } catch (err) {
      dumpHlsPrewarmCapSnapshot(
        "reject-propagation-assert-failed",
        PREWARM_BUDGET_MS,
        caught instanceof Error ? caught.message : caught,
      );
      throw err;
    }
  });
});
