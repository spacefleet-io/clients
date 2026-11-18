/**
 * @test-id PLAYBACK-ABR-DOWNSHIFT-HYSTERESIS-001
 * @level unit
 * @bugfix
 * @regression-proof
 *
 * Issue #25 P8 (ultimate run 1791529129542: 430 downshifts, cascades 70 ms apart; the common trigger of P1b, P2 and P3).
 * Moved here from the desktop's own ABR when both clients started sharing one package.
 *
 * Evidence:
 *   S1 c055 (shard-1/timeline.jsonl): 721.997 "format switch: reloaded" (1080p -> 480p) -> 722.062 "abr downshift 480p -> 360p",
 *           65 ms later.
 *   S2 x007 (shard-2/timeline.jsonl): 473.210 "format switch: reloaded" -> 473.220 "abr downshift 480p -> 360p", 10 ms later.
 * A freshly reloaded stream has an empty buffer and an estimator still measuring the previous variant, so the next tick
 * always looked starving.
 *
 * Fix (Chris, 2026-10-09): no downshift within 5 s of a reload, and none until 3 s after the first frame.
 */
import { describe, expect, it } from "vitest";
import {
  DOWNSHIFT_HOLD_AFTER_FIRST_FRAME_MS,
  DOWNSHIFT_HOLD_AFTER_RELOAD_MS,
  abrDecide,
  type AbrState,
  type CacheConfig,
  type Variant,
} from "../src";

const LOG = "[abr-downshift-hysteresis]";
const DESKTOP_CACHE: CacheConfig = { cacheSecs: 16, demuxerMaxBytes: 96 * 1024 * 1024 };
const F_1080: Variant = { id: "f-1080", quality: "1080p", codec: "h264", bitrateKbps: 8000 };
const F_480: Variant = { id: "f-480", quality: "480p", codec: "h264", bitrateKbps: 1500 };
const F_360: Variant = { id: "f-360", quality: "360p", codec: "h264", bitrateKbps: 800 };
const NOW = 1_791_539_722_062;

// c055 at 722.062: on 480p, buffer empty right after the reload, throughput far below 480p - an emergency (buffer-critical)
// downshift to 360p.
const starving = (overrides: Partial<AbrState>): AbrState => ({
  variants: [F_1080, F_480, F_360],
  currentId: F_480.id,
  ewmaBps: 400_000,
  bufferSeconds: 0.2,
  underrunSinceMs: null,
  lastSwitchAtMs: NOW - 65,
  nowMs: NOW,
  bannedIds: new Set(),
  cacheReachedEof: false,
  loadStartedAtMs: NOW - 61_000,
  firstFrameAtMs: NOW - 60_000,
  lastReloadAtMs: null,
  cache: DESKTOP_CACHE,
  ...overrides,
});

const decide = (label: string, state: AbrState) => {
  const result = abrDecide(state);
  console.info(
    `${LOG} phase=${label} sinceFirstFrameMs=${state.firstFrameAtMs === null ? "none" : state.nowMs - state.firstFrameAtMs} sinceReloadMs=${state.lastReloadAtMs === null ? "none" : state.nowMs - state.lastReloadAtMs} decision=${JSON.stringify(result)}`,
  );
  return result;
};

describe("ABR downshift hysteresis (@bugfix @regression-proof issue #25 P8)", () => {
  it("windows are the decided 5 s after a reload and 3 s after the first frame", () => {
    expect(DOWNSHIFT_HOLD_AFTER_RELOAD_MS).toBe(5_000);
    expect(DOWNSHIFT_HOLD_AFTER_FIRST_FRAME_MS).toBe(3_000);
  });

  it("replays c055: a starving tick 65 ms after a reload settled holds instead of cascading to 360p", () => {
    expect(decide("c055-65ms", starving({ lastReloadAtMs: NOW - 65 }))).toEqual({ action: "hold", downshiftHeld: "reload" });
  });

  it("still holds at 4.999 s after the reload, downshifts at 5 s", () => {
    expect(decide("reload-4999", starving({ lastReloadAtMs: NOW - 4_999 }))).toEqual({ action: "hold", downshiftHeld: "reload" });
    expect(decide("reload-5000", starving({ lastReloadAtMs: NOW - 5_000 }))).toEqual({
      action: "downshift",
      targetId: F_360.id,
      reason: "buffer-critical",
    });
  });

  it("no downshift before the first frame, nor within 3 s of it; allowed from 3 s on", () => {
    expect(decide("no-first-frame", starving({ loadStartedAtMs: NOW - 1_000, firstFrameAtMs: null }))).toEqual({
      action: "hold",
      downshiftHeld: "first-frame",
    });
    expect(decide("first-frame-2999", starving({ firstFrameAtMs: NOW - 2_999 }))).toEqual({ action: "hold", downshiftHeld: "first-frame" });
    expect(decide("first-frame-3000", starving({ firstFrameAtMs: NOW - 3_000 }))).toEqual({
      action: "downshift",
      targetId: F_360.id,
      reason: "buffer-critical",
    });
  });

  it("the preemptive (buffer-low) downshift is held the same way", () => {
    const lowBuffer = { bufferSeconds: 3, ewmaBps: 1_200_000 };
    expect(decide("buffer-low-held", starving({ ...lowBuffer, lastReloadAtMs: NOW - 1_000 }))).toEqual({ action: "hold", downshiftHeld: "reload" });
    expect(decide("buffer-low-allowed", starving({ ...lowBuffer, lastReloadAtMs: NOW - 6_000 }))).toEqual({
      action: "downshift",
      targetId: F_360.id,
      reason: "buffer-low",
    });
  });

  it("an upshift is not affected by the downshift windows", () => {
    const result = decide(
      "upshift",
      starving({ currentId: F_360.id, ewmaBps: 100_000_000, bufferSeconds: 30, lastSwitchAtMs: null, lastReloadAtMs: NOW - 100 }),
    );
    expect(result.action).toBe("upshift");
  });
});
