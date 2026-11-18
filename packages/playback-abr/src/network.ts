/**
 * Network ABR: one pure decision per poll. Nothing here is a blacklist: a downshift only changes the current rung, so a
 * recovered link always leads back to the ceiling (anti-flap lives in the controller's climb hold, which is capped).
 */
import { BUFFER_LOW_S, upshiftBufferThresholdS, type CacheConfig } from "./cache";
import {
  effectiveBitrateBps,
  oneStepDown,
  qualityRank,
  sortVariantsBestToWorst,
  type Variant,
  type VariantSegment,
} from "./ladder";

export const SAFETY_FACTOR = 0.85;
/** Base wait between two upshifts (and after any switch). Backs off up to MAX_CLIMB_HOLD_MS when climbs keep failing. */
export const SWITCH_COOLDOWN_MS = 30_000;
export const BUFFER_CRITICAL_S = 1;
export const UPSHIFT_HEADROOM = 1.5;
export const UNDERRUN_GRACE_MS = 2_000;
export const DOWNSHIFT_HOLD_AFTER_RELOAD_MS = 5_000;
export const DOWNSHIFT_HOLD_AFTER_FIRST_FRAME_MS = 3_000;
export const DOWNSHIFT_HOLD_AWAITING_FRAME_MAX_MS = 10_000;
/**
 * A user seek empties the buffer and mpv pauses for cache while it refills: that stall is the seek, not the link. Downshifts
 * are held at least this long after a seek, and while the stall that started with it goes on, up to the cap (a dead link
 * still steps down).
 */
export const DOWNSHIFT_HOLD_AFTER_SEEK_MS = 3_000;
export const DOWNSHIFT_HOLD_AFTER_SEEK_MAX_MS = 10_000;
/** A pinned rung's "the network cannot sustain this" warning is shown at most this often. */
export const PINNED_WARN_COOLDOWN_MS = 60_000;

/** Anti-flap: a downshift within this window of an upshift doubles the climb hold. */
export const CLIMB_FLAP_WINDOW_MS = 90_000;
/** Hard cap of the climb hold: a recovered network is back at the top within a bounded number of these per rung. */
export const MAX_CLIMB_HOLD_MS = 120_000;
/** No downshift for this long: the climb hold goes back to SWITCH_COOLDOWN_MS. */
export const CLIMB_STABLE_RESET_MS = 120_000;
/**
 * Margin of the drain rule on top of the refill time (`switchRefillSeconds`): the reload and the first frame of the new rung.
 * Equal to BUFFER_LOW_S, the margin the buffer-low rule already keeps.
 */
export const DRAIN_SWITCH_MARGIN_S = BUFFER_LOW_S;

export type AbrState = {
  variants: Variant[];
  currentId: string | null;
  ewmaBps: number;
  bufferSeconds: number;
  underrunSinceMs: number | null;
  lastSwitchAtMs: number | null;
  nowMs: number;
  /** Variants proven undecodable on this device for this file (decode-bound); never selected by ABR. NOT network history. */
  bannedIds: ReadonlySet<string>;
  cacheReachedEof: boolean;
  loadStartedAtMs: number | null;
  firstFrameAtMs: number | null;
  lastReloadAtMs: number | null;
  /** When the user last seeked (null = never): see DOWNSHIFT_HOLD_AFTER_SEEK_MS. Optional: clients without seeks omit it. */
  lastSeekAtMs?: number | null;
  /** Highest rung Auto may reach as a rank (0 = 2160p ... lower number = better). Settings quality (+ decode ceiling), or `capCeilingRank` of it while the silo reports a quality cap. Default: none. */
  ceilingRank?: number;
  /** Wait after the last switch before an upshift (anti-flap backoff). Default SWITCH_COOLDOWN_MS. */
  upshiftHoldMs?: number;
  /** The player's configured mpv cache; sets the upshift buffer gate. */
  cache: CacheConfig;
  /**
   * Seconds of buffer lost per second while it has been falling (see `trackBufferDrain`); null or absent = not draining or
   * not measured yet. Clients that do not measure it never take the drain rule.
   */
  bufferDrainRate?: number | null;
  /** Playback position (seconds): picks the segment a switch must fetch first. Absent = the drain rule is off. */
  positionSeconds?: number | null;
};

/** Why a downshift is suppressed right now. */
export type DownshiftHeld = "reload" | "first-frame" | "seek";

export type AbrDecision =
  | { action: "hold"; downshiftHeld?: DownshiftHeld }
  | { action: "downshift"; targetId: string; reason: "underrun" | "buffer-low" | "buffer-critical" | "drain" }
  | { action: "upshift"; targetId: string };

