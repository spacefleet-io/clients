import { MetadataUnavailableError } from "@space/metadata-client";
import type { MediaDetails, MediaRow } from "@/lib/libraryDb";
import {
  EXTERNAL_SKIP_MARKER_FETCH_KIND,
  EXTERNAL_SKIP_MARKER_SHOW_KIND,
  createExternalSkipMarkerFetchPayload,
  createShowSkipCachePayload,
  isExternalSkipMarkerFetchPayload,
  isServiceSkipMarkerSource,
  parseShowSkipCachePayload,
  showEpisodeKey,
  type ExternalSkipMarkerCoverageEntry,
  type ExternalSkipMarkerFetchResult,
  type ShowSkipCachePayload,
  type ShowSkipMarker,
} from "../../../shared/skipMarkerCache";

/**
 * PLAY-NEXT-02 backfill: TV episodes already in the library with a file but no
 * service marker get their intro/credits fetched once, in the background,
 * through the metadata service (META-SKIP-01; the desktop never calls a source itself),
 * so TV and mobile (which read markers from the synced library and never call
 * a source) can offer "Skip intro". Episodes imported before the import path
 * carried markers to the runtime are the main target.
 *
 * An episode is skipped when it already has a service-fetched marker,
 * or when the show cache / per-episode fetch rows record a hit or a miss for
 * it. A cached hit whose markers never reached the episode is written from the
 * cache without asking the metadata service again.
 */

/** Same freshness rule as the import window's show cache read. */
export const SHOW_SKIP_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Gap between two skip-marker lookups sent to the metadata service: one at a time, so one library never floods it. */
export const SKIP_BACKFILL_REQUEST_GAP_MS = 1_500;
/** Consecutive failures after which the run stops until the next app start. */
export const SKIP_BACKFILL_MAX_CONSECUTIVE_FAILURES = 3;

export type SkipAnalysisRow = {
  episodeId: string | null;
  payload: Record<string, unknown>;
  updatedAt: string;
};

export type SkipBackfillEpisode = {
  episodeId: string;
  seasonNumber: number;
  episodeNumber: number;
  durationSeconds: number | null;
  /** Markers already known from the show cache: write them, no request. */
  cachedMarkers: ShowSkipMarker[] | null;
};

export type SkipBackfillDeps = {
  fetchMediaDetails: (mediaId: string) => Promise<MediaDetails | null>;
  listSkipAnalysis: (mediaId: string, kind: string) => Promise<SkipAnalysisRow[]>;
  upsertSkipAnalysis: (
    mediaId: string,
    episodeId: string | null,
    kind: string,
    payload: Record<string, unknown>,
  ) => Promise<void>;
  replaceSkipMarkers: (mediaId: string, episodeId: string | null, markers: ShowSkipMarker[]) => Promise<void>;
  fetchMarkers: (input: {
    catalogId: number;
    seasonNumber: number;
    episodeNumber: number;
    durationSeconds: number | null;
  }) => Promise<ExternalSkipMarkerFetchResult>;
  sleep: (ms: number) => Promise<void>;
  log: (message: string, details: Record<string, unknown>) => void;
  now?: () => number;
  isCancelled?: () => boolean;
};

export type SkipBackfillSummary = {
  shows: number;
  showsWithWork: number;
  fetched: number;
  hits: number;
  misses: number;
  writtenFromCache: number;
  failed: number;
  stoppedEarly: string | null;
};

/** Newest show cache row for the show, or null when absent or older than the freshness window. */
export const pickShowSkipCache = (rows: SkipAnalysisRow[], nowMs: number): ShowSkipCachePayload | null => {
  const fresh = rows
    .filter((row) => row.episodeId === null)
    .map((row) => ({ updatedAt: row.updatedAt, payload: parseShowSkipCachePayload(row.payload) }))
    .filter((row) => row.payload !== null)
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))[0];
  if (!fresh?.payload) return null;
  const ageMs = nowMs - new Date(fresh.payload.fetchedAt).getTime();
  return ageMs < SHOW_SKIP_CACHE_MAX_AGE_MS ? fresh.payload : null;
};

