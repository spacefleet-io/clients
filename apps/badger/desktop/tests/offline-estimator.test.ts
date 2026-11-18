// @vitest-environment node
//
// Pure-function unit tests for `offlineEstimator.ts`. Covers:
//   - `resolveOfflineQuality`: best ≤ preferred across in-scope items,
//     null when nothing qualifies, fallback selection
//   - `collectOfflineLocalCounts`: movie / TV roll-ups, per-season counts,
//     episodesTotal denominator, missing-season fallback
//   - `resolveButtonState`: the 12 scope × state combos per the plan table
//   - `inScopeFileIds`: scope → fileId set
//
// Phase 3 of the offline-mode plan (Layer C item 12).
//
// Test logging: each suite emits phase markers and state dumps on
// assertion failure per the "tests log generously" convention.
import { describe, expect, it } from "vitest";
import {
  collectOfflineLocalCounts,
  inScopeFileIds,
  resolveButtonState,
  resolveOfflineQuality,
  resolveScopeMediaIds,
  type OfflineScope,
} from "@/lib/offlineEstimator";
import type { MediaDetails } from "@/lib/libraryDb";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const makeMovieDetails = (overrides: Partial<MediaDetails> = {}): MediaDetails => ({
  id: "movie-1",
  type: "movie",
  tmdbId: 1,
  externalIds: null,
  title: "Test Movie",
  originalTitle: null,
  originalLanguage: null,
  overview: null,
  year: "2020",
  rating: null,
  posterPath: null,
  backdropPath: null,
  genres: [],
  addedAt: "2024-01-01",
  updatedAt: "2024-01-01",
  hasFiles: true,
  progressPct: 0,
  lastWatchedAt: null,
  totalEpisodes: null,
  episodeCount: 0,
  cast: [],
  playlistIds: [],
  seasons: [],
  episodes: [],
  trailers: [],
  files: [
    { id: "movie-file-1", filename: "movie.mkv", season: null, episode: null, desiredFormats: [] },
  ],
  formats: [
    { id: "fmt-1080p", mediaId: "movie-1", fileId: "movie-file-1", quality: "1080p", codec: "h264", bitrateKbps: 5000, sizeMb: 1000, initKey: null, initSize: null, durationSeconds: 7200, totalSize: null, chunks: [] },
    { id: "fmt-720p", mediaId: "movie-1", fileId: "movie-file-1", quality: "720p", codec: "h264", bitrateKbps: 3000, sizeMb: 600, initKey: null, initSize: null, durationSeconds: 7200, totalSize: null, chunks: [] },
  ],
  audioTracks: [],
  subtitleTracks: [],
  subtitles: [],
  chapters: [],
  skipMarkers: [],
  hasLocalFiles: false,
  ...overrides,
});

