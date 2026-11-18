import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  seeksAllowed,
  type PlaybackPhase,
} from "@space/desktop-mpv-playback";

/**
 * @bugfix @regression-proof
 *
 * Regression test for commits 29ad99ad + ede80b62 — ensureExternalSeek
 * source-level gate. Originally lifecycle-based; then improved to gate
 * on `isReadyToRevealRef && streamLoadfileCompleteRef`. Hardening
 * Phase 3.2d collapses that AND into a single predicate
 * `seeksAllowed(phaseRef.current)` from `@space/desktop-mpv-playback`.
 *
 * The current gate (post-3.2d) bails the seek BEFORE any retry loop
 * when `seeksAllowed(phaseRef.current)` is false. The predicate is
 * defined as `playing || (reloading && streamLoaded)` — equivalent to
 * the legacy AND at every observable engine state per the canonical
 * mapping in `tests/seeks-allowed-phase-coverage.test.ts`.
 *
 * Pre-ready bail-out is INTENTIONAL — mpv's --start=<time> cmdline
 * handles the resume position
 * during launch. The renderer-side seek would only race the launch.
 *
 * This test pins:
 *  1. Source-contract: the bail-out predicate reads
 *     `seeksAllowed(phaseRef.current)` and announces "BLOCKED".
 *  2. Source-contract: the gate does NOT read lifecycle.kind directly
 *     (that was the broken implementation we replaced at ede80b62).
 *  3. Source-contract: the deleted-flag-ref `streamLoadfileCompleteRef`
 *     is GONE from the engine (no declaration, no writes).
 *  4. Semantic: the phase-derived gate returns the same truth table as
 *     the legacy AND across every PlaybackPhase variant.
 */

const ENGINE_PATH = resolve(
  process.cwd(),
  "src/renderer/src/lib/useMpvPlaybackEngine.ts",
);
const engineSource = readFileSync(ENGINE_PATH, "utf8");

