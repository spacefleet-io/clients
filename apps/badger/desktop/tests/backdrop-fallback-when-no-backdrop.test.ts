import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { resolvePlaybackBackdrop, type PlaybackBackdropDeps } from "../src/renderer/src/lib/playbackBackdrop";

/**
 * @bugfix @regression-proof
 *
 * Regression test for the no-backdrop fallback path of the backdrop
 * rewire. When `media.backdropPath` is null/undefined/empty, the flow
 * MUST fall back to launching directly on the stream URL — the
 * previously-stable behaviour, preserved unchanged.
 *
 * Why this matters:
 *  - Not every media item has a TMDB backdrop populated (custom
 *    user-imported media, fresh metadata that hasn't been fetched yet,
 *    etc.).
 *  - The fallback path uses `--start=<time>` to handle the resume position
 *    (no prefill, #25 playable-start); it is bounded by the prewarm cap
 *    (2 s); subtitles no longer wait (PLAY-TRACK-07 interim) — see `useMpvPlaybackEngine-launch-flow-source.test.ts`.
 *  - If the fallback path were to fire signalPlaybackReady early like
 *    the backdrop path, mpv would still be cold (no image, no stream)
 *    and the user would see a Black window flash before mpv showed
 *    anything. That's why the early-signal is GATED on
 *    `useBackdropHandoff`.
 *
 * This test pins:
 *  1. resolvePlaybackBackdrop(null/undefined/"") returns null, and so does a
 *     failed or slow lookup — confirming useBackdropHandoff evaluates to false.
 *  2. The launch IPC payload's `startTime` resolves to the original
 *     options.startTime in the fallback branch.
 *  3. The early-signal branch is conditional on useBackdropHandoff
 *     (so it doesn't fire in the fallback).
 *  4. The backdrop swap-loadfile block is wrapped in
 *     `if (useBackdropHandoff)` — so the fallback never enters it.
 */

const ENGINE_PATH = resolve(
  process.cwd(),
  "src/renderer/src/lib/useMpvPlaybackEngine.ts",
);
const engineSource = readFileSync(ENGINE_PATH, "utf8");
console.info(
  `[backdrop-fallback-when-no-backdrop:setup] read engine source from ${ENGINE_PATH} (${engineSource.length} chars)`,
);

