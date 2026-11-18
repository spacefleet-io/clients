/**
 * Why no artwork asset was produced: `missing` (the service has no such image), `no_ticket` / `unavailable` (try
 * again later) or `rate_limited` (the service said "slow down": ask again after `retryAfterMs`, its Retry-After).
 */
export class AssetArtworkError extends Error {
  constructor(
    readonly reason: "missing" | "no_ticket" | "unavailable" | "rate_limited",
    readonly retryAfterMs?: number
  ) {
    super(`ASSET_ARTWORK_${reason.toUpperCase()}`);
    this.name = "AssetArtworkError";
  }
}
