/**
 * The mpv stream cache the desktop client configures, as `@space/playback-abr` needs it (the upshift buffer gate is derived
 * from what the cache can actually hold, so it is always reachable).
 *
 * Mirrors `@space/mpv`'s launch defaults (`--cache-secs` 16, `--demuxer-max-bytes` 96 MiB); the renderer cannot import
 * `@space/mpv`, so `tests/abr-cache-config.test.ts` keeps the two in lockstep. The live values are read from mpv whenever
 * it answers, since `SF_MPV_STREAM_CACHE_*` can override them.
 */
import { getProperty, type MpvSend } from "@space/mpv-protocol";
import type { CacheConfig } from "@space/playback-abr";

export const DESKTOP_DEFAULT_CACHE_CONFIG: CacheConfig = { cacheSecs: 16, demuxerMaxBytes: 96 * 1024 * 1024 };

const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/** mpv's live cache limits; each missing/unusable answer falls back to the launch default. Never throws. */
export const readMpvCacheConfig = async (send: MpvSend): Promise<CacheConfig> => {
  const [cacheSecs, demuxerMaxBytes] = await Promise.all([
    getProperty(send, "cache-secs").catch(() => null),
    getProperty(send, "demuxer-max-bytes").catch(() => null),
  ]);
  return {
    cacheSecs: positive(cacheSecs) ? cacheSecs : DESKTOP_DEFAULT_CACHE_CONFIG.cacheSecs,
    demuxerMaxBytes: positive(demuxerMaxBytes) ? demuxerMaxBytes : DESKTOP_DEFAULT_CACHE_CONFIG.demuxerMaxBytes,
  };
};
