/**
 * @test-id DESKTOP-ABR-CACHE-CONFIG-001
 * @level unit
 * @bugfix
 * @regression-proof
 *
 * The shared ABR derives its upshift buffer gate from the client's mpv cache (`@space/playback-abr` `reachableBufferSeconds`).
 * The desktop's default is `DESKTOP_DEFAULT_CACHE_CONFIG`, mirrored from `@space/mpv`'s launch flags (the renderer cannot import
 * `@space/mpv`). If the two drift, the gate is computed for a cache the player does not have: too high and Auto never climbs
 * back (the desktop's old 20 s gate vs a 16 s cache), too low and it climbs into a starving cache.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { DESKTOP_DEFAULT_CACHE_CONFIG } from "../src/renderer/src/lib/abrCacheConfig";

const LOG = "[abr-cache-config]";
const external = readFileSync(resolve(__dirname, "../../../../packages/mpv/src/external.ts"), "utf8");

describe("desktop ABR cache config stays in lockstep with the mpv launch flags", () => {
  it("cache-secs default", () => {
    const match = external.match(/SF_MPV_STREAM_CACHE_SECS \?\? "(\d+)"/);
    console.info(`${LOG} external.ts cache-secs default=${match?.[1]} config=${DESKTOP_DEFAULT_CACHE_CONFIG.cacheSecs}`);
    expect(match, "external.ts no longer reads SF_MPV_STREAM_CACHE_SECS with a string default").not.toBeNull();
    expect(Number(match![1])).toBe(DESKTOP_DEFAULT_CACHE_CONFIG.cacheSecs);
  });

  it("demuxer-max-bytes default", () => {
    const match = external.match(/SF_MPV_STREAM_CACHE_MAX_BYTES \?\? `\$\{(\d+) \* 1024 \* 1024\}`/);
    console.info(`${LOG} external.ts max-bytes default=${match?.[1]} MiB config=${DESKTOP_DEFAULT_CACHE_CONFIG.demuxerMaxBytes}`);
    expect(match, "external.ts no longer reads SF_MPV_STREAM_CACHE_MAX_BYTES with a MiB default").not.toBeNull();
    expect(Number(match![1]) * 1024 * 1024).toBe(DESKTOP_DEFAULT_CACHE_CONFIG.demuxerMaxBytes);
  });
});
