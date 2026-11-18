/**
 * The auto-quality controller: the per-sample entry points every client calls.
 *
 *  - `stepAbr` (full): decode-bound check first, then network ABR. Mobile and TV run this.
 *  - `stepDecoder`: the decode-bound check alone (lag detector -> lighter version, or `too-weak`). The desktop runs it, then
 *    `stepNetworkAbr` when it returns null, so it keeps the pinned-rung network warning only that entry point raises.
 *  - `stepNetworkAbr`: network ABR only (the web player, which has no decoder evidence, and the desktop's network half). It
 *    is the same network code path, so the product rules for the network (no rung ban, capped climb hold, reachable upshift
 *    gate, Settings quality as ceiling, Force wins) hold identically on every client.
 *
 * All mutate the controller and return an action; the client applies it with its own reload mechanism.
 */
import { BUFFER_LOW_S, healthyBufferFloorS, type CacheConfig } from "./cache";
import { needsH264Fallback, qualityRank, type Variant } from "./ladder";
import { createLagDetector, resetLagDetector, stepLagDetector, type LagDetector, type LagVerdict } from "./lag";
import {
  CLIMB_FLAP_WINDOW_MS,
  CLIMB_STABLE_RESET_MS,
  MAX_CLIMB_HOLD_MS,
  SWITCH_COOLDOWN_MS,
  abrDecide,
  PINNED_WARN_COOLDOWN_MS,
  blendBps,
  pinnedNetworkWarning,
  type AbrDecision,
  type AbrState,
  type DownshiftHeld,
} from "./network";
import { applyAbrDecision, createQualityState, planDecodeFallback, type QualityState } from "./qualityState";
import type { DecoderPolicy, DecoderVerdicts, QualitySetting } from "./start";

export type AbrController = {
  quality: QualityState;
  /** Settings quality as a rank: the highest rung Auto may reach; clients set it to `capCeilingRank(...)` while the silo reports a cap. */
  settingsCeilingRank: number;
  ewmaBps: number;
  underrunSinceMs: number | null;
  lag: LagDetector;
  loadStartedAtMs: number | null;
  firstFrameAtMs: number | null;
  lastReloadAtMs: number | null;
  /** The user's last seek (null = none yet): its refill stall is not a network verdict. */
  lastSeekAtMs: number | null;
  /**
   * Where the first frame of a load comes from: "vo" = the first sample with a configured video output (mobile), "event" =
   * the client calls `noteFirstFrame` (desktop: mpv's first playback-restart, which a resume only reaches after fetching its
   * seek-target segment, however long that takes on a slow link).
   */
  firstFrameFrom: "vo" | "event";
  /** The client's `netBps` is already a smoothed estimate (desktop link meter): adopt it as is instead of smoothing it again. */
  netBpsIsSmoothed: boolean;
  /**
   * Which decoders count (PLAY-QUAL-06): `hardware-first` (phone) or `any` (computer, TV). Under `any` software decoding is a
   * normal way to play, so it is never a decode-bound verdict by itself: only measured drops, desync or a stall are.
   */
  decoderPolicy: DecoderPolicy;
  /** The "this device is not powerful enough" notice was already raised for this playback (once per file). */
  tooWeakNotified: boolean;
  /** When the pinned-rung network warning last fired (rate limit, `PINNED_WARN_COOLDOWN_MS`). */
  lastPinnedWarnAtMs: number | null;
  /** Anti-flap: wait between upshifts; doubles (capped) when a climb is followed by a downshift, resets after stability. */
  upshiftHoldMs: number;
  lastUpshiftAtMs: number | null;
  /** Start of the current no-downshift stretch. */
  stableSinceMs: number | null;
  /** Recent buffer readings while playing, for the drain rate (`trackBufferDrain`). */
  bufferHistory: BufferReading[];
  /** The latest drain rate (seconds of buffer lost per second), null = not draining. */
  bufferDrainRate: number | null;
};

/** One buffer reading: when, and how many seconds were buffered ahead. */
export type BufferReading = { atMs: number; bufferSeconds: number };

/** The drain rate is measured over the readings of this window. */
export const DRAIN_WINDOW_MS = 5_000;
/** A drain rate needs readings spanning at least this long (one or two polls are noise). */
export const DRAIN_MIN_SPAN_MS = 3_000;

