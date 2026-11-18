/**
 * @regression-proof playbackPhase reducer — @space/desktop-mpv-playback
 *
 * Phase 3 of the playback-engine hardening. These traces are
 * the canonical spec for the playbackPhase state machine — they pin the six
 * named regression scenarios from the plan plus the predicate truth tables.
 *
 * Discipline: do NOT edit traces to match a buggy reducer. If a trace appears
 * wrong, escalate. The plan explicitly mandates "net before knife" — a
 * refactor that requires editing these traces is a behavior change, not a
 * refactor.
 *
 * Logs generously on failure (project convention):
 * `runTrace` records the full state path and emits it in the failure message.
 */

import { describe, expect, it } from "vitest";

import {
  deriveIsReadyToReveal,
  initialPhase,
  isLoadInFlight,
  reducePhase,
  seeksAllowed,
  type PhaseEvent,
  type PlaybackPhase,
} from "../src/playbackPhase";

// ---------------------------------------------------------------------------
// Trace runner (state-only — the reducer has no effects)
// ---------------------------------------------------------------------------

type Trace = {
  name: string;
  events: PhaseEvent[];
  expectedFinalState: Partial<PlaybackPhase> & { kind: PlaybackPhase["kind"] };
  initial?: PlaybackPhase;
};

const formatStep = (state: PlaybackPhase): string => {
  if (state.kind === "reloading") {
    return `(${state.kind} gen=${state.gen} streamLoaded=${state.streamLoaded})`;
  }
  if (state.kind === "launching") {
    return `(${state.kind} gen=${state.gen} intent=${state.intent})`;
  }
  if (state.kind === "backdropHandoff" || state.kind === "playing") {
    return `(${state.kind} gen=${state.gen})`;
  }
  return `(${state.kind})`;
};

