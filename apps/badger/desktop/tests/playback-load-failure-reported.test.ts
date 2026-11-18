// @bugfix @regression-proof issue #25 run 8013 playback-backdrop-handoff
// "a stream that fails to load during the handoff ... surfaces the error":
// Start Over after a stop relaunches through startFrom's zero-seek path,
// `void pauseForChange(() => loadStream(...))`, which had no catch. The
// handoff failure (`playback_handoff_load_failed`) escaped as an unhandled
// rejection (pageerror) and "couldn't start playback" never showed.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  MPV_NO_DISPLAY,
  PLAYBACK_LOAD_STOPPED,
  isPlaybackLoadStopped,
  playbackLoadFailureKey,
  runReportingLoadFailure,
} from "../src/renderer/src/lib/playbackLoadFailure";

describe("runReportingLoadFailure", () => {
  it("reports a failed load instead of rejecting", async () => {
    const report = vi.fn();
    const failure = new Error("playback_handoff_load_failed");
    await expect(runReportingLoadFailure(async () => { throw failure; }, report)).resolves.toBeUndefined();
    expect(report).toHaveBeenCalledWith(failure);
  });

  it("does not report a load that succeeds", async () => {
    const report = vi.fn();
    await runReportingLoadFailure(async () => undefined, report);
    expect(report).not.toHaveBeenCalled();
  });
});

describe("playbackLoadFailureKey", () => {
  it("says the source is unreachable only for playback_source_unreachable", () => {
    expect(playbackLoadFailureKey(new Error("playback_source_unreachable"))).toBe("player.errors.sourceUnreachable");
    expect(playbackLoadFailureKey(new Error("playback_handoff_load_failed"))).toBe("player.errors.playback");
    expect(playbackLoadFailureKey("boom")).toBe("player.errors.playback");
  });
  // @bugfix @regression-proof wayland-appid-option-not-found: a Wayland-only session with the bundled
  // mpv (no Wayland) played nothing and said nothing. The main process refuses the launch with
  // `mpv_no_display`, which reaches the renderer wrapped by Electron's IPC.
  it("says why when no player window can open (Wayland only, mpv without Wayland)", () => {
    const wrapped = new Error(`Error invoking remote method 'sf-mpv-external-play': Error: ${MPV_NO_DISPLAY}`);
    console.info(`[playback-load-failure] no-display wrapped=${wrapped.message} -> ${playbackLoadFailureKey(wrapped)}`);
    expect(playbackLoadFailureKey(wrapped)).toBe("player.errors.noDisplay");
    expect(playbackLoadFailureKey(new Error(MPV_NO_DISPLAY))).toBe("player.errors.noDisplay");
    for (const locale of ["en", "fr", "de", "es", "nl"]) {
      const strings = JSON.parse(readFileSync(resolve(process.cwd(), `src/renderer/src/i18n/${locale}.json`), "utf8"));
      const message: unknown = strings.player?.errors?.noDisplay;
      console.info(`[playback-load-failure] ${locale} player.errors.noDisplay=${String(message)}`);
      expect(typeof message === "string" && message.includes("X11")).toBe(true);
    }
  });
  // @bugfix @regression-proof issue #25 run 8013 playback.e2e "zero unexpected
  // console errors": a reload interrupted by a stop warned three times.
  it("has no user-facing message for a load that ended because mpv was stopped", () => {
    const stopped = new Error(PLAYBACK_LOAD_STOPPED);
    expect(isPlaybackLoadStopped(stopped)).toBe(true);
    expect(isPlaybackLoadStopped(new Error("playback_handoff_load_failed"))).toBe(false);
    expect(playbackLoadFailureKey(stopped)).toBeNull();
  });
});


describe("useMpvPlaybackEngine load sites", () => {
  it("routes every pauseForChange load through runReportingLoadFailure", () => {
    const source = readFileSync(resolve(process.cwd(), "src/renderer/src/lib/useMpvPlaybackEngine.ts"), "utf8");
    const sites = [...source.matchAll(/void pauseForChange\(/g)].map((m) => m.index ?? -1);
    console.info(`[playback-load-failure] pauseForChange load sites at offsets ${JSON.stringify(sites)}`);
    expect(sites.length).toBeGreaterThanOrEqual(2);
    for (const index of sites) {
      const call = source.slice(index, index + 80);
      expect(call, `site at ${index}: ${call}`).toMatch(/^void pauseForChange\(\(\) => runReportingLoadFailure\(async \(\) =>/);
    }
  });

  it("the loadfile reload checks for a stop before its readiness gates and throws PLAYBACK_LOAD_STOPPED", () => {
    const source = readFileSync(resolve(process.cwd(), "src/renderer/src/lib/useMpvPlaybackEngine.ts"), "utf8");
    const readyAt = source.indexOf("const recoveredReady = await confirmExternalPlaybackReady();");
    const warnAt = source.indexOf('"external not ready after loadfile"');
    const stopCheckAt = source.indexOf("throw new Error(PLAYBACK_LOAD_STOPPED)", readyAt);
    console.info(`[playback-load-failure] reload readiness=${readyAt} stopCheck=${stopCheckAt} warn=${warnAt}`);
    expect(readyAt).toBeGreaterThan(-1);
    expect(stopCheckAt).toBeGreaterThan(readyAt);
    expect(stopCheckAt).toBeLessThan(warnAt);
  });

  // @bugfix @regression-proof badger shard-3 at 54c699a1d playback.e2e "zero
  // unexpected console errors": resume-accuracy stopped mpv right after the
  // direct launch resumed it; the launch's ready gate then bailed on the dead
  // player after 1 ms and warned "vo-configured did not fire before budget".
  it("the direct launch checks for a stop before its ready gate and throws PLAYBACK_LOAD_STOPPED", () => {
    const source = readFileSync(resolve(process.cwd(), "src/renderer/src/lib/useMpvPlaybackEngine.ts"), "utf8");
    const resumedAt = source.indexOf('"loadStream: resumeExternalPlayback complete"');
    const gateAt = source.indexOf("const READY_GATE_BUDGET_MS = 5000;", resumedAt);
    const stopCheckAt = source.indexOf("throw new Error(PLAYBACK_LOAD_STOPPED)", resumedAt);
    console.info(`[playback-load-failure] launch resumed=${resumedAt} stopCheck=${stopCheckAt} gate=${gateAt}`);
    expect(resumedAt).toBeGreaterThan(-1);
    expect(gateAt).toBeGreaterThan(resumedAt);
    expect(stopCheckAt).toBeGreaterThan(resumedAt);
    expect(stopCheckAt).toBeLessThan(gateAt);
  });
});
