/**
 * Quality switch state machine (PLAY-ABR-04): every switch, Auto or manual, finishes loading the new rung and continues
 * from the position the viewer was at, never from 0:00 and never stuck. Pure of React and of the native module: the
 * screen injects `SwitchPorts`, the tests inject a fake player and a fake clock (see tests/playback-quality-switch.test.ts).
 *
 * What it guarantees:
 *  - position: a start the player has not reached yet (first load, user seek, a previous reload that has not landed) is
 *    held as a pending start target, and a switch reloads there instead of at the position mpv reports meanwhile
 *    (0 before the start seek lands, the old position while a seek is in flight);
 *  - completion: a load that never settles (stalled, idle, rejected) is retried at the same start, up to
 *    `SWITCH_MAX_ATTEMPTS`, then the switch ends anyway (the stuck-loading timers of `health.ts` then fail loudly);
 *  - queueing: a manual pick made during a switch is kept (the last one wins) and run when the switch ends;
 *    an automatic request during a switch is dropped (Auto decides again once the switch settled);
 *  - cancellation: `cancel()` (Retry, or a playback failure on screen) ends the running switch at once; it never
 *    touches the player again, reports nothing and drops the queued pick;
 *  - make before break: with a `warm` port (the Android proxy) the old rung plays on while the proxy fetches the new
 *    rung's segment the reload will start in (`planSwitchWarm`), and the reload happens once it is here and the playhead
 *    has reached it, so the new rung's first frame does not wait on the network.
 */
import type { MpvTrack, PlaybackSnapshot, SubtitleTrack } from "@space/mobile-mpv-playback";
import { directRenderOf } from "@space/mobile-mpv-playback/ocrTwin";
import type { VariantSegment } from "@space/playback-abr";
import { findActiveSidecar, sidecarSubtitleUrl } from "./sidecarSubtitle";
import { buildSwitchLoadOptions, planSwitchRestore, rungMasterUrl } from "./rungSwitch";
import { planSwitchWarm } from "./switchWarm";

/** A sample within this distance of the target means the start landed. */
export const PENDING_START_REACHED_TOLERANCE_S = 3;
/** If mpv keeps advancing somewhere else for this long it ignored the start: accept where it really plays. */
export const PENDING_START_ABANDON_AFTER_MS = 10_000;
/** Targets at or below this are a start-at-zero: nothing to protect. */
export const PENDING_START_MIN_TARGET_S = 0.25;
/** One load attempt waits this long for a stable frame before it is retried. */
export const SWITCH_SETTLE_TIMEOUT_MS = 15_000;
export const SWITCH_MAX_ATTEMPTS = 3;
/** The new file needs a moment before its properties replace the old file's (a poll right after `loadfile` is the old file). */
const LOAD_LANDING_MS = 400;
const SETTLE_POLL_MS = 200;
/** A reload aimed at a warmed segment's start lands this far inside it: the metadata's starts and the proxy's EXTINF sums may differ by a rounding. */
export const WARM_SEGMENT_EDGE_S = 0.1;
/** The reload onto a warmed later segment fires once the playhead is this close to it (the forward skip at most). */
export const WARM_LEAD_S = 0.5;
/** After the playhead's way to the warmed segment, a warm that has not landed gets this long before the switch reloads without it. */
export const WARM_MAX_EXTRA_MS = SWITCH_SETTLE_TIMEOUT_MS;

export type PendingStartVerdict = "none" | "pending" | "reached" | "abandoned";

/** The position a launch / reload / seek asked mpv for, held until mpv's reported position gets there. */
export class PendingStart {
  private target: number | null = null;
  private lastSample: number | null = null;
  private advancingSince: number | null = null;
  private loadInFlight = false;
  private seekDuringLoad: number | null = null;

  arm(target: number | null): number | null {
    this.target = target !== null && Number.isFinite(target) && target > PENDING_START_MIN_TARGET_S ? target : null;
    this.lastSample = null;
    this.advancingSince = null;
    this.loadInFlight = false;
    this.seekDuringLoad = null;
    return this.target;
  }

