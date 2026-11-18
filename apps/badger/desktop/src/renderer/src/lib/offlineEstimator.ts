/**
 * Renderer-side helpers for the offline-mode feature (Phase 3 of the
 * offline-mode plan — `let-s-talk-about-offline-glimmering-knuth.md`).
 *
 * Sibling to `mediaDetailsProcessing.ts`. The runtime owns the authoritative
 * data (size, file existence, expectedFilename), but the renderer needs
 * lightweight roll-ups for buttons + badges that can be computed without an
 * IPC round-trip. These helpers do that:
 *
 *   - `resolveOfflineQuality(details, scope, preferred)` picks the best
 *     available quality ≤ the user's preferred quality for the in-scope
 *     items. Mirrors `pickReTranscodeSource`'s ≤ rule (see
 *     packages/ingest-core/src/quality.ts).
 *   - `collectOfflineLocalCounts(details, localFileIds)` rolls up the
 *     per-media `media_local_downloads` rows (delivered as the set of fileIds
 *     known to be saved locally) into per-scope counters that drive the
 *     button labels and partial badges.
 *   - `resolveButtonState(scope, counts)` returns the state→label/icon
 *     mapping per the plan's button table.
 *
 * Pure — no React, no IPC. Unit tested in
 * `tests/offline-estimator.test.ts`.
 */
import type { MediaDetails } from "@/lib/libraryDb";
import { QUALITY_ORDER, type QualityPreset } from "../../../shared/quality";

// ---------------------------------------------------------------------------
// Scope discriminators — match the renderer's button targets. The runtime
// receives `mediaIds[]` regardless; these structures only live in renderer
// code so the click handler can pick the right summary text + the right
// `media_local_downloads` slice to delete.
// ---------------------------------------------------------------------------

export type OfflineScope =
  | { kind: "movie" }
  | { kind: "show" }
  | { kind: "season"; seasonNumber: number }
  | { kind: "episode"; episodeId: string; seasonNumber: number; episodeNumber: number };

// ---------------------------------------------------------------------------
// Quality resolution
// ---------------------------------------------------------------------------

/**
 * Pick the best available quality ≤ preferred across in-scope items.
 *
 * Rule: walk `QUALITY_ORDER` from highest (2160p) to lowest (144p). The
 * first quality that's both (a) at or below the preferred rank AND (b)
 * present in at least one in-scope file's formats is the chosen quality.
 *
 * Returns `null` when no compatible quality exists for any in-scope item
 * — the caller surfaces that to the user as "N items will be skipped (no
 * compatible quality)". The backend's `estimate_size` result also reports
 * these via `skipped[]`; this helper exists for renderer-side previews
 * before the round-trip.
 */
export const resolveOfflineQuality = (
  details: MediaDetails | null,
  scope: OfflineScope,
  preferred: QualityPreset,
): QualityPreset | null => {
  if (!details) return null;
  const fileIds = inScopeFileIds(details, scope);
  if (fileIds.size === 0) return null;

  const preferredRank = QUALITY_ORDER.indexOf(preferred);
  if (preferredRank < 0) return null;

  // Collect distinct qualities across the in-scope files' formats.
  const available = new Set<string>();
  details.formats.forEach((format) => {
    if (!fileIds.has(format.fileId)) return;
    available.add(format.quality);
  });
  if (available.size === 0) return null;

  // Walk from preferred downward and return the first match.
  for (let rank = preferredRank; rank < QUALITY_ORDER.length; rank += 1) {
    const candidate = QUALITY_ORDER[rank];
    if (candidate && available.has(candidate)) return candidate;
  }
  return null;
};

// ---------------------------------------------------------------------------
// Local-availability counts
// ---------------------------------------------------------------------------

/**
 * Roll up the offline-availability state for a media item.
 *
 * The renderer passes in the set of fileIds known to be saved locally
 * (sourced from `badger.offline.list_local` filtered by mediaId), and this
 * helper turns that into the per-scope counters the UI needs:
 *
 *   - `movieLocal`     — for movies: was the single file saved? Boolean.
 *   - `episodesLocal`  — for shows: the set of "S-E" keys that ARE saved
 *                        (matches the `episodeHasFile` shape from
 *                        `buildMediaFilePresence`).
 *   - `episodesTotal`  — total playable episodes (denominator).
 *   - `seasonLocal`    — per-season { local, total } counts for the partial
 *                        badge on each season card.
 *
 * Movies short-circuit: when `details.type === "movie"`, only `movieLocal`
 * is populated and the TV-only fields are zero/empty.
 */
