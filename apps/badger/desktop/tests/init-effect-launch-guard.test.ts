import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * @bugfix @regression-proof
 *
 * Regression test for commit 9a83087a — init-effect launch guard.
 *
 * The init useEffect runs whenever its dep tuple changes (fileId,
 * audioMapSignature, effectiveFormatSignature, ...). During a launch
 * the runtime SSE snapshot push, the optimistic media-details update,
 * and StrictMode's double-fire can each independently churn one of
 * those deps. Pre-fix the effect entered `init()` even while a launch
 * was in flight: launchInProgressRef caught the SECOND `loadStream`
 * call but NOT the init() side effects (setBufferingImmediate,
 * setPlayerSession bump, etc.) which ran in parallel and queued
 * additional re-fires. Manifested as a 3-segment-loop on first play.
 *
 * Fix: the init effect's FIRST statement (after the basic open/file
 * gate) is `if (isLoadInFlight(phaseRef.current)) return;`
 *
 * History: from 9a83087a through 3.1c the guard read both
 * launchInProgressRef and initEffectInFlightRef directly. PR 3.2c-1
 * (post-shadow-mode zero-divergence verification) flipped the reader to
 * the phase-derived `isLoadInFlight` predicate from
 * `@space/desktop-mpv-playback`. Flag writes remain until PR 3.2c-3
 * (full deletion).
 *
 * This test pins:
 *  1. The guard sits at the top of the init effect, BEFORE any
 *     side-effecting call (setBufferingImmediate, setPlayerSession, etc.).
 *  2. The guard reads `isLoadInFlight(phaseRef.current)` (the phase
 *     predicate — single source of truth for in-flight state).
 *  3. Semantic: the guard short-circuits the body without invoking
 *     the init function.
 */

const ENGINE_PATH = resolve(
  process.cwd(),
  "src/renderer/src/lib/useMpvPlaybackEngine.ts",
);
const engineSource = readFileSync(ENGINE_PATH, "utf8");

