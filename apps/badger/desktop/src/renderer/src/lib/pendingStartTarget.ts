// Pending start target: the position a launch / reload / seek asked mpv to
// start at, held until mpv's reported position actually gets there.
//
// @bugfix @regression-proof issue #25 P8 (ultimate run case c002): mpv was
// loaded with `start=39.54`, but until that seek lands mpv reports
// `time-pos 0`. The 250 ms poll copied that 0 into `lastKnownTimeRef` /
// `currentTime` and even persisted `pct 0`. 2.2 s in, an ABR downshift called
// `selectFixedFormat`, which took `currentTime` (0) as the resume point; the
// reload effect then re-captured `time-pos` (0 again) and reloaded with
// `options=""`, so playback restarted at 0:00. While a start target is
// pending, positions far from it are "not there yet", not the playhead.

import { LUA_OUTBOUND_CHANNELS } from "@space/mpv-protocol";

/** A sample within this distance of the target means the start landed. */
export const PENDING_START_REACHED_TOLERANCE_SEC = 3;
/**
 * If mpv keeps advancing somewhere else for this long, it ignored the start
 * request: accept where it really plays instead of pinning the old target
 * forever (a stale pin would make the next format switch jump).
 */
export const PENDING_START_ABANDON_AFTER_MS = 10_000;
/** Targets at or below this are a start-at-zero: nothing to protect. */
export const PENDING_START_MIN_TARGET_SEC = 0.25;

export type PendingStartVerdict =
  /** No start target pending: the sample is the playhead. */
  | "none"
  /** The sample is far from the pending target: do not trust it yet. */
  | "pending"
  /** The sample reached the target: it is the playhead, target cleared. */
  | "reached"
  /** mpv advanced elsewhere for too long: target dropped, sample trusted. */
  | "abandoned";

export class PendingStartTarget {
  private target: number | null = null;
  private lastSample: number | null = null;
  private advancingSince: number | null = null;
  private loadInFlight = false;
  /** A user seek made since the last `armForReload`, to restore after it. */
  private seekDuringReload: number | null = null;

  /** Arm a new target (or clear with null / a start-at-zero). */
  arm(target: number | null): number | null {
    this.target =
      target !== null && Number.isFinite(target) && target > PENDING_START_MIN_TARGET_SEC ? target : null;
    this.lastSample = null;
    this.advancingSince = null;
    this.loadInFlight = false;
    this.seekDuringReload = null;
    return this.target;
  }

  /**
   * Arm for a `loadfile replace` on a live mpv. Until `loadLanded()`, every
   * sample is the OLD file's position, so none of them can reach or abandon
   * the target (issue #25 c061).
   */
  armForReload(target: number | null): number | null {
    const armed = this.arm(target);
    this.loadInFlight = true;
    return armed;
  }

  /**
   * The user seeked (app seekbar or the mpv OSC). The seek becomes the
   * pending target; during a reload the old file's samples stay untrusted,
   * and the reload restores this target instead of its own start.
   * @bugfix @regression-proof issue #25 P1b (ultimate run S1 c055)
   */
  userSeek(target: number): number | null {
    const loadInFlight = this.loadInFlight;
    const armed = this.arm(target);
    this.loadInFlight = loadInFlight;
    this.seekDuringReload = target;
    return armed;
  }

  /**
   * The seek a reload must send once its new file is up: the user's seek made
   * since the reload began, unless the loadfile's own `start=` (none when
   * `loadfileStart` is null/0) already put mpv there. Null = send nothing.
   * Consumed.
   */
  takeReloadSeek(loadfileStart: number | null): number | null {
    const seek = this.seekDuringReload;
    this.seekDuringReload = null;
    if (seek === null || Math.abs(seek - (loadfileStart ?? 0)) <= PENDING_START_MIN_TARGET_SEC) return null;
    return seek;
  }

  /** The reload ended (done, failed or abandoned): carry no seek past it. */
  reloadSettled(): void {
    this.seekDuringReload = null;
  }

  /** mpv loaded the new file (or the load ended): samples are live again. */
  loadLanded(): void {
    this.loadInFlight = false;
  }

  /** A reload's file has not loaded yet: mpv still reports the old file. */
  isLoadInFlight(): boolean {
    return this.loadInFlight;
  }

  get(): number | null {
    return this.target;
  }

  /** Feed one polled display-time sample; returns how to treat it. */
  observe(displayTime: number, now: number): PendingStartVerdict {
    const target = this.target;
    if (target === null) return "none";
    if (this.loadInFlight) return "pending";
    if (Math.abs(displayTime - target) <= PENDING_START_REACHED_TOLERANCE_SEC) {
      this.arm(null);
      return "reached";
    }
    const advancing = this.lastSample !== null && displayTime > this.lastSample + 0.05;
    this.lastSample = displayTime;
    if (!advancing) return "pending";
    this.advancingSince ??= now;
    if (now - this.advancingSince >= PENDING_START_ABANDON_AFTER_MS) {
      this.arm(null);
      return "abandoned";
    }
    return "pending";
  }
}

/**
 * Where a quality / format switch should resume, recorded when the switch is
 * requested. A pending start target wins over the polled position, which
 * during startup still reads mpv's pre-seek 0. The render-time `currentTime`
 * is never used: it is a closure value that can lag mpv by a poll or more
 * (issue #25 s1:x002). The reload itself re-reads mpv's live time-pos.
 */
export const resolveFormatSwitchResumeTime = (input: {
  pendingStart: number | null;
  lastKnownTime: number;
}): number => input.pendingStart ?? input.lastKnownTime;

/**
 * Start time for a reload (format / audio map change). A pending start
 * target wins over the freshly captured `time-pos`, which is the pre-seek 0
 * while the start has not landed yet. While a previous reload's file has not
 * loaded (`loadInFlight`), the captured `time-pos` is not this stream's
 * position at all: the seek target the reload asked for wins over it.
 *
 * @bugfix @regression-proof issue #25 c061 (NEW-abr-reload-pos-zero): a
 * second ABR reload during a stalled reload read time-pos 0 and restarted
 * the stream at 0:00 instead of the 8.979 s the first reload targeted.
 */
export const resolveReloadStartTime = (input: {
  pendingStart: number | null;
  capturedTime: number | null;
  seekTarget: number | null;
  lastKnownTime: number;
  loadInFlight?: boolean;
}): number | null => {
  const liveTime = input.loadInFlight ? null : input.capturedTime;
  const resumeTime = input.pendingStart ?? liveTime ?? input.seekTarget ?? input.lastKnownTime;
  return Number.isFinite(resumeTime) ? resumeTime : null;
};

/**
 * The absolute seek target the mpv OSC announced on `sf-osc-seek <seconds>`;
 * null for any other message or a malformed / negative value.
 */
export const parseOscSeekMessage = (msg: { type: string; name?: unknown; args?: unknown }): number | null => {
  if (msg.type !== "script_message" || msg.name !== LUA_OUTBOUND_CHANNELS.OSC_SEEK) return null;
  const raw = Array.isArray(msg.args) ? msg.args[0] : undefined;
  const seconds = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
};
