// Premature end of file: recover at the real position instead of ending.
//
// @bugfix @regression-proof issue #25 P6 (ultimate run s2: c075, x052 and 8
// resume-mismatch). A segment fetch that ended early ("partial file") made
// mpv's demuxer report EOF at minute 2. keep-open mpv then seeks to the last
// frame, so time-pos jumps 145.9 → 720 with `eof-reached`. The poll trusted
// that sample: the UI jumped to the end and progress was saved at 100 %, so
// the next open offered no resume. (The OSC also opened the next episode;
// sf.lua now only advances on a natural approach to the end.)
//
// A genuine end is approached by playback: the last trusted sample is within
// a poll interval or two of the end. An EOF sample whose last trusted
// position is far from the end is a premature EOF: the sample is not the
// playhead, and the player seeks back to the last trusted position, which
// makes mpv fetch the segment again.
//
// The end zone is the user's: from the credits marker, or the last
// END_ZONE_SEC when there is none (the OSC's next-episode pill window), a
// jump to the end is "skip the rest" (RIGHT, Skip credits) and is trusted.
// Seeks the app issues arm the pending start target, so their samples never
// reach this check before they land. A seek made inside mpv (OSC seekbar)
// from before the end zone straight past the end looks the same as a
// premature EOF; it costs at most PREMATURE_EOF_MAX_RECOVERIES seeks back
// before the end is accepted.
//
// A recovery arms the pending start target. When the segment fails again
// mpv may land, play a fraction of a second and jump back to the end
// between two polls (1 Hz while the app window is hidden), which would pin
// the target forever. A recovery whose target stays pending while mpv
// reports EOF for PREMATURE_EOF_RECOVERY_WAIT_MS counts as the next
// occurrence, so the bound always ends in a decision.

/** Last trusted position further than this from the end ⇒ the EOF is premature. */
export const PREMATURE_EOF_MIN_GAP_SEC = 5;
/** Recoveries at one position before the EOF is accepted as the end. */
export const PREMATURE_EOF_MAX_RECOVERIES = 2;
/** Without a credits marker, the end zone is the OSC's next-episode window. */
export const END_ZONE_SEC = 15;
/** A recovery still pending at EOF after this long failed again. */
export const PREMATURE_EOF_RECOVERY_WAIT_MS = 5_000;

export type PrematureEofVerdict =
  /** Not an EOF, or a genuine one: trust the sample. */
  | { kind: "none" }
  /** Premature EOF: ignore the sample and seek back to `position`. */
  | { kind: "recover"; position: number; attempt: number }
  /** Premature EOF seen too often at this position: accept it as the end. */
  | { kind: "give-up"; position: number; attempts: number };

export class PrematureEofRecovery {
  private position: number | null = null;
  private attempts = 0;
  /** The target the latest recovery armed, and when; null once it landed. */
  private armed: { target: number; since: number } | null = null;

  /**
   * Classify one polled sample. `lastTrustedTime` is the last position the
   * poll accepted as the playhead (display clock, like `time` / `duration`
   * / `creditsStart`).
   */
  observe(sample: {
    eof: boolean | null;
    time: number;
    duration: number | null;
    lastTrustedTime: number | null;
    creditsStart: number | null;
    now: number;
  }): PrematureEofVerdict {
    const { eof, time, duration, lastTrustedTime, creditsStart } = sample;
    if (eof !== true) {
      this.armed = null;
      return { kind: "none" };
    }
    if (duration === null || !Number.isFinite(duration) || duration <= 0) return { kind: "none" };
    if (lastTrustedTime === null || !Number.isFinite(lastTrustedTime)) return { kind: "none" };
    if (duration - lastTrustedTime <= PREMATURE_EOF_MIN_GAP_SEC) return { kind: "none" };
    const endZoneStart = Math.min(creditsStart ?? Number.POSITIVE_INFINITY, duration - END_ZONE_SEC);
    if (lastTrustedTime >= endZoneStart) return { kind: "none" };
    // EOF reported while the sample itself sits well before the end: mpv kept
    // the real position (no last-frame jump), so there is nothing to undo.
    if (duration - time > PREMATURE_EOF_MIN_GAP_SEC) return { kind: "none" };
    if (this.position === null || Math.abs(this.position - lastTrustedTime) > PREMATURE_EOF_MIN_GAP_SEC) {
      this.position = lastTrustedTime;
      this.attempts = 0;
    }
    if (this.attempts >= PREMATURE_EOF_MAX_RECOVERIES) {
      this.armed = null;
      return { kind: "give-up", position: lastTrustedTime, attempts: this.attempts };
    }
    this.attempts += 1;
    this.armed = { target: lastTrustedTime, since: sample.now };
    return { kind: "recover", position: lastTrustedTime, attempt: this.attempts };
  }

  /**
   * True when the pending start target is the one the latest recovery armed
   * and mpv has kept reporting EOF for PREMATURE_EOF_RECOVERY_WAIT_MS: the
   * recovery failed again. The caller drops the target so the sample is
   * observed as the next occurrence.
   */
  recoveryStalled(input: { eof: boolean | null; pendingTarget: number | null; now: number }): boolean {
    if (input.eof !== true) {
      this.armed = null;
      return false;
    }
    return (
      this.armed !== null &&
      input.pendingTarget === this.armed.target &&
      input.now - this.armed.since >= PREMATURE_EOF_RECOVERY_WAIT_MS
    );
  }
}
