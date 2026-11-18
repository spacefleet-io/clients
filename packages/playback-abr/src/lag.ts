/**
 * Decode-bound detector: tells "the device cannot decode this" (healthy buffer, but dropped frames / A-V desync / stalls /
 * software decoding of a non-H.264 picture) from "the network is too slow" (starved buffer, which belongs to `abrDecide`).
 */
import { BUFFER_LOW_S } from "./cache";

export type DecodeSample = {
  /** JS clock when the sample was processed. Only used for settle windows after a switch: NEVER to judge progress. */
  nowMs: number;
  /**
   * Native monotonic clock (`SystemClock.elapsedRealtime`) at the instant `timePos` and the drop counters were read.
   * Progress is judged against THIS clock: the JS thread can process a snapshot seconds after it was taken, or
   * re-process the same one, and `nowMs` then says nothing about how long the video had to move.
   */
  sampledAtMs: number;
  timePos: number;
  paused: boolean;
  pausedForCache: boolean;
  seeking: boolean;
  /** `decoder-frame-drop-count` + `frame-drop-count` */
  droppedFrames: number;
  hwdecCurrent: string | null;
  /** The playing picture is not H.264 (`needsH264Fallback(mpv video-format)`: HEVC, AV1, VP9 ...); false while mpv has not said. */
  videoCodecIsNonH264: boolean;
  /** Seconds buffered ahead (`demuxer-cache-duration`). Absent = unknown = treated as healthy. */
  bufferSeconds?: number;
  /** Buffer level below which the buffer is starved (see `healthyBufferFloorS`). Default BUFFER_LOW_S. */
  bufferFloorS?: number;
  /** The whole file is already cached: a short buffer near the end is not starvation. */
  cacheReachedEof?: boolean;
  /** mpv `avsync` (A/V difference, seconds). */
  avsyncSeconds?: number | null;
  /**
   * Software decoding of a non-H.264 picture is a verdict by itself (default). False when nothing lighter exists to switch to: software
   * decoding alone then proves nothing about the experience, so the measured signals (drops, desync, stall) decide.
   */
  softwareDecodeIsLag?: boolean;
};

export type LagVerdict =
  | { lag: false }
  | { lag: true; reason: "software-decode" | "frame-drops" | "stall" | "avsync" };

export const LAG_WINDOW_MS = 5_000;
export const LAG_MAX_DROPS_PER_WINDOW = 25;
export const LAG_MIN_PROGRESS_RATIO = 0.3;
export const LAG_SETTLE_MS = 3_000;
/** |avsync| above this, for most of a window, is decode lag. */
export const LAG_AVSYNC_S = 0.5;
export const LAG_AVSYNC_BAD_RATIO = 0.6;
export const LAG_AVSYNC_MIN_SAMPLES = 4;

export type LagDetector = {
  /** Native clock (`DecodeSample.sampledAtMs`) of the window's first sample. */
  windowStartMs: number | null;
  windowStartPos: number;
  windowStartDrops: number;
  windowSamples: number;
  windowAvsyncBad: number;
  /** JS clock until which samples are ignored after a switch / seek. */
  settledAtMs: number | null;
  /** Native clock of the newest sample taken in: a replayed or older snapshot is not new evidence. */
  lastSampledAtMs: number | null;
};

export const createLagDetector = (): LagDetector => ({
  windowStartMs: null,
  windowStartPos: 0,
  windowStartDrops: 0,
  windowSamples: 0,
  windowAvsyncBad: 0,
  settledAtMs: null,
  lastSampledAtMs: null,
});

/** Call after any seek / load / variant switch so the next samples are ignored while it settles. */
export const resetLagDetector = (detector: LagDetector, nowMs: number) => {
  detector.windowStartMs = null;
  detector.settledAtMs = nowMs + LAG_SETTLE_MS;
};

const bufferStarved = (sample: DecodeSample): boolean =>
  sample.cacheReachedEof !== true &&
  sample.bufferSeconds !== undefined &&
  sample.bufferSeconds < (sample.bufferFloorS ?? BUFFER_LOW_S);

/**
 * Evaluates one poll. Mutates `detector`.
 *  - software-decode: a non-H.264 picture (HEVC, AV1, VP9 ...) on a software decoder is decode-bound at once (any buffer level).
 *  - frame-drops / avsync / stall: only judged while the buffer is healthy; a starved buffer is a NETWORK problem and
 *    belongs to `abrDecide` (the window restarts so a network stall is never blamed on the decoder afterwards).
 */
export const stepLagDetector = (detector: LagDetector, sample: DecodeSample): LagVerdict => {
  // The same native snapshot processed again (the player effect re-runs on any dependency change while the poll lags
  // behind a busy JS thread) carries no new information; judging it against a later JS clock reads as a stall.
  if (detector.lastSampledAtMs !== null && sample.sampledAtMs <= detector.lastSampledAtMs) return { lag: false };
  detector.lastSampledAtMs = sample.sampledAtMs;
  const playing = !sample.paused && !sample.pausedForCache && !sample.seeking && sample.timePos > 0;
  if (!playing || (detector.settledAtMs !== null && sample.nowMs < detector.settledAtMs)) {
    detector.windowStartMs = null;
    return { lag: false };
  }
  if (sample.softwareDecodeIsLag !== false && sample.videoCodecIsNonH264 && (sample.hwdecCurrent === "no" || sample.hwdecCurrent === "")) {
    return { lag: true, reason: "software-decode" };
  }
  if (bufferStarved(sample)) {
    detector.windowStartMs = null;
    return { lag: false };
  }
  if (detector.windowStartMs === null) {
    detector.windowStartMs = sample.sampledAtMs;
    detector.windowStartPos = sample.timePos;
    detector.windowStartDrops = sample.droppedFrames;
    detector.windowSamples = 0;
    detector.windowAvsyncBad = 0;
  }
  detector.windowSamples++;
  if (sample.avsyncSeconds !== undefined && sample.avsyncSeconds !== null && Math.abs(sample.avsyncSeconds) >= LAG_AVSYNC_S) {
    detector.windowAvsyncBad++;
  }
  const wall = sample.sampledAtMs - detector.windowStartMs;
  if (wall < LAG_WINDOW_MS) return { lag: false };
  const progressed = sample.timePos - detector.windowStartPos;
  const drops = sample.droppedFrames - detector.windowStartDrops;
  const samples = detector.windowSamples;
  const avsyncBad = detector.windowAvsyncBad;
  detector.windowStartMs = sample.sampledAtMs;
  detector.windowStartPos = sample.timePos;
  detector.windowStartDrops = sample.droppedFrames;
  detector.windowSamples = 0;
  detector.windowAvsyncBad = 0;
  if (progressed < (wall / 1000) * LAG_MIN_PROGRESS_RATIO) return { lag: true, reason: "stall" };
  if (drops >= LAG_MAX_DROPS_PER_WINDOW) return { lag: true, reason: "frame-drops" };
  if (samples >= LAG_AVSYNC_MIN_SAMPLES && avsyncBad / samples >= LAG_AVSYNC_BAD_RATIO) return { lag: true, reason: "avsync" };
  return { lag: false };
};
