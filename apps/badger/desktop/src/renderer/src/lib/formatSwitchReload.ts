// Format (quality / ABR) switch completion.
//
// @bugfix @regression-proof issue #25 (ultimate run part 2: c035, c065,
// s1:x002 — "skip-intro pill missing" because playback never reached 60 s).
//
// With the external mpv player a quality switch works like this:
// `selectFixedFormat` / `selectAutoQuality` pause mpv at once, then change
// `selectedFormatId` / `qualityMode`. That flips `effectiveFormatSignature`,
// which re-fires the init effect, and the init effect reloads the stream.
// The init effect had three exits that dropped the switch:
//
//   c035  a load was in flight (backdrop handoff) → "skip (load already in
//         flight)", and nothing re-ran the effect once that load settled.
//         mpv stayed paused at 54.938 s forever.
//   c065  startFrom's zero-seek path left the `userZeroSeek` intent parked
//         on the phase. The switch's re-fire took the intent-consume return
//         and never called loadStream. mpv stayed paused.
//   x002  an OSC seekbar seek to 55 s happened inside mpv; 100 ms later the
//         ABR switch reloaded at the renderer's last polled time (1.938 s,
//         captured from the render closure), so the seek was lost.
//
// Rule this module encodes: a switch always completes. Either it reloads
// now, or it is queued until the in-flight load settles and then reloads;
// an exit that does not reload settles the switch and resumes mpv unless
// the user had paused. The reload position is read live from mpv at reload
// time (behind a pending start target), never from a render-closure value.

export type FormatSwitchSource = "user" | "abr" | "auto";

export interface FormatSwitchRequest {
  /** Monotonic id, for logs. */
  id: number;
  source: FormatSwitchSource;
  /** Target format id; null for "auto". */
  formatId: string | null;
  requestedAt: number;
  /** Resume playback after the switch (false only when the user paused). */
  resumeAutoplay: boolean;
  /** Times the init effect found a load in flight and queued this switch. */
  deferrals: number;
  /** Queued behind an in-flight load; the init effect must re-fire for it. */
  waitingForLoad: boolean;
}

export type FormatSwitchSettleReason =
  | "reloaded"
  | "load-failed"
  | "already-loaded"
  | "smoke-test"
  | "playback-deferred"
  | "resume-prompt";

/** Holds the one switch that still has to complete (latest request wins). */
export class PendingFormatSwitch {
  private current: FormatSwitchRequest | null = null;
  private nextId = 1;

  request(input: {
    source: FormatSwitchSource;
    formatId: string | null;
    now: number;
    resumeAutoplay: boolean;
  }): FormatSwitchRequest {
    // A newer request supersedes the queued one but keeps its queue state:
    // it still has to wait for the same in-flight load.
    this.current = {
      id: this.nextId++,
      source: input.source,
      formatId: input.formatId,
      requestedAt: input.now,
      resumeAutoplay: input.resumeAutoplay,
      deferrals: this.current?.deferrals ?? 0,
      waitingForLoad: this.current?.waitingForLoad ?? false,
    };
    return this.current;
  }

  get(): FormatSwitchRequest | null {
    return this.current;
  }

  /** Queue the switch behind the in-flight load. */
  defer(): FormatSwitchRequest | null {
    if (!this.current) return null;
    this.current = { ...this.current, deferrals: this.current.deferrals + 1, waitingForLoad: true };
    return this.current;
  }

  /** The init effect is being re-fired for the queued switch. */
  markRetried(): void {
    if (this.current) this.current = { ...this.current, waitingForLoad: false };
  }

  /**
   * The switch completed (or can no longer apply): clear it and return it.
   * With `id`, only that request is cleared — a newer request that arrived
   * while this one was reloading stays queued for its own reload.
   */
  settle(id?: number): FormatSwitchRequest | null {
    const settled = this.current;
    if (!settled || (id !== undefined && settled.id !== id)) return null;
    this.current = null;
    return settled;
  }
}

export type InitEntryDecision =
  /** Run the init body (launch or reload). */
  | "proceed"
  /** No switch pending: a dep churn during a launch, safe to drop. */
  | "skip-load-in-flight"
  /** A switch is pending: queue it, re-fire once the load settles. */
  | "defer-switch-until-settled"
  /** No switch pending and the stream is already this key: nothing to do. */
  | "skip-matches-last-launched-key"
  /** A switch is pending but mpv already plays this key: settle + resume. */
  | "settle-switch-already-loaded";

export const decideInitEntry = (input: {
  loadInFlight: boolean;
  switchPending: boolean;
  matchesLastLaunchedKey: boolean;
}): InitEntryDecision => {
  if (input.loadInFlight) {
    return input.switchPending ? "defer-switch-until-settled" : "skip-load-in-flight";
  }
  if (input.matchesLastLaunchedKey) {
    return input.switchPending ? "settle-switch-already-loaded" : "skip-matches-last-launched-key";
  }
  return "proceed";
};

export type LaunchIntent = "userManual" | "userZeroSeek" | string | null;

export type IntentConsumeDecision =
  /** No startFrom intent to consume: load normally. */
  | "load"
  /** startFrom already loaded this stream: consume the intent, skip loading. */
  | "consume-intent-and-skip"
  /** A format switch is pending: consume the stale intent and still reload. */
  | "consume-intent-and-load";

export const decideIntentConsume = (input: {
  pendingIntent: LaunchIntent;
  externalActive: boolean;
  switchPending: boolean;
}): IntentConsumeDecision => {
  const { pendingIntent } = input;
  if (pendingIntent !== "userManual" && pendingIntent !== "userZeroSeek") return "load";
  const consume = pendingIntent === "userManual" || input.externalActive;
  if (!consume) return "load";
  return input.switchPending ? "consume-intent-and-load" : "consume-intent-and-skip";
};

/** Re-fire the init effect for a queued switch once no load is in flight. */
export const shouldRetryDeferredSwitch = (input: {
  loadInFlight: boolean;
  pending: FormatSwitchRequest | null;
}): boolean => !input.loadInFlight && input.pending?.waitingForLoad === true;
