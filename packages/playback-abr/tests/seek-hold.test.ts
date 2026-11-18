/**
 * @test-id PLAYBACK-ABR-SEEK-HOLD-001
 * @level unit
 * @bugfix
 * @regression-proof
 *
 * Perf report, normal run 2026-10-15T21-28-03-365Z: a timeline seek was followed 0.35 s later by a network
 * `abr-downshift` (trigger=network), which reloaded the stream and issued a SECOND seek: seek_ms 3091 where a clean seek
 * restarts in ~1.3 s. A seek empties the buffer and mpv pauses for cache while it refills; that stall is the seek, not the
 * link. Downshifts are held for DOWNSHIFT_HOLD_AFTER_SEEK_MS after a seek, and while the stall that started with it goes on
 * up to DOWNSHIFT_HOLD_AFTER_SEEK_MAX_MS (a dead link still steps down).
 */
import { describe, expect, it } from "vitest";
import {
  DOWNSHIFT_HOLD_AFTER_SEEK_MAX_MS,
  DOWNSHIFT_HOLD_AFTER_SEEK_MS,
  createAbrController,
  noteFirstFrame,
  noteLaunch,
  noteLoadStarted,
  noteSeek,
  noteSessionStarted,
  stepNetworkAbr,
  type CacheConfig,
  type Variant,
} from "../src";

const LOG = "[seek-hold]";
const CACHE: CacheConfig = { cacheSecs: 30, demuxerMaxBytes: 32 * 1024 * 1024 };
const v = (id: string, quality: string, bitrateKbps: number): Variant => ({ id, quality, codec: "h264", bitrateKbps });
const ladder = [v("f", "1080p", 6_000), v("h", "720p", 2_500), v("s", "480p", 1_000)];

const playingController = () => {
  const ctrl = createAbrController(ladder, { quality: "1080p", force: false }, 0, null);
  noteLaunch(ctrl);
  noteSessionStarted(ctrl, 0);
  noteLoadStarted(ctrl, 0);
  noteFirstFrame(ctrl, 500);
  return ctrl;
};
const sample = (nowMs: number, bufferSeconds: number, pausedForCache: boolean, netBps: number) => ({
  nowMs,
  voConfigured: true,
  pausedForCache,
  bufferSeconds,
  cacheReachedEof: false,
  netBps,
  cache: CACHE,
});

describe("network ABR after a user seek", () => {
  it("@bugfix @regression-proof no downshift for the refill stall of the user's own seek (buffer 0, paused for cache)", () => {
    const ctrl = playingController();
    for (let t = 1; t <= 20; t++) stepNetworkAbr(ctrl, ladder, sample(t * 1000, 20, false, 20e6));
    noteSeek(ctrl, 30_000);
    // Perf's trace: the decision came 0.35 s after the seek, with the buffer drained and the player paused for cache.
    const actions = [];
    for (const dt of [350, 1000, 1500, 2000, 2900]) actions.push(stepNetworkAbr(ctrl, ladder, sample(30_000 + dt, 0, true, 0)));
    console.info(`${LOG} actions within ${DOWNSHIFT_HOLD_AFTER_SEEK_MS} ms: ${JSON.stringify(actions.map((a) => a.kind))}`);
    expect(actions.every((a) => a.kind === "hold")).toBe(true);
    expect(actions[0]).toEqual({ kind: "hold", downshiftHeld: "seek" });
    expect(ctrl.quality.currentId).toBe("f");
  });

  it("a stall that started with the seek stays held up to the cap, then a dead link steps down", () => {
    const ctrl = playingController();
    noteSeek(ctrl, 30_000);
    let firstSwitchDt: number | null = null;
    for (let dt = 350; dt <= 15_000 && firstSwitchDt === null; dt += 250) {
      const action = stepNetworkAbr(ctrl, ladder, sample(30_000 + dt, 0, true, 0));
      if (action.kind === "switch") firstSwitchDt = dt;
    }
    console.info(`${LOG} first downshift ${firstSwitchDt} ms after the seek`);
    expect(firstSwitchDt).not.toBeNull();
    expect(firstSwitchDt!).toBeGreaterThanOrEqual(DOWNSHIFT_HOLD_AFTER_SEEK_MAX_MS);
  });

  it("a seek whose refill finished does not extend the hold past the minimum", () => {
    const ctrl = playingController();
    noteSeek(ctrl, 30_000);
    stepNetworkAbr(ctrl, ladder, sample(30_500, 0, true, 0));
    // Refilled by 1.3 s (a clean seek), then the link really collapses: the hold ends at the minimum, not the cap.
    stepNetworkAbr(ctrl, ladder, sample(31_300, 4, false, 20e6));
    const action = stepNetworkAbr(ctrl, ladder, sample(30_000 + DOWNSHIFT_HOLD_AFTER_SEEK_MS + 500, 0, true, 0));
    expect(action.kind).toBe("switch");
  });

  it("without a seek the same collapsed sample downshifts immediately (the hold is seek-only)", () => {
    const ctrl = playingController();
    for (let t = 1; t <= 20; t++) stepNetworkAbr(ctrl, ladder, sample(t * 1000, 20, false, 20e6));
    expect(stepNetworkAbr(ctrl, ladder, sample(30_350, 0, true, 0)).kind).toBe("switch");
  });
});
