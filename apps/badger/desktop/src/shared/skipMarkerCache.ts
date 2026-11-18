// v2 invalidates v1 because the v1 cache was poisoned by an earlier build
// that pointed at a fictional v2/media endpoint and recorded false "miss"
// entries that suppressed every subsequent lazy re-fetch on playback. Bumping
// the kind orphans the v1 rows (harmless) and forces a fresh fetch via v3.
export const EXTERNAL_SKIP_MARKER_FETCH_KIND = "external-skip-markers-v2";

import {
  LEGACY_SKIP_MARKER_PROVIDERS,
  LEGACY_SKIP_MARKER_SOURCE_PREFIX,
  readLegacyShowCatalogId,
} from "./legacyFormat";

// The provider tag fresh payloads carry. Older payloads carry the tags in
// `legacyFormat.ts`; every tag is ACCEPTED on read so already-cached rows stay
// valid — no forced re-fetch storm against the metadata service — while new
// payloads get this tag and the cache self-heals over time. Do NOT drop the
// legacy tags: that would invalidate every cached marker. (The cache *key* is
// the `kind` const above, which is unchanged.)
export const SKIP_MARKER_PROVIDER = "metadata-v1";
export type SkipMarkerProvider = string;

const isSkipMarkerProvider = (value: unknown): value is SkipMarkerProvider =>
  value === SKIP_MARKER_PROVIDER || (typeof value === "string" && LEGACY_SKIP_MARKER_PROVIDERS.includes(value));

/** The `source` of skip markers the metadata service answers (contract 2). */
export const SERVICE_SKIP_MARKER_SOURCE = "metadata";

/** True for a skip marker fetched from the metadata service, whatever Badger version stored it. */
export const isServiceSkipMarkerSource = (source: string): boolean =>
  source === SERVICE_SKIP_MARKER_SOURCE || source.startsWith(LEGACY_SKIP_MARKER_SOURCE_PREFIX);

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
  fetchedAt: string
): ExternalSkipMarkerFetchPayload => ({
  provider: SKIP_MARKER_PROVIDER,
  status: entry.status,
  fetchedAt,
  ...(entry.markerTypes && entry.markerTypes.length > 0 ? { markerTypes: [...entry.markerTypes].sort() } : {}),
});

export const isExternalSkipMarkerFetchPayload = (value: unknown): value is ExternalSkipMarkerFetchPayload => {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (!isSkipMarkerProvider(record.provider)) return false;
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
  showCatalogId: number;
  fetchedAt: string;
  coverage: ExternalSkipMarkerCoverageEntry[];
  markersByEpisode: Record<string /* "s:e" */, ShowSkipMarker[]>;
};

export const showEpisodeKey = (seasonNumber: number, episodeNumber: number): string =>
  `${seasonNumber}:${episodeNumber}`;

export const createShowSkipCachePayload = (params: {
  showCatalogId: number;
  fetchedAt: string;
  coverage: ExternalSkipMarkerCoverageEntry[];
  markersByEpisode: Record<string, ShowSkipMarker[]>;
}): ShowSkipCachePayload => ({
  provider: SKIP_MARKER_PROVIDER,
  showCatalogId: params.showCatalogId,
  fetchedAt: params.fetchedAt,
  coverage: params.coverage,
  markersByEpisode: params.markersByEpisode,
});

const isPositiveId = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/** The show cache payload in `value`, with a legacy payload's keys read into the current shape; null when invalid. */
export const parseShowSkipCachePayload = (value: unknown): ShowSkipCachePayload | null => {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (!isSkipMarkerProvider(record.provider)) return null;
  const showCatalogId = record.showCatalogId ?? readLegacyShowCatalogId(record);
  if (!isPositiveId(showCatalogId)) return null;
  if (typeof record.fetchedAt !== "string" || record.fetchedAt.length === 0) return null;
  if (!Array.isArray(record.coverage)) return null;
  if (!record.markersByEpisode || typeof record.markersByEpisode !== "object") return null;
  return {
    provider: record.provider,
    showCatalogId,
    fetchedAt: record.fetchedAt,
    coverage: record.coverage as ExternalSkipMarkerCoverageEntry[],
    markersByEpisode: record.markersByEpisode as Record<string, ShowSkipMarker[]>,
  };
};