/**
 * Records one reading and returns how fast the buffer is falling (seconds of buffer lost per second) over the last
 * DRAIN_WINDOW_MS, or null when it is not falling or the readings span less than DRAIN_MIN_SPAN_MS. A stall (paused for
 * cache) clears the history: nothing is played from the buffer then.
 */
export const trackBufferDrain = (
  history: BufferReading[],
  nowMs: number,
  bufferSeconds: number,
  pausedForCache: boolean,
): number | null => {
  if (pausedForCache || !Number.isFinite(bufferSeconds)) {
    history.length = 0;
    return null;
  }
  history.push({ atMs: nowMs, bufferSeconds });
  while (history.length > 0 && nowMs - history[0]!.atMs > DRAIN_WINDOW_MS) history.shift();
  const oldest = history[0]!;
  const spanMs = nowMs - oldest.atMs;
  if (spanMs < DRAIN_MIN_SPAN_MS) return null;
  const rate = (oldest.bufferSeconds - bufferSeconds) / (spanMs / 1000);
  return rate > 0 ? rate : null;
};

export type AbrControllerOptions = { firstFrameFrom?: "vo" | "event"; netBpsIsSmoothed?: boolean; decoderPolicy?: DecoderPolicy };

export const createAbrController = (
  variants: Variant[],
  setting: QualitySetting,
  nowMs: number,
  caps: DecoderVerdicts | null = null,
  options: AbrControllerOptions = {},
): AbrController => ({
  quality: createQualityState(variants, setting, caps, options.decoderPolicy ?? "hardware-first"),
  settingsCeilingRank: qualityRank(setting.quality),
  ewmaBps: 0,
  underrunSinceMs: null,
  lag: createLagDetector(),
  tooWeakNotified: false,
  lastPinnedWarnAtMs: null,
  loadStartedAtMs: nowMs,
  firstFrameAtMs: null,
  lastReloadAtMs: null,
  lastSeekAtMs: null,
  firstFrameFrom: options.firstFrameFrom ?? "vo",
  netBpsIsSmoothed: options.netBpsIsSmoothed ?? false,
  decoderPolicy: options.decoderPolicy ?? "hardware-first",
  upshiftHoldMs: SWITCH_COOLDOWN_MS,
  lastUpshiftAtMs: null,
  stableSinceMs: null,
  bufferHistory: [],
  bufferDrainRate: null,
});

/** Everything the network rules need from one poll. */
export type NetworkSample = {
  nowMs: number;
  /** The player renders video (mobile: native `vo-configured`; desktop: past the reveal gate). Before that: hold. */
  voConfigured: boolean;
  pausedForCache: boolean;
  /** Seconds buffered ahead (`demuxer-cache-duration`). */
  bufferSeconds: number;
  /** The whole file is already cached: a short buffer near the end is not starvation (see `cacheReachedEnd`). */
  cacheReachedEof: boolean;
  /**
   * One throughput sample (bits/s). The controller smooths it, unless the controller was created with `netBpsIsSmoothed`
   * (then it is the client's own estimate, adopted as is, 0 = no estimate yet). Unsmoothed, 0 / unknown carries no information.
   */
  netBps: number;
  /** The player's configured mpv cache; sets the upshift buffer gate. */
  cache: CacheConfig;
  /** Playback position (seconds). Optional: without it the drain rule is off (see `abrDecide`). */
  position?: number;
};

/** One player snapshot with decoder evidence, reduced to what the full controller needs. */
export type AbrSample = NetworkSample & {
  /** Native clock the snapshot was taken at (see `DecodeSample.sampledAtMs`). */
  sampledAtMs: number;
  position: number;
  paused: boolean;
  seeking: boolean;
  droppedFrames: number;
  hwdec: string | null;
  videoCodec: string | null;
  avsyncSeconds: number | null;
  /**
   * Extra rows the decode fallback may pick, for a client whose `variants` keeps one row per quality (desktop: an H.264 row
   * of a quality can sit behind its HEVC row; it passes the ladder rebuilt with the playing codec blocked). Mobile omits it.
   */
  decodeVariants?: Variant[];
};

