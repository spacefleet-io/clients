import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * @bugfix @regression-proof
 *
 * Regression test for the backdrop-handoff rewire — `signalPlaybackReady`
 * fires IMMEDIATELY after `launchExternalMpv` returns in the backdrop
 * branch, not after the full ready-gate. This is the load-bearing
 * change that closes the window-hide delay: mpv is up displaying the
 * still backdrop image within ~200 ms of the launch IPC, so the
 * Electron window can hide right then.
 *
 * The direct-launch (no-backdrop) path retains the previous shape:
 * signalPlaybackReady fires only AFTER tracks-stable + vo-configured
 * + metadata applied. Both paths exist; the backdrop path comes first
 * in code order so we assert relative positioning.
 *
 * This test pins:
 *  1. The backdrop signalPlaybackReady call is immediately after the
 *     launchExternalMpv IPC and BEFORE the metadata payload phase.
 *  2. The direct-launch signalPlaybackReady call still exists AND
 *     fires AFTER the metadata phase (preserved for the no-backdrop
 *     fallback).
 *  3. The backdrop call is guarded by `useBackdropHandoff &&
 *     isExternalActive(lifecycleRef.current)` — it must not fire if
 *     the launch branch never chose backdrop mode, AND it must not
 *     fire if mpv died between the IPC return and the await.
 */

const ENGINE_PATH = resolve(
  process.cwd(),
  "src/renderer/src/lib/useMpvPlaybackEngine.ts",
);
console.info(`[signal-playback-ready-immediate:setup] reading engine source from ${ENGINE_PATH}`);
const engineSource = readFileSync(ENGINE_PATH, "utf8");
console.info(
  `[signal-playback-ready-immediate:setup] engine source loaded, length=${engineSource.length} chars, signalPlaybackReady occurrences=${(engineSource.match(/signalPlaybackReady/g) ?? []).length}`,
);