const HOLD: AbrDecision = { action: "hold" };

const highestSustainableBelow = (
  variants: Variant[],
  current: Variant,
  ewmaBps: number,
  banned: ReadonlySet<string>,
): Variant | null => {
  const currentRank = qualityRank(current.quality);
  for (const v of sortVariantsBestToWorst(variants)) {
    if (v.id === current.id || banned.has(v.id)) continue;
    if (qualityRank(v.quality) <= currentRank) continue;
    if (effectiveBitrateBps(v) * SAFETY_FACTOR <= ewmaBps) return v;
  }
  return null;
};

/** Best rung above `current`, within the ceiling, that the measured throughput sustains with headroom. */
const highestSustainableAbove = (
  variants: Variant[],
  current: Variant,
  ewmaBps: number,
  banned: ReadonlySet<string>,
  ceilingRank: number,
): Variant | null => {
  const currentRank = qualityRank(current.quality);
  for (const v of sortVariantsBestToWorst(variants)) {
    if (v.id === current.id || banned.has(v.id)) continue;
    const rank = qualityRank(v.quality);
    if (rank >= currentRank || rank < ceilingRank) continue;
    if (effectiveBitrateBps(v) * UPSHIFT_HEADROOM <= ewmaBps) return v;
  }
  return null;
};

/** The clocks `downshiftHold` reads. */
export type DownshiftClock = Pick<
  AbrState,
  "nowMs" | "loadStartedAtMs" | "firstFrameAtMs" | "lastReloadAtMs" | "lastSeekAtMs" | "underrunSinceMs"
>;

/**
 * Why a downshift is suppressed right now: a reload or a load still waiting for its frame says nothing about the link. Also
 * the settling window clients use to keep load-time frame drops out of their decode-bound detector.
 */
export const downshiftHold = (state: DownshiftClock): DownshiftHeld | null => {
  const awaitingFrameHeld =
    state.firstFrameAtMs === null &&
    (state.loadStartedAtMs === null || state.nowMs - state.loadStartedAtMs < DOWNSHIFT_HOLD_AWAITING_FRAME_MAX_MS);
  if (state.lastReloadAtMs !== null && state.nowMs - state.lastReloadAtMs < DOWNSHIFT_HOLD_AFTER_RELOAD_MS) return "reload";
  if (
    awaitingFrameHeld ||
    (state.firstFrameAtMs !== null && state.nowMs - state.firstFrameAtMs < DOWNSHIFT_HOLD_AFTER_FIRST_FRAME_MS)
  ) {
    return "first-frame";
  }
  if (state.lastSeekAtMs != null) {
    const sinceSeek = state.nowMs - state.lastSeekAtMs;
    // The stall began with the seek (within the minimum hold): a later, separate stall is a network verdict again.
    const stalledSinceSeek =
      state.underrunSinceMs !== null &&
      state.underrunSinceMs >= state.lastSeekAtMs &&
      state.underrunSinceMs - state.lastSeekAtMs < DOWNSHIFT_HOLD_AFTER_SEEK_MS;
    if (sinceSeek >= 0 && (sinceSeek < DOWNSHIFT_HOLD_AFTER_SEEK_MS || (stalledSinceSeek && sinceSeek < DOWNSHIFT_HOLD_AFTER_SEEK_MAX_MS))) {
      return "seek";
    }
  }
  return null;
};

/**
 * A pinned rung (Force, or a pick inside the player) never switches, but when the measured throughput cannot sustain it the
 * user is told so (PLAY-QUAL-03). Returns the highest lower rung the link does sustain, or null when there is nothing to say:
 * the rung is sustainable, nothing lower is sustainable either, the whole file is cached, or the load is not settled yet.
 */
export const pinnedNetworkWarning = (state: AbrState): { recommendedId: string } | null => {
  if (state.variants.length < 2) return null;
  const current = state.variants.find((v) => v.id === state.currentId) ?? null;
  if (!current || state.cacheReachedEof) return null;
  if (downshiftHold(state)) return null;
  if (state.ewmaBps >= effectiveBitrateBps(current) * SAFETY_FACTOR) return null;
  const recommended = highestSustainableBelow(state.variants, current, state.ewmaBps, state.bannedIds);
  return recommended ? { recommendedId: recommended.id } : null;
};