export type OfflineLocalCounts = {
  /** True if the single movie file is saved locally (movies only). */
  movieLocal: boolean;
  /** "S-E" keys of episodes saved locally (TV only). */
  episodesLocal: Set<string>;
  /** Total playable episodes the user can save (TV only). */
  episodesTotal: number;
  /** Per-season counters keyed by `seasonNumber` (TV only). */
  seasonLocal: Map<number, { local: number; total: number }>;
};

export const collectOfflineLocalCounts = (
  details: MediaDetails | null,
  localFileIds: ReadonlySet<string>,
): OfflineLocalCounts => {
  const empty: OfflineLocalCounts = {
    movieLocal: false,
    episodesLocal: new Set<string>(),
    episodesTotal: 0,
    seasonLocal: new Map<number, { local: number; total: number }>(),
  };
  if (!details) return empty;

  if (details.type === "movie") {
    // Movies have a single file (or zero — pre-ingest); local-ness is the
    // boolean OR across whatever movie-typed files exist.
    const movieFileIds = details.files
      .filter((file) => file.season == null && file.episode == null)
      .map((file) => file.id);
    const movieLocal = movieFileIds.some((id) => localFileIds.has(id));
    return { ...empty, movieLocal };
  }

  // TV: per-season + per-episode roll-up. Build the file→episode-key index
  // first so we can map each `localFileIds` entry back to its episode key.
  const fileIdToEpisodeKey = new Map<string, string>();
  const fileIdToSeason = new Map<string, number>();
  details.files.forEach((file) => {
    if (file.season == null || file.episode == null) return;
    fileIdToEpisodeKey.set(file.id, `${file.season}-${file.episode}`);
    fileIdToSeason.set(file.id, file.season);
  });

  const episodesLocal = new Set<string>();
  localFileIds.forEach((fileId) => {
    const key = fileIdToEpisodeKey.get(fileId);
    if (key) episodesLocal.add(key);
  });

  // episodesTotal = playable episodes (have at least one file). Mirrors
  // `getPlayableEpisodeKeySet` semantics via the files list.
  const playableEpisodeKeys = new Set<string>();
  details.files.forEach((file) => {
    if (file.season == null || file.episode == null) return;
    playableEpisodeKeys.add(`${file.season}-${file.episode}`);
  });

  // Per-season counts. Total = playable in that season; local = how many of
  // those are saved offline.
  const seasonLocal = new Map<number, { local: number; total: number }>();
  playableEpisodeKeys.forEach((key) => {
    const [seasonRaw] = key.split("-");
    const season = Number(seasonRaw);
    if (!Number.isFinite(season)) return;
    const entry = seasonLocal.get(season) ?? { local: 0, total: 0 };
    entry.total += 1;
    if (episodesLocal.has(key)) entry.local += 1;
    seasonLocal.set(season, entry);
  });

  return {
    movieLocal: false,
    episodesLocal,
    episodesTotal: playableEpisodeKeys.size,
    seasonLocal,
  };
};

// ---------------------------------------------------------------------------
// Button-state mapping
// ---------------------------------------------------------------------------

/**
 * Result of `resolveButtonState`. Drives the modal-trigger button label,
 * icon choice, and the count rendered for partial states.
 */
export type OfflineButtonState = {
  /** "save" → opens download modal, "complete" → same with missing-only,
   *  "delete" → fires the delete-from-local path, "hidden" → no button. */
  state: "save" | "complete" | "delete" | "hidden";
  /** i18n key (under `library.offline.button.*`) — caller passes to t(). */
  labelKey: string;
  /** Icon name to render. "RemoveOffline" is a barred-download glyph (NOT a
   *  trash can) — removing a local copy keeps the title in the library, so a
   *  delete/bin icon would wrongly imply a full library delete. */
  iconName: "Download" | "DownloadCloud" | "RemoveOffline";
  /** Local/Total count surfaced inside "Complete download (3/8)" labels. */
  badgeCount?: { local: number; total: number };
};

/**
 * Map a (scope, counts) pair to the button state per the plan's table:
 *
 *   movie:    none-local → Save offline
 *             all-local  → Delete from local
 *   episode:  same as movie (atomic — no partial state)
 *   season:   none-local → Save offline
 *             partial    → Complete download (3/8)
 *             all-local  → Delete from local
 *   show:     same as season
 *
 * Greyed seasons (no playable file at all) get state="hidden" so the caller
 * can skip rendering the hover button.
 */
