// v2 invalidates v1 because the v1 cache was poisoned by an earlier build
// that pointed at a fictional v2/media endpoint and recorded false "miss"
// entries that suppressed every subsequent lazy re-fetch on playback. Bumping
// the kind orphans the v1 rows (harmless) and forces a fresh fetch via v3.
export const EXTERNAL_SKIP_MARKER_FETCH_KIND = "external-skip-markers-v2";

// The provider tag historically carried "-v2" (a cache-format-era label, NOT
// the API version). The metadata service now serves TheIntroDB's real v3
// answers and tags fresh payloads "theintrodb-v3". We ACCEPT BOTH on read so
// already-cached v2-tagged rows stay valid — no forced re-fetch storm against
// the metadata service — while newly-written
// payloads get the correct v3 tag and the cache self-heals over time. Do NOT
// collapse this back to a single literal: that would invalidate every cached
// marker. (The cache *key* is the `kind` const above, which is unchanged.)
export type SkipMarkerProvider = "theintrodb-v2" | "theintrodb-v3";

export type ExternalSkipMarkerFetchStatus = "hit" | "miss" | "pending_detail";

export type ExternalSkipMarkerFetchPayload = {
  provider: SkipMarkerProvider;
  status: ExternalSkipMarkerFetchStatus;
  fetchedAt: string;
  markerTypes?: Array<"intro" | "credits">;
};

export type ExternalSkipMarkerCoverageEntry = {
  seasonNumber: number;
  episodeNumber: number;
  status: ExternalSkipMarkerFetchStatus;
  markerTypes?: Array<"intro" | "credits">;
};

export type ExternalSkipMarkerFetchResult = {
  provider: SkipMarkerProvider;
  fetchedAt: string;
  markers: Array<{
    type: "intro" | "credits";
    startSeconds: number;
    endSeconds: number | null;
    extendsToEof: boolean;
    confidence: number | null;
    source: string;
    version: string;
    meta: Record<string, unknown> | null;
  }>;
  coverage: ExternalSkipMarkerCoverageEntry[];
};

export const createExternalSkipMarkerFetchPayload = (
  entry: ExternalSkipMarkerCoverageEntry,
  fetchedAt: string,
  provider: SkipMarkerProvider = "theintrodb-v3"
): ExternalSkipMarkerFetchPayload => ({
  provider,
  status: entry.status,
  fetchedAt,
  ...(entry.markerTypes && entry.markerTypes.length > 0 ? { markerTypes: [...entry.markerTypes].sort() } : {}),
});

export const isExternalSkipMarkerFetchPayload = (value: unknown): value is ExternalSkipMarkerFetchPayload => {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.provider !== "theintrodb-v2" && record.provider !== "theintrodb-v3") return false;
  if (record.status !== "hit" && record.status !== "miss" && record.status !== "pending_detail") return false;
  if (typeof record.fetchedAt !== "string" || record.fetchedAt.length === 0) return false;
  if (!Array.isArray(record.markerTypes) && typeof record.markerTypes !== "undefined") return false;
  if (Array.isArray(record.markerTypes) && record.markerTypes.some((item) => item !== "intro" && item !== "credits")) {
    return false;
  }
  return true;
};

// ---------------------------------------------------------------------------
// Whole-show skip-marker cache
// ---------------------------------------------------------------------------
//
// The import modal fetches markers for ALL episodes of a TV show in one batch
// (one lookup at a time through the metadata service) and caches the result
// keyed by the show's media_items.id. Subsequent modal opens of any episode
// from the same show hit this cache — no API round-trip.
//
// Stored in `media_skip_analysis` with `kind = EXTERNAL_SKIP_MARKER_SHOW_KIND`
// and `episode_id = null` (one row per show, refreshed on every TV ingest).
//
// v2 invalidates v1 because the v1 cache was poisoned by an earlier build
// that pointed at a fictional v2/media endpoint and recorded false "miss"
// entries that suppressed every subsequent re-fetch. Bumping the kind
// orphans the v1 rows (harmless) and forces a fresh fetch via the real v3.
export const EXTERNAL_SKIP_MARKER_SHOW_KIND = "external-skip-markers-show-v2";

export type ShowSkipMarker = {
  type: "intro" | "credits";
  startSeconds: number;
  endSeconds: number;
  source: string;
  confidence: number | null;
};

export type ShowSkipCachePayload = {
  provider: SkipMarkerProvider;
  showTmdbId: number;
  fetchedAt: string;
  coverage: ExternalSkipMarkerCoverageEntry[];
  markersByEpisode: Record<string /* "s:e" */, ShowSkipMarker[]>;
};

export const showEpisodeKey = (seasonNumber: number, episodeNumber: number): string =>
  `${seasonNumber}:${episodeNumber}`;

export const createShowSkipCachePayload = (params: {
  showTmdbId: number;
  fetchedAt: string;
  coverage: ExternalSkipMarkerCoverageEntry[];
  markersByEpisode: Record<string, ShowSkipMarker[]>;
  provider?: SkipMarkerProvider;
}): ShowSkipCachePayload => ({
  provider: params.provider ?? "theintrodb-v3",
  showTmdbId: params.showTmdbId,
  fetchedAt: params.fetchedAt,
  coverage: params.coverage,
  markersByEpisode: params.markersByEpisode,
});

export const isShowSkipCachePayload = (value: unknown): value is ShowSkipCachePayload => {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.provider !== "theintrodb-v2" && record.provider !== "theintrodb-v3") return false;
  if (typeof record.showTmdbId !== "number" || !Number.isFinite(record.showTmdbId) || record.showTmdbId <= 0) return false;
  if (typeof record.fetchedAt !== "string" || record.fetchedAt.length === 0) return false;
  if (!Array.isArray(record.coverage)) return false;
  if (!record.markersByEpisode || typeof record.markersByEpisode !== "object") return false;
  return true;
};