  /** Arm for a `loadfile` on a live mpv: until `loadLanded()` every sample is the OLD file's, so none can reach the target. */
  armForLoad(target: number | null): number | null {
    const armed = this.arm(target);
    this.loadInFlight = true;
    return armed;
  }

  /** The viewer seeked: the seek is the new target; while a load is in flight it is also remembered to re-apply. */
  userSeek(target: number): number | null {
    const loadInFlight = this.loadInFlight;
    const armed = this.arm(target);
    this.loadInFlight = loadInFlight;
    if (loadInFlight) this.seekDuringLoad = armed;
    return armed;
  }

  /** The seek to re-send once a load landed (consumed): null when the load's own start already put mpv there. */
  takeSeekDuringLoad(loadStart: number): number | null {
    const seek = this.seekDuringLoad;
    this.seekDuringLoad = null;
    return seek === null || Math.abs(seek - loadStart) <= PENDING_START_MIN_TARGET_S ? null : seek;
  }

  loadLanded(): void {
    this.loadInFlight = false;
  }

  get(): number | null {
    return this.target;
  }

  /** Feed one polled position; returns how to treat it. */
  observe(position: number, nowMs: number): PendingStartVerdict {
    const target = this.target;
    if (target === null) return "none";
    if (this.loadInFlight) return "pending";
    if (Math.abs(position - target) <= PENDING_START_REACHED_TOLERANCE_S) {
      this.arm(null);
      return "reached";
    }
    const advancing = this.lastSample !== null && position > this.lastSample + 0.05;
    this.lastSample = position;
    if (!advancing) return "pending";
    this.advancingSince ??= nowMs;
    if (nowMs - this.advancingSince >= PENDING_START_ABANDON_AFTER_MS) {
      this.arm(null);
      return "abandoned";
    }
    return "pending";
  }
}

/** A frame is on screen and stable (not idle, seeking or rebuffering). */
export const isStableFrame = (snapshot: PlaybackSnapshot): boolean =>
  !snapshot.idle && snapshot.voConfigured && !snapshot.seeking && !snapshot.pausedForCache;

export type FreshPlayback = { snapshot: PlaybackSnapshot; tracks: MpvTrack[] };

export type SwitchPorts = {
  /** Fresh native read (never the polled snapshot): position, pause and aid/sid at this very moment, plus the track list. */
  readPlayback: () => Promise<FreshPlayback | null>;
  readSnapshot: () => Promise<PlaybackSnapshot | null>;
  load: (url: string, startSeconds: number, options: string) => Promise<void>;
  seek: (seconds: number) => Promise<void>;
  /** Re-add the sidecar subtitle `loadfile replace` dropped; a failure must not fail the switch. */
  restoreSidecar: (url: string, sidecar: SubtitleTrack) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  /**
   * Make before break: has the proxy fetch the rung `targetId`'s segment at `atSeconds` while the old rung plays on;
   * resolves once it is here. Absent where the proxy cannot (iOS): the switch reloads straight away.
   */
  warm?: (targetId: string, atSeconds: number) => Promise<void>;
  now: () => number;
  /** False once the screen unmounted: the native view is gone, never touch it. */
  alive: () => boolean;
  log: (event: string, data: Record<string, unknown>) => void;
};

export type SwitchResult = { targetId: string; reason: string; settled: boolean; attempts: number; ms: number; startSeconds: number };

/** What the warm plan needs about the rung switched to: its segments and the measured throughput (bits/s). */
export type WarmInputs = { segments: readonly VariantSegment[]; ewmaBps: number | null };

export type SwitchContext = {
  playUrl: string | null;
  subtitleTracks: SubtitleTrack[];
  warmInputs?: (targetId: string) => WarmInputs | null;
};

export type SwitchRequestOutcome = "completed" | "queued" | "ignored";