/** The cached range reaches (within 2 s of) the end of the file. */
export const cacheReachedEnd = (durationSeconds: number, cacheEndSeconds: number): boolean =>
  durationSeconds > 0 && cacheEndSeconds >= durationSeconds - 2;

export type SwitchTrigger = "network" | "decoder";

export type AbrAction =
  | { kind: "hold"; downshiftHeld?: DownshiftHeld }
  /** The device cannot play smoothly and nothing lighter exists (or Force pins it): tell the user, once per playback. */
  /** Pinned rung (Force / manual pick) that the network cannot sustain: tell the user, never switch. `stepNetworkAbr` only. */
  | { kind: "warn"; reason: "pinned-network-insufficient"; recommendedId: string }
  | { kind: "too-weak"; verdict: LagVerdict & { lag: true }; pinned: boolean }
  | {
      kind: "switch";
      targetId: string;
      trigger: SwitchTrigger;
      /** `abr-downshift` | `abr-upshift` | `hevc-fallback` | `decode-fallback` */
      reason: string;
      /** The decision / verdict that caused it, for the log line. */
      detail: AbrDecision | (LagVerdict & { lag: true });
    };

/** A fresh player launch: nothing loaded yet, so no clock of the load runs. */
export const noteLaunch = (ctrl: AbrController): void => {
  ctrl.loadStartedAtMs = null;
  ctrl.firstFrameAtMs = null;
  ctrl.lastReloadAtMs = null;
  ctrl.lastSeekAtMs = null;
  ctrl.bufferHistory.length = 0;
};

/**
 * A new player session: throughput history and the anti-flap clocks restart, and the first upshift waits
 * SWITCH_COOLDOWN_MS (the estimate has not converged yet). The load clock is NOT touched (see `noteLaunch`).
 */
export const noteSessionStarted = (ctrl: AbrController, nowMs: number): void => {
  ctrl.ewmaBps = 0;
  ctrl.underrunSinceMs = null;
  ctrl.upshiftHoldMs = SWITCH_COOLDOWN_MS;
  ctrl.lastUpshiftAtMs = null;
  ctrl.stableSinceMs = null;
  ctrl.bufferHistory.length = 0;
  ctrl.quality = { ...ctrl.quality, lastSwitchAtMs: nowMs };
};

/** A variant switch settled (live track change or reload): downshifts are held briefly and the decode detector re-settles. */
export const noteSwitchSettled = (ctrl: AbrController, nowMs: number): void => {
  ctrl.lastReloadAtMs = nowMs;
  ctrl.loadStartedAtMs = nowMs;
  resetLagDetector(ctrl.lag, nowMs);
  ctrl.bufferHistory.length = 0;
};

/** A reload is about to replace the stream: its first frame is due again. */
export const noteReloadStarted = (ctrl: AbrController): void => {
  ctrl.firstFrameAtMs = null;
};

/** The player showed the first frame of the current load (only for `firstFrameFrom: "event"` controllers). */
export const noteFirstFrame = (ctrl: AbrController, nowMs: number): void => {
  ctrl.firstFrameAtMs = nowMs;
};

/** A seek was issued: the decode detector re-settles and the refill stall that follows is not held against the network. */
export const noteSeek = (ctrl: AbrController, nowMs: number): void => {
  ctrl.lastSeekAtMs = nowMs;
  resetLagDetector(ctrl.lag, nowMs);
  ctrl.bufferHistory.length = 0;
};

/** A (re)load of the file begins (or its stream was handed to the player): clock for the first-frame hold restarts. */
export const noteLoadStarted = (ctrl: AbrController, nowMs: number): void => {
  ctrl.loadStartedAtMs = nowMs;
  ctrl.firstFrameAtMs = null;
  ctrl.bufferHistory.length = 0;
};

