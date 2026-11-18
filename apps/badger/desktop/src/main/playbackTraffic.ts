import type { StorageTraffic } from "@space/shared/storageTunnel";

/**
 * Desktop playback under the gateway's traffic state (STOR-BW-01): the HLS
 * object look-ahead shrinks while traffic is high, and foreground fetches tell
 * the gateway when a playback starts or seeks so its per-viewer scheduler can
 * burst. Pure helpers; the playback server owns the state.
 */

/** Objects kept ahead of the requested one while high and the gateway's buffer (or a duration) is unknown. */
const HIGH_TRAFFIC_FALLBACK_PREFETCH_COUNT = 2;

/**
 * The look-ahead window for the current traffic state. Normal: the full
 * window. High: the leading objects whose cumulative duration stays within the
 * gateway's `playbackBufferSeconds` (at least one, so playback never starves
 * for want of its next object).
 */
export const limitPrefetchKeys = (
  nextKeys: string[],
  traffic: Pick<StorageTraffic, "state" | "playbackBufferSeconds">,
  durationOf: (key: string) => number | null,
): string[] => {
  if (traffic.state !== "high" || nextKeys.length === 0) return nextKeys;
  const fallback = nextKeys.slice(0, HIGH_TRAFFIC_FALLBACK_PREFETCH_COUNT);
  const budget = traffic.playbackBufferSeconds;
  if (budget === null || !Number.isFinite(budget)) return fallback;
  let total = 0;
  let count = 0;
  for (const key of nextKeys) {
    const duration = durationOf(key);
    if (duration === null || !(duration > 0)) return fallback;
    if (count > 0 && total + duration > budget) break;
    total += duration;
    count += 1;
  }
  return nextKeys.slice(0, Math.max(1, count));
};

export type BurstObjectMeta = {
  kind: "video" | "audio";
  isInit: boolean;
  startSeconds: number | null;
  durationSeconds: number | null;
};

export type Burst = "start" | "seek";

/** A video segment starting more than this many segment durations past the last one is a forward seek. */
const FORWARD_SEEK_SEGMENTS = 2;

/**
 * Classifies foreground object requests: the first of a playback is `start`;
 * afterwards a video segment far outside the position of the previous one
 * (ahead of its end by over two segments, or back by over one) is a `seek`.
 * Everything else, and every look-ahead fetch, carries no burst.
 */
export const createBurstTracker = () => {
  let started = false;
  let lastStart: number | null = null;
  let lastEnd: number | null = null;

  const reset = () => {
    started = false;
    lastStart = null;
    lastEnd = null;
  };

  const note = (meta: BurstObjectMeta | undefined): Burst | undefined => {
    let burst: Burst | undefined;
    if (!started) {
      started = true;
      burst = "start";
    }
    if (!meta || meta.kind !== "video" || meta.isInit || meta.startSeconds === null) return burst;
    const duration = meta.durationSeconds ?? 0;
    if (!burst && lastStart !== null && lastEnd !== null) {
      const forward = meta.startSeconds > lastEnd + FORWARD_SEEK_SEGMENTS * duration;
      const backward = meta.startSeconds < lastStart - duration;
      if (forward || backward) burst = "seek";
    }
    lastStart = meta.startSeconds;
    lastEnd = meta.startSeconds + duration;
    return burst;
  };

  return { note, reset };
};
