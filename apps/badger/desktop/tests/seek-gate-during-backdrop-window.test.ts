import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  reducePhase,
  seeksAllowed,
  initialPhase,
  type PlaybackPhase,
} from "@space/desktop-mpv-playback";

/**
 * @bugfix @regression-proof  — CRITICAL
 *
 * Regression test for the seek-gate behaviour during the backdrop
 * handoff window. The backdrop rewire introduces a window between:
 *   T0: mpv launches on the static backdrop image, signalPlaybackReady
 *       fires, the engine dispatches `backdrop_shown` → phase enters
 *       backdropHandoff (window-hide milestone reached).
 *   T1: the swap `loadfile <streamUrl> replace -1 start=<resume>`
 *       completes, tracks-stable + vo-configured arrive, the engine
 *       dispatches `stream_loadfile_done` → phase advances backdropHandoff
 *       → playing (seek gate opens).
 *
 * During [T0, T1] the user sees mpv showing a still backdrop. mpv itself
 * has NO timeline (it's on an image with
 * `--image-display-duration=inf`), so any seek IPC the renderer sends in
 * that window either no-ops or — worse — transitions mpv into a corrupt
 * state where the subsequent `loadfile`'s `start=` per-load option doesn't
 * apply.
 *
 * The gate MUST therefore key on `seeksAllowed(phaseRef.current)` which
 * is `playing || (reloading && streamLoaded)` — explicitly FALSE in
 * `backdropHandoff`. Pre-PR-3.2d the gate was the AND
 * `isReadyToRevealRef.current && streamLoadfileCompleteRef.current`;
 * post-3.2d it's the single phase predicate. The behavioral guarantee
 * is identical: the backdrop window is closed to seeks.
 *
 * If a future refactor "simplifies" the gate to `phase.kind !== "idle"`
 * or any predicate true in `backdropHandoff`, mid-backdrop seeks slip
 * through and the load corruption resurfaces. This test is the
 * early-warning system for that.
 */

const ENGINE_PATH = resolve(
  process.cwd(),
  "src/renderer/src/lib/useMpvPlaybackEngine.ts",
);
const engineSource = readFileSync(ENGINE_PATH, "utf8");