// On assertion failure, dump the full domain state this reducer cares about:
// the phase shape, all cross-cutting fields, and the three derived predicates
// (the truth-table outputs that most tests pivot on). Wrapped in try/catch so a
// dump failure can never mask the real assertion. (project convention:
// "Tests log generously")
const dumpPlaybackPhaseSnapshot = (
  label: string,
  states: Record<string, PlaybackPhase | null | undefined>,
  extra?: Record<string, unknown>,
): void => {
  try {
    console.error(`=== [playback-phase:${label}] state snapshot ===`);
    for (const [name, state] of Object.entries(states)) {
      if (!state) {
        console.error(`  ${name}: ${JSON.stringify(state)}`);
        continue;
      }
      let predicates = "(predicate-eval-failed)";
      try {
        predicates = `seeksAllowed=${seeksAllowed(state)} readyToReveal=${deriveIsReadyToReveal(
          state,
        )} loadInFlight=${isLoadInFlight(state)}`;
      } catch (err) {
        predicates = `(predicate-eval-failed: ${err instanceof Error ? err.message : String(err)})`;
      }
      console.error(`  ${name}: ${formatStep(state)} ${predicates}`);
      console.error(`  ${name} full=${JSON.stringify(state)}`);
    }
    if (extra) {
      console.error(`  extra=${JSON.stringify(extra, null, 2)}`);
    }
  } catch (err) {
    console.error(
      `(snapshot failed: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
};

const runTrace = (trace: Trace): PlaybackPhase => {
  let state: PlaybackPhase = trace.initial ?? initialPhase;
  const steps: string[] = [formatStep(state)];
  console.info(
    `[playback-phase:trace] "${trace.name}" start=${formatStep(state)} events=[${trace.events
      .map((e) => e.type)
      .join(", ")}]`,
  );
  for (const event of trace.events) {
    state = reducePhase(state, event);
    steps.push(`${event.type} → ${formatStep(state)}`);
  }
  console.info(`[playback-phase:trace] "${trace.name}" path: ${steps.join(" | ")}`);
  try {
    expect(
      state,
      `[${trace.name}] final state. path: ${steps.join(" | ")}`,
    ).toMatchObject(trace.expectedFinalState);
  } catch (err) {
    dumpPlaybackPhaseSnapshot(`trace-${trace.name}`, { final: state }, {
      trace: trace.name,
      path: steps,
      expectedFinalState: trace.expectedFinalState,
    });
    throw err;
  }
  return state;
};

const startLoad = (
  intent: "auto" | "userManual" | "userZeroSeek" = "auto",
): PhaseEvent => ({ type: "start_load", intent });

// Test factory — each phase variant with sensible defaults for predicate
// truth-table checks. `extra` lets reloading override `streamLoaded`.
const ph = (
  kind: PlaybackPhase["kind"],
  extra: Partial<PlaybackPhase> = {},
): PlaybackPhase => {
  const base: PlaybackPhase = { ...initialPhase, ...extra, kind } as PlaybackPhase;
  switch (kind) {
    case "idle":
      return {
        kind: "idle",
        lastLaunchedKey: null,
        lastReloadSignature: null,
        lastConsumedIntent: null,
      };
    case "launching":
      return {
        ...base,
        kind: "launching",
        gen: 1,
        intent: "auto",
      } as PlaybackPhase;
    case "backdropHandoff":
      return { ...base, kind: "backdropHandoff", gen: 1 } as PlaybackPhase;
    case "playing":
      return { ...base, kind: "playing", gen: 1 } as PlaybackPhase;
    case "reloading": {
      const streamLoaded =
        typeof (extra as { streamLoaded?: boolean }).streamLoaded === "boolean"
          ? (extra as { streamLoaded: boolean }).streamLoaded
          : false;
      return {
        ...base,
        kind: "reloading",
        gen: 1,
        streamLoaded,
      } as PlaybackPhase;
    }
    case "stopping":
      return { ...base, kind: "stopping" } as PlaybackPhase;
  }
};

// ---------------------------------------------------------------------------
// Named regression traces — the 6 from the plan + 1 supporting trace
// ---------------------------------------------------------------------------

describe("@regression-proof playbackPhase traces", () => {
  describe("named regression traces (from the plan)", () => {
    it("cold-start direct: idle → launching → playing", () => {
      runTrace({
        name: "cold-start direct",
        events: [startLoad("auto"), { type: "stream_loadfile_done" }],
        expectedFinalState: { kind: "playing", gen: 1 },
      });
    });

    it("backdrop handoff: idle → launching → backdropHandoff → playing", () => {
      runTrace({
        name: "backdrop handoff",
        events: [
          startLoad("auto"),
          { type: "backdrop_shown" },
          { type: "stream_loadfile_done" },
        ],
        expectedFinalState: { kind: "playing", gen: 1 },
      });
    });

    it("quality reload preserves seek gate (#3 headline)", () => {
      // From playing, start_load triggers a reload. seeksAllowed must be FALSE
      // while reloading{streamLoaded:false}, TRUE after stream_loadfile_done,
      // and load_settled completes the reload back to playing.
      const playingState: PlaybackPhase = {
        ...initialPhase,
        kind: "playing",
        gen: 5,
      };
      console.info(
        `[playback-phase:quality-reload] start=${formatStep(playingState)}`,
      );

      const afterStart = reducePhase(playingState, startLoad("auto"));
      const afterReloadBranch = reducePhase(afterStart, {
        type: "reload_branch",
      });
      const afterLoadfileDone = reducePhase(afterReloadBranch, {
        type: "stream_loadfile_done",
      });
      const afterSettled = reducePhase(afterLoadfileDone, {
        type: "load_settled",
      });
      try {
        expect(afterStart, "reload entry").toMatchObject({
          kind: "reloading",
          gen: 6,
          streamLoaded: false,
        });
        expect(
          seeksAllowed(afterStart),
          "seeks BLOCKED while streamLoaded:false (the #3 cure)",
        ).toBe(false);

        // engine's defensive reload_branch dispatch is a no-op from reloading
        expect(
          afterReloadBranch,
          "reload_branch from reloading is a no-op",
        ).toEqual(afterStart);

        expect(afterLoadfileDone, "stream loaded mid-reload").toMatchObject({
          kind: "reloading",
          gen: 6,
          streamLoaded: true,
        });
        expect(
          seeksAllowed(afterLoadfileDone),
          "seeks OPEN after streamLoaded:true",
        ).toBe(true);

        expect(afterSettled, "reload settled → playing").toMatchObject({
          kind: "playing",
          gen: 6,
        });
        expect(
          seeksAllowed(afterSettled),
          "seeks remain open in playing",
        ).toBe(true);
      } catch (err) {
        dumpPlaybackPhaseSnapshot("quality-reload-seek-gate", {
          playingState,
          afterStart,
          afterReloadBranch,
          afterLoadfileDone,
          afterSettled,
        });
        throw err;
      }
    });

    it("relaunch from playing: start_load enters reloading (alive-mpv path)", () => {
      // The plan's "relaunch from playing" trace. Because the engine
      // doesn't tear down mpv between sessions, start_load from playing maps
      // to a reload, not a fresh launching.
      const playingState: PlaybackPhase = {
        ...initialPhase,
        kind: "playing",
        gen: 2,
      };
      const after = reducePhase(playingState, startLoad("auto"));
      expect(after).toMatchObject({
        kind: "reloading",
        gen: 3,
        streamLoaded: false,
      });
    });

    it("process_gone universal: any state → idle (lastLaunchedKey cleared)", () => {
      const states: PlaybackPhase[] = [
        initialPhase,
        ph("launching"),
        ph("backdropHandoff"),
        ph("playing"),
        ph("reloading", { streamLoaded: false }),
        ph("reloading", { streamLoaded: true }),
        ph("stopping"),
      ];
      console.info(
        `[playback-phase:process-gone-universal] checking ${states.length} start states`,
      );
      for (const start of states) {
        const withKey: PlaybackPhase = {
          ...start,
          lastLaunchedKey: "abc|fmt|aud",
          lastReloadSignature: "fmt|aud",
        };
        const after = reducePhase(withKey, { type: "process_gone" });
        if (
          after.kind !== "idle" ||
          after.lastLaunchedKey !== null ||
          after.lastReloadSignature !== "fmt|aud"
        ) {
          dumpPlaybackPhaseSnapshot("process-gone-universal", { withKey, after }, {
            fromKind: start.kind,
          });
        }
        expect(after.kind, `from ${start.kind}`).toBe("idle");
        expect(after.lastLaunchedKey, "lastLaunchedKey cleared").toBeNull();
        expect(
          after.lastReloadSignature,
          "lastReloadSignature preserved (mirrors engine L218-220)",
        ).toBe("fmt|aud");
      }
    });

    it("load_failed during reload → playing (mpv still alive)", () => {
      const reloadingState: PlaybackPhase = {
        ...initialPhase,
        kind: "reloading",
        gen: 4,
        streamLoaded: false,
      };
      const after = reducePhase(reloadingState, { type: "load_failed" });
      expect(after, "reload error keeps mpv alive — back to playing").toMatchObject({
        kind: "playing",
        gen: 4,
      });
    });
  });

  describe("supporting traces", () => {
    it("alive-mpv reload via launching (start_load from idle, then reload_branch)", () => {
      // Variant where the engine entered launching from idle (lifecycle race —
      // engine L1387-1394) and then discovered processActive=true mid-load.
      // The new model handles this via the launching → reloading transition
      // on reload_branch.
      runTrace({
        name: "launching → reload_branch → reloading",
        events: [
          startLoad("auto"),
          { type: "reload_branch" },
          { type: "stream_loadfile_done" },
          { type: "load_settled" },
        ],
        expectedFinalState: { kind: "playing", gen: 1 },
      });
    });

    it("backdrop path full lifecycle including load_settled", () => {
      runTrace({
        name: "backdrop full lifecycle",
        events: [
          startLoad("auto"),
          { type: "backdrop_shown" },
          { type: "stream_loadfile_done" },
          { type: "load_settled" },
        ],
        expectedFinalState: { kind: "playing", gen: 1 },
      });
    });

    it("user-zero-seek intent rides on start_load and survives until reveal", () => {
      const after = reducePhase(initialPhase, startLoad("userZeroSeek"));
      expect(after).toMatchObject({
        kind: "launching",
        gen: 1,
        intent: "userZeroSeek",
      });
    });

    it("process_gone during launching → idle (no half-loaded zombie state)", () => {
      runTrace({
        name: "process_gone during launching",
        events: [startLoad("auto"), { type: "process_gone" }],
        expectedFinalState: { kind: "idle" },
      });
    });

    it("user_stop → stopping → idle (on process_gone)", () => {
      runTrace({
        name: "user stop teardown",
        events: [
          startLoad("auto"),
          { type: "stream_loadfile_done" },
          { type: "user_stop" },
          { type: "process_gone" },
        ],
        expectedFinalState: { kind: "idle" },
      });
    });
  });

  // -------------------------------------------------------------------------
  // Transition table (per state, per event)
  // -------------------------------------------------------------------------

  describe("transition table", () => {
    it("idle ignores everything except start_load and process_gone", () => {
      const ignored: PhaseEvent[] = [
        { type: "backdrop_shown" },
        { type: "stream_loadfile_done" },
        { type: "load_settled" },
        { type: "load_failed" },
        { type: "user_stop" },
        { type: "reload_branch" },
      ];
      console.info(
        `[playback-phase:idle-ignores] checking ${ignored.length} events are no-ops from idle`,
      );
      for (const event of ignored) {
        const after = reducePhase(initialPhase, event);
        if (JSON.stringify(after) !== JSON.stringify(initialPhase)) {
          dumpPlaybackPhaseSnapshot("idle-ignores", { initialPhase, after }, {
            event: event.type,
          });
        }
        expect(reducePhase(initialPhase, event)).toEqual(initialPhase);
      }
    });

    it("idle + process_gone → idle (idempotent)", () => {
      expect(reducePhase(initialPhase, { type: "process_gone" })).toEqual(
        initialPhase,
      );
    });

    it("launching + user_stop → stopping", () => {
      expect(reducePhase(ph("launching"), { type: "user_stop" }).kind).toBe(
        "stopping",
      );
    });

    it("launching + load_failed → idle (clears lastLaunchedKey, preserves signature)", () => {
      const launching: PlaybackPhase = {
        kind: "launching",
        gen: 1,
        intent: "auto",
        lastLaunchedKey: "old",
        lastReloadSignature: "sig",
        lastConsumedIntent: null,
      };
      const after = reducePhase(launching, { type: "load_failed" });
      expect(after.kind).toBe("idle");
      expect(after.lastLaunchedKey).toBeNull();
      expect(after.lastReloadSignature).toBe("sig");
    });

    it("launching + load_settled (defensive) → playing", () => {
      const after = reducePhase(ph("launching"), { type: "load_settled" });
      expect(after).toMatchObject({ kind: "playing", gen: 1 });
    });

    // PR 3.2c-2: cancel_load rolls back early-return paths from launching → idle
    // while PRESERVING all cross-cutting fields (lastLaunchedKey,
    // lastReloadSignature, lastConsumedIntent).
    it("launching + cancel_load → idle (preserves cross-cutting fields)", () => {
      const launching: PlaybackPhase = {
        kind: "launching",
        gen: 1,
        intent: "userZeroSeek",
        lastLaunchedKey: "key1",
        lastReloadSignature: "sig1",
        lastConsumedIntent: "userZeroSeek",
      };
      const after = reducePhase(launching, { type: "cancel_load" });
      expect(after.kind).toBe("idle");
      expect(after.lastLaunchedKey, "lastLaunchedKey preserved").toBe("key1");
      expect(after.lastReloadSignature, "lastReloadSignature preserved").toBe(
        "sig1",
      );
      expect(after.lastConsumedIntent, "lastConsumedIntent preserved").toBe(
        "userZeroSeek",
      );
    });

    it("reloading{streamLoaded:false} + cancel_load → playing (mpv alive)", () => {
      const r = ph("reloading", { streamLoaded: false });
      const after = reducePhase(r, { type: "cancel_load" });
      expect(after).toMatchObject({ kind: "playing", gen: 1 });
    });

    it("reloading{streamLoaded:true} + cancel_load → playing (mpv alive)", () => {
      const r = ph("reloading", { streamLoaded: true });
      const after = reducePhase(r, { type: "cancel_load" });
      expect(after).toMatchObject({ kind: "playing", gen: 1 });
    });

    it("idle + cancel_load → idle no-op (returns same reference)", () => {
      const before = initialPhase;
      const after = reducePhase(before, { type: "cancel_load" });
      expect(after).toBe(before);
    });

    it("playing + cancel_load → playing no-op (returns same reference)", () => {
      const p = ph("playing");
      const after = reducePhase(p, { type: "cancel_load" });
      expect(after).toBe(p);
    });

    it("backdropHandoff + cancel_load → no-op (unreachable but safe)", () => {
      const bh = ph("backdropHandoff");
      const after = reducePhase(bh, { type: "cancel_load" });
      expect(after).toBe(bh);
    });

    it("stopping + cancel_load → stopping no-op", () => {
      const s: PlaybackPhase = { ...initialPhase, kind: "stopping" };
      const after = reducePhase(s, { type: "cancel_load" });
      expect(after).toBe(s);
    });

    it("backdropHandoff + user_stop → stopping", () => {
      expect(
        reducePhase(ph("backdropHandoff"), { type: "user_stop" }).kind,
      ).toBe("stopping");
    });

    it("backdropHandoff + load_failed → idle", () => {
      expect(
        reducePhase(ph("backdropHandoff"), { type: "load_failed" }).kind,
      ).toBe("idle");
    });

    it("backdropHandoff ignores reload_branch (backdrop has no alive-mpv reload entry)", () => {
      const bh = ph("backdropHandoff");
      expect(reducePhase(bh, { type: "reload_branch" })).toEqual(bh);
    });

    it("backdrop_shown is idempotent in backdropHandoff", () => {
      const bh = ph("backdropHandoff");
      expect(reducePhase(bh, { type: "backdrop_shown" })).toEqual(bh);
    });

    it("playing + stream_loadfile_done → playing (idempotent late stamp)", () => {
      const p = ph("playing");
      expect(reducePhase(p, { type: "stream_loadfile_done" })).toEqual(p);
    });

    it("playing + load_settled → playing (idempotent)", () => {
      const p = ph("playing");
      expect(reducePhase(p, { type: "load_settled" })).toEqual(p);
    });

    it("playing + user_stop → stopping", () => {
      expect(reducePhase(ph("playing"), { type: "user_stop" }).kind).toBe(
        "stopping",
      );
    });

    it("reloading{streamLoaded:false} + stream_loadfile_done → reloading{streamLoaded:true}", () => {
      const r = ph("reloading", { streamLoaded: false });
      const after = reducePhase(r, { type: "stream_loadfile_done" });
      expect(after).toMatchObject({
        kind: "reloading",
        gen: 1,
        streamLoaded: true,
      });
    });

    it("reloading{streamLoaded:true} + stream_loadfile_done is idempotent", () => {
      const r = ph("reloading", { streamLoaded: true });
      expect(reducePhase(r, { type: "stream_loadfile_done" })).toEqual(r);
    });

    it("reloading + load_settled → playing (slight-early release per plan W3)", () => {
      const r = ph("reloading", { streamLoaded: true });
      expect(reducePhase(r, { type: "load_settled" })).toMatchObject({
        kind: "playing",
        gen: 1,
      });
    });

    it("reloading + load_failed → playing (mpv alive; plan-mandated)", () => {
      expect(
        reducePhase(ph("reloading", { streamLoaded: false }), {
          type: "load_failed",
        }),
      ).toMatchObject({ kind: "playing", gen: 1 });
    });

    it("reloading + user_stop → stopping", () => {
      expect(
        reducePhase(ph("reloading", { streamLoaded: true }), {
          type: "user_stop",
        }).kind,
      ).toBe("stopping");
    });

    it("stopping + process_gone → idle (everything else stays in stopping)", () => {
      const s: PlaybackPhase = {
        ...initialPhase,
        kind: "stopping",
        lastLaunchedKey: "x",
      };
      expect(reducePhase(s, { type: "process_gone" })).toMatchObject({
        kind: "idle",
        lastLaunchedKey: null,
      });
      const others: PhaseEvent[] = [
        { type: "user_stop" },
        { type: "stream_loadfile_done" },
        { type: "load_settled" },
        { type: "load_failed" },
        { type: "backdrop_shown" },
        { type: "reload_branch" },
      ];
      console.info(
        `[playback-phase:stopping-sticky] checking ${others.length} non-process_gone events stay in stopping`,
      );
      for (const event of others) {
        const after = reducePhase(s, event);
        if (after.kind !== "stopping") {
          dumpPlaybackPhaseSnapshot("stopping-sticky", { s, after }, {
            event: event.type,
          });
        }
        expect(after.kind, event.type).toBe("stopping");
      }
    });

    it("start_load is universal — fresh launch from idle, reload from playing, relaunch elsewhere", () => {
      console.info(
        `[playback-phase:start-load-universal] checking 4 start states`,
      );
      // From idle → launching{gen:1}
      const fromIdle = reducePhase(initialPhase, startLoad("auto"));
      // From playing → reloading{gen+1, streamLoaded:false}
      const p: PlaybackPhase = { ...initialPhase, kind: "playing", gen: 7 };
      const fromPlaying = reducePhase(p, startLoad("userZeroSeek"));
      // From launching → launching{gen+1, intent} (relaunch with fresh gen)
      const l: PlaybackPhase = {
        ...initialPhase,
        kind: "launching",
        gen: 3,
        intent: "auto",
      };
      const fromLaunching = reducePhase(l, startLoad("userManual"));
      // From reloading → launching{gen+1, intent} (defensive race entry)
      const r: PlaybackPhase = {
        ...initialPhase,
        kind: "reloading",
        gen: 2,
        streamLoaded: false,
      };
      const fromReloading = reducePhase(r, startLoad("auto"));
      try {
        expect(fromIdle).toMatchObject({
          kind: "launching",
          gen: 1,
          intent: "auto",
        });
        expect(fromPlaying).toMatchObject({
          kind: "reloading",
          gen: 8,
          streamLoaded: false,
        });
        expect(fromLaunching).toMatchObject({
          kind: "launching",
          gen: 4,
          intent: "userManual",
        });
        expect(fromReloading).toMatchObject({
          kind: "launching",
          gen: 3,
          intent: "auto",
        });
      } catch (err) {
        dumpPlaybackPhaseSnapshot("start-load-universal", {
          fromIdle,
          fromPlaying,
          fromLaunching,
          fromReloading,
        });
        throw err;
      }
    });

    it("launching + reload_branch → reloading (alive-mpv discovered mid-launch)", () => {
      const after = reducePhase(ph("launching"), { type: "reload_branch" });
      expect(after).toMatchObject({
        kind: "reloading",
        gen: 1,
        streamLoaded: false,
      });
    });

    it("launching + backdrop_shown → backdropHandoff (carries gen)", () => {
      const after = reducePhase(ph("launching"), { type: "backdrop_shown" });
      expect(after).toMatchObject({ kind: "backdropHandoff", gen: 1 });
    });

    it("launching + stream_loadfile_done → playing (carries gen)", () => {
      const after = reducePhase(ph("launching"), {
        type: "stream_loadfile_done",
      });
      expect(after).toMatchObject({ kind: "playing", gen: 1 });
    });
  });

  // -------------------------------------------------------------------------
  // Predicate truth tables
  // -------------------------------------------------------------------------

  describe("predicate truth tables", () => {
    it("seeksAllowed: only playing OR reloading{streamLoaded:true}", () => {
      const cases: Array<[string, PlaybackPhase, boolean]> = [
        ["idle", ph("idle"), false],
        ["launching", ph("launching"), false],
        // The deliberate split (#1/#3 bug window now explicit + tested):
        ["backdropHandoff", ph("backdropHandoff"), false],
        ["playing", ph("playing"), true],
        [
          "reloading{streamLoaded:false}",
          ph("reloading", { streamLoaded: false }),
          false,
        ],
        [
          "reloading{streamLoaded:true}",
          ph("reloading", { streamLoaded: true }),
          true,
        ],
        ["stopping", ph("stopping"), false],
      ];
      console.info(
        `[playback-phase:seeksAllowed] checking ${cases.length} cases`,
      );
      for (const [label, state, want] of cases) {
        const got = seeksAllowed(state);
        if (got !== want) {
          dumpPlaybackPhaseSnapshot("seeksAllowed", { [label]: state }, {
            predicate: "seeksAllowed",
            case: label,
            want,
            got,
          });
        }
        expect(got, `seeksAllowed(${label})`).toBe(want);
      }
    });

    it("deriveIsReadyToReveal: playing, backdropHandoff, reloading{streamLoaded:true}", () => {
      const cases: Array<[string, PlaybackPhase, boolean]> = [
        ["idle", ph("idle"), false],
        ["launching", ph("launching"), false],
        // window-hide already happened (backdrop_shown dispatched):
        ["backdropHandoff", ph("backdropHandoff"), true],
        ["playing", ph("playing"), true],
        [
          "reloading{streamLoaded:false}",
          ph("reloading", { streamLoaded: false }),
          false,
        ],
        [
          "reloading{streamLoaded:true}",
          ph("reloading", { streamLoaded: true }),
          true,
        ],
        ["stopping", ph("stopping"), false],
      ];
      console.info(
        `[playback-phase:deriveIsReadyToReveal] checking ${cases.length} cases`,
      );
      for (const [label, state, want] of cases) {
        const got = deriveIsReadyToReveal(state);
        if (got !== want) {
          dumpPlaybackPhaseSnapshot("deriveIsReadyToReveal", { [label]: state }, {
            predicate: "deriveIsReadyToReveal",
            case: label,
            want,
            got,
          });
        }
        expect(got, `deriveIsReadyToReveal(${label})`).toBe(want);
      }
    });

    it("isLoadInFlight: launching, backdropHandoff, reloading{streamLoaded:false}", () => {
      const cases: Array<[string, PlaybackPhase, boolean]> = [
        ["idle", ph("idle"), false],
        ["launching", ph("launching"), true],
        ["backdropHandoff", ph("backdropHandoff"), true],
        ["playing", ph("playing"), false],
        [
          "reloading{streamLoaded:false}",
          ph("reloading", { streamLoaded: false }),
          true,
        ],
        // Slight-early release per plan W3 — phase exits in-flight before
        // engine's `finally` runs.
        [
          "reloading{streamLoaded:true}",
          ph("reloading", { streamLoaded: true }),
          false,
        ],
        ["stopping", ph("stopping"), false],
      ];
      console.info(
        `[playback-phase:isLoadInFlight] checking ${cases.length} cases`,
      );
      for (const [label, state, want] of cases) {
        const got = isLoadInFlight(state);
        if (got !== want) {
          dumpPlaybackPhaseSnapshot("isLoadInFlight", { [label]: state }, {
            predicate: "isLoadInFlight",
            case: label,
            want,
            got,
          });
        }
        expect(got, `isLoadInFlight(${label})`).toBe(want);
      }
    });

    it("seeksAllowed and deriveIsReadyToReveal diverge ONLY in backdropHandoff (the locked split)", () => {
      const bh = ph("backdropHandoff");
      console.info(
        `[playback-phase:locked-split] backdropHandoff seeksAllowed=${seeksAllowed(
          bh,
        )} readyToReveal=${deriveIsReadyToReveal(bh)}`,
      );
      if (!(deriveIsReadyToReveal(bh) && !seeksAllowed(bh))) {
        dumpPlaybackPhaseSnapshot("locked-split-backdrop", { backdropHandoff: bh });
      }
      expect(
        deriveIsReadyToReveal(bh) && !seeksAllowed(bh),
        "the #1/#3 bug window is now explicit",
      ).toBe(true);
      for (const k of ["idle", "launching", "playing", "stopping"] as const) {
        const p = ph(k);
        if (seeksAllowed(p)) {
          if (!deriveIsReadyToReveal(p)) {
            dumpPlaybackPhaseSnapshot("locked-split-implication", { [k]: p });
          }
          expect(
            deriveIsReadyToReveal(p),
            `${k}: if seeksAllowed then revealed`,
          ).toBe(true);
        }
      }
      for (const streamLoaded of [false, true] as const) {
        const r = ph("reloading", { streamLoaded });
        if (seeksAllowed(r)) {
          if (!deriveIsReadyToReveal(r)) {
            dumpPlaybackPhaseSnapshot("locked-split-implication", {
              [`reloading{streamLoaded:${streamLoaded}}`]: r,
            });
          }
          expect(
            deriveIsReadyToReveal(r),
            `reloading{streamLoaded:${streamLoaded}}: if seeksAllowed then revealed`,
          ).toBe(true);
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // Cross-cutting fields — lastLaunchedKey + lastReloadSignature
  // -------------------------------------------------------------------------

  describe("cross-cutting fields", () => {
    it("stamp_launched_key sets lastLaunchedKey without changing kind", () => {
      const p = ph("playing");
      const after = reducePhase(p, {
        type: "stamp_launched_key",
        key: "file1|fmt1|aud1",
      });
      expect(after.kind).toBe("playing");
      expect(after.lastLaunchedKey).toBe("file1|fmt1|aud1");
    });

    it("clear_launched_key clears lastLaunchedKey without changing kind", () => {
      const p: PlaybackPhase = {
        ...ph("playing"),
        lastLaunchedKey: "stale",
      };
      const after = reducePhase(p, { type: "clear_launched_key" });
      expect(after.kind).toBe("playing");
      expect(after.lastLaunchedKey).toBeNull();
    });

    it("process_gone clears lastLaunchedKey but preserves lastReloadSignature (engine L218-220 mirror)", () => {
      const p: PlaybackPhase = {
        ...ph("playing"),
        lastLaunchedKey: "k",
        lastReloadSignature: "s",
      };
      const after = reducePhase(p, { type: "process_gone" });
      expect(after.lastLaunchedKey).toBeNull();
      expect(after.lastReloadSignature).toBe("s");
    });

    it("set_reload_signature updates lastReloadSignature without changing kind", () => {
      const p = ph("launching");
      const after = reducePhase(p, {
        type: "set_reload_signature",
        signature: "fmt2|aud2",
      });
      expect(after.kind).toBe("launching");
      expect(after.lastReloadSignature).toBe("fmt2|aud2");
    });

    it("kind transitions preserve lastLaunchedKey across non-process_gone events", () => {
      const launching: PlaybackPhase = {
        kind: "launching",
        gen: 1,
        intent: "auto",
        lastLaunchedKey: "stamp",
        lastReloadSignature: "sig",
        lastConsumedIntent: null,
      };
      const playing = reducePhase(launching, { type: "stream_loadfile_done" });
      expect(
        playing.lastLaunchedKey,
        "stream_loadfile_done preserves stamp",
      ).toBe("stamp");
      expect(
        playing.lastReloadSignature,
        "stream_loadfile_done preserves signature",
      ).toBe("sig");
    });

    // -----------------------------------------------------------------------
    // PR 3.2b: lastConsumedIntent — startFrom parks the user-initiated launch
    // intent before `pauseForChange + loadStream`; consumed by `start_load`
    // (rolling into launching.intent) or by the init effect's short-circuit
    // guards via `consume_intent`.
    // -----------------------------------------------------------------------

    it("set_intent_pending sets lastConsumedIntent without changing kind", () => {
      const p = ph("playing");
      const after = reducePhase(p, {
        type: "set_intent_pending",
        intent: "userZeroSeek",
      });
      expect(after.kind).toBe("playing");
      expect(after.lastConsumedIntent).toBe("userZeroSeek");
    });

    it("consume_intent clears lastConsumedIntent without changing kind", () => {
      const p: PlaybackPhase = {
        ...ph("playing"),
        lastConsumedIntent: "userManual",
      };
      const after = reducePhase(p, { type: "consume_intent" });
      expect(after.kind).toBe("playing");
      expect(after.lastConsumedIntent).toBeNull();
    });

    it("set_intent_pending is last-write-wins (two startFrom clicks overwrite)", () => {
      let p = ph("playing");
      p = reducePhase(p, { type: "set_intent_pending", intent: "userManual" });
      p = reducePhase(p, { type: "set_intent_pending", intent: "userZeroSeek" });
      expect(p.lastConsumedIntent).toBe("userZeroSeek");
    });

    it("start_load PRESERVES lastConsumedIntent (consumed only by consume_intent or process_gone)", () => {
      // The launch carries the intent on `launching.intent`, but
      // `lastConsumedIntent` ALSO persists so the init effect's
      // post-launch consume guards can detect "a startFrom-initiated
      // launch just happened, skip my own loadStream". Consumed by
      // `consume_intent` (init-effect guards) or `process_gone` (mpv died).
      const p: PlaybackPhase = {
        ...ph("idle"),
        lastConsumedIntent: "userZeroSeek",
      };
      const after = reducePhase(p, {
        type: "start_load",
        intent: "userZeroSeek",
      });
      expect(after.kind).toBe("launching");
      expect(after.lastConsumedIntent).toBe("userZeroSeek");
      if (after.kind === "launching") {
        expect(after.intent).toBe("userZeroSeek");
      }
    });

    it("process_gone clears lastConsumedIntent (mpv died — pending intent is stale)", () => {
      const p: PlaybackPhase = {
        ...ph("playing"),
        lastConsumedIntent: "userManual",
      };
      const after = reducePhase(p, { type: "process_gone" });
      expect(after.lastConsumedIntent).toBeNull();
    });

    it("named trace: zero-seek startFrom on dead mpv — lastConsumedIntent persists through launch, init effect post-launch consumes it", () => {
      // Mirrors the engine's startFrom zero-seek path:
      //   1. startFrom sets refs + dispatches set_intent_pending
      //   2. pauseForChange → loadStream → dispatch start_load (preserves
      //      lastConsumedIntent so the init effect can see it after)
      //   3. Launch completes; phase → playing
      //   4. A dep change re-fires the init effect; consume guard reads
      //      phase.lastConsumedIntent and dispatches consume_intent.
      const path: string[] = [];
      let phase = ph("idle");
      path.push(`init ${formatStep(phase)} consumedIntent=${phase.lastConsumedIntent}`);
      try {
        phase = reducePhase(phase, {
          type: "set_intent_pending",
          intent: "userZeroSeek",
        });
        path.push(
          `set_intent_pending → ${formatStep(phase)} consumedIntent=${phase.lastConsumedIntent}`,
        );
        expect(phase.lastConsumedIntent).toBe("userZeroSeek");

        phase = reducePhase(phase, { type: "start_load", intent: "userZeroSeek" });
        path.push(
          `start_load → ${formatStep(phase)} consumedIntent=${phase.lastConsumedIntent}`,
        );
        expect(phase.kind).toBe("launching");
        expect(
          phase.lastConsumedIntent,
          "PRESERVED so post-launch init effect can detect user-initiated launch",
        ).toBe("userZeroSeek");
        if (phase.kind === "launching") {
          expect(phase.intent).toBe("userZeroSeek");
        }

        phase = reducePhase(phase, { type: "stream_loadfile_done" });
        path.push(
          `stream_loadfile_done → ${formatStep(phase)} consumedIntent=${phase.lastConsumedIntent}`,
        );
        expect(phase.kind).toBe("playing");
        expect(phase.lastConsumedIntent).toBe("userZeroSeek"); // still preserved

        phase = reducePhase(phase, { type: "load_settled" });
        path.push(
          `load_settled → ${formatStep(phase)} consumedIntent=${phase.lastConsumedIntent}`,
        );
        expect(phase.kind).toBe("playing");
        expect(phase.lastConsumedIntent).toBe("userZeroSeek"); // still preserved

        // Init effect re-fires from dep change; consume guard fires.
        phase = reducePhase(phase, { type: "consume_intent" });
        path.push(
          `consume_intent → ${formatStep(phase)} consumedIntent=${phase.lastConsumedIntent}`,
        );
        expect(phase.lastConsumedIntent).toBeNull();
        expect(phase.kind).toBe("playing");
      } catch (err) {
        dumpPlaybackPhaseSnapshot("zero-seek-intent-persist", { phase }, { path });
        throw err;
      }
    });

    it("named trace: process_gone (mpv died mid-pending) clears stale intent", () => {
      let phase = ph("idle");
      phase = reducePhase(phase, {
        type: "set_intent_pending",
        intent: "userZeroSeek",
      });
      phase = reducePhase(phase, { type: "process_gone" });
      expect(phase.kind).toBe("idle");
      expect(phase.lastConsumedIntent).toBeNull();
    });

    // PR 3.2c-2 named regression traces — the 4 early-return branches in
    // the init effect dispatch `cancel_load` to roll phase back instead of
    // leaving it stuck in `launching` forever (no loadStream call → no
    // subsequent stream_loadfile_done / load_settled to advance).
    it("named trace: init-effect smokeTest early-return — start_load + cancel_load round-trips to idle", () => {
      let phase = ph("idle");
      phase = reducePhase(phase, { type: "start_load", intent: "auto" });
      expect(phase.kind).toBe("launching");
      phase = reducePhase(phase, { type: "cancel_load" });
      expect(phase.kind).toBe("idle");
    });

    it("named trace: init-effect deferPlayback early-return preserves lastConsumedIntent", () => {
      let phase = ph("idle");
      phase = reducePhase(phase, {
        type: "set_intent_pending",
        intent: "userZeroSeek",
      });
      phase = reducePhase(phase, { type: "start_load", intent: "userZeroSeek" });
      expect(phase.lastConsumedIntent).toBe("userZeroSeek");
      phase = reducePhase(phase, { type: "cancel_load" });
      expect(phase.kind).toBe("idle");
      expect(
        phase.lastConsumedIntent,
        "intent preserved — next launch will still see it",
      ).toBe("userZeroSeek");
    });

    it("named trace: pendingIntent-consume — start_load + cancel_load + consume_intent → idle with null intent", () => {
      let phase = ph("idle");
      phase = reducePhase(phase, {
        type: "set_intent_pending",
        intent: "userManual",
      });
      phase = reducePhase(phase, { type: "start_load", intent: "userManual" });
      expect(phase.kind).toBe("launching");
      expect(phase.lastConsumedIntent).toBe("userManual");
      phase = reducePhase(phase, { type: "cancel_load" });
      expect(phase.kind).toBe("idle");
      expect(phase.lastConsumedIntent).toBe("userManual");
      phase = reducePhase(phase, { type: "consume_intent" });
      expect(phase.kind).toBe("idle");
      expect(phase.lastConsumedIntent).toBeNull();
    });

    it("named trace: alive-mpv init-effect re-fire from playing — start_load + cancel_load returns to playing without phantom reload", () => {
      let phase: PlaybackPhase = { ...initialPhase, kind: "playing", gen: 5 };
      // dep change triggers init-effect; phase advances to reloading.
      phase = reducePhase(phase, { type: "start_load", intent: "auto" });
      expect(phase).toMatchObject({
        kind: "reloading",
        gen: 6,
        streamLoaded: false,
      });
      // init effect hits an early-return (e.g. lastLaunchedKey matches);
      // cancel_load rolls back to playing.
      phase = reducePhase(phase, { type: "cancel_load" });
      expect(phase).toMatchObject({ kind: "playing", gen: 6 });
    });
  });

  // -------------------------------------------------------------------------
  // gen / generation invariants
  // -------------------------------------------------------------------------

  describe("gen invariants", () => {
    it("each start_load increments gen across the cycle", () => {
      const path: string[] = [];
      let state = reducePhase(initialPhase, startLoad("auto"));
      path.push(`start_load → ${formatStep(state)}`);
      try {
        expect(state).toMatchObject({ kind: "launching", gen: 1 });
        state = reducePhase(state, { type: "stream_loadfile_done" });
        path.push(`stream_loadfile_done → ${formatStep(state)}`);
        expect(state).toMatchObject({ kind: "playing", gen: 1 });
        state = reducePhase(state, startLoad("auto"));
        path.push(`start_load → ${formatStep(state)}`);
        expect(state).toMatchObject({
          kind: "reloading",
          gen: 2,
          streamLoaded: false,
        });
        state = reducePhase(state, { type: "stream_loadfile_done" });
        path.push(`stream_loadfile_done → ${formatStep(state)}`);
        state = reducePhase(state, { type: "load_settled" });
        path.push(`load_settled → ${formatStep(state)}`);
        expect(state).toMatchObject({ kind: "playing", gen: 2 });
      } catch (err) {
        dumpPlaybackPhaseSnapshot("gen-increment-cycle", { state }, { path });
        throw err;
      }
    });

    it("process_gone resets to idle (idle has no gen field)", () => {
      const p: PlaybackPhase = { ...initialPhase, kind: "playing", gen: 99 };
      const after = reducePhase(p, { type: "process_gone" });
      expect(after.kind).toBe("idle");
      expect("gen" in after).toBe(false);
    });

    it("relaunch from launching bumps gen (start_load fresh) even though engine bails", () => {
      // start_load arrived defensively while a launch was in flight. Engine's
      // launchInProgressRef latch should have bailed, but if dispatch fired,
      // the phase should advance to the new gen so the reducer's truth table
      // stays consistent.
      const launching: PlaybackPhase = {
        ...initialPhase,
        kind: "launching",
        gen: 5,
        intent: "auto",
      };
      const after = reducePhase(launching, startLoad("auto"));
      expect(after).toMatchObject({ kind: "launching", gen: 6 });
    });
  });
});