describe("@bugfix @regression-proof init effect launch guard", () => {
  it("guard reads isLoadInFlight(phaseRef.current) and early-returns", () => {
    // Issue #25 (c035): the guard now goes through decideInitEntry, which
    // returns "skip-load-in-flight" or "defer-switch-until-settled" (never
    // "proceed") while a load is in flight — the init body still returns
    // before any side effect; a pending format switch is queued, not lost.
    expect(engineSource).toMatch(
      /loadInFlight: isLoadInFlight\(phaseRef\.current\)[\s\S]{0,600}?if \(entryDecision !== "proceed"\) \{[\s\S]{0,2000}?return;\s*\}/,
    );
  });

  it("the guard appears BEFORE setBufferingImmediate / setPlayerSession side effects in init()", () => {
    // The init useEffect's body must structure as:
    //   if (!open || ...) return;   // dep precondition
    //   if (isLoadInFlight(phaseRef.current)) return;
    //   ... (post-launch key check) ...
    //   initEffectInFlightRef.current = true;
    //   const init = async () => { ... setBufferingImmediate(!smokeTest); ... };
    //   void init();
    //
    // The guard ('init effect: skip (load already in flight)' log)
    // must be ABOVE the setBufferingImmediate(true) call inside init().
    const skipLogIdx = engineSource.indexOf("init effect: skip (load already in flight)");
    const setPlayerSessionIdx = engineSource.indexOf("setPlayerSession((value) => value + 1);");
    expect(skipLogIdx).toBeGreaterThan(-1);
    expect(setPlayerSessionIdx).toBeGreaterThan(-1);
    expect(skipLogIdx).toBeLessThan(setPlayerSessionIdx);
  });

  it("PR 3.2c-2/3: start_load dispatch fires SYNCHRONOUSLY before init() runs (closes pre-loadStream-window race)", () => {
    // Post-3.2c-3, the initEffectInFlightRef latch is gone. The new
    // synchronous gate is the `start_load` dispatch at the init-effect
    // top — it advances phase to `launching` BEFORE any await, so
    // subsequent dep-change re-fires read `isLoadInFlight(phase) === true`
    // at the top guard and short-circuit.
    const startLoadIdx = engineSource.indexOf(
      'dispatchPhase({\n      type: "start_load"',
    );
    const initInvokeIdx = engineSource.indexOf("void init()");
    expect(
      startLoadIdx,
      "start_load dispatch must exist at the init-effect top",
    ).toBeGreaterThan(-1);
    expect(initInvokeIdx).toBeGreaterThan(-1);
    expect(
      startLoadIdx,
      "start_load dispatch must precede void init()",
    ).toBeLessThan(initInvokeIdx);
  });

  it("PR 3.2c-2: each early-return branch in init() dispatches cancel_load before its return", () => {
    // The 4 early-return branches (smokeTest, deferPlayback, cancelled,
    // blockAutoPlay-with-startTime, pendingIntent-consume) must dispatch
    // cancel_load so phase rolls back instead of stuck in `launching`
    // forever (no loadStream call → no load_settled / load_failed to
    // advance).
    const cancelLoadMatches =
      engineSource.match(/dispatchPhase\(\s*\{\s*type:\s*"cancel_load"/g) ?? [];
    // We expect AT LEAST 5 cancel_load dispatches (smokeTest, deferPlayback,
    // cancelled, blockAutoPlay, pendingIntent-consume).
    expect(
      cancelLoadMatches.length,
      "each early-return branch must dispatch cancel_load",
    ).toBeGreaterThanOrEqual(5);
  });

  it("PR 3.2c-3: launchInProgressRef + initEffectInFlightRef are FULLY GONE from the engine (code-level)", () => {
    // The two latch refs and all their writes were deleted in PR 3.2c-3.
    // Comments may still reference the names historically; only code-level
    // declarations and assignments are forbidden.
    expect(engineSource).not.toContain(
      "const launchInProgressRef = useRef(false);",
    );
    expect(engineSource).not.toContain(
      "const initEffectInFlightRef = useRef(false);",
    );
    expect(engineSource).not.toMatch(
      /launchInProgressRef\.current\s*=\s*(true|false);/,
    );
    expect(engineSource).not.toMatch(
      /initEffectInFlightRef\.current\s*=\s*(true|false);/,
    );
    // Reads were also deleted. Refuse any `.current` access (RHS reads).
    expect(engineSource).not.toMatch(/launchInProgressRef\.current[^=]/);
    expect(engineSource).not.toMatch(/initEffectInFlightRef\.current[^=]/);
  });

  it("semantic: a guard-shaped effect with phase=launching skips init body (post-3.2c-1)", () => {
    // Local-clone test of the production idiom: an effect runs but the
    // phase-derived isLoadInFlight predicate is true so the body no-ops.
    // After PR 3.2c-1 the guard is `if (isLoadInFlight(phaseRef.current)) return;`.
    // Imported lazily so the test doesn't depend on the (already-tested)
    // reducer transition table — just on the predicate semantics.
    type Phase = { kind: "idle" | "launching" | "backdropHandoff" | "playing" | "reloading" | "stopping"; streamLoaded?: boolean };
    const phase: Phase = { kind: "launching" };
    const isLoadInFlight = (p: Phase): boolean =>
      p.kind === "launching" ||
      p.kind === "backdropHandoff" ||
      (p.kind === "reloading" && !p.streamLoaded);
    let initBodyRan = 0;
    const runInitEffect = () => {
      if (isLoadInFlight(phase)) return;
      initBodyRan += 1;
    };
    runInitEffect();
    expect(initBodyRan).toBe(0);

    // Once the launch completes (phase advances to playing), the effect's
    // NEXT run executes.
    phase.kind = "playing";
    runInitEffect();
    expect(initBodyRan).toBe(1);

    // While a reload is in flight (streamLoaded:false), another fire is
    // also blocked.
    phase.kind = "reloading";
    phase.streamLoaded = false;
    runInitEffect();
    expect(initBodyRan).toBe(1);

    // Once the reload's stream loadfile is done (streamLoaded:true), the
    // gate opens again.
    phase.streamLoaded = true;
    runInitEffect();
    expect(initBodyRan).toBe(2);
  });
});
