/**
 * @req STOR-BW-01[badger-desktop]
 *
 * High-traffic period: mpv's readahead target (`--cache-secs`) is capped to
 * the gateway's `playbackBufferSeconds` and restored when traffic is normal.
 */
import { afterEach, describe, expect, it } from "vitest";

import { buildExternalMpvArgs, capMpvStreamCacheSecs, resolveMpvStreamCacheSecs } from "../src/external";

const cacheSecsArg = (args: string[]) => args.find((a) => a.startsWith("--cache-secs="));

describe("capMpvStreamCacheSecs", () => {
  it("never raises the normal readahead target", () => {
    expect(capMpvStreamCacheSecs(16, 30)).toBe(16);
    expect(capMpvStreamCacheSecs(16, 16)).toBe(16);
  });

  it("lowers it to the gateway's playback buffer when that is smaller", () => {
    expect(capMpvStreamCacheSecs(16, 10)).toBe(10);
    expect(capMpvStreamCacheSecs(16, 4.9)).toBe(4);
  });

  it("leaves it alone when normal (null) and keeps a disabled cache disabled", () => {
    expect(capMpvStreamCacheSecs(16, null)).toBe(16);
    expect(capMpvStreamCacheSecs(16, undefined)).toBe(16);
    expect(capMpvStreamCacheSecs(0, 10)).toBe(0);
  });

  it("never drops below one second while a cache exists", () => {
    expect(capMpvStreamCacheSecs(16, 0)).toBe(1);
    expect(capMpvStreamCacheSecs(16, 0.2)).toBe(1);
  });
});

describe("buildExternalMpvArgs under high traffic", () => {
  const prev = process.env.SF_MPV_STREAM_CACHE_SECS;
  afterEach(() => {
    if (prev === undefined) delete process.env.SF_MPV_STREAM_CACHE_SECS;
    else process.env.SF_MPV_STREAM_CACHE_SECS = prev;
  });

  it("launches with the capped --cache-secs while high and the normal one otherwise", () => {
    delete process.env.SF_MPV_STREAM_CACHE_SECS;
    expect(resolveMpvStreamCacheSecs()).toBe(16);
    const base = { url: "http://127.0.0.1:1/x.m3u8", vo: "gpu" };
    expect(cacheSecsArg(buildExternalMpvArgs({ ...base, playbackBufferSeconds: 6 }))).toBe("--cache-secs=6");
    expect(cacheSecsArg(buildExternalMpvArgs({ ...base, playbackBufferSeconds: null }))).toBe("--cache-secs=16");
    expect(cacheSecsArg(buildExternalMpvArgs(base))).toBe("--cache-secs=16");
  });
});
