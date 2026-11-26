/**
 * Pure lane reservation helpers for engineV2. The legacy scheduler has its
 * own counters in `scheduler.ts`; engineV2 is intentionally net-new and
 * keeps a small, testable counter helper here. Three lanes per plan §3:
 *   - source : extract / probe / commit lane (default cap 2)
 *   - format : transcode lane (default cap 1, GPU-bound)
 *   - upload : upload lane (default cap 2)
 */

import type { IngestJobLane } from "@space/runtime-jobs";

export interface LaneCaps {
  source: number;
  format: number;
  upload: number;
}

export interface LaneState {
  source: number;
  format: number;
  upload: number;
}

export const DEFAULT_LANE_CAPS: LaneCaps = {
  source: 2,
  format: 1,
  upload: 2,
};

/**
 * Host-aware ceiling for the user-tunable lanes.
 *
 * `format` (transcode): one libx264/libx265 encode already wants every core
 * it is given, so extra concurrent encodes only add context-switching and
 * memory pressure on a small machine. One encode per 4 logical cores
 * (min 1): 1 up to 7 cores — the 4-core i5 reference box — 2 at 8, 3 at 12.
 * Each encode is additionally niced and thread-capped (`@space/ffmpeg`
 * resourcePolicy), so wide hosts can still oversubscribe a little safely.
 *
 * `source` (extract): remux + analysis, lighter; one per 2 cores (min 1).
 *
 * `upload` is I/O-bound with small AES-GCM chunks and stays as configured.
 */
export const maxLaneCapsForHost = (logicalCpuCount: number): LaneCaps => {
  const cores = Number.isFinite(logicalCpuCount) ? Math.max(1, Math.trunc(logicalCpuCount)) : 1;
  return {
    source: Math.max(1, Math.floor(cores / 2)),
    format: Math.max(1, Math.floor(cores / 4)),
    upload: Number.MAX_SAFE_INTEGER,
  };
};

/** Clamp requested caps to the host ceiling (see `maxLaneCapsForHost`). */
export const clampLaneCapsForHost = (caps: LaneCaps, logicalCpuCount: number): LaneCaps => {
  const max = maxLaneCapsForHost(logicalCpuCount);
  return {
    source: Math.min(caps.source, max.source),
    format: Math.min(caps.format, max.format),
    upload: Math.min(caps.upload, max.upload),
  };
};

export const createLaneState = (): LaneState => ({
  source: 0,
  format: 0,
  upload: 0,
});

/**
 * Reserve a slot on the lane if capacity is available. Mutates `state`.
 * Returns `true` if the reservation succeeded, `false` if the lane is full.
 */
export function tryReserveLane(
  state: LaneState,
  lane: IngestJobLane,
  caps: LaneCaps
): boolean {
  if (state[lane] >= caps[lane]) return false;
  state[lane] += 1;
  return true;
}

/**
 * Release a slot on the lane. Mutates `state`. Clamps to 0 to defend against
 * a double-release; returns the new running count for that lane.
 */
export function releaseLane(state: LaneState, lane: IngestJobLane): number {
  state[lane] = Math.max(0, state[lane] - 1);
  return state[lane];
}
