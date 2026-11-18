// @bugfix @regression-proof issue #25 (Auto never climbs back to the ceiling
// after the network recovers).
//
// Evidence (live mpv 0.41, app cache args, /tmp/sf-abr-live, 2026-10-15):
//   - `demuxer-cache-state.cache-duration` plateaus at exactly 16.0 s
//     (= `--cache-secs=16`) on an unthrottled link and never exceeds it. The
//     upshift gate `bufferSeconds > BUFFER_HIGH_S (20)` could never open.
//   - The engine banned every rung it downshifted away from
//     (`abrBannedFormatIdsRef.current.add`) and nothing ever cleared it, so
//     even an open gate could never re-enter the ceiling rung.
//
// The shared @space/playback-abr (desktop + mobile) fixes both by design: the
// upshift gate is a fraction of what mpv's cache can hold (read from the
// player's own cache config), and the network never bans a rung. Anti-flap is
// the controller's climb hold: one switch cooldown, doubled (capped) when a
// climb is followed by a downshift, so a recovered link always leads back to the
// ceiling.
import { describe, expect, it } from "vitest";
import {
  abrDecide,
  AUDIO_BITRATE_KBPS_FALLBACK,
  createAbrController,
  MAX_CLIMB_HOLD_MS,
  noteSessionStarted,
  qualityRank,
  stepNetworkAbr,
  SWITCH_COOLDOWN_MS,
  upshiftBufferThresholdS,
  UPSHIFT_BUFFER_FRACTION,
  UPSHIFT_HEADROOM,
  type AbrAction,
  type AbrState,
  type CacheConfig,
  type Variant,
} from "@space/playback-abr";

const LOG = "[abr-recovery-to-ceiling]";
const F_1080: Variant = { id: "f-1080", quality: "1080p", bitrateKbps: 4000, codec: "h264" };
const F_720: Variant = { id: "f-720", quality: "720p", bitrateKbps: 2500, codec: "h264" };
const F_480: Variant = { id: "f-480", quality: "480p", bitrateKbps: 1200, codec: "h264" };
const LADDER = [F_1080, F_720, F_480];
const T0 = 1_791_600_000_000;
// Live plateau: mpv never buffers more than its readahead target.
const MPV_CACHE_SECS = 16;
const CACHE: CacheConfig = { cacheSecs: MPV_CACHE_SECS, demuxerMaxBytes: 96 * 1024 * 1024 };
const RECOVERED_LINK_BPS = 30_000_000;
const DROPPED_LINK_BPS = (F_480.bitrateKbps! + AUDIO_BITRATE_KBPS_FALLBACK) * 1000;

const recovered = (overrides: Partial<AbrState>): AbrState => ({
  variants: LADDER,
  currentId: F_720.id,
  ewmaBps: RECOVERED_LINK_BPS,
  bufferSeconds: MPV_CACHE_SECS,
  underrunSinceMs: null,
  lastSwitchAtMs: T0,
  nowMs: T0 + SWITCH_COOLDOWN_MS,
  ceilingRank: qualityRank("1080p"),
  bannedIds: new Set<string>(),
  cacheReachedEof: false,
  loadStartedAtMs: T0 - 1_000,
  firstFrameAtMs: T0,
  lastReloadAtMs: T0,
  cache: CACHE,
  ...overrides,
});

const decide = (label: string, state: AbrState) => {
  const result = abrDecide(state);
  console.info(
    `${LOG} phase=${label} current=${state.currentId} buffer=${state.bufferSeconds} cacheSecs=${state.cache.cacheSecs} ewmaBps=${state.ewmaBps} banned=${JSON.stringify([...state.bannedIds])} sinceSwitchMs=${state.lastSwitchAtMs === null ? "none" : state.nowMs - state.lastSwitchAtMs} result=${JSON.stringify(result)}`,
  );
  return result;
};

