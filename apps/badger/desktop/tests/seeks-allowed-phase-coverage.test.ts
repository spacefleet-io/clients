/**
 * @bugfix @regression-proof seeks-allowed phase-predicate coverage
 *
 * Pins the seek-gate semantic before/after PR 3.2d replaces the legacy
 * `isReadyToRevealRef.current && streamLoadfileCompleteRef.current` AND
 * at `useMpvPlaybackEngine.ts:603` with `seeksAllowed(phaseRef.current)`.
 *
 * Phase 3.1's gate:desktop-release run confirmed ZERO
 * `[playbackPhase-equiv]` divergence across 160 E2E + 18 integration +
 * 1103 unit paths — empirical proof that the two expressions are
 * equivalent at the gate site. This test pins the equivalence as a
 * mechanical, fast-feedback unit assertion so PR 3.2d's flag deletion
 * cannot silently regress the truth table.
 *
 * The deliberate locked split (the #1/#3 cure) is explicitly tested:
 * `backdropHandoff` is the ONLY phase where `isReadyToReveal === true`
 * but `streamLoadfileComplete === false` — and `seeksAllowed` correctly
 * returns FALSE there. That's the bug window from the #1 early-seek-
 * jumps-to-0 and #3 quality-reload-restart glitches, now structural.
 *
 * The legacy formula uses the SNAPSHOT of `streamLoadfileCompleteRef`
 * at the seek-gate read time. `streamLoadfileCompleteRef` is sticky-true
 * across alive-mpv reloads (engine never resets it between L1969 of one
 * launch and L1838 of the next reload — only the launch-catch at L1898
 * and teardown at L2160 reset it false). The mapping below reflects
 * that engine behavior: reloading{streamLoaded:false} maps to
 * `streamLoadfileComplete=true` (carry-over from prior playing state)
 * combined with `isReadyToReveal=false` (set at L1838 of the reload
 * branch). The AND evaluates to FALSE, matching `seeksAllowed`.
 */

import { describe, expect, it } from "vitest";

import {
  seeksAllowed,
  type PlaybackPhase,
} from "@space/desktop-mpv-playback";

type LegacyFlags = {
  isReadyToReveal: boolean;
  streamLoadfileComplete: boolean;
};

const ph = (
  kind: PlaybackPhase["kind"],
  extra: { streamLoaded?: boolean } = {},
): PlaybackPhase => {
  const base = {
    lastLaunchedKey: null,
    lastReloadSignature: null,
    lastConsumedIntent: null,
  };
  switch (kind) {
    case "idle":
      return { ...base, kind: "idle" };
    case "launching":
      return { ...base, kind: "launching", gen: 1, intent: "auto" };
    case "backdropHandoff":
      return { ...base, kind: "backdropHandoff", gen: 1 };
    case "playing":
      return { ...base, kind: "playing", gen: 1 };
    case "reloading":
      return {
        ...base,
        kind: "reloading",
        gen: 1,
        streamLoaded: extra.streamLoaded ?? false,
      };
    case "stopping":
      return { ...base, kind: "stopping" };
  }
};

/**
 * Engine flag snapshot at the moment phase reaches each kind. Derived
 * from the writes in `useMpvPlaybackEngine.ts`:
 * - L1547/L1640: setIsReadyToReveal(false) — direct launch entry
 * - L1611/L1628: setIsReadyToReveal(true) — backdrop_shown moment
 * - L1664/L1731: streamLoadfileComplete=true — backdrop loadfile done
 * - L1824/L1828: setIsReadyToReveal(true) + streamLoadfileComplete=true — direct path complete
 * - L1838/L1879: setIsReadyToReveal(false) — reload branch entry (streamLoadfileComplete stays sticky-true)
 * - L1964/L1969: setIsReadyToReveal(true) + streamLoadfileComplete=true — reload complete
 * - L2095/L2136: setIsReadyToReveal(false) + streamLoadfileComplete=false — teardown
 */
const legacyAt = (phase: PlaybackPhase): LegacyFlags => {
  switch (phase.kind) {
    case "idle":
      return { isReadyToReveal: false, streamLoadfileComplete: false };
    case "launching":
      return { isReadyToReveal: false, streamLoadfileComplete: false };
    case "backdropHandoff":
      // The deliberate locked split: window-hide already happened
      // (isReadyToReveal=true at L1611) but the new stream's loadfile
      // hasn't completed yet (streamLoadfileComplete still false).
      return { isReadyToReveal: true, streamLoadfileComplete: false };
    case "playing":
      return { isReadyToReveal: true, streamLoadfileComplete: true };
    case "reloading":
      if (phase.streamLoaded) {
        // Reload's stream_loadfile_done dispatched (engine L1964/L1969):
        // both flags true.
        return { isReadyToReveal: true, streamLoadfileComplete: true };
      }
      // Reload entry window: engine set isReadyToReveal=false at L1838;
      // streamLoadfileComplete carries over true from the prior playing
      // state (engine doesn't reset it on reload entry).
      return { isReadyToReveal: false, streamLoadfileComplete: true };
    case "stopping":
      return { isReadyToReveal: false, streamLoadfileComplete: false };
  }
};

