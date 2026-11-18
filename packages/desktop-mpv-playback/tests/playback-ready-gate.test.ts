import { describe, expect, it } from "vitest";
import { pollMetadataApplied, pollVoConfigured } from "../src/externalMpvController";

/**
 * @bugfix badger-desktop-playback-ready-gate
 * @regression-proof
 *
 * Before this fix, the badger-desktop playback launch flow dismissed the
 * loading modal as soon as mpv reported `isPlaying` over IPC, hid the
 * Electron window the moment mpv's IPC socket appeared, and only THEN
 * sent subtitle/chapter metadata via script-message. The user saw the
 * modal vanish → blank gap of seconds → mpv finally pops up with empty
 * track names / no chapters / blank subtitle labels that "caught up"
 * after another few seconds.
 *
 * The fix centralizes "ready to reveal" on a gate that waits for both
 * (a) metadata applied to track-list / chapter-list and (b) mpv's video
 * output configured (or time-pos > 0 as a fallback). These tests pin the
 * pure polling cores so the gate behavior cannot regress silently.
 */
// On assertion failure, dump the poll outcome + the fake-clock elapsed time +
// any poll-call counter so timeout/budget edge cases are diagnosable offline.
// Body in try/catch so a dump failure can't mask the assertion failure.
const dumpReadyGateSnapshot = (
  label: string,
  ctx: { ok?: boolean; elapsedMs?: number; budgetMs?: number; calls?: number; extra?: Record<string, unknown> },
): void => {
  try {
    console.error(`=== [playback-ready-gate:${label}] snapshot ===`);
    console.error(
      `ok=${ctx.ok} fakeClockElapsedMs=${ctx.elapsedMs} budgetMs=${ctx.budgetMs} calls=${ctx.calls}`,
    );
    if (ctx.extra) console.error(`extra: ${JSON.stringify(ctx.extra)}`);
  } catch (err) {
    console.error(
      `(snapshot failed: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
};

describe("playback ready-gate polling cores", () => {
  // Fake clock + sleep so tests run instantly and deterministically.
  const makeClock = () => {
    let t = 0;
    const now = () => t;
    const sleep = async (ms: number) => {
      t += ms;
    };
    return { now, sleep, advance: (ms: number) => (t += ms) };
  };

  it("pollMetadataApplied returns true immediately when nothing is expected", async () => {
    console.info(`[playback-ready-gate:meta-nothing-expected] polling with no expectations, budget=5000`);
    const { now, sleep } = makeClock();
    const send = async () => ({ data: [] });
    const ok = await pollMetadataApplied({}, 5000, send, sleep, now);
    console.info(`[playback-ready-gate:meta-nothing-expected] ok=${ok} fakeClockElapsedMs=${now()}`);
    if (ok !== true) dumpReadyGateSnapshot("meta-nothing-expected", { ok, elapsedMs: now(), budgetMs: 5000 });
    expect(ok).toBe(true);
  });

  it("pollMetadataApplied resolves true once subtitles match expected count", async () => {
    console.info(`[playback-ready-gate:meta-subs-match] expecting 2 external subs (arrive on 2nd poll), budget=5000`);
    const { now, sleep } = makeClock();
    let calls = 0;
    const send = async (cmd: unknown) => {
      const [, prop] = (cmd as { command: [string, string] }).command;
      if (prop !== "track-list") return { data: [] };
      calls += 1;
      console.info(`[playback-ready-gate:meta-subs-match] track-list poll #${calls} at fakeClockMs=${now()}`);
      // First poll: no external subs yet. Second poll: 2 external subs.
      if (calls < 2) {
        return { data: [{ type: "video", external: false }] };
      }
      return {
        data: [
          { type: "video", external: false },
          { type: "sub", external: true },
          { type: "sub", external: true },
        ],
      };
    };
    const ok = await pollMetadataApplied(
      { expectedExternalSubtitles: 2 },
      5000,
      send,
      sleep,
      now
    );
    console.info(`[playback-ready-gate:meta-subs-match] ok=${ok} calls=${calls} fakeClockElapsedMs=${now()}`);
    if (ok !== true || calls < 2) {
      dumpReadyGateSnapshot("meta-subs-match", { ok, elapsedMs: now(), budgetMs: 5000, calls });
    }
    expect(ok).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("pollMetadataApplied resolves false when expectations never met within budget", async () => {
    console.info(`[playback-ready-gate:meta-budget-exceeded] expecting 1 sub + 5 chapters, send always empty, budget=500`);
    const { now, sleep } = makeClock();
    const send = async () => ({ data: [] });
    const ok = await pollMetadataApplied(
      { expectedExternalSubtitles: 1, expectedChapters: 5 },
      500,
      send,
      sleep,
      now
    );
    console.info(`[playback-ready-gate:meta-budget-exceeded] ok=${ok} fakeClockElapsedMs=${now()} budget=500`);
    if (ok !== false) dumpReadyGateSnapshot("meta-budget-exceeded", { ok, elapsedMs: now(), budgetMs: 500 });
    expect(ok).toBe(false);
  });

  it("pollMetadataApplied requires BOTH subtitle AND chapter expectations to pass", async () => {
    console.info(`[playback-ready-gate:meta-both-required] subs present, chapters never arrive, budget=300`);
    const { now, sleep } = makeClock();
    // Subs present from the start; chapters never arrive.
    const send = async (cmd: unknown) => {
      const [, prop] = (cmd as { command: [string, string] }).command;
      if (prop === "track-list") {
        return { data: [{ type: "sub", external: true }] };
      }
      return { data: [] };
    };
    const ok = await pollMetadataApplied(
      { expectedExternalSubtitles: 1, expectedChapters: 1 },
      300,
      send,
      sleep,
      now
    );
    console.info(`[playback-ready-gate:meta-both-required] ok=${ok} fakeClockElapsedMs=${now()} budget=300`);
    if (ok !== false) {
      dumpReadyGateSnapshot("meta-both-required", { ok, elapsedMs: now(), budgetMs: 300, extra: { note: "chapters never arrive → must stay false" } });
    }
    expect(ok).toBe(false);
  });

  it("pollMetadataApplied counts external subs only (not embedded)", async () => {
    console.info(`[playback-ready-gate:meta-external-only] 2 embedded subs only, expecting 1 external, budget=300`);
    const { now, sleep } = makeClock();
    const send = async () => ({
      data: [
        { type: "sub", external: false },
        { type: "sub", external: false },
      ],
    });
    const ok = await pollMetadataApplied(
      { expectedExternalSubtitles: 1 },
      300,
      send,
      sleep,
      now
    );
    console.info(`[playback-ready-gate:meta-external-only] ok=${ok} fakeClockElapsedMs=${now()} budget=300`);
    if (ok !== false) {
      dumpReadyGateSnapshot("meta-external-only", { ok, elapsedMs: now(), budgetMs: 300, extra: { note: "embedded subs must not satisfy external expectation" } });
    }
    expect(ok).toBe(false);
  });

  it("pollVoConfigured resolves true when mpv reports vo-configured", async () => {
    console.info(`[playback-ready-gate:vo-configured-true] vo-configured=true, budget=5000`);
    const { now, sleep } = makeClock();
    const send = async (cmd: unknown) => {
      const [, prop] = (cmd as { command: [string, string] }).command;
      if (prop === "vo-configured") return { data: true };
      return { data: null };
    };
    const ok = await pollVoConfigured(5000, send, sleep, now);
    console.info(`[playback-ready-gate:vo-configured-true] ok=${ok} fakeClockElapsedMs=${now()}`);
    if (ok !== true) dumpReadyGateSnapshot("vo-configured-true", { ok, elapsedMs: now(), budgetMs: 5000 });
    expect(ok).toBe(true);
  });

  it("pollVoConfigured falls back to time-pos > 0 when vo-configured unavailable", async () => {
    console.info(`[playback-ready-gate:vo-fallback-timepos] vo-configured unavailable, time-pos=1.234, budget=5000`);
    const { now, sleep } = makeClock();
    const send = async (cmd: unknown) => {
      const [, prop] = (cmd as { command: [string, string] }).command;
      if (prop === "vo-configured") return { error: "property unavailable" };
      if (prop === "time-pos") return { data: 1.234 };
      return null;
    };
    const ok = await pollVoConfigured(5000, send, sleep, now);
    console.info(`[playback-ready-gate:vo-fallback-timepos] ok=${ok} fakeClockElapsedMs=${now()}`);
    if (ok !== true) {
      dumpReadyGateSnapshot("vo-fallback-timepos", { ok, elapsedMs: now(), budgetMs: 5000, extra: { note: "time-pos>0 must satisfy gate when vo-configured unavailable" } });
    }
    expect(ok).toBe(true);
  });

  it("pollVoConfigured returns false when neither vo-configured nor time-pos progresses", async () => {
    console.info(`[playback-ready-gate:vo-no-progress] vo-configured null, time-pos=0, budget=300`);
    const { now, sleep } = makeClock();
    const send = async (cmd: unknown) => {
      const [, prop] = (cmd as { command: [string, string] }).command;
      if (prop === "time-pos") return { data: 0 };
      return { data: null };
    };
    const ok = await pollVoConfigured(300, send, sleep, now);
    console.info(`[playback-ready-gate:vo-no-progress] ok=${ok} fakeClockElapsedMs=${now()} budget=300`);
    if (ok !== false) dumpReadyGateSnapshot("vo-no-progress", { ok, elapsedMs: now(), budgetMs: 300 });
    expect(ok).toBe(false);
  });
});