describe("ABR recovery to the ceiling (@bugfix @regression-proof issue #25)", () => {
  it("upshifts with mpv's live buffer plateau (16 s of a 16 s cache)", () => {
    const result = decide("plateau-16s", recovered({}));
    expect(result).toEqual({ action: "upshift", targetId: F_1080.id });
  });

  it("the upshift gate is a fraction of what the player's cache can hold, never above it", () => {
    const gate = upshiftBufferThresholdS(CACHE, F_720);
    console.info(`${LOG} phase=gate gate=${gate} fraction=${UPSHIFT_BUFFER_FRACTION} cacheSecs=${MPV_CACHE_SECS}`);
    expect(gate).toBeCloseTo(MPV_CACHE_SECS * UPSHIFT_BUFFER_FRACTION, 6);
    expect(gate).toBeLessThan(MPV_CACHE_SECS);
    expect(decide("gate-open", recovered({ bufferSeconds: gate }))).toEqual({ action: "upshift", targetId: F_1080.id });
    expect(decide("gate-shut", recovered({ bufferSeconds: gate - 0.01 }))).toEqual({ action: "hold" });
  });

  it("a rung Auto left because of the network is not banned: it is eligible again once the switch cooldown passes", () => {
    const justBefore = decide("cooldown", recovered({ nowMs: T0 + SWITCH_COOLDOWN_MS - 1 }));
    expect(justBefore).toEqual({ action: "hold" });
    expect(decide("eligible", recovered({ nowMs: T0 + SWITCH_COOLDOWN_MS }))).toEqual({
      action: "upshift",
      targetId: F_1080.id,
    });
  });

  it("full cycle: 1080p → 480p on a drop, back at the 1080p ceiling one switch cooldown after the link recovers", () => {
    let current = F_1080;
    let lastSwitchAt: number | null = T0 - 120_000;
    let now = T0;
    const path: string[] = [current.quality];

    // Drop: link falls below 720p, buffer drains to critical.
    const drop = decide(
      "drop",
      recovered({
        currentId: current.id,
        ewmaBps: DROPPED_LINK_BPS,
        bufferSeconds: 0.5,
        lastSwitchAtMs: lastSwitchAt,
        nowMs: now,
        lastReloadAtMs: null,
        firstFrameAtMs: T0 - 100_000,
      }),
    );
    expect(drop).toEqual({ action: "downshift", targetId: F_480.id, reason: "buffer-critical" });
    current = F_480;
    lastSwitchAt = now;
    path.push(current.quality);

    // Recovery: link fat, buffer at mpv's plateau. Tick at 1 Hz.
    for (let tick = 1; tick <= 300 && current.id !== F_1080.id; tick += 1) {
      now = T0 + tick * 1_000;
      const result = abrDecide(recovered({ currentId: current.id, lastSwitchAtMs: lastSwitchAt, nowMs: now, lastReloadAtMs: lastSwitchAt }));
      if (result.action === "upshift") {
        const next = LADDER.find((f) => f.id === result.targetId)!;
        console.info(`${LOG} phase=recovery tick=${tick} upshift ${current.quality}→${next.quality}`);
        current = next;
        lastSwitchAt = now;
        path.push(current.quality);
      } else {
        expect(result.action).toBe("hold");
      }
    }
    console.info(`${LOG} phase=done path=${path.join("→")} reachedAtMs=${now - T0}`);
    expect(path).toEqual(["1080p", "480p", "1080p"]);
    expect(now - T0).toBe(SWITCH_COOLDOWN_MS);
    // Headroom stays in force: the climb needed the full 1.5× margin.
    expect(RECOVERED_LINK_BPS).toBeGreaterThan((F_1080.bitrateKbps! + AUDIO_BITRATE_KBPS_FALLBACK) * 1000 * UPSHIFT_HEADROOM);
  });

  it("anti-flap: a climb that is followed by a drop doubles the climb hold, capped, and the ceiling is always reached again", () => {
    // The desktop engine's controller: the link meter's own estimate is adopted as is.
    const ctrl = createAbrController(LADDER, { quality: "1080p", force: false }, T0 - 120_000, null, {
      firstFrameFrom: "event",
      netBpsIsSmoothed: true,
    });
    noteSessionStarted(ctrl, T0 - 120_000);
    ctrl.quality = { ...ctrl.quality, currentId: F_1080.id, mode: "auto" };
    ctrl.loadStartedAtMs = T0 - 100_000;
    ctrl.firstFrameAtMs = T0 - 99_000;

    const sample = (nowMs: number, netBps: number, bufferSeconds: number) =>
      stepNetworkAbr(ctrl, LADDER, {
        nowMs,
        voConfigured: true,
        pausedForCache: false,
        bufferSeconds,
        cacheReachedEof: false,
        netBps,
        cache: CACHE,
      });

    let now = T0;
    const waits: number[] = [];
    for (let cycle = 0; cycle < 6; cycle += 1) {
      // The link drops: Auto leaves the ceiling.
      const down = sample(now, DROPPED_LINK_BPS, 0.5);
      expect(down).toMatchObject({ kind: "switch", targetId: F_480.id });
      const droppedAt = now;
      // The link recovers: tick at 1 Hz until Auto is back at the ceiling.
      let back: AbrAction = { kind: "hold" };
      while (back.kind !== "switch") {
        now += 1_000;
        back = sample(now, RECOVERED_LINK_BPS, MPV_CACHE_SECS);
        if (now - droppedAt > 600_000) throw new Error("never climbed back");
      }
      expect(back).toMatchObject({ kind: "switch", targetId: F_1080.id });
      waits.push(now - droppedAt);
      // The very next sample drops again: the climb was too optimistic.
      now += 1_000;
    }
    console.info(`${LOG} phase=flap waitsMs=${JSON.stringify(waits)}`);
    // 30 s the first time, doubled by each climb that is followed by a drop, capped; a stable stretch resets it.
    expect(waits.slice(0, 3)).toEqual([SWITCH_COOLDOWN_MS, SWITCH_COOLDOWN_MS * 2, MAX_CLIMB_HOLD_MS]);
    expect(Math.max(...waits)).toBeLessThanOrEqual(MAX_CLIMB_HOLD_MS);
  });
});