const makeTvDetails = (overrides: Partial<MediaDetails> = {}): MediaDetails => ({
  id: "show-1",
  type: "tv",
  tmdbId: 100,
  externalIds: null,
  title: "Test Show",
  originalTitle: null,
  originalLanguage: null,
  overview: null,
  year: "2020",
  rating: null,
  posterPath: null,
  backdropPath: null,
  genres: [],
  addedAt: "2024-01-01",
  updatedAt: "2024-01-01",
  hasFiles: true,
  progressPct: 0,
  lastWatchedAt: null,
  totalEpisodes: 8,
  episodeCount: 8,
  cast: [],
  playlistIds: [],
  // 2 seasons, 4 episodes each
  seasons: [
    { id: "s1", seasonNumber: 1, name: "Season 1", overview: null, posterPath: null, episodeCount: 4, airDate: null },
    { id: "s2", seasonNumber: 2, name: "Season 2", overview: null, posterPath: null, episodeCount: 4, airDate: null },
  ],
  episodes: [
    { id: "ep-1-1", seasonNumber: 1, episodeNumber: 1, name: "Ep 1.1", overview: null, stillPath: null, airDate: null },
    { id: "ep-1-2", seasonNumber: 1, episodeNumber: 2, name: "Ep 1.2", overview: null, stillPath: null, airDate: null },
    { id: "ep-1-3", seasonNumber: 1, episodeNumber: 3, name: "Ep 1.3", overview: null, stillPath: null, airDate: null },
    { id: "ep-1-4", seasonNumber: 1, episodeNumber: 4, name: "Ep 1.4", overview: null, stillPath: null, airDate: null },
    { id: "ep-2-1", seasonNumber: 2, episodeNumber: 1, name: "Ep 2.1", overview: null, stillPath: null, airDate: null },
    { id: "ep-2-2", seasonNumber: 2, episodeNumber: 2, name: "Ep 2.2", overview: null, stillPath: null, airDate: null },
    { id: "ep-2-3", seasonNumber: 2, episodeNumber: 3, name: "Ep 2.3", overview: null, stillPath: null, airDate: null },
    { id: "ep-2-4", seasonNumber: 2, episodeNumber: 4, name: "Ep 2.4", overview: null, stillPath: null, airDate: null },
  ],
  trailers: [],
  files: [
    { id: "file-1-1", filename: "s1e1.mkv", season: 1, episode: 1, desiredFormats: [] },
    { id: "file-1-2", filename: "s1e2.mkv", season: 1, episode: 2, desiredFormats: [] },
    { id: "file-1-3", filename: "s1e3.mkv", season: 1, episode: 3, desiredFormats: [] },
    { id: "file-1-4", filename: "s1e4.mkv", season: 1, episode: 4, desiredFormats: [] },
    { id: "file-2-1", filename: "s2e1.mkv", season: 2, episode: 1, desiredFormats: [] },
    { id: "file-2-2", filename: "s2e2.mkv", season: 2, episode: 2, desiredFormats: [] },
    { id: "file-2-3", filename: "s2e3.mkv", season: 2, episode: 3, desiredFormats: [] },
    { id: "file-2-4", filename: "s2e4.mkv", season: 2, episode: 4, desiredFormats: [] },
  ],
  formats: [
    // Every file has 1080p and 720p; the in-scope filter is what we test.
    ...["file-1-1", "file-1-2", "file-1-3", "file-1-4", "file-2-1", "file-2-2", "file-2-3", "file-2-4"].flatMap((fileId) => [
      { id: `fmt-${fileId}-1080p`, mediaId: "show-1", fileId, quality: "1080p", codec: "h264", bitrateKbps: 5000, sizeMb: 500, initKey: null, initSize: null, durationSeconds: 2400, totalSize: null, chunks: [] },
      { id: `fmt-${fileId}-720p`, mediaId: "show-1", fileId, quality: "720p", codec: "h264", bitrateKbps: 3000, sizeMb: 300, initKey: null, initSize: null, durationSeconds: 2400, totalSize: null, chunks: [] },
    ]),
  ],
  audioTracks: [],
  subtitleTracks: [],
  subtitles: [],
  chapters: [],
  skipMarkers: [],
  hasLocalFiles: false,
  ...overrides,
});

// ---------------------------------------------------------------------------
// resolveOfflineQuality
// ---------------------------------------------------------------------------