/**
 * META-SKIP-02 timing: Skip times are added by a community, often days after an episode airs, so an
 * empty answer is asked again after 1 day and a partial one (intro or credits only) after 7 days. An episode
 * with both an intro and a credits marker is never asked again.
 */
export const SKIP_BACKFILL_MISS_RETRY_MS = 24 * 60 * 60 * 1000;
export const SKIP_BACKFILL_PARTIAL_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Episodes of one show that need markers: they have a file, no complete
 * (intro + credits) service markers, and no answer recent enough to wait on
 * (see SKIP_BACKFILL_MISS_RETRY_MS / SKIP_BACKFILL_PARTIAL_RETRY_MS).
 */
export const selectSkipBackfillEpisodes = (
  details: MediaDetails,
  showCache: ShowSkipCachePayload | null,
  episodeFetchRows: SkipAnalysisRow[],
  nowMs: number,
): SkipBackfillEpisode[] => {
  const fileIdsByKey = new Map<string, string[]>();
  for (const file of details.files) {
    if (typeof file.season !== "number" || typeof file.episode !== "number") continue;
    const key = showEpisodeKey(file.season, file.episode);
    fileIdsByKey.set(key, [...(fileIdsByKey.get(key) ?? []), file.id]);
  }
  const serviceTypesByEpisode = new Map<string, Set<string>>();
  for (const marker of details.skipMarkers) {
    if (marker.episodeId === null || !isServiceSkipMarkerSource(marker.source)) continue;
    const types = serviceTypesByEpisode.get(marker.episodeId) ?? new Set<string>();
    types.add(marker.type);
    serviceTypesByEpisode.set(marker.episodeId, types);
  }
  const lastFetchByEpisode = new Map<string, { status: string; fetchedAtMs: number }>();
  for (const row of episodeFetchRows) {
    if (row.episodeId === null || !isExternalSkipMarkerFetchPayload(row.payload)) continue;
    if (row.payload.status !== "hit" && row.payload.status !== "miss") continue;
    const fetchedAtMs = new Date(row.payload.fetchedAt).getTime();
    if (!Number.isFinite(fetchedAtMs)) continue;
    const previous = lastFetchByEpisode.get(row.episodeId);
    if (!previous || previous.fetchedAtMs < fetchedAtMs) {
      lastFetchByEpisode.set(row.episodeId, { status: row.payload.status, fetchedAtMs });
    }
  }
  const cacheStatusByKey = new Map(
    (showCache?.coverage ?? []).map((entry) => [showEpisodeKey(entry.seasonNumber, entry.episodeNumber), entry.status] as const),
  );
  const cacheFetchedAtMs = showCache ? new Date(showCache.fetchedAt).getTime() : Number.NaN;

  const selected: SkipBackfillEpisode[] = [];
  for (const episode of details.episodes) {
    const key = showEpisodeKey(episode.seasonNumber, episode.episodeNumber);
    const fileIds = fileIdsByKey.get(key);
    if (!fileIds || fileIds.length === 0) continue;
    const types = serviceTypesByEpisode.get(episode.id) ?? new Set<string>();
    if (types.has("intro") && types.has("credits")) continue;
    const cachedStatus = cacheStatusByKey.get(key);
    const cachedMarkers = showCache?.markersByEpisode[key] ?? null;
    if (types.size === 0 && cachedStatus === "hit" && cachedMarkers && cachedMarkers.length > 0) {
      selected.push({ episodeId: episode.id, seasonNumber: episode.seasonNumber, episodeNumber: episode.episodeNumber, durationSeconds: null, cachedMarkers });
      continue;
    }
    const lastFetch = lastFetchByEpisode.get(episode.id);
    const lastAskedMs = lastFetch?.fetchedAtMs ?? (cachedStatus && Number.isFinite(cacheFetchedAtMs) ? cacheFetchedAtMs : null);
    if (lastAskedMs !== null) {
      const lastAnswerEmpty = types.size === 0 && (lastFetch ? lastFetch.status === "miss" : cachedStatus === "miss");
      const waitMs = lastAnswerEmpty ? SKIP_BACKFILL_MISS_RETRY_MS : SKIP_BACKFILL_PARTIAL_RETRY_MS;
      if (nowMs - lastAskedMs < waitMs) continue;
    }
    const durations = details.formats
      .filter((format) => fileIds.includes(format.fileId))
      .map((format) => format.durationSeconds)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
    selected.push({
      episodeId: episode.id,
      seasonNumber: episode.seasonNumber,
      episodeNumber: episode.episodeNumber,
      durationSeconds: durations.length > 0 ? Math.max(...durations) : null,
      cachedMarkers: null,
    });
  }
  return selected;
};