/** Per-poll bookkeeping shared by both entry points. */
const observe = (ctrl: AbrController, sample: NetworkSample): void => {
  const now = sample.nowMs;
  if (ctrl.firstFrameFrom === "vo" && ctrl.firstFrameAtMs === null) ctrl.firstFrameAtMs = now;
  if (ctrl.stableSinceMs === null) ctrl.stableSinceMs = now;
  ctrl.ewmaBps = ctrl.netBpsIsSmoothed ? Math.max(0, sample.netBps) : blendBps(ctrl.ewmaBps, sample.netBps);
  if (sample.pausedForCache) ctrl.underrunSinceMs ??= now;
  else ctrl.underrunSinceMs = null;
  ctrl.bufferDrainRate = trackBufferDrain(ctrl.bufferHistory, now, sample.bufferSeconds, sample.pausedForCache);
};

const networkState = (ctrl: AbrController, variants: Variant[], sample: NetworkSample): AbrState => ({
  variants,
  currentId: ctrl.quality.currentId,
  ewmaBps: ctrl.ewmaBps,
  bufferSeconds: sample.bufferSeconds,
  underrunSinceMs: ctrl.underrunSinceMs,
  lastSwitchAtMs: ctrl.quality.lastSwitchAtMs,
  nowMs: sample.nowMs,
  bannedIds: new Set(ctrl.quality.bannedIds),
  cacheReachedEof: sample.cacheReachedEof,
  loadStartedAtMs: ctrl.loadStartedAtMs,
  firstFrameAtMs: ctrl.firstFrameAtMs,
  lastReloadAtMs: ctrl.lastReloadAtMs,
  lastSeekAtMs: ctrl.lastSeekAtMs,
  ceilingRank: Math.max(ctrl.settingsCeilingRank, ctrl.quality.decodeCeilingRank ?? 0),
  upshiftHoldMs: ctrl.upshiftHoldMs,
  cache: sample.cache,
  bufferDrainRate: ctrl.bufferDrainRate,
  positionSeconds: sample.position ?? null,
});

/** Network ABR (Auto only): downshift on underrun / low buffer, upshift back up to the Settings ceiling on recovery. */
const decideNetwork = (ctrl: AbrController, variants: Variant[], sample: NetworkSample): AbrAction => {
  const now = sample.nowMs;
  const state = ctrl.quality;
  if (state.mode !== "auto") return { kind: "hold" };

  if (ctrl.upshiftHoldMs > SWITCH_COOLDOWN_MS && ctrl.stableSinceMs !== null && now - ctrl.stableSinceMs >= CLIMB_STABLE_RESET_MS) {
    ctrl.upshiftHoldMs = SWITCH_COOLDOWN_MS;
  }

  const decision = abrDecide(networkState(ctrl, variants, sample));
  if (decision.action === "hold") return decision.downshiftHeld ? { kind: "hold", downshiftHeld: decision.downshiftHeld } : { kind: "hold" };

  if (decision.action === "downshift") {
    // A downshift soon after a climb means the climb was too optimistic: wait longer before the next one (capped).
    if (ctrl.lastUpshiftAtMs !== null && now - ctrl.lastUpshiftAtMs < CLIMB_FLAP_WINDOW_MS) {
      ctrl.upshiftHoldMs = Math.min(ctrl.upshiftHoldMs * 2, MAX_CLIMB_HOLD_MS);
    }
  } else {
    ctrl.lastUpshiftAtMs = now;
  }
  ctrl.stableSinceMs = now;
  ctrl.quality = applyAbrDecision(state, decision, now);
  return { kind: "switch", targetId: decision.targetId, trigger: "network", reason: ctrl.quality.lastReason ?? "abr", detail: decision };
};

/**
 * Network-only decision for a client that has no decoder evidence. Mutates `ctrl` (including `ctrl.quality` when it returns
 * a switch). Never returns `too-weak`: without decoder signals nothing can prove the device is the bottleneck. A pinned rung
 * (Force / manual pick) never switches; when the link cannot sustain it, this returns a rate-limited `warn` instead.
 */
export const stepNetworkAbr = (ctrl: AbrController, variants: Variant[], sample: NetworkSample): AbrAction => {
  if (!sample.voConfigured) return { kind: "hold" };
  observe(ctrl, sample);
  if (ctrl.quality.mode === "auto") return decideNetwork(ctrl, variants, sample);
  const warning = pinnedNetworkWarning(networkState(ctrl, variants, sample));
  if (!warning) return { kind: "hold" };
  if (ctrl.lastPinnedWarnAtMs !== null && sample.nowMs - ctrl.lastPinnedWarnAtMs < PINNED_WARN_COOLDOWN_MS) return { kind: "hold" };
  ctrl.lastPinnedWarnAtMs = sample.nowMs;
  return { kind: "warn", reason: "pinned-network-insufficient", recommendedId: warning.recommendedId };
};