export const abrDecide = (state: AbrState): AbrDecision => {
  if (state.variants.length < 2) return HOLD;
  const current = state.variants.find((v) => v.id === state.currentId) ?? null;
  if (!current) return HOLD;
  if (state.cacheReachedEof) return HOLD;

  const bandwidthInsufficient = state.ewmaBps < effectiveBitrateBps(current) * SAFETY_FACTOR;

  const downshiftHeld = downshiftHold(state);

  const underrunBreached = state.underrunSinceMs !== null && state.nowMs - state.underrunSinceMs >= UNDERRUN_GRACE_MS;
  const bufferCritical = state.bufferSeconds < BUFFER_CRITICAL_S;

  if (underrunBreached || bufferCritical) {
    let target = highestSustainableBelow(state.variants, current, state.ewmaBps, state.bannedIds);
    if (!target) {
      const sorted = sortVariantsBestToWorst(state.variants).filter((v) => !state.bannedIds.has(v.id));
      const floor = sorted[sorted.length - 1];
      if (floor && qualityRank(floor.quality) > qualityRank(current.quality)) target = floor;
    }
    if (!target) return HOLD;
    if (downshiftHeld) return { action: "hold", downshiftHeld };
    return { action: "downshift", targetId: target.id, reason: underrunBreached ? "underrun" : "buffer-critical" };
  }

  if (state.bufferSeconds < BUFFER_LOW_S && bandwidthInsufficient) {
    const target = oneStepDown(state.variants, current, state.bannedIds);
    if (!target) return HOLD;
    if (downshiftHeld) return { action: "hold", downshiftHeld };
    return { action: "downshift", targetId: target.id, reason: "buffer-low" };
  }

  // Drain rule: a rung switch (a reload on mobile) must fetch the whole segment of the new rung at the playing position
  // before playback resumes. When the measured speed cannot sustain the current rung and the buffer, at its measured drain
  // rate, empties before that fetch would finish, step down now rather than at BUFFER_LOW_S. Off without a drain rate,
  // a position or segment sizes (nothing changes for a client that does not pass them).
  if (bandwidthInsufficient) {
    const target = oneStepDown(state.variants, current, state.bannedIds);
    if (target && drainOutrunsSwitch(state, target)) {
      if (downshiftHeld) return { action: "hold", downshiftHeld };
      return { action: "downshift", targetId: target.id, reason: "drain" };
    }
  }

  const holdMs = state.upshiftHoldMs ?? SWITCH_COOLDOWN_MS;
  const holdElapsed = state.lastSwitchAtMs === null || state.nowMs - state.lastSwitchAtMs >= holdMs;
  const gate = upshiftBufferThresholdS(state.cache, current);
  if (holdElapsed && state.bufferSeconds >= gate) {
    const next = highestSustainableAbove(state.variants, current, state.ewmaBps, state.bannedIds, state.ceilingRank ?? 0);
    if (next) return { action: "upshift", targetId: next.id };
  }
  return HOLD;
};

/** The segment of `segments` (sorted by start) that holds `positionSeconds`, or null when there is none. */
const segmentAt = (segments: readonly VariantSegment[], positionSeconds: number): VariantSegment | null => {
  let hit: VariantSegment | null = null;
  for (const segment of segments) {
    if (segment.startSeconds > positionSeconds) break;
    hit = segment;
  }
  return hit ?? segments[0] ?? null;
};

/**
 * Seconds a switch to `target` needs before playback resumes: the whole segment of `target` that holds the position, at the
 * measured throughput. Null when it is unknown (no segment sizes, no position, no estimate).
 */
export const switchRefillSeconds = (target: Variant, positionSeconds: number, ewmaBps: number): number | null => {
  if (!target.segments || target.segments.length === 0 || !(ewmaBps > 0) || !Number.isFinite(positionSeconds)) return null;
  const segment = segmentAt(target.segments, positionSeconds);
  if (!segment || !(segment.sizeBytes > 0)) return null;
  return (segment.sizeBytes * 8) / ewmaBps;
};

/**
 * The buffer, falling at its measured rate, empties before a switch to `target` could refill it, with DRAIN_SWITCH_MARGIN_S
 * to spare. False whenever the buffer is not falling or anything is unknown.
 */
const drainOutrunsSwitch = (state: AbrState, target: Variant): boolean => {
  const rate = state.bufferDrainRate ?? null;
  const position = state.positionSeconds ?? null;
  if (rate === null || !(rate > 0) || position === null) return false;
  const refill = switchRefillSeconds(target, position, state.ewmaBps);
  if (refill === null) return false;
  return state.bufferSeconds / rate < refill + DRAIN_SWITCH_MARGIN_S;
};

/** Blends one throughput sample (bits/s) into the running estimate. Non-positive samples carry no information. */
export const blendBps = (previousBps: number, sampleBps: number, alpha = 0.3): number => {
  if (!Number.isFinite(sampleBps) || sampleBps <= 0) return previousBps;
  if (previousBps <= 0) return sampleBps;
  return previousBps * (1 - alpha) + sampleBps * alpha;
};