describe("resolveOfflineQuality", () => {
  it("[offline-estimator] picks the exact preferred quality when available", () => {
    console.info("[offline-estimator] movie has 1080p and 720p; preferred=1080p");
    const details = makeMovieDetails();
    const result = resolveOfflineQuality(details, { kind: "movie" }, "1080p");
    console.info("[offline-estimator] result", result);
    expect(result).toBe("1080p");
  });

  it("[offline-estimator] falls back to the best ≤ preferred when preferred is missing", () => {
    console.info("[offline-estimator] formats: 720p only; preferred=1080p");
    const details = makeMovieDetails({
      formats: [
        { id: "fmt-720p", mediaId: "movie-1", fileId: "movie-file-1", quality: "720p", codec: "h264", bitrateKbps: 3000, sizeMb: 600, initKey: null, initSize: null, durationSeconds: 7200, totalSize: null, chunks: [] },
      ],
    });
    const result = resolveOfflineQuality(details, { kind: "movie" }, "1080p");
    console.info("[offline-estimator] result", result);
    expect(result).toBe("720p");
  });

  it("[offline-estimator] returns null when nothing qualifies at or below preferred", () => {
    console.info("[offline-estimator] preferred=144p but formats are 1080p/720p");
    const details = makeMovieDetails();
    const result = resolveOfflineQuality(details, { kind: "movie" }, "144p");
    console.info("[offline-estimator] result", result);
    expect(result).toBeNull();
  });

  it("[offline-estimator] picks across in-scope files for a season scope", () => {
    console.info("[offline-estimator] TV show; season 1 scope; preferred=1080p");
    const details = makeTvDetails();
    const result = resolveOfflineQuality(details, { kind: "season", seasonNumber: 1 }, "1080p");
    console.info("[offline-estimator] result", result);
    expect(result).toBe("1080p");
  });

  it("[offline-estimator] returns null for null details", () => {
    const result = resolveOfflineQuality(null, { kind: "movie" }, "1080p");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// collectOfflineLocalCounts
// ---------------------------------------------------------------------------

describe("collectOfflineLocalCounts", () => {
  it("[offline-estimator] movie — nothing saved", () => {
    console.info("[offline-estimator] movie with empty localFileIds");
    const counts = collectOfflineLocalCounts(makeMovieDetails(), new Set());
    console.info("[offline-estimator] counts", { movieLocal: counts.movieLocal });
    expect(counts.movieLocal).toBe(false);
    expect(counts.episodesLocal.size).toBe(0);
    expect(counts.seasonLocal.size).toBe(0);
  });

  it("[offline-estimator] movie — saved", () => {
    console.info("[offline-estimator] movie with the movie file saved");
    const counts = collectOfflineLocalCounts(makeMovieDetails(), new Set(["movie-file-1"]));
    expect(counts.movieLocal).toBe(true);
  });

  it("[offline-estimator] TV — partial season 1, none in season 2", () => {
    console.info("[offline-estimator] TV: 2 episodes of S1 saved");
    const counts = collectOfflineLocalCounts(
      makeTvDetails(),
      new Set(["file-1-1", "file-1-2"]),
    );
    console.info("[offline-estimator] counts", {
      episodesLocal: Array.from(counts.episodesLocal),
      episodesTotal: counts.episodesTotal,
      seasonLocal: Array.from(counts.seasonLocal.entries()),
    });
    expect(counts.episodesLocal.has("1-1")).toBe(true);
    expect(counts.episodesLocal.has("1-2")).toBe(true);
    expect(counts.episodesLocal.has("2-1")).toBe(false);
    expect(counts.episodesTotal).toBe(8);
    expect(counts.seasonLocal.get(1)).toEqual({ local: 2, total: 4 });
    expect(counts.seasonLocal.get(2)).toEqual({ local: 0, total: 4 });
  });

  it("[offline-estimator] TV — all episodes saved", () => {
    console.info("[offline-estimator] TV: all 8 episodes saved");
    const allFileIds = new Set([
      "file-1-1", "file-1-2", "file-1-3", "file-1-4",
      "file-2-1", "file-2-2", "file-2-3", "file-2-4",
    ]);
    const counts = collectOfflineLocalCounts(makeTvDetails(), allFileIds);
    expect(counts.episodesLocal.size).toBe(8);
    expect(counts.seasonLocal.get(1)?.local).toBe(4);
    expect(counts.seasonLocal.get(2)?.local).toBe(4);
  });

  it("[offline-estimator] null details → empty counts", () => {
    const counts = collectOfflineLocalCounts(null, new Set(["file-1-1"]));
    expect(counts.movieLocal).toBe(false);
    expect(counts.episodesLocal.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// resolveButtonState — 12 scope × state combos per the plan's table
// ---------------------------------------------------------------------------

describe("resolveButtonState — movie", () => {
  it("[offline-estimator] movie + nothing local → save", () => {
    const counts = collectOfflineLocalCounts(makeMovieDetails(), new Set());
    const s = resolveButtonState({ kind: "movie" }, counts);
    console.info("[offline-estimator] state", s);
    expect(s.state).toBe("save");
    expect(s.iconName).toBe("Download");
  });

  it("[offline-estimator] movie + saved → delete (barred-download icon, not a bin)", () => {
    const counts = collectOfflineLocalCounts(makeMovieDetails(), new Set(["movie-file-1"]));
    const s = resolveButtonState({ kind: "movie" }, counts);
    expect(s.state).toBe("delete");
    // RemoveOffline = a barred-download glyph. Deliberately NOT "Trash2": the
    // local copy is removed but the title stays in the library, so a bin icon
    // would wrongly read as a full delete.
    expect(s.iconName).toBe("RemoveOffline");
  });

  it("[offline-estimator] season fully-local → delete uses RemoveOffline (not Trash2)", () => {
    // Season 1 has 4 episodes (file-1-1..file-1-4); all local → delete state.
    const counts = collectOfflineLocalCounts(
      makeTvDetails(),
      new Set(["file-1-1", "file-1-2", "file-1-3", "file-1-4"]),
    );
    const s = resolveButtonState({ kind: "season", seasonNumber: 1 }, counts);
    expect(s.state).toBe("delete");
    expect(s.iconName).toBe("RemoveOffline");
  });
});

describe("resolveButtonState — episode", () => {
  it("[offline-estimator] episode + nothing local → save", () => {
    const counts = collectOfflineLocalCounts(makeTvDetails(), new Set());
    const s = resolveButtonState(
      { kind: "episode", episodeId: "ep-1-1", seasonNumber: 1, episodeNumber: 1 },
      counts,
    );
    expect(s.state).toBe("save");
  });

  it("[offline-estimator] episode + saved → delete", () => {
    const counts = collectOfflineLocalCounts(makeTvDetails(), new Set(["file-1-1"]));
    const s = resolveButtonState(
      { kind: "episode", episodeId: "ep-1-1", seasonNumber: 1, episodeNumber: 1 },
      counts,
    );
    expect(s.state).toBe("delete");
  });

  it("[offline-estimator] episode + adjacent saved (not THIS one) → save", () => {
    const counts = collectOfflineLocalCounts(makeTvDetails(), new Set(["file-1-2"]));
    const s = resolveButtonState(
      { kind: "episode", episodeId: "ep-1-1", seasonNumber: 1, episodeNumber: 1 },
      counts,
    );
    expect(s.state).toBe("save");
  });
});

describe("resolveButtonState — season", () => {
  it("[offline-estimator] season + nothing local → save", () => {
    const counts = collectOfflineLocalCounts(makeTvDetails(), new Set());
    const s = resolveButtonState({ kind: "season", seasonNumber: 1 }, counts);
    expect(s.state).toBe("save");
  });

  it("[offline-estimator] season + 2/4 saved → complete (with count)", () => {
    const counts = collectOfflineLocalCounts(makeTvDetails(), new Set(["file-1-1", "file-1-2"]));
    const s = resolveButtonState({ kind: "season", seasonNumber: 1 }, counts);
    console.info("[offline-estimator] season state", s);
    expect(s.state).toBe("complete");
    expect(s.badgeCount).toEqual({ local: 2, total: 4 });
  });

  it("[offline-estimator] season + all 4 saved → delete", () => {
    const counts = collectOfflineLocalCounts(
      makeTvDetails(),
      new Set(["file-1-1", "file-1-2", "file-1-3", "file-1-4"]),
    );
    const s = resolveButtonState({ kind: "season", seasonNumber: 1 }, counts);
    expect(s.state).toBe("delete");
    expect(s.badgeCount).toEqual({ local: 4, total: 4 });
  });

  it("[offline-estimator] season with no playable files → hidden", () => {
    const counts = collectOfflineLocalCounts(makeTvDetails(), new Set());
    // Ask for a non-existent season
    const s = resolveButtonState({ kind: "season", seasonNumber: 99 }, counts);
    expect(s.state).toBe("hidden");
  });
});

describe("resolveButtonState — show", () => {
  it("[offline-estimator] show + nothing local → save", () => {
    const counts = collectOfflineLocalCounts(makeTvDetails(), new Set());
    const s = resolveButtonState({ kind: "show" }, counts);
    expect(s.state).toBe("save");
  });

  it("[offline-estimator] show + partial → complete with X/Y count", () => {
    const counts = collectOfflineLocalCounts(makeTvDetails(), new Set(["file-1-1", "file-2-1"]));
    const s = resolveButtonState({ kind: "show" }, counts);
    console.info("[offline-estimator] show state", s);
    expect(s.state).toBe("complete");
    expect(s.badgeCount).toEqual({ local: 2, total: 8 });
  });

  it("[offline-estimator] show + all → delete", () => {
    const allFileIds = new Set([
      "file-1-1", "file-1-2", "file-1-3", "file-1-4",
      "file-2-1", "file-2-2", "file-2-3", "file-2-4",
    ]);
    const counts = collectOfflineLocalCounts(makeTvDetails(), allFileIds);
    const s = resolveButtonState({ kind: "show" }, counts);
    expect(s.state).toBe("delete");
    expect(s.badgeCount).toEqual({ local: 8, total: 8 });
  });

  it("[offline-estimator] show with no episodes → hidden", () => {
    const details = makeTvDetails({ episodes: [], files: [], formats: [] });
    const counts = collectOfflineLocalCounts(details, new Set());
    const s = resolveButtonState({ kind: "show" }, counts);
    expect(s.state).toBe("hidden");
  });
});

// ---------------------------------------------------------------------------
// inScopeFileIds + resolveScopeMediaIds
// ---------------------------------------------------------------------------

describe("inScopeFileIds", () => {
  it("[offline-estimator] movie scope → the movie file", () => {
    const ids = inScopeFileIds(makeMovieDetails(), { kind: "movie" });
    expect(ids).toEqual(new Set(["movie-file-1"]));
  });

  it("[offline-estimator] episode scope → just the one file", () => {
    const ids = inScopeFileIds(makeTvDetails(), {
      kind: "episode",
      episodeId: "ep-1-2",
      seasonNumber: 1,
      episodeNumber: 2,
    });
    expect(ids).toEqual(new Set(["file-1-2"]));
  });

  it("[offline-estimator] season scope → all episodes of that season", () => {
    const ids = inScopeFileIds(makeTvDetails(), { kind: "season", seasonNumber: 1 });
    expect(ids).toEqual(new Set(["file-1-1", "file-1-2", "file-1-3", "file-1-4"]));
  });

  it("[offline-estimator] show scope → every episode file", () => {
    const ids = inScopeFileIds(makeTvDetails(), { kind: "show" });
    expect(ids.size).toBe(8);
  });
});

describe("resolveScopeMediaIds", () => {
  it.each<OfflineScope>([
    { kind: "movie" },
    { kind: "show" },
    { kind: "season", seasonNumber: 1 },
    { kind: "episode", episodeId: "ep-1-1", seasonNumber: 1, episodeNumber: 1 },
  ])("[offline-estimator] returns [details.id] for every scope", (scope) => {
    const ids = resolveScopeMediaIds(makeTvDetails(), scope);
    expect(ids).toEqual(["show-1"]);
  });
});
