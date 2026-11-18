/**
 * Playback phase state machine for the badger-desktop external-mpv flow.
 *
 * Replaces nine implicit boolean refs in
 * `apps/badger/desktop/src/renderer/src/lib/useMpvPlaybackEngine.ts`
 * (manualStartRef, isReadyToReveal+ref, streamLoadfileCompleteRef,
 * skipExternalInitRef, skipReloadRef, launchInProgressRef,
 * initEffectInFlightRef, lastLaunchedKeyRef, lastReloadSignatureRef) with
 * one explicit pure reducer + three predicates.
 *
 * Phase 3 of the playback-engine hardening. Shipped in
 * shadow mode first: the engine dispatches phase events at every flag-write
 * site, but the flags remain authoritative. Dev-only equivalence assertions
 * verify `seeksAllowed(phase) === (isReadyToRevealRef && streamLoadfileCompleteRef)`
 * at the seek gate, the init guard, and the ABR gate before any flag deletion
 * (PR 3.2).
 *
 * Why this fixes #1/#3 structurally: "stream loaded" becomes the
 * `reloading.streamLoaded:false→true` transition (only reachable via
 * stream_loadfile_done in the current gen), not a free-floating boolean that
 * can be stale from a prior session. The two ANDed booleans at the seek gate
 * (isReadyToReveal && streamLoadfileComplete) collapse into a single predicate
 * `seeksAllowed(phase) = playing || (reloading && streamLoaded)` that cannot
 * internally disagree. The deliberate locked split: `isReadyToReveal`
 * (window-hide) becomes true at `backdrop_shown`, but `seeksAllowed` only at
 * `stream_loadfile_done` — the two predicates diverge in `backdropHandoff`,
 * exactly the bug window, now explicit and tested.
 *
 * The traces in `tests/playbackPhase.test.ts` are the canonical spec.
 */

/**
 * Why the engine called loadStream. Tracked so the reducer can distinguish
 * auto-driven re-entry (init effect dep change) from a user-initiated zero-seek
 * relaunch (startFrom + manualStartRef/skipExternalInitRef = true). Subsumes
 * `manualStartRef` + `skipExternalInitRef` from the engine.
 */
export type LaunchIntent = "auto" | "userManual" | "userZeroSeek";

type PhaseKind =
  | { kind: "idle" }
  | { kind: "launching"; gen: number; intent: LaunchIntent }
  | { kind: "backdropHandoff"; gen: number }
  | { kind: "playing"; gen: number }
  | { kind: "reloading"; gen: number; streamLoaded: boolean }
  | { kind: "stopping" };

/**
 * Full phase state. Three cross-cutting fields ride alongside the kind:
 * - `lastLaunchedKey` — `${fileId}|${effectiveFormatSignature}|${audioMapSignature}`
 *   stamped after a launch lands (engine L2267); cleared on process_gone
 *   (engine L219). Used by the init effect's idempotency guard (engine L2158).
 * - `lastReloadSignature` — `${effectiveFormatSignature}|${audioMapSignature}`,
 *   written at engine L2243/L2249/L2254. Per plan W1, the HTML5-side writes
 *   (L2323/L2327) stay as flag mutations (the HTML5 reload effect is
 *   external-player-dead — see engine L2317).
 * - `lastConsumedIntent` — `LaunchIntent | null` parked by `startFrom`
 *   before its `pauseForChange + loadStream` chain, then consumed by either
 *   the next `start_load` (rolling into the launching state's `intent`) or
 *   the init effect's short-circuit guards. Subsumes `manualStartRef` +
 *   `skipExternalInitRef` from the engine. PR 3.2b — mirrors PR 3.2a's
 *   `lastLaunchedKey` pattern.
 */
export type PlaybackPhase = PhaseKind & {
  lastLaunchedKey: string | null;
  lastReloadSignature: string | null;
  lastConsumedIntent: LaunchIntent | null;
};

