/**
 * Lifecycle state machine for the external-mpv process.
 *
 * A PURE state-transition reducer: (state, event) → next state.
 *
 * Earlier iterations also computed a `LifecycleEffect[]` per transition, but
 * the dispatcher only ever `void`-ed them — the real side effects (window
 * hide/show, OSC polling, process kill) are performed IMPERATIVELY in the main
 * process (`externalMpv.ts` / `mpvSocketClient.ts`), never driven by reducer
 * effects. That effect machinery, plus three intermediate states/events that
 * no producer ever dispatched (`tracks-stable`/`metadata-applied`/
 * `vo-configured`), were dead weight and have been removed. The reducer now
 * models only what the main process actually produces: launch → socket-ready,
 * plus teardown and relaunch. See `tests/lifecycle-traces.test.ts`.
 *
 * NOTE: `playing` is retained in the union (and `isExternalReady` in the engine
 * checks it) for forward-compat, but no current producer dispatches an event
 * that advances socket-ready → playing — so at runtime the machine rests at
 * `socket-ready` for the duration of a launch. (Do not confuse this removed
 * lifecycle state with the live mpv *property* `"vo-configured"` used by the
 * renderer's `pollVoConfigured` — that is unrelated and stays.)
 */

export type LifecycleState =
  | { kind: "idle" }
  | { kind: "launching"; launchId: number; startedAt: number }
  | { kind: "socket-ready"; launchId: number }
  | { kind: "playing"; launchId: number }
  | { kind: "stopping" };

export type LifecycleEvent =
  | { type: "launch_started"; launchId: number; startedAt: number }
  | { type: "socket_ready" }
  | { type: "socket_failed" }
  | { type: "process_exited"; code: number | null; signal: string | null }
  | { type: "user_stop" };

/**
 * Pure lifecycle reducer. Given a state + event, returns the next state.
 * The traces in `tests/lifecycle-traces.test.ts` are the canonical spec.
 */
export function reduce(
  state: LifecycleState,
  event: LifecycleEvent,
): LifecycleState {
  // launch_started is universal — it resets the machine into a new launch from
  // ANY state. The main process tears down the prior mpv imperatively; the
  // reducer just records the new launch.
  if (event.type === "launch_started") {
    return { kind: "launching", launchId: event.launchId, startedAt: event.startedAt };
  }

  switch (state.kind) {
    case "idle":
      return state;

    case "launching":
      switch (event.type) {
        case "socket_ready":
          return { kind: "socket-ready", launchId: state.launchId };
        case "socket_failed":
        case "user_stop":
        case "process_exited":
          return { kind: "idle" };
      }
      return state;

    case "socket-ready":
      switch (event.type) {
        case "user_stop":
        case "process_exited":
          return { kind: "idle" };
        case "socket_ready":
        case "socket_failed":
          return state;
      }
      return state;

    case "playing":
      // Retained for forward-compat; not reached by current producers.
      switch (event.type) {
        case "user_stop":
          return { kind: "stopping" };
        case "process_exited":
          return { kind: "idle" };
        case "socket_ready":
        case "socket_failed":
          return state;
      }
      return state;

    case "stopping":
      switch (event.type) {
        case "process_exited":
          return { kind: "idle" };
        case "socket_ready":
        case "socket_failed":
        case "user_stop":
          return state;
      }
      return state;
  }
}