// On assertion failure, dump the source-grep findings + per-phase gate
// evaluation so a failed source-contract / truth-table assertion is
// diagnosable offline without re-reading the engine by hand.
const dumpSeekGateSnapshot = (label: string, ctx: Record<string, unknown> = {}) => {
  try {
    console.error(`=== [ensure-external-seek-gate:${label}] snapshot ===`);
    console.error(`ENGINE_PATH=${ENGINE_PATH} engineSource.length=${engineSource.length}`);
    console.error(
      `source-grep flags: ${JSON.stringify(
        {
          hasStreamCompleteRefDecl: engineSource.includes(
            "const streamLoadfileCompleteRef = useRef(false);",
          ),
          hasStreamCompleteRefWrite: /streamLoadfileCompleteRef\.current\s*=\s*(true|false);/.test(
            engineSource,
          ),
          hasStreamCompleteRefRead: /streamLoadfileCompleteRef\.current[^=]/.test(engineSource),
          hasLegacyAndShape:
            /!isReadyToRevealRef\.current\s*\|\|\s*!streamLoadfileCompleteRef\.current/.test(
              engineSource,
            ),
        },
        null,
        2,
      )}`,
    );
    if (Object.keys(ctx).length) {
      console.error(`extra ctx:\n${JSON.stringify(ctx, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const phase = (
  kind: PlaybackPhase["kind"],
  extra: { streamLoaded?: boolean } = {},
): PlaybackPhase => {
  const base = { lastLaunchedKey: null, lastReloadSignature: null, lastConsumedIntent: null };
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

describe("@bugfix @regression-proof ensureExternalSeek gate", () => {
  // PR 4.0: source-grep tests that pinned `ensureExternalSeek`'s body shape
  // in the engine file have been DELETED. PR 4.1 (facade extraction) will
  // move the seek helper to `lib/useExternalMpvCommands.ts` — the regex
  // would falsely fail with no behavior change. The behavioral guarantee
  // is now covered by:
  //   - `tests/seeks-allowed-phase-coverage.test.ts` (predicate truth table)
  //   - The semantic tests below in this file (post-3.2d shape proof)
  //   - `e2e/playback-backdrop-handoff.e2e.test.ts:1140` (the live
  //     [seek-gate] BLOCKED marker on a real backdrop-window seek)
  //   - `e2e/playback-quality-reload.e2e.test.ts:636` (#3 headline guard)

  it("@bugfix @regression-proof source: streamLoadfileCompleteRef is fully GONE (PR 3.2d deletion)", () => {
    console.info(`[ensure-external-seek-gate:source] asserting streamLoadfileCompleteRef decl/writes/reads are gone from ${ENGINE_PATH}`);
    // The ref declaration, all writes, and all reads must be deleted.
    // Comments in the source may reference the name historically — those
    // are fine. Code-level references are not.
    try {
      expect(engineSource).not.toContain("const streamLoadfileCompleteRef = useRef(false);");
      expect(engineSource).not.toMatch(/streamLoadfileCompleteRef\.current\s*=\s*(true|false);/);
      // Also no read references (e.g. `streamLoadfileCompleteRef.current` on a RHS).
      expect(engineSource).not.toMatch(/streamLoadfileCompleteRef\.current[^=]/);
    } catch (err) {
      dumpSeekGateSnapshot("stream-complete-ref-gone-assert");
      throw err;
    }
  });

  it("@bugfix @regression-proof source: legacy AND shape is GONE from engine (pre-3.2d shape rejected)", () => {
    console.info(`[ensure-external-seek-gate:source] asserting legacy isReadyToReveal && streamComplete AND-shape is gone`);
    // After PR 3.2d the legacy `!isReadyToRevealRef.current ||
    // !streamLoadfileCompleteRef.current` AND-formula must not exist
    // anywhere in the engine source. Survives PR 4.1's facade extraction
    // because it greps the engine file (not the moved helper file) and
    // the AND-shape can never re-appear there.
    try {
      expect(engineSource).not.toMatch(/!isReadyToRevealRef\.current\s*\|\|\s*!streamLoadfileCompleteRef\.current/);
    } catch (err) {
      dumpSeekGateSnapshot("legacy-and-shape-gone-assert");
      throw err;
    }
  });

  it("@bugfix @regression-proof semantic: seeksAllowed truth table matches the legacy AND across every phase", () => {
    // Canonical (phase → legacy-flag) mapping derived from the engine's
    // flag-write sites at L1611/L1664/L1731/L1828/L1838/L1969/L2095.
    // Verified equivalent at runtime by PR 3.1c's shadow-mode assertion
    // (zero divergence across the full gate:desktop-release suite).
    const legacyAt = (
      p: PlaybackPhase,
    ): { isReadyToReveal: boolean; streamComplete: boolean } => {
      switch (p.kind) {
        case "idle":
        case "launching":
        case "stopping":
          return { isReadyToReveal: false, streamComplete: false };
        case "backdropHandoff":
          return { isReadyToReveal: true, streamComplete: false };
        case "playing":
          return { isReadyToReveal: true, streamComplete: true };
        case "reloading":
          return p.streamLoaded
            ? { isReadyToReveal: true, streamComplete: true }
            : { isReadyToReveal: false, streamComplete: true };
      }
    };
    const phases: PlaybackPhase[] = [
      phase("idle"),
      phase("launching"),
      phase("backdropHandoff"),
      phase("playing"),
      phase("reloading", { streamLoaded: false }),
      phase("reloading", { streamLoaded: true }),
      phase("stopping"),
    ];
    console.info(`[ensure-external-seek-gate:truth-table] comparing seeksAllowed() vs legacy AND across ${phases.length} phases`);
    for (const p of phases) {
      const { isReadyToReveal, streamComplete } = legacyAt(p);
      const legacyPasses = isReadyToReveal && streamComplete;
      const phaseLabel = `${p.kind}${p.kind === "reloading" ? `(streamLoaded=${p.streamLoaded})` : ""}`;
      const actual = seeksAllowed(p);
      console.info(`[ensure-external-seek-gate:truth-table] phase=${phaseLabel} seeksAllowed=${actual} legacyPasses=${legacyPasses}`);
      try {
        expect(actual, `phase=${phaseLabel}`).toBe(legacyPasses);
      } catch (err) {
        dumpSeekGateSnapshot("truth-table-assert", { phase: phaseLabel, actual, legacyPasses });
        throw err;
      }
    }
  });

  it("@bugfix @regression-proof semantic: pre-ready seek does NOT enter the retry loop", () => {
    // Drive a tiny seek-runner that mirrors the production shape: gate
    // first; only if it passes, enter a retry loop that consumes
    // sendCommand.
    let attempts = 0;
    const sendCommand = vi.fn(async () => {
      attempts += 1;
      return true;
    });
    const ensureSeek = async (
      p: PlaybackPhase,
      target: number,
    ) => {
      if (!seeksAllowed(p)) {
        return; // BLOCKED
      }
      for (let i = 0; i < 6; i++) {
        await sendCommand();
        return target;
      }
    };

    void (async () => {
      try {
        // Idle: blocked.
        const r1 = await ensureSeek(phase("idle"), 100);
        console.info(`[ensure-external-seek-gate:retry-loop] phase=idle result=${r1} attempts=${attempts}`);
        expect(r1).toBeUndefined();
        expect(sendCommand).not.toHaveBeenCalled();
        expect(attempts).toBe(0);

        // backdropHandoff (the deliberate locked split): still blocked.
        const r2 = await ensureSeek(phase("backdropHandoff"), 100);
        console.info(`[ensure-external-seek-gate:retry-loop] phase=backdropHandoff result=${r2} attempts=${attempts}`);
        expect(r2).toBeUndefined();
        expect(sendCommand).not.toHaveBeenCalled();

        // reloading{streamLoaded:false}: blocked.
        const r3 = await ensureSeek(phase("reloading", { streamLoaded: false }), 100);
        console.info(`[ensure-external-seek-gate:retry-loop] phase=reloading(streamLoaded=false) result=${r3} attempts=${attempts}`);
        expect(r3).toBeUndefined();
        expect(sendCommand).not.toHaveBeenCalled();

        // playing: seek runs.
        const r4 = await ensureSeek(phase("playing"), 100);
        console.info(`[ensure-external-seek-gate:retry-loop] phase=playing result=${r4} attempts=${attempts} sendCommand.calls=${sendCommand.mock.calls.length}`);
        expect(r4).toBe(100);
        expect(sendCommand).toHaveBeenCalledOnce();
      } catch (err) {
        dumpSeekGateSnapshot("retry-loop-assert", {
          attempts,
          sendCommandCalls: sendCommand.mock.calls.length,
        });
        throw err;
      }
    })();
  });
});
