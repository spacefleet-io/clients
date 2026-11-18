/**
 * The duration an app seek clamps to: the engine's polled duration, or mpv's
 * live `duration` when the poll has not landed one yet. The poll runs at 1 Hz
 * while the app window is hidden, so a seek requested in the first second of
 * a file used to read 0 and was dropped without reaching mpv
 * (@bugfix app-seek-dropped-before-duration-poll). Null only when mpv itself
 * has no duration.
 */
export const resolveSeekDuration = async (
  polledDuration: number,
  readLiveDuration: () => Promise<unknown>,
): Promise<number | null> => {
  if (Number.isFinite(polledDuration) && polledDuration > 0) return polledDuration;
  const live = await readLiveDuration();
  return typeof live === "number" && Number.isFinite(live) && live > 0 ? live : null;
};