// On assertion failure, dump the load-bearing index positions + the matched
// backdrop fragment so a structural drift in useMpvPlaybackEngine.ts is
// diagnosable from CI logs without re-reading the source by hand.
const dumpSignalReadySnapshot = (label: string, extra?: Record<string, unknown>) => {
  try {
    const backdropGuardIdx = engineSource.indexOf(
      "if (useBackdropHandoff && isExternalActive(lifecycleRef.current))",
    );
    const backdropIpcIdx = engineSource.indexOf(
      "signalPlaybackReady IPC complete (backdrop) — window hide",
    );
    const swapBlockIdx = engineSource.indexOf("backdrop->stream loadfile swap dispatched");
    const directIpcIdx = engineSource.indexOf('signalPlaybackReady IPC complete"');
    const signalCount = (engineSource.match(/signalPlaybackReady/g) ?? []).length;
    console.error(`=== [signal-playback-ready-immediate:${label}] snapshot ===`);
    console.error(
      `index positions: backdropGuard=${backdropGuardIdx} backdropIpc=${backdropIpcIdx} swapBlock=${swapBlockIdx} directIpc=${directIpcIdx}`,
    );
    console.error(`signalPlaybackReady occurrence count=${signalCount}`);
    if (extra) console.error(`extra: ${JSON.stringify(extra, null, 2)}`);
    console.error(`=== [signal-playback-ready-immediate:${label}] end ===`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("@bugfix @regression-proof signalPlaybackReady fires immediately in backdrop branch", () => {
  it("backdrop signalPlaybackReady call is guarded by useBackdropHandoff && isExternalActive", () => {
    // The early-fire guard MUST gate on useBackdropHandoff so the
    // direct path doesn't double-call signalPlaybackReady, AND on
    // isExternalActive so a dead mpv mid-IPC doesn't trigger a hide
    // when the user can still see the renderer.
    console.info("[signal-playback-ready-immediate:guard] asserting backdrop guard precedes signalPlaybackReady");
    const guardRe =
      /if \(useBackdropHandoff && isExternalActive\(lifecycleRef\.current\)\)[\s\S]{0,400}?signalPlaybackReady/;
    if (!guardRe.test(engineSource)) {
      dumpSignalReadySnapshot("guard-no-match", { pattern: String(guardRe) });
    }
    expect(engineSource).toMatch(guardRe);
  });

  it("backdrop signalPlaybackReady is followed by a 'backdrop' log + dispatchPhase backdrop_shown", () => {
    // Pin the structure: try { await sf.signalPlaybackReady; log({...,
    // handoffPhase: "backdrop"}, "...window hide"); } catch { warn }
    // dispatchPhase({ type: "backdrop_shown" }) — atomic with window hide.
    // PR 3.2e: previously this followed setIsReadyToReveal(true); the
    // setIsReadyToReveal call is gone (replaced by the phase reducer's
    // deriveIsReadyToReveal(backdropHandoff) === true).
    expect(engineSource).toMatch(
      /signalPlaybackReady IPC complete \(backdrop\) — window hide/,
    );
    expect(engineSource).toMatch(
      /handoffPhase:\s*["']backdrop["']/,
    );
    // The backdrop_shown dispatch follows the IPC await in this branch.
    console.info("[signal-playback-ready-immediate:backdrop-shown] asserting backdrop log + handoffPhase + backdrop_shown dispatch");
    const backdropFragment = engineSource.match(
      /if \(useBackdropHandoff && isExternalActive\(lifecycleRef\.current\)\)[\s\S]{0,2000}?dispatchPhase\(\s*\{\s*type:\s*"backdrop_shown"/,
    );
    if (!backdropFragment) {
      dumpSignalReadySnapshot("backdrop-fragment-no-match");
    } else if (backdropFragment[0].includes("setIsReadyToReveal")) {
      dumpSignalReadySnapshot("backdrop-fragment-has-legacy-setIsReadyToReveal", {
        fragmentLength: backdropFragment[0].length,
      });
    }
    expect(
      backdropFragment,
      "backdrop fragment must include dispatchPhase backdrop_shown",
    ).toBeTruthy();
    // Defensive: the legacy setIsReadyToReveal call must be GONE from this
    // branch (deletion is the load-bearing change in PR 3.2e).
    expect(backdropFragment?.[0] ?? "").not.toContain("setIsReadyToReveal");
  });

  it("direct-launch signalPlaybackReady survives (fallback path preserved)", () => {
    // The non-backdrop path's signalPlaybackReady call lives AFTER the
    // ready-gate (metadata + tracks-stable + vo-configured). Verify
    // both signalPlaybackReady calls coexist — at least 2 occurrences.
    const matches = engineSource.match(/signalPlaybackReady/g) ?? [];
    console.info(`[signal-playback-ready-immediate:fallback] signalPlaybackReady occurrence count=${matches.length} (expected >= 2)`);
    if (matches.length < 2) {
      dumpSignalReadySnapshot("fallback-too-few-signal-calls", { count: matches.length });
    }
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("the backdrop call is positioned BEFORE the metadata + tracks-stable + vo-configured chain", () => {
    // Code order (post-3.2e): launchExternalMpv → setBufferingImmediate(true) →
    // IF backdrop: signalPlaybackReady + dispatchPhase backdrop_shown;
    // THEN (later) the swap loadfile + tracks-stable + vo-configured.
    //
    // We pin: the backdrop signalPlaybackReady occurs BEFORE the
    // `useBackdropHandoff` swap-loadfile block AND before the direct
    // signalPlaybackReady.
    const backdropIpcIdx = engineSource.indexOf(
      "signalPlaybackReady IPC complete (backdrop) — window hide",
    );
    const swapBlockIdx = engineSource.indexOf("backdrop->stream loadfile swap dispatched");
    const directIpcIdx = engineSource.indexOf(
      "signalPlaybackReady IPC complete\"",
    );
    console.info(
      `[signal-playback-ready-immediate:ordering] backdropIpcIdx=${backdropIpcIdx} swapBlockIdx=${swapBlockIdx} directIpcIdx=${directIpcIdx}`,
    );
    if (
      backdropIpcIdx < 0 ||
      swapBlockIdx < 0 ||
      directIpcIdx < 0 ||
      backdropIpcIdx >= swapBlockIdx ||
      backdropIpcIdx >= directIpcIdx
    ) {
      dumpSignalReadySnapshot("ordering-violation", {
        backdropIpcIdx,
        swapBlockIdx,
        directIpcIdx,
      });
    }
    expect(backdropIpcIdx).toBeGreaterThan(-1);
    expect(swapBlockIdx).toBeGreaterThan(-1);
    expect(directIpcIdx).toBeGreaterThan(-1);
    expect(backdropIpcIdx).toBeLessThan(swapBlockIdx);
    expect(backdropIpcIdx).toBeLessThan(directIpcIdx);
  });
});