export const resolveButtonState = (
  scope: OfflineScope,
  counts: OfflineLocalCounts,
): OfflineButtonState => {
  if (scope.kind === "movie") {
    return counts.movieLocal
      ? { state: "delete", labelKey: "library.offline.button.delete", iconName: "RemoveOffline" }
      : { state: "save", labelKey: "library.offline.button.save", iconName: "Download" };
  }

  if (scope.kind === "episode") {
    const key = `${scope.seasonNumber}-${scope.episodeNumber}`;
    return counts.episodesLocal.has(key)
      ? { state: "delete", labelKey: "library.offline.button.delete", iconName: "RemoveOffline" }
      : { state: "save", labelKey: "library.offline.button.save", iconName: "Download" };
  }

  if (scope.kind === "season") {
    const season = counts.seasonLocal.get(scope.seasonNumber);
    if (!season || season.total === 0) {
      return { state: "hidden", labelKey: "", iconName: "Download" };
    }
    if (season.local === 0) {
      return { state: "save", labelKey: "library.offline.button.save", iconName: "Download" };
    }
    if (season.local >= season.total) {
      return {
        state: "delete",
        labelKey: "library.offline.button.delete",
        iconName: "RemoveOffline",
        badgeCount: { local: season.local, total: season.total },
      };
    }
    return {
      state: "complete",
      labelKey: "library.offline.button.complete",
      iconName: "DownloadCloud",
      badgeCount: { local: season.local, total: season.total },
    };
  }

  // scope.kind === "show": roll up across all seasons.
  if (counts.episodesTotal === 0) {
    return { state: "hidden", labelKey: "", iconName: "Download" };
  }
  if (counts.episodesLocal.size === 0) {
    return { state: "save", labelKey: "library.offline.button.save", iconName: "Download" };
  }
  if (counts.episodesLocal.size >= counts.episodesTotal) {
    return {
      state: "delete",
      labelKey: "library.offline.button.delete",
      iconName: "RemoveOffline",
      badgeCount: { local: counts.episodesLocal.size, total: counts.episodesTotal },
    };
  }
  return {
    state: "complete",
    labelKey: "library.offline.button.complete",
    iconName: "DownloadCloud",
    badgeCount: { local: counts.episodesLocal.size, total: counts.episodesTotal },
  };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return the set of fileIds in `details.files` that fall under `scope`.
 * Exported so the modal can pass them straight through to the runtime's
 * estimate / submit commands (since the runtime takes mediaIds, the scope
 * gets flattened to mediaIds before sending).
 */
export const inScopeFileIds = (
  details: MediaDetails,
  scope: OfflineScope,
): Set<string> => {
  const out = new Set<string>();
  if (scope.kind === "movie") {
    details.files.forEach((file) => {
      if (file.season == null && file.episode == null) out.add(file.id);
    });
    return out;
  }
  if (scope.kind === "episode") {
    details.files.forEach((file) => {
      if (file.season === scope.seasonNumber && file.episode === scope.episodeNumber) {
        out.add(file.id);
      }
    });
    return out;
  }
  if (scope.kind === "season") {
    details.files.forEach((file) => {
      if (file.season === scope.seasonNumber && file.episode != null) {
        out.add(file.id);
      }
    });
    return out;
  }
  // scope.kind === "show": every episode file.
  details.files.forEach((file) => {
    if (file.season != null && file.episode != null) {
      out.add(file.id);
    }
  });
  return out;
};

/**
 * Resolve the runtime-side mediaIds for a scope. The runtime API takes a
 * mediaIds list (one item per file the user wants to download), so the
 * scope ↔ mediaIds mapping needs to be consistent: for movies/shows there's
 * one mediaId (the movie or show itself); for episodes the episodes share
 * the show's mediaId — files are addressed by fileId on the runtime side
 * via the in-flight resolution there.
 *
 * IMPORTANT — runtime API: per the contract, `mediaIds` resolves to ALL
 * downloadable files attached to those media items. The renderer must
 * narrow the set before submitting; today the only narrowing is via the
 * runtime's own roll-up. For season / episode scopes, the renderer
 * currently passes the show mediaId and trusts the runtime to dedupe
 * already-local items via `skipAlreadyLocal: true` — which works for
 * "Save all missing" semantics but means the per-episode action will
 * over-download adjacent files. This is a known plan-deviation to surface
 * to the main agent: the contract may need a `fileIds[]` payload variant
 * for true single-episode scope, OR the runtime needs an in-scope filter.
 */
export const resolveScopeMediaIds = (
  details: MediaDetails,
  _scope: OfflineScope,
): string[] => {
  // Today the runtime takes mediaIds. All four scopes hit the same media
  // (movies / show / its episodes), so we pass `[details.id]` and trust
  // smart-fill + skipAlreadyLocal. See the JSDoc above for the known caveat.
  return [details.id];
};