export type PhaseEvent =
  /**
   * Engine entered loadStream — set synchronously at engine L1365 (the
   * launchInProgressRef latch acquire). Universal: from any non-idle non-playing
   * state, transitions to launching with a new gen; from playing it transitions
   * to reloading{streamLoaded:false} (alive-mpv reload entry). If the engine
   * subsequently observes processActive=false mid-flow (lifecycle race —
   * engine L1387-1394), it dispatches a defensive `reload_branch` event to
   * confirm the alive-mpv path.
   */
  | { type: "start_load"; intent: LaunchIntent }
  /**
   * Engine took the alive-mpv reload branch (engine L1837). Sent right after
   * start_load when the engine confirms processActive=true. From `launching`
   * this transitions → reloading{streamLoaded:false}; from `reloading` it is
   * a no-op (the prior start_load from playing already opened reloading).
   */
  | { type: "reload_branch" }
  /**
   * Backdrop `signalPlaybackReady` fired — set at engine L1570 (backdrop path
   * only). The window is hidden but the HLS stream loadfile has NOT happened
   * yet. The deliberate locked split: isReadyToReveal=true but
   * seeksAllowed=false.
   */
  | { type: "backdrop_shown" }
  /**
   * The HLS stream's loadfile completed and the engine declared the stream
   * loaded. Sent at three engine sites:
   * - L1828 (direct path): launching → playing
   * - L1667 (backdrop path): backdropHandoff → playing
   * - L1969 (reload path): reloading{streamLoaded:false} → reloading{streamLoaded:true}
   */
  | { type: "stream_loadfile_done" }
  /**
   * The engine's loadStream `finally` ran (engine L1973) — release the
   * load-in-flight latch. In direct/backdrop paths this is a no-op (already
   * playing). In the reload path it advances reloading{streamLoaded:true} →
   * playing — exactly the slight-early-release of plan W3.
   */
  | { type: "load_settled" }
  /**
   * The launch / loadfile threw — sent in the launch branch's catch (engine
   * L1832) and from init-effect catch (engine L2276) on reload-branch errors.
   * From launching/backdropHandoff → idle. From reloading → playing (mpv still
   * alive — the prior stream is still running, plan-mandated).
   */
  | { type: "load_failed" }
  /**
   * Init effect dispatched `start_load` at its top but then hit an early-
   * return branch (smokeTest / deferPlayback / blockAutoPlay-with-startTime /
   * pendingIntent-consume) WITHOUT calling loadStream — so neither
   * stream_loadfile_done nor load_settled will ever advance the phase.
   * `cancel_load` rolls the phase back: from `launching` → idle (mpv was
   * never spawned for this attempt); from `reloading` → playing (mpv is
   * still alive on the prior stream). All cross-cutting fields are
   * preserved. PR 3.2c-2.
   */
  | { type: "cancel_load" }
  /**
   * The main-process lifecycle reducer transitioned to idle (engine L218
   * subscribes via mpvClient.subscribeLifecycle). Universal: resets phase to
   * idle and clears lastLaunchedKey (preserves lastReloadSignature — the
   * engine mirrors this: L219 clears lastLaunchedKeyRef but not
   * lastReloadSignatureRef).
   */
  | { type: "process_gone" }
  /**
   * User-initiated teardown (e.g. dialog close — engine L2090). Transitions
   * to stopping; expect process_gone next.
   */
  | { type: "user_stop" }
  /**
   * Init effect stamps the launched tuple after loadStream completes
   * (engine L2267). Replaces lastLaunchedKeyRef writes.
   */
  | { type: "stamp_launched_key"; key: string }
  /**
   * Mirrors engine L219 — lastLaunchedKey is cleared when lifecycle
   * transitions to idle. (process_gone clears it too; this exists for
   * any other future producer.)
   */
  | { type: "clear_launched_key" }
  /**
   * Init effect's reload-signature bookkeeping (engine L2243/L2249/L2254).
   * Replaces lastReloadSignatureRef writes. Per plan W1, the HTML5-side
   * writes (L2323/L2327) stay as flag mutations.
   */
  | { type: "set_reload_signature"; signature: string }
  /**
   * `startFrom` parks the user-initiated launch intent before dispatching
   * the actual `loadStream` call (via pauseForChange). The intent waits
   * in `phase.lastConsumedIntent` until either:
   *   - the next `start_load` consumes it (the launching state's
   *     `intent` field becomes authoritative), OR
   *   - the init effect's short-circuit guards consume it via
   *     `consume_intent` (when the init effect re-fires from a post-
   *     load dep change and needs to know "the recent load was
   *     user-initiated, skip my own loadStream").
   * Subsumes `manualStartRef + skipExternalInitRef`. PR 3.2b.
   */
  | { type: "set_intent_pending"; intent: LaunchIntent }
  /**
   * The init effect's manualStart-consume / skipExternalInit-consume
   * short-circuit branches (engine L2395 / L2408) clear the pending
   * intent and update the reload signature. PR 3.2b.
   */
  | { type: "consume_intent" };

export const initialPhase: PlaybackPhase = {
  kind: "idle",
  lastLaunchedKey: null,
  lastReloadSignature: null,
  lastConsumedIntent: null,
};

const getGen = (state: PlaybackPhase): number => {
  if (state.kind === "idle" || state.kind === "stopping") return 0;
  return state.gen;
};