/** Keeps the episode's non-service markers of types the fetch did not return, like the playback lazy fetch. */
const mergeEpisodeMarkers = (details: MediaDetails, episodeId: string, fetched: ShowSkipMarker[]): ShowSkipMarker[] => {
  const fetchedTypes = new Set(fetched.map((marker) => marker.type));
  return [
    ...details.skipMarkers
      .filter((marker) => marker.episodeId === episodeId && !fetchedTypes.has(marker.type))
      .map((marker) => ({
        type: marker.type,
        startSeconds: marker.startSeconds,
        endSeconds: marker.endSeconds,
        source: marker.source,
        confidence: marker.confidence,
      })),
    ...fetched,
  ].sort((left, right) => left.startSeconds - right.startSeconds);
};

/** The metadata service said "not now" (429 rate limit or 503 source capacity): stop and retry at the next app start. */
const isRateLimited = (err: unknown) => err instanceof MetadataUnavailableError;

/**
 * Walks every TV show in `media`, one metadata service lookup at a time. Writes
 * markers with `replaceSkipMarkers`, the per-episode hit/miss row and the
 * show cache with `upsertSkipAnalysis` — the same writers the import window
 * and the playback lazy fetch use — so nothing is asked twice.
 */
export const runSkipMarkerBackfill = async (media: MediaRow[], deps: SkipBackfillDeps): Promise<SkipBackfillSummary> => {
  const now = deps.now ?? Date.now;
  const summary: SkipBackfillSummary = {
    shows: 0,
    showsWithWork: 0,
    fetched: 0,
    hits: 0,
    misses: 0,
    writtenFromCache: 0,
    failed: 0,
    stoppedEarly: null,
  };
  const shows = media.filter(
    (item): item is MediaRow & { catalogId: number } =>
      item.type === "tv" && item.hasFiles && typeof item.catalogId === "number" && item.catalogId > 0,
  );
  summary.shows = shows.length;
  deps.log("[skip-markers] backfill start", { shows: shows.length, mediaCount: media.length });
  let consecutiveFailures = 0;
  let requestsSent = 0;

  for (const show of shows) {
    if (deps.isCancelled?.()) {
      summary.stoppedEarly = "cancelled";
      break;
    }
    const details = await deps.fetchMediaDetails(show.id);
    if (!details) {
      deps.log("[skip-markers] backfill show details missing", { mediaId: show.id, title: show.title });
      continue;
    }
    const showCacheRows = await deps.listSkipAnalysis(show.id, EXTERNAL_SKIP_MARKER_SHOW_KIND);
    const showCache = pickShowSkipCache(showCacheRows, now());
    const episodeFetchRows = await deps.listSkipAnalysis(show.id, EXTERNAL_SKIP_MARKER_FETCH_KIND);
    const todo = selectSkipBackfillEpisodes(details, showCache, episodeFetchRows, now());
    deps.log("[skip-markers] backfill show", {
      mediaId: show.id,
      title: show.title,
      catalogId: show.catalogId,
      episodes: details.episodes.length,
      files: details.files.length,
      serviceMarkers: details.skipMarkers.filter((marker) => isServiceSkipMarkerSource(marker.source)).length,
      showCacheCoverage: showCache?.coverage.length ?? 0,
      episodeFetchRows: episodeFetchRows.length,
      todo: todo.map((episode) => `${showEpisodeKey(episode.seasonNumber, episode.episodeNumber)}${episode.cachedMarkers ? ":cache" : ""}`),
    });
    if (todo.length === 0) continue;
    summary.showsWithWork += 1;

    const newCoverage: ExternalSkipMarkerCoverageEntry[] = [];
    const newMarkers: Record<string, ShowSkipMarker[]> = {};
    let stop = false;
    for (const episode of todo) {
      const key = showEpisodeKey(episode.seasonNumber, episode.episodeNumber);
      if (episode.cachedMarkers) {
        await deps.replaceSkipMarkers(show.id, episode.episodeId, mergeEpisodeMarkers(details, episode.episodeId, episode.cachedMarkers));
        summary.writtenFromCache += 1;
        deps.log("[skip-markers] backfill wrote cached markers", { mediaId: show.id, episode: key, markers: episode.cachedMarkers });
        continue;
      }
      if (deps.isCancelled?.()) {
        summary.stoppedEarly = "cancelled";
        stop = true;
        break;
      }
      if (requestsSent > 0) await deps.sleep(SKIP_BACKFILL_REQUEST_GAP_MS);
      requestsSent += 1;
      try {
        const result = await deps.fetchMarkers({
          catalogId: show.catalogId,
          seasonNumber: episode.seasonNumber,
          episodeNumber: episode.episodeNumber,
          durationSeconds: episode.durationSeconds,
        });
        consecutiveFailures = 0;
        summary.fetched += 1;
        const markers: ShowSkipMarker[] = result.markers
          .filter((marker) => marker.endSeconds != null)
          .map((marker) => ({
            type: marker.type,
            startSeconds: marker.startSeconds,
            endSeconds: marker.endSeconds as number,
            source: marker.source,
            confidence: marker.confidence,
          }));
        const coverage: ExternalSkipMarkerCoverageEntry = result.coverage.find(
          (entry) => entry.seasonNumber === episode.seasonNumber && entry.episodeNumber === episode.episodeNumber,
        ) ?? {
          seasonNumber: episode.seasonNumber,
          episodeNumber: episode.episodeNumber,
          status: markers.length > 0 ? "hit" : "miss",
        };
        await deps.upsertSkipAnalysis(
          show.id,
          episode.episodeId,
          EXTERNAL_SKIP_MARKER_FETCH_KIND,
          createExternalSkipMarkerFetchPayload(coverage, result.fetchedAt),
        );
        newCoverage.push(coverage);
        if (markers.length > 0) {
          newMarkers[key] = markers;
          summary.hits += 1;
          await deps.replaceSkipMarkers(show.id, episode.episodeId, mergeEpisodeMarkers(details, episode.episodeId, markers));
        } else {
          summary.misses += 1;
        }
        deps.log("[skip-markers] backfill fetched", { mediaId: show.id, episode: key, status: coverage.status, markers });
      } catch (err) {
        summary.failed += 1;
        consecutiveFailures += 1;
        const error = err instanceof Error ? err.message : String(err);
        deps.log("[skip-markers] backfill fetch failed", { mediaId: show.id, episode: key, error, consecutiveFailures });
        if (isRateLimited(err)) {
          summary.stoppedEarly = `rate-limited: ${error}`;
          stop = true;
          break;
        }
        if (consecutiveFailures >= SKIP_BACKFILL_MAX_CONSECUTIVE_FAILURES) {
          summary.stoppedEarly = `${consecutiveFailures} failures in a row: ${error}`;
          stop = true;
          break;
        }
      }
    }

    if (newCoverage.length > 0) {
      const fetchedKeys = new Set(newCoverage.map((entry) => showEpisodeKey(entry.seasonNumber, entry.episodeNumber)));
      const payload = createShowSkipCachePayload({
        showCatalogId: show.catalogId,
        fetchedAt: new Date(now()).toISOString(),
        coverage: [
          ...(showCache?.coverage ?? []).filter(
            (entry) => !fetchedKeys.has(showEpisodeKey(entry.seasonNumber, entry.episodeNumber)),
          ),
          ...newCoverage,
        ],
        markersByEpisode: { ...(showCache?.markersByEpisode ?? {}), ...newMarkers },
      });
      await deps.upsertSkipAnalysis(show.id, null, EXTERNAL_SKIP_MARKER_SHOW_KIND, payload);
      deps.log("[skip-markers] backfill show cache written", {
        mediaId: show.id,
        coverage: payload.coverage.length,
        markersByEpisode: Object.keys(payload.markersByEpisode).length,
      });
    }
    if (stop) break;
  }

  deps.log("[skip-markers] backfill done", { ...summary });
  return summary;
};