/**
 * Decode-bound check for one snapshot. Mutates `ctrl` (including `ctrl.quality` when it returns a switch). Null = no verdict
 * this poll (the caller goes on with the network rules). On a verdict (healthy buffer + drops / desync / stall, or software
 * decoding of a non-H.264 picture under `hardware-first`):
 *  - Auto with a lighter version: switch to it (`planDecodeFallback`: H.264 at the same resolution, else lower H.264, else
 *    the next lighter rung of any codec; H.264 one rung down), sticky for the file (PLAY-CODEC-01/02).
 *  - nothing lighter left, or pinned (Force or a manual pick: nothing may switch): `too-weak`, once per file
 *    (`pinned` tells the UI to hint at unpinning): the device cannot keep up at this quality (PLAY-CODEC-03, PLAY-QUAL-03).
 * The fallback may pick from `sample.decodeVariants` as well as `variants` (see `AbrSample.decodeVariants`).
 */
export const stepDecoder = (ctrl: AbrController, variants: Variant[], sample: AbrSample): AbrAction | null => {
  if (!sample.voConfigured) return null;
  const now = sample.nowMs;
  const state = ctrl.quality;
  const pool = withDecodeVariants(variants, sample.decodeVariants);
  const current = pool.find((v) => v.id === state.currentId) ?? null;

  const plan = planDecodeFallback(pool, state, now);
  const lag = stepLagDetector(ctrl.lag, {
    nowMs: now,
    sampledAtMs: sample.sampledAtMs,
    timePos: sample.position,
    paused: sample.paused,
    pausedForCache: sample.pausedForCache,
    seeking: sample.seeking,
    droppedFrames: sample.droppedFrames,
    hwdecCurrent: sample.hwdec,
    videoCodecIsNonH264: needsH264Fallback(sample.videoCodec),
    bufferSeconds: sample.bufferSeconds,
    bufferFloorS: current ? healthyBufferFloorS(sample.cache, current) : BUFFER_LOW_S,
    cacheReachedEof: sample.cacheReachedEof,
    avsyncSeconds: sample.avsyncSeconds,
    softwareDecodeIsLag: plan !== null && ctrl.decoderPolicy === "hardware-first",
  });
  if (!lag.lag) return null;
  resetLagDetector(ctrl.lag, now);
  // Nothing lighter to go to, or the quality is pinned (Force / manual pick: nothing may switch): the device cannot keep up,
  // say so once per file. `pinned` lets the UI add the hint to unpin / pick a lower quality.
  if (!plan || state.mode !== "auto") {
    if (ctrl.tooWeakNotified) return { kind: "hold" };
    ctrl.tooWeakNotified = true;
    return { kind: "too-weak", verdict: lag, pinned: state.mode !== "auto" };
  }
  ctrl.quality = plan.state;
  ctrl.stableSinceMs = now;
  return { kind: "switch", targetId: plan.target.id, trigger: "decoder", reason: plan.state.lastReason ?? "decode-fallback", detail: lag };
};

/** `variants` plus the rows of `extra` it does not already hold (by id). */
const withDecodeVariants = (variants: Variant[], extra: Variant[] | undefined): Variant[] => {
  if (!extra || extra.length === 0) return variants;
  const ids = new Set(variants.map((v) => v.id));
  return [...variants, ...extra.filter((v) => !ids.has(v.id))];
};

/**
 * Per-snapshot decision. Mutates `ctrl` (including `ctrl.quality` when it returns a switch). Order:
 *  1. decode-bound check: `stepDecoder`.
 *  2. network ABR (Auto only): see `stepNetworkAbr`.
 */
export const stepAbr = (ctrl: AbrController, variants: Variant[], sample: AbrSample): AbrAction => {
  if (!sample.voConfigured) return { kind: "hold" };
  observe(ctrl, sample);
  return stepDecoder(ctrl, variants, sample) ?? decideNetwork(ctrl, variants, sample);
};