export class QualitySwitchMachine {
  readonly pendingStart = new PendingStart();
  private running: Promise<void> | null = null;
  private runningTarget: string | null = null;
  private queued: string | null = null;
  /** The running attempt's awaited start; `landed` once its file replaced the old one (a seek then goes to the new file). */
  private attempt: { target: PendingStart; landed: boolean } | null = null;
  /** Bumped by `cancel()`: a run started under an older epoch is over and must not touch the player or this machine. */
  private epoch = 0;
  /** Bumped by every viewer seek: a seek during the warm ends the wait (the reload goes to the seek target). */
  private seeks = 0;

  constructor(
    private readonly ports: SwitchPorts,
    private readonly context: () => SwitchContext | null,
    private readonly events: { onSettled: (result: SwitchResult) => void; onQueuedPick: (targetId: string) => void },
  ) {}

  get switching(): boolean {
    return this.running !== null;
  }

  /** The first load's start (resume position), held until the first frame lands there. */
  armStart(seconds: number): void {
    this.pendingStart.arm(seconds);
  }

  noteSeek(target: number): void {
    this.seeks += 1;
    this.pendingStart.userSeek(target);
    // A seek on the already-landed new file moves what the running attempt waits for, or it would wait out its timeout
    // for a position the viewer just left and reload for nothing.
    if (this.attempt?.landed) this.attempt.target.arm(target);
  }

  /** The last pick is no longer a switch (Auto chosen, or the rung already loading re-picked): drop the queued one. */
  cancelQueued(): void {
    this.queued = null;
  }

  /** Feed every polled snapshot so a reached start releases its pin. A running switch observes by itself. */
  observe(snapshot: PlaybackSnapshot, nowMs: number): void {
    if (this.running) return;
    this.pendingStart.observe(snapshot.position, nowMs);
  }

  /**
   * End the running switch now (Retry reloads the session; a failure on screen stops playback): `switching` is false at
   * once, the queued pick is dropped, and the cancelled run never loads, seeks or reports again.
   */
  cancel(): void {
    if (!this.running) return;
    this.ports.log("switch_cancelled", { target: this.runningTarget, queued: this.queued });
    this.epoch += 1;
    this.running = null;
    this.runningTarget = null;
    this.queued = null;
    this.attempt = null;
    this.pendingStart.arm(null);
  }

  /**
   * Switch to `targetId`. Resolves "completed" when the switch it started has ended (settled or out of attempts),
   * "queued" when a manual pick was kept behind the running switch, "ignored" otherwise.
   * Synchronous up to the first await, so `switching` is true as soon as this returns.
   */
  request(targetId: string, reason: string): Promise<SwitchRequestOutcome> {
    if (this.running) {
      if (targetId === this.runningTarget) {
        this.queued = null;
        return Promise.resolve("ignored");
      }
      if (reason !== "manual") return Promise.resolve("ignored");
      this.queued = targetId;
      this.ports.log("pick_queued", { picked: targetId, running: this.runningTarget });
      return Promise.resolve("queued");
    }
    this.runningTarget = targetId;
    const run = this.run(targetId, reason, this.epoch).finally(() => {
      // A cancelled run ends after the switch that replaced it may have started: leave that one alone.
      if (this.running !== run) return;
      this.running = null;
      this.runningTarget = null;
      const queued = this.queued;
      this.queued = null;
      if (queued && this.ports.alive()) this.events.onQueuedPick(queued);
    });
    this.running = run;
    return run.then(() => "completed" as const);
  }

  /** The screen is mounted and `cancel()` has not ended the run started under `epoch`. */
  private live(epoch: number): boolean {
    return this.ports.alive() && epoch === this.epoch;
  }

