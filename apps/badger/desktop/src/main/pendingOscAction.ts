/**
 * Durable osc_action recovery slot (main process).
 *
 * A re-subscribing renderer pulls the last osc_action so one dropped in a
 * listener teardown window (or fired before the listener mounted) is
 * replayed instead of lost (@bugfix next-episode-osc-action-dropped-on-listener-churn).
 *
 * @bugfix @regression-proof issue #25 P14: the slot was a bare module global.
 * An action read from a killed mpv's file after its exit was stored, and the
 * controller that mounted after the kill pulled it and navigated an episode
 * forward on a player that no longer existed (ultimate s3 c067 / c069). Each
 * action is now bound to the mpv client that produced it: actions from a
 * client that is not the current one are refused, the slot is cleared when
 * that client exits, and a pull never returns an action owned by another one.
 */
import type { OscActionFile } from "@space/mpv-protocol";

export const PENDING_OSC_ACTION_TTL_MS = 15_000;

type Pending<Owner> = { owner: Owner | null; action: OscActionFile; seq: number; atMs: number };

export type PendingOscActionTake = { action: OscActionFile; seq: number } | null;

export class PendingOscActionSlot<Owner> {
  private seq = 0;
  private pending: Pending<Owner> | null = null;

  /**
   * Record `action` from `owner`. Returns the assigned seq, or null when
   * `owner` is not the current client (a stale mpv instance).
   */
  record(owner: Owner | null, currentOwner: Owner | null, action: OscActionFile, nowMs = Date.now()): number | null {
    if (owner !== currentOwner) return null;
    this.seq += 1;
    this.pending = { owner, action, seq: this.seq, atMs: nowMs };
    return this.seq;
  }

  /** The pending action if it belongs to `currentOwner` and is fresh; otherwise clears it. */
  take(currentOwner: Owner | null, nowMs = Date.now()): PendingOscActionTake {
    const pending = this.pending;
    if (!pending) return null;
    if (pending.owner !== currentOwner || nowMs - pending.atMs > PENDING_OSC_ACTION_TTL_MS) {
      this.pending = null;
      return null;
    }
    return { action: pending.action, seq: pending.seq };
  }

  ack(seq: number): void {
    if (this.pending?.seq === seq) this.pending = null;
  }

  /** Drop the pending action of `owner` (its mpv exited or was disposed). Returns true if one was dropped. */
  clearOwner(owner: Owner): boolean {
    if (this.pending?.owner !== owner) return false;
    this.pending = null;
    return true;
  }

  /** Diagnostics only. */
  peek(): { seq: number; ageMs: number; action: OscActionFile } | null {
    return this.pending ? { seq: this.pending.seq, ageMs: Date.now() - this.pending.atMs, action: this.pending.action } : null;
  }
}
