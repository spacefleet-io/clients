/**
 * @regression-proof playbackPhaseStore — @space/desktop-mpv-playback
 *
 * Phase 3.2e of the playback-engine hardening. Pins:
 *  - The store's dispatch → snapshot identity rules (same-reference
 *    bailout suppresses re-renders).
 *  - Listener-set semantics (add/remove, multi-listener fan-out).
 *  - The reducer composes correctly inside the store (full lifecycle
 *    + cross-cutting field updates).
 *
 * Reactivity inside React (the `usePlaybackPhase` hook → useSyncExternalStore
 * wiring) is implicitly verified by the store's contract: subscribers fire
 * iff and only iff the snapshot reference changes. React's
 * useSyncExternalStore is itself well-tested upstream; we test the store
 * contract directly.
 */

import { describe, expect, it, vi } from "vitest";

import {
  createPlaybackPhaseStore,
  deriveIsReadyToReveal,
  initialPhase,
  seeksAllowed,
  type PlaybackPhase,
} from "../src/index";

// `gen` only exists on the non-idle/non-stopping phases.
const genOf = (phase: PlaybackPhase): number | null => ("gen" in phase ? phase.gen : null);

// On assertion failure, dump the store's current snapshot + derived flags so
// a failure can be diagnosed offline without re-running with a debugger.
// Body wrapped in try/catch so a dump failure can't mask the real assertion.
const dumpPhaseStoreSnapshot = (
  label: string,
  snapshot: ReturnType<ReturnType<typeof createPlaybackPhaseStore>["getSnapshot"]>,
  extra?: Record<string, unknown>,
): void => {
  try {
    console.error(`=== [playback-phase-store:${label}] snapshot ===`);
    console.error(`snapshot:\n${JSON.stringify(snapshot, null, 2)}`);
    console.error(
      `derived: seeksAllowed=${seeksAllowed(snapshot)} isReadyToReveal=${deriveIsReadyToReveal(snapshot)}`,
    );
    if (extra) console.error(`extra: ${JSON.stringify(extra)}`);
  } catch (err) {
    console.error(
      `(snapshot failed: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
};

describe("@regression-proof playbackPhaseStore", () => {
  it("initial getSnapshot returns initialPhase by reference", () => {
    const store = createPlaybackPhaseStore();
    expect(store.getSnapshot()).toBe(initialPhase);
  });

  it("dispatch advances snapshot on a state-changing event", () => {
    const store = createPlaybackPhaseStore();
    store.dispatch({ type: "start_load", intent: "auto" });
    expect(store.getSnapshot().kind).toBe("launching");
  });

  it("dispatch is a no-op when reducer returns same reference (no listener notify)", () => {
    const store = createPlaybackPhaseStore();
    const listener = vi.fn();
    store.subscribe(listener);

    // idle + a non-applicable event is a no-op (reducer returns
    // `state` unchanged).
    store.dispatch({ type: "stream_loadfile_done" });
    expect(listener).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toBe(initialPhase);
  });

  it("listener fires exactly once per state-changing dispatch", () => {
    const store = createPlaybackPhaseStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.dispatch({ type: "start_load", intent: "auto" });
    expect(listener).toHaveBeenCalledTimes(1);
    store.dispatch({ type: "stream_loadfile_done" });
    expect(listener).toHaveBeenCalledTimes(2);
    store.dispatch({ type: "load_settled" });
    // playing + load_settled is a no-op (already playing).
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("multi-listener fan-out: all subscribers receive each notification", () => {
    const store = createPlaybackPhaseStore();
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    store.subscribe(a);
    store.subscribe(b);
    store.subscribe(c);

    store.dispatch({ type: "start_load", intent: "userZeroSeek" });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(c).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe stops further notifications for that listener only", () => {
    const store = createPlaybackPhaseStore();
    const a = vi.fn();
    const b = vi.fn();
    const unsubA = store.subscribe(a);
    store.subscribe(b);

    store.dispatch({ type: "start_load", intent: "auto" });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    unsubA();
    store.dispatch({ type: "stream_loadfile_done" });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it("full launch lifecycle produces a stable snapshot at every step", () => {
    console.info(`[playback-phase-store:lifecycle] starting full launch lifecycle`);
    const store = createPlaybackPhaseStore();

    console.info(`[playback-phase-store:lifecycle] dispatch start_load(auto)`);
    store.dispatch({ type: "start_load", intent: "auto" });
    let snap = store.getSnapshot();
    console.info(
      `[playback-phase-store:lifecycle] after start_load kind=${snap.kind} gen=${genOf(snap)} seeksAllowed=${seeksAllowed(snap)}`,
    );
    if (snap.kind !== "launching" || snap.gen !== 1 || seeksAllowed(snap) !== false) {
      dumpPhaseStoreSnapshot("lifecycle-after-start_load", snap);
    }
    expect(snap).toMatchObject({ kind: "launching", gen: 1 });
    expect(seeksAllowed(snap)).toBe(false);

    console.info(`[playback-phase-store:lifecycle] dispatch backdrop_shown`);
    store.dispatch({ type: "backdrop_shown" });
    snap = store.getSnapshot();
    console.info(
      `[playback-phase-store:lifecycle] after backdrop_shown kind=${snap.kind} gen=${genOf(snap)} isReadyToReveal=${deriveIsReadyToReveal(snap)} seeksAllowed=${seeksAllowed(snap)}`,
    );
    if (snap.kind !== "backdropHandoff" || deriveIsReadyToReveal(snap) !== true) {
      dumpPhaseStoreSnapshot("lifecycle-after-backdrop_shown", snap);
    }
    expect(snap).toMatchObject({
      kind: "backdropHandoff",
      gen: 1,
    });
    expect(deriveIsReadyToReveal(snap)).toBe(true);
    expect(seeksAllowed(snap)).toBe(false);

    console.info(`[playback-phase-store:lifecycle] dispatch stream_loadfile_done`);
    store.dispatch({ type: "stream_loadfile_done" });
    snap = store.getSnapshot();
    console.info(
      `[playback-phase-store:lifecycle] after stream_loadfile_done kind=${snap.kind} gen=${genOf(snap)} isReadyToReveal=${deriveIsReadyToReveal(snap)} seeksAllowed=${seeksAllowed(snap)}`,
    );
    if (snap.kind !== "playing" || seeksAllowed(snap) !== true) {
      dumpPhaseStoreSnapshot("lifecycle-after-stream_loadfile_done", snap);
    }
    expect(snap).toMatchObject({ kind: "playing", gen: 1 });
    expect(deriveIsReadyToReveal(snap)).toBe(true);
    expect(seeksAllowed(snap)).toBe(true);
  });

  it("cross-cutting field dispatches change snapshot identity (drive re-renders)", () => {
    console.info(`[playback-phase-store:cross-cutting] starting cross-cutting field dispatch run`);
    const store = createPlaybackPhaseStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.dispatch({ type: "set_intent_pending", intent: "userZeroSeek" });
    console.info(
      `[playback-phase-store:cross-cutting] after set_intent_pending notifyCount=${listener.mock.calls.length} lastConsumedIntent=${store.getSnapshot().lastConsumedIntent}`,
    );
    if (listener.mock.calls.length !== 1 || store.getSnapshot().lastConsumedIntent !== "userZeroSeek") {
      dumpPhaseStoreSnapshot("cross-cutting-set_intent_pending", store.getSnapshot(), {
        notifyCount: listener.mock.calls.length,
      });
    }
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().lastConsumedIntent).toBe("userZeroSeek");

    store.dispatch({ type: "stamp_launched_key", key: "f|fmt|aud" });
    console.info(
      `[playback-phase-store:cross-cutting] after stamp_launched_key notifyCount=${listener.mock.calls.length} lastLaunchedKey=${store.getSnapshot().lastLaunchedKey}`,
    );
    if (listener.mock.calls.length !== 2 || store.getSnapshot().lastLaunchedKey !== "f|fmt|aud") {
      dumpPhaseStoreSnapshot("cross-cutting-stamp_launched_key", store.getSnapshot(), {
        notifyCount: listener.mock.calls.length,
      });
    }
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().lastLaunchedKey).toBe("f|fmt|aud");

    store.dispatch({ type: "set_reload_signature", signature: "fmt|aud" });
    console.info(
      `[playback-phase-store:cross-cutting] after set_reload_signature notifyCount=${listener.mock.calls.length} lastReloadSignature=${store.getSnapshot().lastReloadSignature}`,
    );
    if (listener.mock.calls.length !== 3 || store.getSnapshot().lastReloadSignature !== "fmt|aud") {
      dumpPhaseStoreSnapshot("cross-cutting-set_reload_signature", store.getSnapshot(), {
        notifyCount: listener.mock.calls.length,
      });
    }
    expect(listener).toHaveBeenCalledTimes(3);
    expect(store.getSnapshot().lastReloadSignature).toBe("fmt|aud");
  });

  it("snapshot identity is stable when no event applies (cross-store .is() guard)", () => {
    const store = createPlaybackPhaseStore();
    const before = store.getSnapshot();
    // backdrop_shown is invalid from idle — reducer returns the same state ref.
    store.dispatch({ type: "backdrop_shown" });
    const after = store.getSnapshot();
    expect(Object.is(before, after)).toBe(true);
  });

  it("isolated stores don't share state", () => {
    const a = createPlaybackPhaseStore();
    const b = createPlaybackPhaseStore();
    a.dispatch({ type: "start_load", intent: "auto" });
    expect(a.getSnapshot().kind).toBe("launching");
    expect(b.getSnapshot().kind).toBe("idle");
  });

  // -------------------------------------------------------------------------
  // Selector contract — re-renders only when the derived value changes
  // (the optimization that protects downstream consumers from unrelated
  // phase mutations like set_reload_signature / stamp_launched_key /
  // set_intent_pending).
  // -------------------------------------------------------------------------

  it("selector via store.subscribe: notify fires on EVERY phase change (selector decides re-render via useSyncExternalStore Object.is)", () => {
    const store = createPlaybackPhaseStore();
    // Simulate the useSyncExternalStore semantics — subscribers are
    // always notified, but React only re-renders when the selector's
    // returned value changes by Object.is.
    let renderedValue: boolean | null = null;
    const subscribeWithSelector = () => {
      store.subscribe(() => {
        const next = deriveIsReadyToReveal(store.getSnapshot());
        if (!Object.is(next, renderedValue)) {
          renderedValue = next;
        }
      });
    };
    subscribeWithSelector();
    renderedValue = deriveIsReadyToReveal(store.getSnapshot());
    console.info(`[playback-phase-store:selector] initial renderedValue=${renderedValue} kind=${store.getSnapshot().kind}`);
    expect(renderedValue).toBe(false); // idle

    // Cross-cutting field updates do NOT flip the derived value — no
    // "render".
    store.dispatch({ type: "stamp_launched_key", key: "k" });
    console.info(`[playback-phase-store:selector] after stamp_launched_key renderedValue=${renderedValue} kind=${store.getSnapshot().kind}`);
    if (renderedValue !== false) dumpPhaseStoreSnapshot("selector-stamp_launched_key", store.getSnapshot(), { renderedValue });
    expect(renderedValue).toBe(false);
    store.dispatch({ type: "set_intent_pending", intent: "userZeroSeek" });
    console.info(`[playback-phase-store:selector] after set_intent_pending renderedValue=${renderedValue} kind=${store.getSnapshot().kind}`);
    if (renderedValue !== false) dumpPhaseStoreSnapshot("selector-set_intent_pending", store.getSnapshot(), { renderedValue });
    expect(renderedValue).toBe(false);
    store.dispatch({ type: "set_reload_signature", signature: "sig" });
    console.info(`[playback-phase-store:selector] after set_reload_signature renderedValue=${renderedValue} kind=${store.getSnapshot().kind}`);
    if (renderedValue !== false) dumpPhaseStoreSnapshot("selector-set_reload_signature", store.getSnapshot(), { renderedValue });
    expect(renderedValue).toBe(false);

    // start_load enters launching — still derives false.
    store.dispatch({ type: "start_load", intent: "userZeroSeek" });
    console.info(`[playback-phase-store:selector] after start_load renderedValue=${renderedValue} kind=${store.getSnapshot().kind}`);
    if (renderedValue !== false) dumpPhaseStoreSnapshot("selector-start_load", store.getSnapshot(), { renderedValue });
    expect(renderedValue).toBe(false);

    // backdrop_shown enters backdropHandoff — derives true.
    store.dispatch({ type: "backdrop_shown" });
    console.info(`[playback-phase-store:selector] after backdrop_shown renderedValue=${renderedValue} kind=${store.getSnapshot().kind}`);
    if (renderedValue !== true) dumpPhaseStoreSnapshot("selector-backdrop_shown", store.getSnapshot(), { renderedValue });
    expect(renderedValue).toBe(true);

    // stream_loadfile_done transitions to playing — still true.
    store.dispatch({ type: "stream_loadfile_done" });
    console.info(`[playback-phase-store:selector] after stream_loadfile_done renderedValue=${renderedValue} kind=${store.getSnapshot().kind}`);
    if (renderedValue !== true) dumpPhaseStoreSnapshot("selector-stream_loadfile_done", store.getSnapshot(), { renderedValue });
    expect(renderedValue).toBe(true);
  });
});