// On a source-grep assertion failure, dump the regex that failed + the
// neighbourhood of the closest anchor token so the drift in
// useMpvPlaybackEngine.ts is visible without re-opening the file. Wrapped
// in try/catch so a dump failure can't mask the assertion.
const dumpBackdropFallbackSnapshot = (label: string, pattern: RegExp, anchor: string) => {
  try {
    console.error(`=== [backdrop-fallback-when-no-backdrop:${label}] source-grep snapshot ===`);
    console.error(`pattern=${pattern.toString()}`);
    console.error(`pattern.test(engineSource)=${pattern.test(engineSource)}`);
    const idx = engineSource.indexOf(anchor);
    if (idx >= 0) {
      const slice = engineSource.slice(Math.max(0, idx - 120), idx + 280);
      console.error(`anchor=${JSON.stringify(anchor)} found at index ${idx}; neighbourhood:\n${slice}`);
    } else {
      console.error(`anchor=${JSON.stringify(anchor)} NOT FOUND in engine source`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("@bugfix @regression-proof backdrop fallback when no backdrop", () => {
  it("@bugfix @regression-proof @req META-ART-01 @req META-ART-02 resolvePlaybackBackdrop returns null for a missing path, a title without its own copy, a failed read and a slow one", async () => {
    console.info("[backdrop-fallback-when-no-backdrop:resolve] missing/no copy/failed/slow → null; own copy → data URI");
    const getAssetUrl = vi.fn(async () => "blob:copy");
    // The pre-vault shape asked the metadata service for a provider path while playing; nothing may take it now.
    const resolveImage = vi.fn(async () => "data:image/png;base64,SERVICE");
    const deps: PlaybackBackdropDeps = Object.assign(
      {
        isAssetKey: (path: string) => path.startsWith("asset:"),
        getAssetUrl,
        toDataUrl: async () => "data:image/png;base64,AAAA",
        timeoutMs: 30,
      },
      { resolveImage },
    );
    expect(await resolvePlaybackBackdrop(null, deps)).toBeNull();
    expect(await resolvePlaybackBackdrop(undefined, deps)).toBeNull();
    expect(await resolvePlaybackBackdrop("", deps)).toBeNull();
    console.info("[backdrop-fallback-when-no-backdrop:resolve] provider path (no copy yet) → null, metadata service untouched");
    expect(await resolvePlaybackBackdrop("/abc.jpg", deps)).toBeNull();
    expect(resolveImage).not.toHaveBeenCalled();
    expect(getAssetUrl).not.toHaveBeenCalled();
    console.info("[backdrop-fallback-when-no-backdrop:resolve] own copy → data URI");
    expect(await resolvePlaybackBackdrop("asset:backdrop::assets/x.txt", deps)).toBe("data:image/png;base64,AAAA");
    expect(await resolvePlaybackBackdrop("asset:backdrop::assets/x.txt", { ...deps, getAssetUrl: async () => { throw new Error("gone"); } })).toBeNull();
    expect(await resolvePlaybackBackdrop("asset:backdrop::assets/x.txt", { ...deps, getAssetUrl: () => new Promise(() => undefined) })).toBeNull();
  });

  it("@bugfix @regression-proof source: launch IPC startTime resolves to options.startTime when NOT in backdrop mode", () => {
    console.info("[backdrop-fallback-when-no-backdrop:source-startTime] checking startTime conditional preserves fallback shape");
    // The conditional: `startTime: useBackdropHandoff ? null : (options.startTime > 0 ? options.startTime : null)`
    // — when no backdrop, the prior shape is preserved.
    const pattern =
      /startTime:\s*useBackdropHandoff[\s\S]{0,200}?:\s*\(options\.startTime\s*!==\s*null\s*&&\s*options\.startTime\s*>\s*0\s*\?\s*options\.startTime\s*:\s*null\)/;
    try {
      expect(engineSource).toMatch(pattern);
    } catch (err) {
      dumpBackdropFallbackSnapshot("source-startTime-assert-failed", pattern, "startTime:");
      throw err;
    }
  });

  it("@bugfix @regression-proof source: early signalPlaybackReady is gated by useBackdropHandoff", () => {
    console.info("[backdrop-fallback-when-no-backdrop:source-signal-gate] checking early signalPlaybackReady is gated");
    // The fallback path MUST NOT fire signalPlaybackReady early — it
    // would hide the Electron window before mpv had anything to show.
    // Gate must be present.
    const pattern =
      /if \(useBackdropHandoff && isExternalActive\(lifecycleRef\.current\)\)\s*\{[\s\S]{0,400}?signalPlaybackReady/;
    try {
      expect(engineSource).toMatch(pattern);
    } catch (err) {
      dumpBackdropFallbackSnapshot("source-signal-gate-assert-failed", pattern, "signalPlaybackReady");
      throw err;
    }
  });

  it("@bugfix @regression-proof source: backdrop swap-loadfile block is wrapped in if (useBackdropHandoff)", () => {
    console.info("[backdrop-fallback-when-no-backdrop:source-swap-gate] checking swap-loadfile block is backdrop-gated");
    // The swap path is exclusive to backdrop mode. The fallback must
    // skip it entirely and use the existing direct-launch chain.
    const pattern = /if \(useBackdropHandoff\)\s*\{[\s\S]{0,200}?const swapStartMs = Date\.now\(\);/;
    try {
      expect(engineSource).toMatch(pattern);
    } catch (err) {
      dumpBackdropFallbackSnapshot("source-swap-gate-assert-failed", pattern, "swapStartMs");
      throw err;
    }
  });

  it("@bugfix @regression-proof source: direct-launch path's phase-1 metadata + tracks-stable chain still exists (fallback preserved)", () => {
    // Phase 1 (no-backdrop): tracksStablePromise + metadataPromise +
    // confirmExternalPlaybackReady + verify-pass ensureExternalSeek.
    // None of these are removed.
    //
    // Phase-2b update: the inline `(async () => { ... })()` IIFE that
    // wrapped the [0, 100, 300] adaptive-backoff loop was extracted into
    // the shared `sendMetadataWithBackoff` helper (see
    // `mpvMetadataBackoff.ts`). The CALL-SITE SHAPE is now
    // `const metadataPromise = sendMetadataWithBackoff(...)`. The chain
    // itself — tracksStablePromise + metadataPromise + Promise.all —
    // is preserved unchanged; only the inner retry/backoff body moved.
    console.info("[backdrop-fallback-when-no-backdrop:source-direct-launch] checking phase-1 metadata + tracks-stable chain preserved");
    const tracksPattern = /const tracksStablePromise = waitForExternalTracksStable\(\)/;
    const metadataPattern = /const metadataPromise = sendMetadataWithBackoff\(/;
    const confirmPattern = /await confirmExternalPlaybackReady\(\)/;
    try {
      expect(engineSource).toMatch(tracksPattern);
      expect(engineSource).toMatch(metadataPattern);
      expect(engineSource).toMatch(confirmPattern);
    } catch (err) {
      dumpBackdropFallbackSnapshot("source-tracks-stable-assert-failed", tracksPattern, "tracksStablePromise");
      dumpBackdropFallbackSnapshot("source-metadata-backoff-assert-failed", metadataPattern, "sendMetadataWithBackoff");
      dumpBackdropFallbackSnapshot("source-confirm-ready-assert-failed", confirmPattern, "confirmExternalPlaybackReady");
      throw err;
    }
  });

  it("@bugfix @regression-proof source: launchPaused fallback respects shouldLaunchPaused when no backdrop", () => {
    console.info("[backdrop-fallback-when-no-backdrop:source-launch-paused] checking launchPaused fallback keeps shouldLaunchPaused");
    // shouldLaunchPaused is the legacy condition (paused || resume-from-non-zero).
    // The backdrop branch overrides it to false (image needs to display)
    // but the fallback keeps it.
    const launchPausedPattern = /const launchPaused = useBackdropHandoff\s*\?\s*false\s*:\s*shouldLaunchPaused/;
    const shouldLaunchPausedPattern =
      /const shouldLaunchPaused\s*=\s*options\.paused\s*\|\|\s*\(options\.startTime\s*!==\s*null\s*&&\s*options\.startTime\s*>\s*ZERO_SEEK_EPS\)/;
    try {
      expect(engineSource).toMatch(launchPausedPattern);
      expect(engineSource).toMatch(shouldLaunchPausedPattern);
    } catch (err) {
      dumpBackdropFallbackSnapshot("source-launch-paused-assert-failed", launchPausedPattern, "const launchPaused");
      dumpBackdropFallbackSnapshot("source-should-launch-paused-assert-failed", shouldLaunchPausedPattern, "const shouldLaunchPaused");
      throw err;
    }
  });
});
