/**
 * @test-id PLAYBACK-ABR-THROTTLED-RESUME-001
 * @level unit
 * @bugfix
 * @regression-proof
 *
 * Issue #25 N4 (ultimate M1 vs before, seed 1791529129542): on throttled resumes the ttff p95 went from 11.5 s to 17.6 s, and the
 * number with 2+ downshifts went from 5 to 28. Moved here from the desktop's own ABR when both clients started sharing one package.
 *
 * Evidence: M1 shard-1/timeline.jsonl, case c061:resume, 6000 kbps throttle (throttleFloorMs 7171), with offsets from the click:
 *   +2362  "load handoff complete". This stamped the first-frame hold clock, but no frame had been decoded.
 *   +5839  "abr downshift 1080p -> 480p", 3.48 s after that stamp -> reload
 *   +6703  reloaded. The reload hold (5 s) ran out while the 480p load was still waiting for its frame.
 *   +11721 "abr downshift 480p -> 360p" -> second reload
 *   +19597 first frame. The run before #151 had one downshift and a 10599 ms ttff.
 * A resume has to fetch its whole seek-target segment before the player shows a frame. Until then the buffer reads empty: that is
 * the load in flight, not a starving link. The 3 s / 5 s holds ran out first, so every reload restarted the throttled transfer.
 *
 * Fix: for a client whose first frame is an event (desktop: mpv's first playback-restart; `firstFrameFrom: "event"`) the
 * first-frame clock is that event, and every reload resets it. While a load waits for its frame, downshifts stay held, up to
 * DOWNSHIFT_HOLD_AWAITING_FRAME_MAX_MS, so a dead link still steps down.
 */
import { describe, expect, it } from "vitest";
import {
  DOWNSHIFT_HOLD_AFTER_FIRST_FRAME_MS,
  DOWNSHIFT_HOLD_AWAITING_FRAME_MAX_MS,
  createAbrController,
  noteFirstFrame,
  noteLaunch,
  noteLoadStarted,
  noteReloadStarted,
  noteSessionStarted,
  noteSwitchSettled,
  stepNetworkAbr,
  type CacheConfig,
  type Variant,
} from "../src";

const LOG = "[abr-throttled-resume]";
const DESKTOP_CACHE: CacheConfig = { cacheSecs: 16, demuxerMaxBytes: 96 * 1024 * 1024 };
// c061's rungs (mpv-12 log: `--vid=1 3821 kbps`, `--vid=2 270`, `--vid=3 184`).
const F_1080: Variant = { id: "f-1080", quality: "1080p", codec: "h264", bitrateKbps: 3821 };
const F_480: Variant = { id: "f-480", quality: "480p", codec: "h264", bitrateKbps: 270 };
const F_360: Variant = { id: "f-360", quality: "360p", codec: "h264", bitrateKbps: 184 };
const FORMATS = [F_1080, F_480, F_360];

// Offsets from the click, taken from c061 in M1.
const HANDOFF_MS = 2362;
const FIRST_TICK_MS = 2820;
const TICK_MS = 1000;
// One seek-target segment at 6000 kbps (the case's throttleFloorMs). In M1 every load took about this long to its frame,
// whatever the rung (the 360p reload took +11929 -> +19597).
const SEGMENT_MS = 7171;
// Downshift -> "format switch: reloaded" in M1 (+5839 -> +6703).
const RELOAD_SETTLE_MS = 850;
// The ttff of c061 in the run before #151.
const BEFORE_151_TTFF_MS = 10_599;

type Link = {
  /** ms from a load's start to its first frame; null = the frame never comes. */
  frameAfterLoadMs: number | null;
  /** Throughput while a load waits for its frame. */
  waitingBps: number;
  /** Buffer + throughput once frames flow. */
  playing: { bufferSeconds: number; bps: number };
  endMs: number;
};

type Downshift = { atMs: number; from: string; to: string; reason: string };

