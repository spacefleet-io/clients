import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * @bugfix @regression-proof
 *
 * Regression test for the backdrop-then-stream UX rewire (pending
 * commit; source already in tree). The launch branch resolves a TMDB
 * backdrop URL from `media.backdropPath` and passes it to
 * `launchExternalMpv` so mpv comes up displaying a still placeholder
 * within ~1 s of the user click. The window-hide path then fires
 * `signalPlaybackReady` IMMEDIATELY (not after the full ready-gate)
 * to atomically swap the Electron window behind mpv.
 *
 * If the media has NO backdrop path, the flow falls back to launching
 * directly on the stream URL (the previously-stable shape, preserved
 * for the no-backdrop case).
 *
 * This test pins:
 *  1. The launch IPC payload includes `backdropUrl` (not hardcoded null).
 *  2. The backdrop is resolved by `resolvePlaybackBackdrop` (library copy or the
 *     metadata service, as a data URI; never a TMDB CDN URL in the default mode).
 *  3. When no backdrop is available, `backdropUrl` falls through to
 *     null (the fallback branch) — the test asserts the conditional
 *     wiring is in place, not the runtime null value.
 */

const ENGINE_PATH = resolve(
  process.cwd(),
  "src/renderer/src/lib/useMpvPlaybackEngine.ts",
);
const engineSource = readFileSync(ENGINE_PATH, "utf8");

// Dump-on-failure helper: for source-string assertions, dump the regex that
// failed and a window of the engine source around the relevant call site so a
// source-shape regression is diagnosable offline. try/catch-guarded.
const dumpEngineSnapshot = (
  label: string,
  ctx: { pattern?: RegExp | string; anchor?: string },
) => {
  try {
    console.error(`=== [launch-with-backdrop:${label}] engine-source snapshot ===`);
    console.error(`engine path=${ENGINE_PATH} bytes=${engineSource.length}`);
    console.error(`failed pattern=${String(ctx.pattern)}`);
    if (ctx.anchor) {
      const idx = engineSource.indexOf(ctx.anchor);
      if (idx >= 0) {
        const window = engineSource.slice(Math.max(0, idx - 200), idx + 400);
        console.error(`source around "${ctx.anchor}":\n${window}`);
      } else {
        console.error(`anchor "${ctx.anchor}" not found in engine source`);
      }
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

console.info(`[launch-with-backdrop:setup] loaded engine source from ${ENGINE_PATH} (${engineSource.length} bytes)`);

describe("@bugfix @regression-proof launch IPC passes backdropUrl", () => {
  it("resolves backdropUrl via resolvePlaybackBackdrop(media.backdropPath, ...) (metadata service, never the TMDB CDN)", () => {
    // The renderer must resolve media.backdropPath through resolvePlaybackBackdrop at
    // launch time (as one of the parallel pre-launch loads, #928). The previous
    // hard-coded `backdropUrl: null` is the pre-fix shape we explicitly REJECTED.
    const pattern = /backdrop: \(\) =>\s*resolvePlaybackBackdrop\(media\.backdropPath,[\s\S]{0,1500}?const backdropUrl = prelaunch\.backdrop;/;
    console.info("[launch-with-backdrop:assert] checking backdropUrl resolution pattern");
    if (!pattern.test(engineSource)) {
      dumpEngineSnapshot("backdropUrl-resolution-missing", { pattern, anchor: "backdropUrl" });
    }
    expect(engineSource).toMatch(pattern);
    // META-ART-02: no TMDB image CDN in the engine.
    expect(engineSource).not.toMatch(/image\.tmdb\.org|tmdbImageUrl/);
  });

  it("launchExternalMpv IPC payload carries backdropUrl (not hard-coded null)", () => {
    // The launchExternalMpv call site must pass the resolved URL via
    // the `backdropUrl` field — not a hard-coded literal.
    const launchCall = engineSource.match(
      /window\.sf\?\.launchExternalMpv\?\.\(\{[\s\S]*?\}\)/,
    )?.[0] ?? "";
    console.info(`[launch-with-backdrop:assert] matched launchExternalMpv call (${launchCall.length} chars)`);
    if (!launchCall) {
      dumpEngineSnapshot("launch-call-missing", {
        pattern: /window\.sf\?\.launchExternalMpv\?\.\(\{[\s\S]*?\}\)/, anchor: "launchExternalMpv",
      });
    }
    expect(launchCall, "launchExternalMpv call must be present").toBeTruthy();
    if (!/backdropUrl:\s*backdropUrl/.test(launchCall) || /backdropUrl:\s*null/.test(launchCall)) {
      console.error(`=== [launch-with-backdrop:launch-call-shape] launchExternalMpv payload ===`);
      console.error(launchCall);
    }
    expect(launchCall).toMatch(/backdropUrl:\s*backdropUrl/);
    // Hard-coded `backdropUrl: null` was the prior workaround; ensure
    // it's not back.
    expect(launchCall).not.toMatch(/backdropUrl:\s*null/);
  });

  it("useBackdropHandoff is derived from Boolean(backdropUrl) — fallback branch is preserved", () => {
    console.info("[launch-with-backdrop:assert] checking useBackdropHandoff + fallback startTime wiring");
    const boolPattern = /const useBackdropHandoff = Boolean\(backdropUrl\)/;
    if (!boolPattern.test(engineSource)) {
      dumpEngineSnapshot("useBackdropHandoff-missing", { pattern: boolPattern, anchor: "useBackdropHandoff" });
    }
    expect(engineSource).toMatch(boolPattern);
    // The fallback (no backdrop → use the cmdline --start path) is
    // preserved: when useBackdropHandoff is false, startTime is the
    // original `options.startTime > 0 ? options.startTime : null`.
    const startTimePattern = /startTime:\s*useBackdropHandoff[\s\S]*?\?\s*null[\s\S]*?:\s*\(options\.startTime/;
    if (!startTimePattern.test(engineSource)) {
      dumpEngineSnapshot("fallback-startTime-missing", { pattern: startTimePattern, anchor: "startTime:" });
    }
    expect(engineSource).toMatch(startTimePattern);
  });

  it("paused flag follows backdrop mode: useBackdropHandoff → unpaused (image needs to display)", () => {
    // mpv must launch UNPAUSED in backdrop mode — the image otherwise
    // never displays. For direct-stream launches the prior
    // shouldLaunchPaused semantics are preserved.
    console.info("[launch-with-backdrop:assert] checking launchPaused derivation + payload wiring");
    const launchPausedPattern = /const launchPaused = useBackdropHandoff\s*\?\s*false\s*:\s*shouldLaunchPaused/;
    if (!launchPausedPattern.test(engineSource)) {
      dumpEngineSnapshot("launchPaused-missing", { pattern: launchPausedPattern, anchor: "launchPaused" });
    }
    expect(engineSource).toMatch(launchPausedPattern);
    const launchCall = engineSource.match(
      /window\.sf\?\.launchExternalMpv\?\.\(\{[\s\S]*?\}\)/,
    )?.[0] ?? "";
    if (!/paused:\s*launchPaused/.test(launchCall)) {
      console.error(`=== [launch-with-backdrop:paused-wiring] launchExternalMpv payload ===`);
      console.error(launchCall);
    }
    expect(launchCall).toMatch(/paused:\s*launchPaused/);
  });
});
