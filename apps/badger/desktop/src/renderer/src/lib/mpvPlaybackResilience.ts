/**
 * The last pause value the app sent to mpv. `applied` turns true once mpv
 * reported that value back: from then on a different pause state came from
 * mpv's own controls (OSC, a click on the picture, Space), not from mpv
 * ignoring the app.
 */
export type SentPause = { value: boolean; at: number; applied?: boolean };

export const markSentPauseSeen = (sent: SentPause | null, paused: unknown): SentPause | null =>
  sent && !sent.applied && paused === sent.value ? { ...sent, applied: true } : sent;

/** How long after the app sent pause:true a pause report is that send's echo. */
const APP_PAUSE_ECHO_MS = 3_000;

/**
 * mpv went from playing to paused and the app did not just ask for it: the
 * user paused in mpv (OSC button, click on the picture, Space). A paused
 * launch (no "playing" seen before) is not a user pause, and neither is the
 * pause mpv makes itself at the end of the file (`--keep-open=yes` pauses
 * there, with `eof-reached` true): counted as the user's, it left a
 * premature-EOF recovery (issue #25 P6) seeked back but paused.
 */
export const isUserPause = ({
  previous,
  next,
  eof,
  lastSentPause,
  now,
}: {
  previous: boolean | null;
  next: unknown;
  eof?: unknown;
  lastSentPause: SentPause | null;
  now: number;
}) =>
  previous === false &&
  next === true &&
  eof !== true &&
  !(lastSentPause?.value === true && now - lastSentPause.at < APP_PAUSE_ECHO_MS);

/**
 * MPV-PAUSE-01: an automatic play (deferred launch, backdrop->stream handoff,
 * resume-from-position seek, poll retry) may run only when no user pause came
 * at or after the latest explicit play request.
 */
export const autoPlayAllowed = ({
  playRequestedAt,
  userPausedAt,
}: {
  playRequestedAt: number;
  userPausedAt: number | null;
}) => userPausedAt === null || userPausedAt < playRequestedAt;

export const shouldForceResumeExternalPlayback = ({
  paused,
  pausedForCache,
  eof,
  userPaused,
  blockAutoPlay,
  externalActive,
  now,
  lastAttemptAt,
  lastSentPause,
}: {
  paused: unknown;
  pausedForCache: unknown;
  eof: unknown;
  userPaused: boolean;
  blockAutoPlay: boolean;
  externalActive: boolean;
  now: number;
  lastAttemptAt: number;
  lastSentPause: SentPause | null;
}) => {
  if (!externalActive) return false;
  if (paused !== true) return false;
  if (pausedForCache === true) return false;
  if (eof === true) return false;
  if (userPaused) return false;
  if (blockAutoPlay) return false;
  // Only retry if we recently asked mpv to play and it's still paused.
  // Pause-true (we asked it to pause) or null (no recent send) or stale
  // (>5s old) means the OSC/user paused and we must respect that.
  if (!lastSentPause || lastSentPause.value !== false) return false;
  // mpv already played after our pause:false: this pause is the user's (OSC
  // button, click on the picture, Space), not mpv ignoring us.
  if (lastSentPause.applied) return false;
  if (now - lastSentPause.at > 5_000) return false;
  return now - lastAttemptAt >= 1000;
};