/**
 * Pure phase reducer. Given a state + event, returns the next state.
 * The traces in `tests/playbackPhase.test.ts` are the canonical spec.
 */
export function reducePhase(
  state: PlaybackPhase,
  event: PhaseEvent,
): PlaybackPhase {
  // ----- Cross-cutting field updates (no kind change) -----
  if (event.type === "stamp_launched_key") {
    return { ...state, lastLaunchedKey: event.key };
  }
  if (event.type === "clear_launched_key") {
    return { ...state, lastLaunchedKey: null };
  }
  if (event.type === "set_reload_signature") {
    return { ...state, lastReloadSignature: event.signature };
  }
  if (event.type === "set_intent_pending") {
    // Last-write-wins (two startFrom clicks back-to-back overwrite).
    return { ...state, lastConsumedIntent: event.intent };
  }
  if (event.type === "consume_intent") {
    return { ...state, lastConsumedIntent: null };
  }

  // ----- Universal kind transitions -----
  // process_gone resets the machine to idle and clears the launched-key stamp.
  // Mirror of engine L218-220: lastLaunchedKeyRef is cleared on lifecycle→idle
  // but lastReloadSignatureRef is preserved (the next launch re-stamps it).
  // lastConsumedIntent is also cleared (mpv died — any pending intent
  // is stale; matches the implicit reset today, where the next startFrom
  // re-sets the refs).
  if (event.type === "process_gone") {
    return {
      kind: "idle",
      lastLaunchedKey: null,
      lastReloadSignature: state.lastReloadSignature,
      lastConsumedIntent: null,
    };
  }

  // start_load is universal with state-dependent next-kind:
  //   - From playing → reloading{streamLoaded:false} (alive-mpv reload entry)
  //   - From everything else → launching with a fresh gen
  //
  // `lastConsumedIntent` is PRESERVED across start_load — the launch
  // carries the intent on `launching.intent`, but the init effect's
  // post-launch consume guards (engine L2354/L2367) need to read the
  // pending intent AFTER loadStream completes (a dep change may re-fire
  // the init effect, which short-circuits via consume_intent if it sees
  // a startFrom-initiated launch just happened). consume_intent is the
  // sole clearer; process_gone (mpv died) is the only other clearer.
  if (event.type === "start_load") {
    const carry = {
      lastLaunchedKey: state.lastLaunchedKey,
      lastReloadSignature: state.lastReloadSignature,
      lastConsumedIntent: state.lastConsumedIntent,
    };
    if (state.kind === "playing") {
      return {
        ...carry,
        kind: "reloading",
        gen: state.gen + 1,
        streamLoaded: false,
      };
    }
    return {
      ...carry,
      kind: "launching",
      gen: getGen(state) + 1,
      intent: event.intent,
    };
  }

  switch (state.kind) {
    case "idle":
      // start_load + process_gone handled above.
      return state;

    case "launching":
      switch (event.type) {
        case "reload_branch":
          // Engine discovered alive mpv mid-loadStream (lifecycle race —
          // engine L1387-1394). Switch the in-flight launch to a reload.
          return {
            ...state,
            kind: "reloading",
            gen: state.gen,
            streamLoaded: false,
          };
        case "backdrop_shown":
          return { ...state, kind: "backdropHandoff", gen: state.gen };
        case "stream_loadfile_done":
          return { ...state, kind: "playing", gen: state.gen };
        case "load_settled":
          // Defensive — direct path settles AFTER stream_loadfile_done. This
          // arm fires only if stream_loadfile_done was lost (engine race);
          // treat as a soft completion to playing.
          return { ...state, kind: "playing", gen: state.gen };
        case "load_failed":
          return {
            kind: "idle",
            lastLaunchedKey: null,
            lastReloadSignature: state.lastReloadSignature,
            lastConsumedIntent: state.lastConsumedIntent,
          };
        case "cancel_load":
          // PR 3.2c-2: init effect dispatched start_load at its top, then
          // hit an early-return branch. Roll back to idle — mpv was never
          // spawned for this attempt. All cross-cutting fields preserved.
          return {
            kind: "idle",
            lastLaunchedKey: state.lastLaunchedKey,
            lastReloadSignature: state.lastReloadSignature,
            lastConsumedIntent: state.lastConsumedIntent,
          };
        case "user_stop":
          return { ...state, kind: "stopping" };
      }
      return state;

    case "backdropHandoff":
      switch (event.type) {
        case "stream_loadfile_done":
          return { ...state, kind: "playing", gen: state.gen };
        case "load_settled":
          // Defensive — same reasoning as launching + load_settled.
          return { ...state, kind: "playing", gen: state.gen };
        case "load_failed":
          return {
            kind: "idle",
            lastLaunchedKey: null,
            lastReloadSignature: state.lastReloadSignature,
            lastConsumedIntent: state.lastConsumedIntent,
          };
        case "user_stop":
          return { ...state, kind: "stopping" };
        case "backdrop_shown":
          return state; // idempotent
        case "reload_branch":
          return state; // backdrop path has no alive-mpv reload entry
        case "cancel_load":
          // Unreachable in practice (init-effect early returns happen BEFORE
          // any backdrop_shown dispatch), but specify as no-op for safety.
          return state;
      }
      return state;

    case "playing":
      switch (event.type) {
        case "load_settled":
        case "stream_loadfile_done":
        case "reload_branch":
        case "backdrop_shown":
        case "load_failed":
        case "cancel_load":
          // cancel_load from playing is a no-op — no load was in flight.
          // This arm fires when the init effect short-circuits but the
          // post-launch-key-match guard already caught the case (mpv was
          // alive on the same tuple). Safe no-op.
          return state;
        case "user_stop":
          return { ...state, kind: "stopping" };
      }
      return state;

    case "reloading":
      switch (event.type) {
        case "stream_loadfile_done":
          if (state.streamLoaded) {
            // Stream already loaded — engine dispatched twice. Idempotent.
            return state;
          }
          return { ...state, streamLoaded: true };
        case "cancel_load":
          // PR 3.2c-2: rollback to playing — mpv is still alive on the
          // prior stream. Mirror of load_failed's "mpv-still-alive"
          // semantic. All cross-cutting fields preserved.
          return { ...state, kind: "playing", gen: state.gen };
        case "load_settled":
          // Reload completes — slight-early release of in-flight per plan W3.
          return { ...state, kind: "playing", gen: state.gen };
        case "load_failed":
          // Plan: load_failed during reload → playing (mpv still alive; reload
          // didn't take, but the prior stream is still running).
          return { ...state, kind: "playing", gen: state.gen };
        case "user_stop":
          return { ...state, kind: "stopping" };
        case "reload_branch":
        case "backdrop_shown":
          return state;
      }
      return state;

    case "stopping":
      // process_gone handled above. Anything else (including stray load
      // events after teardown) is a no-op.
      return state;
  }
}

