import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { resolveSeekDuration } from "../src/renderer/src/lib/mediaPlaybackTimeline";

/**
 * @bugfix @regression-proof app-seek-dropped-before-duration-poll
 *
 * An app seek (e2e seam, keyboard, seekbar, chapter list) went through
 * `requestSeek`, which clamped to the engine's POLLED duration and returned
 * early while it was 0. The poll runs at 1 Hz while the app window is hidden
 * (mpv plays in its own window), so a seek made in a file's first second
 * never reached mpv even though mpv already knew the duration. Seen live with
 * the bundled mpv (it starts the stream ~1 s sooner than the system mpv):
 * skip-markers credits E2E, renderer log `safeDuration: 0` at the seek, no
 * `Run command: seek` in the mpv log.
 */

const ENGINE_PATH = resolve(__dirname, "../src/renderer/src/lib/useMpvPlaybackEngine.ts");

const requestSeekBody = () => {
  const src = readFileSync(ENGINE_PATH, "utf8");
  const start = src.indexOf("const requestSeek = (");
  return start >= 0 ? src.slice(start, src.indexOf("\n  };\n", start)) : "";
};

describe("app seek before the first duration poll", () => {
  it("falls back to mpv's live duration while the polled one is 0", async () => {
    const readLive = vi.fn(async () => 1440);
    const resolved = await resolveSeekDuration(0, readLive);
    console.info(`[app-seek-duration] polled=0 live=1440 resolved=${resolved} liveReads=${readLive.mock.calls.length}`);
    expect(resolved).toBe(1440);
    expect(readLive).toHaveBeenCalledTimes(1);
  });

  it("uses the polled duration without an IPC round-trip once it is in", async () => {
    const readLive = vi.fn(async () => 1440);
    const resolved = await resolveSeekDuration(1300, readLive);
    console.info(`[app-seek-duration] polled=1300 resolved=${resolved} liveReads=${readLive.mock.calls.length}`);
    expect(resolved).toBe(1300);
    expect(readLive).not.toHaveBeenCalled();
  });

  it("drops the seek only when mpv itself has no duration", async () => {
    for (const live of [null, undefined, 0, -1, Number.NaN, "12"]) {
      const resolved = await resolveSeekDuration(Number.NaN, async () => live);
      console.info(`[app-seek-duration] polled=NaN live=${String(live)} resolved=${resolved}`);
      expect(resolved).toBeNull();
    }
  });

  it("requestSeek resolves its duration through mpv instead of returning on a 0 poll", () => {
    const body = requestSeekBody();
    const readsLiveDuration = /resolveSeekDuration\(\s*safeDuration \|\| duration,\s*\(\) => getProperty\(sendExternalRequest, "duration"\)/.test(body);
    const dropsOnZeroPoll = /if \(!durationValue\) return;/.test(body);
    console.info(`[app-seek-duration] requestSeekFound=${body.length > 0} readsLiveDuration=${readsLiveDuration} dropsOnZeroPoll=${dropsOnZeroPoll}`);
    expect(body.length).toBeGreaterThan(0);
    expect(readsLiveDuration).toBe(true);
    expect(dropsOnZeroPoll).toBe(false);
  });
});