  private async run(targetId: string, reason: string, epoch: number): Promise<void> {
    const { ports } = this;
    const startedAt = ports.now();
    let attempts = 0;
    let settled = false;
    let startSeconds = 0;
    try {
      const context = this.context();
      if (!context?.playUrl || !this.live(epoch)) return;
      let first = await ports.readPlayback().catch(() => null);
      if (!first || !this.live(epoch)) return;
      // Make before break: only from a rung that really plays (no start or seek still pending: then nothing plays to keep).
      let warmedStart: number | null = null;
      if (ports.warm && this.pendingStart.get() === null) {
        const warmed = await this.warmFirst(ports.warm, targetId, first.snapshot, context, epoch);
        if (warmed === "over") return;
        warmedStart = warmed;
        // The viewer's tracks, pause and seek as they are now, after the wait.
        first = (await ports.readPlayback().catch(() => null)) ?? first;
        if (!this.live(epoch)) return;
      }
      const sidecar = findActiveSidecar(first.tracks, context.subtitleTracks);
      // Tracks are read once, at the viewer's moment of choice: a retried load sees the stuck file's tracks, not theirs.
      const restore = planSwitchRestore(first.snapshot, this.pendingStart.get());
      startSeconds = warmedStart ?? restore.startSeconds;
      // The `warm` port is the Android proxy's: there lavf must open one segment at a time (`SWITCH_ONE_SEGMENT_AT_A_TIME`).
      const options = buildSwitchLoadOptions(restore, sidecar !== null, ports.warm !== undefined);
      const url = rungMasterUrl(context.playUrl, targetId);

      while (attempts < SWITCH_MAX_ATTEMPTS && !settled) {
        attempts += 1;
        // Re-resolved on a retry: a seek the viewer made meanwhile (or the start still pending) wins over the stuck file's 0.
        if (attempts > 1) {
          const fresh = await ports.readPlayback().catch(() => null);
          if (!this.live(epoch)) return;
          startSeconds = planSwitchRestore(fresh?.snapshot ?? first.snapshot, this.pendingStart.get()).startSeconds;
        }
        this.pendingStart.armForLoad(startSeconds);
        const loadTarget = new PendingStart();
        loadTarget.armForLoad(startSeconds);
        const attempt = { target: loadTarget, landed: false };
        this.attempt = attempt;
        try {
          await ports.load(url, startSeconds, options);
        } catch (error) {
          if (!this.live(epoch)) return;
          ports.log("load_failed", { target: targetId, attempt: attempts, error: String(error) });
          this.pendingStart.loadLanded();
          await ports.sleep(LOAD_LANDING_MS);
          if (!this.live(epoch)) return;
          continue;
        }
        await ports.sleep(LOAD_LANDING_MS);
        if (!this.live(epoch)) return;
        this.pendingStart.loadLanded();
        loadTarget.loadLanded();
        attempt.landed = true;
        settled = await this.waitSettled(loadTarget, epoch);
        if (!this.live(epoch)) return;
        if (!settled) ports.log("reload_timeout", { target: targetId, reason, attempt: attempts, startSeconds });
      }

      if (settled) {
        const seek = this.pendingStart.takeSeekDuringLoad(startSeconds);
        if (seek !== null) {
          this.pendingStart.arm(seek);
          await ports.seek(seek).catch((error: unknown) => ports.log("seek_after_switch_failed", { error: String(error) }));
        } else {
          this.pendingStart.arm(null);
        }
        if (sidecar && this.live(epoch)) {
          // Picture vs OCR twin (PLAY-TRACK-05): the VO is an option of the mpv instance, so the reload keeps the one
          // the viewer was watching on (direct rendering, or the `vo=gpu` fallback that draws pictures).
          const directRender = directRenderOf(first.snapshot) === true;
          const subUrl = sidecarSubtitleUrl(context.playUrl, sidecar, directRender, "quality_switch");
          await ports.restoreSidecar(subUrl, sidecar).catch(() => undefined);
        }
      }
    } catch (error) {
      ports.log("switch_failed", { reason, error: String(error) });
    } finally {
      if (this.live(epoch)) {
        this.attempt = null;
        this.events.onSettled({ targetId, reason, settled, attempts, ms: ports.now() - startedAt, startSeconds });
      }
    }
  }