describe("@bugfix @regression-proof seek gate during backdrop window", () => {
  // PR 4.0: the `ensureExternalSeek`-body source-grep assertion that pinned
  // the `seeksAllowed(phaseRef.current)` call inside the helper is DELETED.
  // PR 4.1 (facade extraction) will move the seek helper to
  // `lib/useExternalMpvCommands.ts`, which the regex against engineSource
  // wouldn't find. The behavioral guarantee is preserved by:
  //   - The reducer trace below ("backdropHandoff phase BLOCKS seeks")
  //   - The phase-coverage truth table (`tests/seeks-allowed-phase-coverage.test.ts`)
  //   - Phase 0b backdrop-handoff E2E (`e2e/playback-backdrop-handoff.e2e.test.ts:1140`
  //     asserts the [seek-gate] BLOCKED console marker on a real backdrop-window seek)

  it("@bugfix @regression-proof CRITICAL: stream_loadfile_done dispatch sits AFTER waitForExternalTracksStable + waitForVoConfigured in the backdrop branch", () => {
    // The exact post-swap sequence in the backdrop branch (engine ~L1720-1750):
    //   await sendExternalCommand(buildLoadfileCommand(session.url, "replace", {...}))
    //   ... metadata retry chain ...
    //   await waitForExternalTracksStable();
    //   await waitForVoConfigured(...);
    //   await sendMetadataWithBackoff(...);
    //   dispatchPhase({ type: "stream_loadfile_done" });
    //
    // If a future refactor moves the dispatch BEFORE waitForExternalTracksStable,
    // seeks become allowed while mpv is still demuxing the new stream
    // — the same corruption class as the original bug.
    const backdropSwap = engineSource.match(
      /if \(useBackdropHandoff\)\s*\{[\s\S]*?dispatchPhase\(\s*\{\s*type:\s*"stream_loadfile_done"/,
    )?.[0] ?? "";
    expect(backdropSwap, "backdrop swap block must reach stream_loadfile_done dispatch").toBeTruthy();
    // Required ordering: tracks-stable → vo-configured → dispatch.
    const tracksStableIdx = backdropSwap.indexOf("waitForExternalTracksStable()");
    const voConfiguredIdx = backdropSwap.indexOf("waitForVoConfigured(");
    const dispatchIdx = backdropSwap.indexOf('dispatchPhase({ type: "stream_loadfile_done"');
    expect(tracksStableIdx).toBeGreaterThan(-1);
    expect(voConfiguredIdx).toBeGreaterThan(-1);
    expect(tracksStableIdx).toBeLessThan(voConfiguredIdx);
    expect(voConfiguredIdx).toBeLessThan(dispatchIdx);
  });

  it("@bugfix @regression-proof launch-branch error dispatches load_failed (phase → idle re-arms the gate)", () => {
    // The catch block in the launch branch must dispatch load_failed so
    // a failed launch doesn't leave the next Play click with the gate
    // accidentally open. (Reducer: launching+load_failed → idle, which
    // has seeksAllowed=false.)
    expect(engineSource).toMatch(
      /catch \(error\)\s*\{[\s\S]{0,400}dispatchPhase\(\s*\{\s*type:\s*"load_failed"/,
    );
  });

  it("@bugfix @regression-proof teardown dispatches user_stop (phase → stopping re-arms the gate)", () => {
    // The teardown useEffect dispatches user_stop. The reducer carries
    // it to `stopping` (then `process_gone` from the lifecycle observer
    // brings it to idle). Both states have seeksAllowed=false.
    expect(engineSource).toMatch(
      /shouldTeardown[\s\S]{0,800}dispatchPhase\(\s*\{\s*type:\s*"user_stop"/,
    );
  });

  it("@bugfix @regression-proof CRITICAL: backdropHandoff phase BLOCKS seeks (the deliberate locked split)", () => {
    // The whole point of the phase machine's split: even after the
    // window hides (backdrop_shown dispatched, deriveIsReadyToReveal=true),
    // seeks must not fire until stream_loadfile_done advances the
    // phase to playing.
    let phase: PlaybackPhase = initialPhase;
    phase = reducePhase(phase, { type: "start_load", intent: "auto" });
    expect(phase.kind, "after start_load").toBe("launching");
    expect(seeksAllowed(phase), "launching: seeks blocked").toBe(false);

    phase = reducePhase(phase, { type: "backdrop_shown" });
    expect(phase.kind, "after backdrop_shown").toBe("backdropHandoff");
    // THE DELIBERATE LOCKED SPLIT.
    expect(seeksAllowed(phase), "backdropHandoff: seeks BLOCKED (handoff in progress)").toBe(false);

    phase = reducePhase(phase, { type: "stream_loadfile_done" });
    expect(phase.kind, "after stream_loadfile_done").toBe("playing");
    expect(seeksAllowed(phase), "playing: seeks allowed").toBe(true);
  });

  it("@bugfix @regression-proof BLOCKED log includes phaseKind for postmortem analysis (re-pointed at facade in PR 4.1c)", () => {
    // PR 4.1c: ensureExternalSeek moved from useMpvPlaybackEngine.ts to
    // useExternalMpvCommands.ts (the facade). The phaseKind log field is
    // still load-bearing for postmortem debugging — when a [seek-gate]
    // BLOCKED line shows up in a renderer trace, the phase value at that
    // moment must be inspectable.
    const facadeSource = readFileSync(
      resolve(process.cwd(), "src/renderer/src/lib/useExternalMpvCommands.ts"),
      "utf8",
    );
    const seekBody =
      facadeSource.match(/const ensureExternalSeek = useCallback\([\s\S]*?\}, \[/)?.[0] ?? "";
    expect(seekBody).toMatch(/phaseKind:\s*phaseRef\.current\.kind/);
  });
});
