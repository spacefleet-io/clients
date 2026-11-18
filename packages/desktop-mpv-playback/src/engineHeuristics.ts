export const shouldTeardownExternalPlayback = (previousOpen: boolean, nextOpen: boolean) =>
  previousOpen && !nextOpen;

const EXTERNAL_TEARDOWN_GRACE_MS = 1_000;

export const shouldIgnoreExternalTeardownDuringLaunch = (
  launchStartedAtMs: number,
  ready: boolean,
  now = Date.now()
) => !ready && launchStartedAtMs > 0 && now - launchStartedAtMs < EXTERNAL_TEARDOWN_GRACE_MS;

export const shouldPersistPlaybackProgress = (lastPersistedAtMs: number, now = Date.now()) =>
  lastPersistedAtMs === 0 || now - lastPersistedAtMs >= 500;

export type ProgressSaveTarget = { mediaId: string; episodeId: string | null };

export type PolledProgressSaveDecision =
  | { save: true }
  | { save: false; reason: "target-changed" | "load-in-flight" };

/**
 * Whether a polled mpv position may be saved as progress. A save belongs to
 * the media/episode the poll tick was started for; it is dropped when the
 * engine has moved to another target since (the tick resolved after an
 * episode switch), or while a `loadfile replace` has not loaded its file yet
 * (mpv still reports the OLD file's position).
 *
 * @bugfix @regression-proof issue #25 NEW-resume-wrong-episode (ultimate run
 * S1 x005, S2 c060): after an OSC next-episode, an in-flight poll for E(n)
 * read the old file at 631 s against a reset timeline offset and saved pct 0
 * to E(n), so relaunch reopened E(n) from 0:00 with no resume prompt.
 */
export const decidePolledProgressSave = (input: {
  pollTarget: ProgressSaveTarget;
  liveTarget: ProgressSaveTarget;
  loadInFlight: boolean;
}): PolledProgressSaveDecision => {
  if (
    input.pollTarget.mediaId !== input.liveTarget.mediaId ||
    input.pollTarget.episodeId !== input.liveTarget.episodeId
  ) {
    return { save: false, reason: "target-changed" };
  }
  if (input.loadInFlight) return { save: false, reason: "load-in-flight" };
  return { save: true };
};

export const shouldTreatRecoveredExternalStateAsReady = (ready: boolean, recoveredReady: boolean) =>
  ready || recoveredReady;