// ---------------------------------------------------------------------------
// Predicates — the canonical replacements for the flag-derived checks in
// useMpvPlaybackEngine.ts. Equivalence is asserted in shadow mode at the seek
// gate (L559), the init guard (L2131), and the ABR gate (L2817) before any
// flag deletion in PR 3.2.
// ---------------------------------------------------------------------------

/**
 * Whether external seeks are allowed to fire against mpv. Replaces
 * `isReadyToRevealRef.current && streamLoadfileCompleteRef.current` at the
 * seek gate (engine L559).
 *
 * The deliberate locked split: `backdropHandoff` (window hidden but stream
 * not yet loaded) is NOT seeks-allowed — exactly the bug window from #1/#3.
 */
export const seeksAllowed = (phase: PlaybackPhase): boolean =>
  phase.kind === "playing" ||
  (phase.kind === "reloading" && phase.streamLoaded);

/**
 * Whether the engine has declared the playback session "revealed to the user"
 * (window-hide / loading-modal teardown signal). Replaces the
 * `isReadyToRevealRef.current` read at the engine's MediaPlaybackController
 * consumers (L745/783/787 of MediaPlaybackController.tsx) and the public
 * return (engine L3169).
 *
 * Unlike `seeksAllowed`, this returns TRUE in `backdropHandoff` — the
 * window-hide has already happened, even though the stream is still loading.
 */
export const deriveIsReadyToReveal = (phase: PlaybackPhase): boolean =>
  phase.kind === "playing" ||
  phase.kind === "backdropHandoff" ||
  (phase.kind === "reloading" && phase.streamLoaded);

/**
 * Whether a load operation (launch or reload) is currently in flight.
 * Replaces `launchInProgressRef.current || initEffectInFlightRef.current` at
 * the init guard (engine L2131).
 *
 * Per plan W3, this MAY release slightly earlier than the current
 * flag-derived version: phase exits in-flight at `load_settled` in the reload
 * path, whereas today's flags release at the engine's loadStream `finally`
 * (same moment, but the phase reflects the semantic intent rather than the
 * mechanical latch release). Assert
 * `derivedLoadInFlight ⊆ actualLoadInFlight` (phase may release first,
 * never later) when shadowing.
 */
export const isLoadInFlight = (phase: PlaybackPhase): boolean =>
  phase.kind === "launching" ||
  phase.kind === "backdropHandoff" ||
  (phase.kind === "reloading" && !phase.streamLoaded);