/** Drives the engine's clock events + 1 Hz network ticks through one resume, the way the desktop engine does. */
const simulate = (label: string, link: Link) => {
  const ctrl = createAbrController(FORMATS, { quality: "1080p", force: false }, 0, null, { firstFrameFrom: "event" });
  noteLaunch(ctrl);
  noteSessionStarted(ctrl, 0);
  noteLoadStarted(ctrl, HANDOFF_MS);
  let loadStartedAt = HANDOFF_MS;
  let framedAt: number | null = null;
  let firstFrameAt: number | null = null;
  let reload: { settleAt: number } | null = null;
  const downshifts: Downshift[] = [];
  for (let t = FIRST_TICK_MS; t <= link.endMs; t += TICK_MS) {
    if (reload && reload.settleAt <= t) {
      noteSwitchSettled(ctrl, reload.settleAt);
      loadStartedAt = reload.settleAt;
      framedAt = null;
      console.info(`${LOG} ${label} t=${reload.settleAt} reload settled on ${ctrl.quality.currentId}`);
      reload = null;
    }
    if (framedAt === null && link.frameAfterLoadMs !== null && loadStartedAt + link.frameAfterLoadMs <= t) {
      framedAt = loadStartedAt + link.frameAfterLoadMs;
      firstFrameAt ??= framedAt;
      noteFirstFrame(ctrl, framedAt);
      console.info(`${LOG} ${label} t=${framedAt} first frame on ${ctrl.quality.currentId}`);
    }
    // The engine runs no ABR decision while a reload is in flight.
    if (reload) continue;
    const playing = framedAt !== null;
    const from = ctrl.quality.currentId!;
    const action = stepNetworkAbr(ctrl, FORMATS, {
      nowMs: t,
      voConfigured: true,
      pausedForCache: false,
      bufferSeconds: playing ? link.playing.bufferSeconds : 0,
      cacheReachedEof: false,
      netBps: playing ? link.playing.bps : link.waitingBps,
      cache: DESKTOP_CACHE,
    });
    console.info(`${LOG} ${label} t=${t} on=${from} framed=${playing} action=${JSON.stringify(action)}`);
    if (action.kind !== "switch" || action.reason !== "abr-downshift") continue;
    downshifts.push({ atMs: t, from, to: action.targetId, reason: action.reason });
    noteReloadStarted(ctrl);
    reload = { settleAt: t + RELOAD_SETTLE_MS };
  }
  console.info(`${LOG} ${label} result ttffMs=${firstFrameAt} downshifts=${JSON.stringify(downshifts)}`);
  return { ttffMs: firstFrameAt, downshifts };
};

const THROTTLED_RESUME: Link = {
  frameAfterLoadMs: SEGMENT_MS,
  // M1's first pick was 480p, so the estimate cleared 480p's (270+128)*0.85 kbps.
  waitingBps: 500_000,
  playing: { bufferSeconds: 8, bps: 6_000_000 },
  endMs: 40_000,
};

describe("ABR on a throttled resume (@bugfix @regression-proof issue #25 N4)", () => {
  it("c061: no downshift while the 1080p resume waits for its segment; first frame no later than before #151", () => {
    const { ttffMs, downshifts } = simulate("c061", THROTTLED_RESUME);
    expect(downshifts).toEqual([]);
    expect(ttffMs).toBe(HANDOFF_MS + SEGMENT_MS);
    expect(ttffMs).toBeLessThanOrEqual(BEFORE_151_TTFF_MS);
  });

  it("a dead link still steps down once the wait cap passes, and a reload waiting for its frame does not cascade", () => {
    const cap = DOWNSHIFT_HOLD_AWAITING_FRAME_MAX_MS;
    console.info(`${LOG} dead-link cap=${cap}`);
    expect(cap).toBe(10_000);
    const { ttffMs, downshifts } = simulate("dead-link", { ...THROTTLED_RESUME, frameAfterLoadMs: null });
    expect(ttffMs).toBeNull();
    expect(downshifts.map((d) => d.to)).toEqual([F_480.id, F_360.id]);
    const [first, second] = downshifts as [Downshift, Downshift];
    // The first tick at or past handoff + cap.
    expect(first.atMs).toBe(12_820);
    expect(first.atMs).toBeGreaterThanOrEqual(HANDOFF_MS + cap);
    // The 480p reload gets its own full wait, so no second step 5 s after the reload.
    expect(second.atMs).toBeGreaterThanOrEqual(first.atMs + RELOAD_SETTLE_MS + cap);
  });

  it("an unthrottled start keeps #151's hold: no downshift within 3 s of the real first frame", () => {
    const frameAt = HANDOFF_MS + 1500;
    const { ttffMs, downshifts } = simulate("unthrottled-then-starving", {
      frameAfterLoadMs: 1500,
      waitingBps: 500_000,
      // Starving after the frame: emergency territory once the hold ends.
      playing: { bufferSeconds: 0.2, bps: 500_000 },
      endMs: 9_000,
    });
    expect(ttffMs).toBe(frameAt);
    expect(downshifts).toHaveLength(1);
    expect(downshifts[0]!.atMs).toBeGreaterThanOrEqual(frameAt + DOWNSHIFT_HOLD_AFTER_FIRST_FRAME_MS);
  });
});
