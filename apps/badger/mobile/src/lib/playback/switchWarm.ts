/**
 * Make-before-break rung switch (PLAY-ABR-04): which segment of the new rung the proxy fetches while the old rung plays on,
 * so the reload onto it shows its first frame at once instead of waiting on the network with nothing on screen.
 *
 * The reload needs the whole segment of the new rung at the position it starts from. On a slow link that segment takes
 * longer to fetch than the playhead stays inside it (a OnePlus 6 test phone at 1 Mbit/s: 2.3 MB of 420p, about 19 s, against 21 s
 * segments), so the segment holding the position is the wrong one to fetch: by the time it is here the playhead has
 * left it. The plan picks the first segment the fetch can reach before the playhead leaves it and that the old rung's
 * buffer still plays up to, and the switch reloads at its start once the playhead gets there.
 */
import type { VariantSegment } from "@space/playback-abr";

/** The throughput estimate is a recent average: a fetch is planned to take this much longer than it predicts. */
export const WARM_FETCH_SLACK = 1.25;
/** On top of the slack: the request and the reload itself. */
export const WARM_FETCH_MARGIN_S = 1;

export type WarmPlanInput = {
  /** The new rung's segments, sorted by start. */
  segments: readonly VariantSegment[];
  /** Where the old rung plays now. */
  positionSeconds: number;
  /** Seconds the old rung has buffered ahead of the position. */
  bufferSeconds: number;
  /** Measured throughput (bits/s); null or 0 = unknown. */
  ewmaBps: number | null;
  /** False while paused: the playhead stays where it is. */
  advancing: boolean;
};

export type WarmPlan = {
  /** Index of the segment to fetch first. */
  index: number;
  startSeconds: number;
  /** Start of the next segment; null for the last one. */
  endSeconds: number | null;
  /** Predicted fetch time at the measured throughput; null when unknown. */
  fetchSeconds: number | null;
};

const indexAt = (segments: readonly VariantSegment[], positionSeconds: number): number => {
  let found = 0;
  for (let i = 0; i < segments.length; i++) {
    if (segments[i]!.startSeconds > positionSeconds) break;
    found = i;
  }
  return found;
};

/**
 * The segment to warm, or null when the rung's segments are unknown (the switch then reloads straight away).
 *  - paused, or the throughput unknown: the segment at the position;
 *  - otherwise the first segment, from the one at the position on, that the fetch reaches (with slack and margin) before
 *    the playhead leaves it, among those that start within the old rung's buffer;
 *  - none of them: the segment at the position (the switch then cannot avoid a wait, but nothing else takes the link).
 */
export const planSwitchWarm = (input: WarmPlanInput): WarmPlan | null => {
  const { segments, positionSeconds } = input;
  if (segments.length === 0 || !Number.isFinite(positionSeconds)) return null;
  const ewma = input.ewmaBps !== null && input.ewmaBps > 0 ? input.ewmaBps : null;
  const fetchSeconds = (i: number): number | null => {
    const size = segments[i]!.sizeBytes;
    return ewma !== null && size > 0 ? (size * 8) / ewma : null;
  };
  const plan = (i: number): WarmPlan => ({
    index: i,
    startSeconds: segments[i]!.startSeconds,
    endSeconds: segments[i + 1]?.startSeconds ?? null,
    fetchSeconds: fetchSeconds(i),
  });
  const here = indexAt(segments, positionSeconds);
  if (!input.advancing || ewma === null) return plan(here);
  const reach = positionSeconds + Math.max(0, input.bufferSeconds);
  for (let i = here; i < segments.length; i++) {
    if (i > here && segments[i]!.startSeconds > reach) break;
    const fetch = fetchSeconds(i);
    const arrival = positionSeconds + (fetch === null ? 0 : fetch * WARM_FETCH_SLACK + WARM_FETCH_MARGIN_S);
    const end = segments[i + 1]?.startSeconds ?? Number.POSITIVE_INFINITY;
    if (arrival < end) return plan(i);
  }
  return plan(here);
};
