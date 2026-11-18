/**
 * Cast-start timing (UX-TV-03): one `[cast.timing]` log line per step from the tap on a Cast device in the picker to the
 * device playing, each with the milliseconds since that tap. Read with `adb logcat -v epoch -s ReactNativeJS` next to the
 * cast server's `PlaybackHttp` / `CastServer` lines to see where a slow start spends its time.
 */
let pressedAt: number | null = null;

/** The user picked a Cast device: the clock of every later step starts here. */
export const markCastPress = (now = Date.now()): void => {
  pressedAt = now;
  console.info("[cast.timing]", JSON.stringify({ step: "press", ms: 0 }));
};

/** Logs `step` with the milliseconds since the last [markCastPress] (null when the cast did not start from a tap). */
export const castTiming = (step: string, extra: Record<string, unknown> = {}, now = Date.now()): number | null => {
  const ms = pressedAt === null ? null : now - pressedAt;
  console.info("[cast.timing]", JSON.stringify({ step, ms, ...extra }));
  return ms;
};
