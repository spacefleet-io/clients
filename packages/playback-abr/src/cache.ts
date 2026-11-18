import { effectiveBitrateBps, type Variant } from "./ladder";

/**
 * mpv demuxer cache limits the client configured (`cache-secs`, `demuxer-max-bytes`). There is NO default here: each client
 * passes what its own player is really configured with, so the upshift gate can never ask for more buffer than mpv can hold
 * (desktop bug: 20 s gate vs a 16 s cache -> never).
 */
export type CacheConfig = { cacheSecs: number; demuxerMaxBytes: number };

/** Upper bound of the upshift buffer gate; the real gate is `upshiftBufferThresholdS` (never above what mpv can hold). */
export const BUFFER_HIGH_S = 20;
export const BUFFER_LOW_S = 5;
/** Fraction of the reachable buffer that opens the upshift gate (the rest is margin for the switch itself). */
export const UPSHIFT_BUFFER_FRACTION = 0.6;

/** Seconds of media the demuxer cache can hold for a rung: capped by `cache-secs` AND by the byte cap at its bitrate. */
export const reachableBufferSeconds = (cache: CacheConfig, variant: Variant): number =>
  Math.min(cache.cacheSecs, (cache.demuxerMaxBytes * 8) / effectiveBitrateBps(variant));

/**
 * Buffer level (seconds) at which a healthy link may upshift away from `variant`. Never above BUFFER_HIGH_S and always a
 * fraction of what mpv can hold, so the gate can open.
 */
export const upshiftBufferThresholdS = (cache: CacheConfig, variant: Variant): number =>
  Math.min(BUFFER_HIGH_S, reachableBufferSeconds(cache, variant) * UPSHIFT_BUFFER_FRACTION);

/** Below this the buffer counts as starved (network). Scaled down for rungs whose byte cap holds only a few seconds. */
export const healthyBufferFloorS = (cache: CacheConfig, variant: Variant): number =>
  Math.min(BUFFER_LOW_S, reachableBufferSeconds(cache, variant) * 0.5);
