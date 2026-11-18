/**
 * PLAT-WEB-04: the web player hands a movie's playback to the Badger desktop
 * player, and keeps watching it through the runtime.
 *
 *  - The web player (a tool grant of mode `write`) calls `playOnDesktop`: the
 *    runtime publishes `badger.handoff.play` to the desktop apps listening on
 *    `badger.handoff` and answers a hand-off id.
 *  - The desktop app reports `starting`, `playing` (with the position), then
 *    `closed` or `failed` through `POST /runtime/handoff/:id/state`.
 *  - The web player polls `getDesktopPlayback`; a hand-off belongs to the grant
 *    that started it, and nobody else sees it.
 *
 * In memory only: a runtime restart forgets every hand-off, like the grants.
 */
import { randomUUID } from "node:crypto";
import {
  DESKTOP_HANDOFF_ERRORS,
  type DesktopHandoffPlayPayload,
  type DesktopHandoffReport,
  type DesktopPlaybackState,
  type DesktopPlaybackStateName,
} from "@space/tool-access/contracts";

export const DESKTOP_HANDOFF_LIMITS = {
  /** A `requested` hand-off the desktop did not acknowledge (`starting`) within this fails. */
  ackTimeoutMs: 20_000,
  /** A finished (`closed` / `failed`) hand-off stays readable this long, then is forgotten. */
  finishedRetentionMs: 10 * 60_000,
  /** How often finished hand-offs are swept. */
  sweepIntervalMs: 60_000,
} as const;

type Handoff = {
  id: string;
  grantId: string;
  mediaId: string;
  state: DesktopPlaybackStateName;
  positionSeconds: number | null;
  durationSeconds: number | null;
  requestedAt: number;
  updatedAt: number;
  finishedAt: number | null;
  error: string | null;
  ackTimer: ReturnType<typeof setTimeout> | null;
};

const isFinished = (state: DesktopPlaybackStateName) => state === "closed" || state === "failed";

export type DesktopHandoffManagerOptions = {
  /** True when a desktop app (app session, badger scope) listens on `badger.handoff`. */
  hasDesktopPlayer: () => boolean;
  /** Push `badger.handoff.play` to the desktop apps. */
  publishPlay: (payload: DesktopHandoffPlayPayload) => void;
  clock?: () => number;
};

export type DesktopHandoffReportResult = { ok: true; ignored: boolean } | { ok: false; reason: "not_found" };

export class DesktopHandoffManager {
  private readonly handoffs = new Map<string, Handoff>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private readonly clock: () => number;

  constructor(private readonly options: DesktopHandoffManagerOptions) {
    this.clock = options.clock ?? (() => Date.now());
  }

  hasDesktopPlayer(): boolean {
    return this.options.hasDesktopPlayer();
  }

  /**
   * Ask the desktop to play `mediaId` for `grantId`. The caller checked the
   * media exists. An unfinished hand-off of the same grant ends `superseded`.
   */
  play(grantId: string, mediaId: string): { ok: true; handoffId: string } | { ok: false; reason: "no_desktop_player" } {
    const now = this.clock();
    this.purge(now);
    if (!this.options.hasDesktopPlayer()) {
      console.info("[handoff] playOnDesktop refused: no desktop player listening", { grantId, mediaId });
      return { ok: false, reason: "no_desktop_player" };
    }
    for (const entry of this.handoffs.values()) {
      if (entry.grantId === grantId && !isFinished(entry.state)) {
        console.info("[handoff] superseding unfinished hand-off", { handoffId: entry.id, state: entry.state });
        this.finish(entry, "closed", DESKTOP_HANDOFF_ERRORS.superseded, now);
      }
    }
    const entry: Handoff = {
      id: `ho_${randomUUID()}`,
      grantId,
      mediaId,
      state: "requested",
      positionSeconds: null,
      durationSeconds: null,
      requestedAt: now,
      updatedAt: now,
      finishedAt: null,
      error: null,
      ackTimer: null,
    };
    entry.ackTimer = setTimeout(() => this.onAckTimeout(entry.id), DESKTOP_HANDOFF_LIMITS.ackTimeoutMs);
    entry.ackTimer.unref?.();
    this.handoffs.set(entry.id, entry);
    this.ensureSweeper();
    console.info("[handoff] requested", { handoffId: entry.id, grantId, mediaId });
    this.options.publishPlay({ handoffId: entry.id, mediaId, requestedAt: new Date(now).toISOString() });
    return { ok: true, handoffId: entry.id };
  }

