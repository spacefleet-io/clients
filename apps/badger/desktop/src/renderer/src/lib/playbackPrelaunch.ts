/**
 * The three loads a fresh mpv launch waits on before it spawns mpv: the metadata payload (subtitle caching, up to
 * its own budget), the HLS prewarm (init + first segments, up to its own budget) and the backdrop still (up to its
 * own timeout). None needs another's answer, so they start together and the launch waits for the slowest one
 * instead of their sum: on a 2-core Celeron the serial chain cost up to 6.5 s before mpv even started (#928).
 *
 * Each load keeps its own budget and fallback; a load that rejects rejects the whole wait (the caller's launch
 * error path), the others still run to their own end. Timings are the ms from the start to each load's answer.
 */
export interface PrelaunchLoads<M, P, B> {
  metadata: () => Promise<M>;
  prewarm: () => Promise<P>;
  backdrop: () => Promise<B>;
}

export interface PrelaunchTimings {
  metadataMs: number;
  prewarmMs: number;
  backdropMs: number;
  totalMs: number;
}

export interface PrelaunchResult<M, P, B> {
  metadata: M;
  prewarm: P;
  backdrop: B;
  timings: PrelaunchTimings;
}

export const runPrelaunchLoads = async <M, P, B>(
  loads: PrelaunchLoads<M, P, B>,
  now: () => number = Date.now,
): Promise<PrelaunchResult<M, P, B>> => {
  const startedAt = now();
  const timed = async <T>(run: () => Promise<T>): Promise<[T, number]> => {
    const value = await run();
    return [value, now() - startedAt];
  };
  const [[metadata, metadataMs], [prewarm, prewarmMs], [backdrop, backdropMs]] = await Promise.all([
    timed(loads.metadata),
    timed(loads.prewarm),
    timed(loads.backdrop),
  ]);
  return {
    metadata,
    prewarm,
    backdrop,
    timings: { metadataMs, prewarmMs, backdropMs, totalMs: now() - startedAt },
  };
};

/** `{ a: 1, b: null }` → `"a=1 b=-"`: launch stage timings as one log field the console preview never cuts. */
export const formatLaunchTimeline = (stages: Record<string, number | null>): string =>
  Object.entries(stages)
    .map(([name, ms]) => `${name}=${ms === null ? "-" : Math.round(ms)}`)
    .join(" ");