  private async waitSettled(loadTarget: PendingStart, epoch: number): Promise<boolean> {
    const { ports } = this;
    const deadline = ports.now() + SWITCH_SETTLE_TIMEOUT_MS;
    for (;;) {
      if (!this.live(epoch)) return false;
      const snapshot = await ports.readSnapshot().catch(() => null);
      if (snapshot) {
        const verdict = loadTarget.observe(snapshot.position, ports.now());
        if (isStableFrame(snapshot) && verdict !== "pending") return true;
      }
      if (ports.now() >= deadline) return false;
      await ports.sleep(SETTLE_POLL_MS);
    }
  }

  /**
   * Make before break. Has the proxy fetch the segment `planSwitchWarm` picks while the old rung plays on, then waits for
   * it and for the playhead to reach it. Returns where to reload: the playhead (when the segment holds it, or the viewer
   * paused), the warmed segment's start (playhead within `WARM_LEAD_S` of it, or stalled before it), or null for "where
   * the viewer is now" (no plan, the warm failed or took too long, or a seek ended the wait). "over" when the run ended.
   */
  private async warmFirst(
    warm: (targetId: string, atSeconds: number) => Promise<void>,
    targetId: string,
    snapshot: PlaybackSnapshot,
    context: SwitchContext,
    epoch: number,
  ): Promise<number | null | "over"> {
    const { ports } = this;
    const inputs = context.warmInputs?.(targetId) ?? null;
    const position = snapshot.position;
    const plan = inputs
      ? planSwitchWarm({
          segments: inputs.segments,
          positionSeconds: position,
          bufferSeconds: snapshot.cacheDuration,
          ewmaBps: inputs.ewmaBps,
          advancing: !snapshot.paused,
        })
      : null;
    if (!plan) return null;
    // A later segment: the reload goes to its start once the playhead gets there. The segment at the position: right away.
    const boundary = plan.startSeconds > position ? plan.startSeconds + WARM_SEGMENT_EDGE_S : null;
    const warmAt = boundary ?? position;
    // Settled by the warm promise's callbacks; an object so the poll below reads its current value.
    const warmed: { state: "pending" | "done" | "failed"; failure: string } = { state: "pending", failure: "" };
    const startedAt = ports.now();
    warm(targetId, warmAt).then(
      () => {
        warmed.state = "done";
      },
      (error: unknown) => {
        warmed.state = "failed";
        warmed.failure = String(error);
      },
    );
    const round = (seconds: number) => Math.round(seconds * 10) / 10;
    ports.log("warm_start", {
      target: targetId,
      at: round(warmAt),
      position: round(position),
      bufferS: round(snapshot.cacheDuration),
      segment: plan.index,
      fetchS: plan.fetchSeconds === null ? null : round(plan.fetchSeconds),
    });
    const seeks = this.seeks;
    const deadline = startedAt + Math.max(0, warmAt - position) * 1000 + WARM_MAX_EXTRA_MS;
    for (;;) {
      await ports.sleep(SETTLE_POLL_MS);
      if (!this.live(epoch)) return "over";
      if (this.seeks !== seeks) {
        ports.log("warm_abandoned", { target: targetId, reason: "seek", ms: ports.now() - startedAt });
        return null;
      }
      if (warmed.state === "failed") {
        ports.log("warm_failed", { target: targetId, error: warmed.failure, ms: ports.now() - startedAt });
        return null;
      }
      const now = await ports.readSnapshot().catch(() => null);
      if (!this.live(epoch)) return "over";
      if (ports.now() >= deadline) {
        ports.log("warm_timeout", { target: targetId, ms: ports.now() - startedAt, warmed: warmed.state === "done" });
        return null;
      }
      if (warmed.state !== "done" || !now) continue;
      const reached = boundary === null || now.position >= boundary - WARM_SEGMENT_EDGE_S - WARM_LEAD_S;
      if (!reached && !now.paused && !now.pausedForCache) continue;
      const start = boundary === null || now.paused ? now.position : Math.max(now.position, boundary);
      ports.log("warm_done", { target: targetId, ms: ports.now() - startedAt, start: round(start), position: round(now.position) });
      return start;
    }
  }
}