  /** The state of `handoffId` if `grantId` started it; null otherwise (unknown or someone else's). */
  get(grantId: string, handoffId: string): DesktopPlaybackState | null {
    this.purge(this.clock());
    const entry = this.handoffs.get(handoffId);
    if (!entry || entry.grantId !== grantId) return null;
    return this.view(entry);
  }

  /** Desktop side: what its player is doing. Reports after the end are ignored. */
  report(handoffId: string, report: DesktopHandoffReport): DesktopHandoffReportResult {
    const now = this.clock();
    this.purge(now);
    const entry = this.handoffs.get(handoffId);
    if (!entry) {
      console.info("[handoff] report for unknown hand-off", { handoffId, state: report.state });
      return { ok: false, reason: "not_found" };
    }
    if (isFinished(entry.state)) {
      console.info("[handoff] late report ignored", { handoffId, state: entry.state, reported: report.state });
      return { ok: true, ignored: true };
    }
    if (report.positionSeconds !== undefined) entry.positionSeconds = report.positionSeconds;
    if (report.durationSeconds !== undefined) entry.durationSeconds = report.durationSeconds;
    if (isFinished(report.state)) {
      this.finish(entry, report.state, report.error ?? null, now);
    } else {
      if (entry.state !== report.state) console.info("[handoff] state", { handoffId, from: entry.state, to: report.state });
      entry.state = report.state;
      entry.updatedAt = now;
      this.clearAckTimer(entry);
    }
    return { ok: true, ignored: false };
  }

  /** A grant ended (revoked, expired, other user): its unfinished hand-offs close. */
  closeForGrant(grantId: string): number {
    const now = this.clock();
    let closed = 0;
    for (const entry of this.handoffs.values()) {
      if (entry.grantId !== grantId || isFinished(entry.state)) continue;
      this.finish(entry, "closed", DESKTOP_HANDOFF_ERRORS.revoked, now);
      closed += 1;
    }
    if (closed > 0) console.info("[handoff] grant ended, hand-offs closed", { grantId, closed });
    return closed;
  }

  reset() {
    for (const entry of this.handoffs.values()) this.clearAckTimer(entry);
    this.handoffs.clear();
    this.stopSweeper();
  }

  private onAckTimeout(handoffId: string) {
    const entry = this.handoffs.get(handoffId);
    if (!entry) return;
    entry.ackTimer = null;
    if (entry.state !== "requested") return;
    console.info("[handoff] desktop did not acknowledge in time", { handoffId, timeoutMs: DESKTOP_HANDOFF_LIMITS.ackTimeoutMs });
    this.finish(entry, "failed", DESKTOP_HANDOFF_ERRORS.desktopUnresponsive, this.clock());
  }

  private finish(entry: Handoff, state: "closed" | "failed", error: string | null, now: number) {
    this.clearAckTimer(entry);
    console.info("[handoff] finished", { handoffId: entry.id, from: entry.state, to: state, error });
    entry.state = state;
    entry.error = error;
    entry.updatedAt = now;
    entry.finishedAt = now;
  }

  private clearAckTimer(entry: Handoff) {
    if (!entry.ackTimer) return;
    clearTimeout(entry.ackTimer);
    entry.ackTimer = null;
  }

  private view(entry: Handoff): DesktopPlaybackState {
    return {
      handoffId: entry.id,
      mediaId: entry.mediaId,
      state: entry.state,
      positionSeconds: entry.positionSeconds,
      durationSeconds: entry.durationSeconds,
      updatedAt: new Date(entry.updatedAt).toISOString(),
      error: entry.error,
    };
  }

  /** Forget finished hand-offs past their retention. */
  private purge(now: number) {
    for (const [id, entry] of this.handoffs) {
      if (entry.finishedAt !== null && entry.finishedAt + DESKTOP_HANDOFF_LIMITS.finishedRetentionMs <= now) {
        this.handoffs.delete(id);
      }
    }
  }

  private sweep() {
    this.purge(this.clock());
    if (this.handoffs.size === 0) this.stopSweeper();
  }

  private ensureSweeper() {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), DESKTOP_HANDOFF_LIMITS.sweepIntervalMs);
    // Never keep the runtime alive for a sweep.
    this.sweepTimer.unref?.();
  }

  private stopSweeper() {
    if (!this.sweepTimer) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }
}
