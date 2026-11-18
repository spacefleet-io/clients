/**
 * Shared failure path for every playback load (the init effect, Start Over's
 * zero-seek relaunch, the format/audio reload). #25 run 8013: Start Over's
 * relaunch ran `void pauseForChange(() => loadStream(...))` with no catch, so a
 * stream that failed during the backdrop handoff became an unhandled rejection
 * (`playback_handoff_load_failed` pageerror): no load_failed phase transition
 * and no "couldn't start playback" message.
 */

export type PlaybackLoadFailureKey = "player.errors.sourceUnreachable" | "player.errors.noDisplay" | "player.errors.playback";

/**
 * Thrown by the main process's mpv launch on a Linux session with Wayland only
 * (no X display) when the mpv in use has no Wayland support, like the bundled
 * one: no player window can open there. It crosses the IPC wrapped
 * ("Error invoking remote method '…': Error: mpv_no_display"), hence `includes`.
 */
export const MPV_NO_DISPLAY = "mpv_no_display";

/**
 * Thrown by loadStream when mpv was stopped (user stop, dialog close) while a
 * reload was in flight. #25 run 8013 playback.e2e: the loadfile reload went on
 * to wait for readiness on a stopped mpv and warned "external not ready after
 * loadfile", "metadata not fully applied", "vo-configured did not fire" (every
 * gate bailing after 1 ms). A stop is not a failure: nothing to tell the user.
 */
export const PLAYBACK_LOAD_STOPPED = "playback_load_stopped";

export const isPlaybackLoadStopped = (error: unknown): boolean =>
  error instanceof Error && error.message === PLAYBACK_LOAD_STOPPED;

/** The user-facing message for a failed load; null when the load ended because mpv was stopped. */
export const playbackLoadFailureKey = (error: unknown): PlaybackLoadFailureKey | null => {
  if (isPlaybackLoadStopped(error)) return null;
  if (!(error instanceof Error)) return "player.errors.playback";
  if (error.message === "playback_source_unreachable") return "player.errors.sourceUnreachable";
  if (error.message.includes(MPV_NO_DISPLAY)) return "player.errors.noDisplay";
  return "player.errors.playback";
};

/** Run a load; a failure goes to `report` instead of escaping as an unhandled rejection. */
export const runReportingLoadFailure = async (
  load: () => Promise<void>,
  report: (error: unknown) => void,
): Promise<void> => {
  try {
    await load();
  } catch (error) {
    report(error);
  }
};