// On assertion failure, dump the phase + the legacy flag derivation + the
// computed expectation vs the actual seeksAllowed value. Wrapped in try/catch
// so a dump failure can't mask the real assertion.
const dumpSeeksAllowedSnapshot = (
  label: string,
  phase: PlaybackPhase,
): void => {
  try {
    const legacy = legacyAt(phase);
    const expected = legacy.isReadyToReveal && legacy.streamLoadfileComplete;
    const actual = seeksAllowed(phase);
    const phaseLabel =
      phase.kind === "reloading"
        ? `reloading{streamLoaded=${phase.streamLoaded}}`
        : phase.kind;
    console.error(`=== [seeks-allowed-phase-coverage:${label}] snapshot ===`);
    console.error(`phase=${phaseLabel} raw=${JSON.stringify(phase)}`);
    console.error(
      `legacy flags: isReadyToReveal=${legacy.isReadyToReveal} streamLoadfileComplete=${legacy.streamLoadfileComplete}`,
    );
    console.error(
      `legacy AND (expected)=${expected} seeksAllowed(actual)=${actual} match=${expected === actual}`,
    );
  } catch (err) {
    console.error(
      `(snapshot failed: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
};

describe("@regression-proof seeks-allowed phase-predicate coverage", () => {
  console.info(
    "[seeks-allowed-phase-coverage:setup] building phase fixtures for legacy-vs-seeksAllowed equivalence sweep",
  );
  const phases: PlaybackPhase[] = [
    ph("idle"),
    ph("launching"),
    ph("backdropHandoff"),
    ph("playing"),
    ph("reloading", { streamLoaded: false }),
    ph("reloading", { streamLoaded: true }),
    ph("stopping"),
  ];

  it.each(phases.map((p) => [
    p.kind === "reloading" ? `reloading{streamLoaded=${p.streamLoaded}}` : p.kind,
    p,
  ] as const))(
    "legacy formula `isReadyToReveal && streamLoadfileComplete` === seeksAllowed at phase=%s",
    (label, phase) => {
      console.info(
        `[seeks-allowed-phase-coverage:equiv] checking phase=${label}`,
      );
      const legacy = legacyAt(phase);
      const expected = legacy.isReadyToReveal && legacy.streamLoadfileComplete;
      const actual = seeksAllowed(phase);
      if (actual !== expected) {
        dumpSeeksAllowedSnapshot(`equiv-mismatch-${label}`, phase);
      }
      expect(actual).toBe(expected);
    },
  );

  it("backdropHandoff is the deliberate locked split (#1/#3 bug window)", () => {
    const bh = ph("backdropHandoff");
    console.info(
      "[seeks-allowed-phase-coverage:backdropHandoff] verifying the deliberate locked split blocks seeks",
    );
    if (seeksAllowed(bh) !== false) {
      dumpSeeksAllowedSnapshot("backdropHandoff-unexpected-allow", bh);
    }
    expect(
      legacyAt(bh).isReadyToReveal,
      "window-hide already happened at L1611 backdrop_shown",
    ).toBe(true);
    expect(
      legacyAt(bh).streamLoadfileComplete,
      "stream loadfile not yet done (set at L1731 by stream_loadfile_done)",
    ).toBe(false);
    expect(
      seeksAllowed(bh),
      "seeks BLOCKED in backdropHandoff — the #1/#3 bug fix",
    ).toBe(false);
  });

  it("reloading{streamLoaded:false} is BLOCKED even though streamLoadfileComplete is sticky-true", () => {
    // This is the subtle inverse of backdropHandoff. In reload, the engine
    // sets setIsReadyToReveal(false) at L1838 but DOESN'T reset
    // streamLoadfileComplete (it stays true from the prior launch). The
    // AND short-circuits on isReadyToReveal=false. seeksAllowed must
    // match — and does, because reloading{streamLoaded:false} is excluded
    // from the predicate's two-disjunct definition.
    const r = ph("reloading", { streamLoaded: false });
    console.info(
      "[seeks-allowed-phase-coverage:reloading-sticky] verifying sticky-true streamLoadfileComplete still blocks seeks",
    );
    if (seeksAllowed(r) !== false) {
      dumpSeeksAllowedSnapshot("reloading-streamLoaded-false-unexpected-allow", r);
    }
    expect(legacyAt(r).isReadyToReveal).toBe(false);
    expect(legacyAt(r).streamLoadfileComplete).toBe(true);
    expect(seeksAllowed(r)).toBe(false);
  });

  it("reloading{streamLoaded:true} OPENS the gate when stream_loadfile_done fires (engine L1969)", () => {
    const r = ph("reloading", { streamLoaded: true });
    console.info(
      "[seeks-allowed-phase-coverage:reloading-open] verifying gate opens after stream_loadfile_done",
    );
    if (seeksAllowed(r) !== true) {
      dumpSeeksAllowedSnapshot("reloading-streamLoaded-true-unexpected-block", r);
    }
    expect(legacyAt(r).isReadyToReveal).toBe(true);
    expect(legacyAt(r).streamLoadfileComplete).toBe(true);
    expect(seeksAllowed(r)).toBe(true);
  });

  it("playing is the only OTHER seeks-allowed phase (direct launch's stream_loadfile_done at L1828)", () => {
    const p = ph("playing");
    console.info(
      "[seeks-allowed-phase-coverage:playing] verifying playing phase allows seeks",
    );
    if (seeksAllowed(p) !== true) {
      dumpSeeksAllowedSnapshot("playing-unexpected-block", p);
    }
    expect(legacyAt(p).isReadyToReveal).toBe(true);
    expect(legacyAt(p).streamLoadfileComplete).toBe(true);
    expect(seeksAllowed(p)).toBe(true);
  });

  it("teardown phases (idle / stopping) and launching block seeks", () => {
    for (const k of ["idle", "launching", "stopping"] as const) {
      const phase = ph(k);
      console.info(
        `[seeks-allowed-phase-coverage:teardown] verifying seeks blocked at phase=${k}`,
      );
      if (seeksAllowed(phase) !== false) {
        dumpSeeksAllowedSnapshot(`teardown-${k}-unexpected-allow`, phase);
      }
      expect(seeksAllowed(phase), `seeksAllowed(${k})`).toBe(false);
    }
  });
});
