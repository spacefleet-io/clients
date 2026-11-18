/**
 * PLAY-NEXT-02 backfill (Chris 2026-10-28, "Lodgers has no TIDB data? more
 * likely an error"): TV episodes already in the library with a file but no
 * TheIntroDB marker get their markers fetched once, one request at a time, and
 * the hit/miss is recorded so the next app start does not ask again.
 *
 * Drives `runSkipMarkerBackfill` against an in-memory library (skip markers +
 * media_skip_analysis rows) and a fake TheIntroDB.
 */
// @req PLAY-NEXT-02[badger-desktop] @req META-SKIP-03[badger-desktop]
import { describe, expect, it } from "vitest";
import { MetadataUnavailableError } from "@space/metadata-client";
import type { MediaDetails, MediaRow, MediaSkipMarker } from "@space/shared/libraryTypes";
import {
  EXTERNAL_SKIP_MARKER_FETCH_KIND,
  EXTERNAL_SKIP_MARKER_SHOW_KIND,
  createShowSkipCachePayload,
  type ExternalSkipMarkerFetchResult,
  type ShowSkipMarker,
} from "../src/shared/skipMarkerCache";
import {
  SKIP_BACKFILL_REQUEST_GAP_MS,
  runSkipMarkerBackfill,
  selectSkipBackfillEpisodes,
  type SkipAnalysisRow,
  type SkipBackfillDeps,
} from "../src/renderer/src/lib/skipMarkerBackfill";

const P = "[skip-marker-backfill]";
const NOW = Date.parse("2026-10-28T12:00:00.000Z");

const intro: ShowSkipMarker = { type: "intro", startSeconds: 0, endSeconds: 46, source: "external:theintrodb-v3", confidence: null };

const showRow = (id: string, tmdbId: number, title: string): MediaRow => ({
  id,
  type: "tv",
  tmdbId,
  externalIds: null,
  title,
  originalTitle: title,
  originalLanguage: "en",
  overview: null,
  year: "1994",
  rating: null,
  posterPath: null,
  backdropPath: null,
  genres: [],
  addedAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  hasFiles: true,
  progressPct: 0,
  lastWatchedAt: null,
  totalEpisodes: 236,
  episodeCount: 4,
});

/** A show with episodes S01E01..S01E0n; `withFiles` lists which have a file (duration 1370 s). */
const showDetails = (row: MediaRow, episodes: number, withFiles: number[], skipMarkers: MediaSkipMarker[] = []): MediaDetails => ({
  ...row,
  cast: [],
  playlistIds: [],
  seasons: [],
  episodes: Array.from({ length: episodes }, (_, i) => ({
    id: `${row.id}-ep${i + 1}`,
    seasonNumber: 1,
    episodeNumber: i + 1,
    name: `Episode ${i + 1}`,
    overview: null,
    stillPath: null,
    airDate: null,
  })),
  trailers: [],
  files: withFiles.map((n) => ({ id: `${row.id}-file${n}`, filename: `/v/S01E0${n}.mkv`, season: 1, episode: n, desiredFormats: [] })),
  formats: withFiles.map((n) => ({
    id: `${row.id}-fmt${n}`,
    mediaId: row.id,
    fileId: `${row.id}-file${n}`,
    quality: "1080p",
    codec: "h264",
    bitrateKbps: null,
    sizeMb: 700,
    initKey: null,
    initSize: null,
    durationSeconds: 1370 + n,
    totalSize: null,
    chunks: [],
  })),
  audioTracks: [],
  subtitleTracks: [],
  subtitles: [],
  chapters: [],
  skipMarkers,
  hasLocalFiles: false,
});

const storedMarker = (mediaId: string, episodeId: string, source: string, type: "intro" | "credits" = "intro"): MediaSkipMarker => ({
  id: `${episodeId}-${type}-${source}`,
  mediaId,
  episodeId,
  type,
  startSeconds: type === "intro" ? 0 : 1300,
  endSeconds: type === "intro" ? 40 : 1370,
  source,
  confidence: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
});

type FakeLibrary = {
  details: Map<string, MediaDetails>;
  analysis: Array<SkipAnalysisRow & { mediaId: string; kind: string }>;
  written: Map<string, ShowSkipMarker[]>;
  requests: string[];
  sleeps: number[];
  logs: string[];
};

const makeDeps = (
  lib: FakeLibrary,
  answer: (req: { tmdbId: number; seasonNumber: number; episodeNumber: number; durationSeconds: number | null }) => ExternalSkipMarkerFetchResult | Error,
): SkipBackfillDeps => ({
  fetchMediaDetails: async (mediaId) => lib.details.get(mediaId) ?? null,
  listSkipAnalysis: async (mediaId, kind) => lib.analysis.filter((row) => row.mediaId === mediaId && row.kind === kind),
  upsertSkipAnalysis: async (mediaId, episodeId, kind, payload) => {
    lib.analysis = lib.analysis.filter((row) => !(row.mediaId === mediaId && row.episodeId === episodeId && row.kind === kind));
    lib.analysis.push({ mediaId, episodeId, kind, payload, updatedAt: new Date(NOW).toISOString() });
  },
  replaceSkipMarkers: async (mediaId, episodeId, markers) => {
    lib.written.set(`${mediaId}/${episodeId}`, markers);
    // Mirror into the details so a second run sees the stored markers, like the real library.
    const details = lib.details.get(mediaId);
    if (details && episodeId) {
      details.skipMarkers = [
        ...details.skipMarkers.filter((m) => m.episodeId !== episodeId),
        ...markers.map((m) => ({ ...storedMarker(mediaId, episodeId, m.source, m.type), ...m, confidence: m.confidence ?? null })),
      ];
    }
  },
  fetchMarkers: async (req) => {
    lib.requests.push(`${req.tmdbId}:${req.seasonNumber}:${req.episodeNumber}:dur=${req.durationSeconds}`);
    const result = answer(req);
    if (result instanceof Error) throw result;
    return result;
  },
  sleep: async (ms) => {
    lib.sleeps.push(ms);
  },
  log: (message, details) => {
    lib.logs.push(`${message} ${JSON.stringify(details)}`);
  },
  now: () => NOW,
});

const hitOrMiss = (hits: number[]) => (req: { seasonNumber: number; episodeNumber: number }): ExternalSkipMarkerFetchResult => {
  const hit = hits.includes(req.episodeNumber);
  return {
    provider: "theintrodb-v3",
    fetchedAt: new Date(NOW).toISOString(),
    markers: hit
      ? [{ ...intro, endSeconds: 46, extendsToEof: false, version: "v3", meta: null }]
      : [],
    coverage: [{ seasonNumber: req.seasonNumber, episodeNumber: req.episodeNumber, status: hit ? "hit" : "miss" }],
  };
};

const newLibrary = (): FakeLibrary => ({ details: new Map(), analysis: [], written: new Map(), requests: [], sleeps: [], logs: [] });

const dump = (label: string, lib: FakeLibrary) => {
  console.info(`=== ${P}:${label} ===`);
  console.info(`requests=${JSON.stringify(lib.requests)}`);
  console.info(`written=${JSON.stringify([...lib.written.entries()])}`);
  console.info(`analysis=${JSON.stringify(lib.analysis.map((r) => ({ mediaId: r.mediaId, episodeId: r.episodeId, kind: r.kind, payload: r.payload })))}`);
  console.info(`logs:\n${lib.logs.join("\n")}`);
  console.info(`=== ${P}:${label} end ===`);
};

describe("selectSkipBackfillEpisodes", () => {
  const row = showRow("lodgers", 901668, "Lodgers");

  it("picks only episodes with a file and no complete TheIntroDB markers or recent answer", () => {
    const details = showDetails(row, 6, [1, 2, 3, 4, 5], [
      storedMarker("lodgers", "lodgers-ep2", "external:theintrodb-v3", "intro"),
      storedMarker("lodgers", "lodgers-ep2", "external:theintrodb-v3", "credits"),
      // A marker from another source does not count as TheIntroDB data.
      storedMarker("lodgers", "lodgers-ep3", "internal:chapters"),
    ]);
    const cache = createShowSkipCachePayload({
      showTmdbId: 901668,
      fetchedAt: new Date(NOW - 1000).toISOString(),
      coverage: [{ seasonNumber: 1, episodeNumber: 4, status: "miss" }],
      markersByEpisode: {},
    });
    const fetchRows: SkipAnalysisRow[] = [
      { episodeId: "lodgers-ep5", payload: { provider: "theintrodb-v3", status: "hit", fetchedAt: new Date(NOW).toISOString() }, updatedAt: "" },
    ];
    const selected = selectSkipBackfillEpisodes(details, cache, fetchRows, NOW);
    console.info(`${P}:selected=${JSON.stringify(selected)}`);
    // ep1: file, nothing known → fetch. ep2: intro + credits from TheIntroDB. ep3: other-source marker only → fetch.
    // ep4: cached miss 1 s ago. ep5: per-episode answer just now. ep6: no file.
    expect(selected.map((e) => e.episodeId)).toEqual(["lodgers-ep1", "lodgers-ep3"]);
    expect(selected[0]).toMatchObject({ seasonNumber: 1, episodeNumber: 1, durationSeconds: 1371, cachedMarkers: null });
  });

  it("a cached hit whose markers never reached the episode is written from the cache", () => {
    const details = showDetails(row, 2, [1, 2]);
    const cache = createShowSkipCachePayload({
      showTmdbId: 901668,
      fetchedAt: new Date(NOW - 1000).toISOString(),
      coverage: [{ seasonNumber: 1, episodeNumber: 1, status: "hit", markerTypes: ["intro"] }],
      markersByEpisode: { "1:1": [intro] },
    });
    const selected = selectSkipBackfillEpisodes(details, cache, [], NOW);
    console.info(`${P}:selected=${JSON.stringify(selected)}`);
    expect(selected).toEqual([
      { episodeId: "lodgers-ep1", seasonNumber: 1, episodeNumber: 1, durationSeconds: null, cachedMarkers: [intro] },
      { episodeId: "lodgers-ep2", seasonNumber: 1, episodeNumber: 2, durationSeconds: 1372, cachedMarkers: null },
    ]);
  });

  it("asks again after META-SKIP-02's wait: 1 day for an empty answer, 7 days for intro or credits only", () => {
    const DAY = 24 * 60 * 60 * 1000;
    const details = showDetails(row, 6, [1, 2, 3, 4, 5, 6], [
      // ep3, ep4: intro only. ep5: complete, asked long ago. ep6: intro only, never recorded when.
      storedMarker("lodgers", "lodgers-ep3", "external:theintrodb-v3", "intro"),
      storedMarker("lodgers", "lodgers-ep4", "external:theintrodb-v3", "intro"),
      storedMarker("lodgers", "lodgers-ep5", "external:theintrodb-v3", "intro"),
      storedMarker("lodgers", "lodgers-ep5", "external:theintrodb-v3", "credits"),
      storedMarker("lodgers", "lodgers-ep6", "external:theintrodb-v3", "intro"),
    ]);
    const answered = (episodeId: string, status: "hit" | "miss", ageMs: number): SkipAnalysisRow => ({
      episodeId,
      payload: { provider: "theintrodb-v3", status, fetchedAt: new Date(NOW - ageMs).toISOString() },
      updatedAt: "",
    });
    const fetchRows = [
      answered("lodgers-ep1", "miss", 2 * DAY), // empty, 2 days ago → ask again
      answered("lodgers-ep2", "miss", DAY / 2), // empty, 12 h ago → wait
      answered("lodgers-ep3", "hit", 8 * DAY), // intro only, 8 days ago → ask again
      answered("lodgers-ep4", "hit", 3 * DAY), // intro only, 3 days ago → wait
      answered("lodgers-ep5", "hit", 300 * DAY), // complete → never
    ];
    const selected = selectSkipBackfillEpisodes(details, null, fetchRows, NOW);
    console.info(`${P}:retry-selected=${JSON.stringify(selected.map((e) => e.episodeId))}`);
    expect(selected.map((e) => e.episodeId)).toEqual(["lodgers-ep1", "lodgers-ep3", "lodgers-ep6"]);
  });
});

describe("runSkipMarkerBackfill", () => {
  it("Lodgers imported without markers: fetches each episode once, writes the intro, records hit/miss, second run asks nothing", async () => {
    const lib = newLibrary();
    const lodgers = showRow("lodgers", 901668, "Lodgers");
    const movie: MediaRow = { ...showRow("orchard", 903549, "Orchard"), type: "movie" };
    lib.details.set("lodgers", showDetails(lodgers, 5, [1, 2, 3, 4]));
    const deps = makeDeps(lib, hitOrMiss([1, 2, 3]));

    const first = await runSkipMarkerBackfill([lodgers, movie], deps);
    dump("first-run", lib);
    expect(lib.requests).toEqual([
      "901668:1:1:dur=1371",
      "901668:1:2:dur=1372",
      "901668:1:3:dur=1373",
      "901668:1:4:dur=1374",
    ]);
    // One request at a time with a polite gap between them.
    expect(lib.sleeps).toEqual([SKIP_BACKFILL_REQUEST_GAP_MS, SKIP_BACKFILL_REQUEST_GAP_MS, SKIP_BACKFILL_REQUEST_GAP_MS]);
    expect(lib.written.get("lodgers/lodgers-ep1")).toEqual([intro]);
    expect(lib.written.has("lodgers/lodgers-ep4")).toBe(false);
    expect(first).toMatchObject({ shows: 1, showsWithWork: 1, fetched: 4, hits: 3, misses: 1, failed: 0, stoppedEarly: null });

    const episodeRows = lib.analysis.filter((r) => r.kind === EXTERNAL_SKIP_MARKER_FETCH_KIND);
    expect(episodeRows.map((r) => `${r.episodeId}:${String(r.payload.status)}`).sort()).toEqual([
      "lodgers-ep1:hit",
      "lodgers-ep2:hit",
      "lodgers-ep3:hit",
      "lodgers-ep4:miss",
    ]);
    const showCache = lib.analysis.find((r) => r.kind === EXTERNAL_SKIP_MARKER_SHOW_KIND && r.episodeId === null);
    expect(showCache?.payload).toMatchObject({ showTmdbId: 901668, markersByEpisode: { "1:1": [intro], "1:2": [intro], "1:3": [intro] } });

    lib.requests.length = 0;
    const second = await runSkipMarkerBackfill([lodgers, movie], deps);
    dump("second-run", lib);
    expect(lib.requests).toEqual([]);
    expect(second).toMatchObject({ showsWithWork: 0, fetched: 0 });
  });

  it("keeps a credits marker from another source when TheIntroDB only knows the intro", async () => {
    const lib = newLibrary();
    const show = showRow("b99", 48891, "Brooklyn Nine-Nine");
    lib.details.set("b99", showDetails(show, 1, [1], [storedMarker("b99", "b99-ep1", "internal:chapters", "credits")]));
    await runSkipMarkerBackfill([show], makeDeps(lib, hitOrMiss([1])));
    dump("merge", lib);
    expect(lib.written.get("b99/b99-ep1")).toEqual([
      intro,
      { type: "credits", startSeconds: 1300, endSeconds: 1370, source: "internal:chapters", confidence: null },
    ]);
  });

  it("stops at a rate limit answer and keeps what it already got", async () => {
    const lib = newLibrary();
    const show = showRow("lodgers", 901668, "Lodgers");
    lib.details.set("lodgers", showDetails(show, 3, [1, 2, 3]));
    const summary = await runSkipMarkerBackfill(
      [show],
      makeDeps(lib, (req) => (req.episodeNumber === 2 ? new MetadataUnavailableError(503, 5, "upstream_capacity") : hitOrMiss([1, 3])(req))),
    );
    dump("rate-limit", lib);
    expect(lib.requests.map((r) => r.split(":dur")[0])).toEqual(["901668:1:1", "901668:1:2"]);
    expect(summary.stoppedEarly).toContain("metadata service unavailable (503)");
    expect(lib.written.get("lodgers/lodgers-ep1")).toEqual([intro]);
    // The failed episode is not recorded, so the next app start retries it.
    expect(lib.analysis.some((r) => r.episodeId === "lodgers-ep2")).toBe(false);
    const showCache = lib.analysis.find((r) => r.kind === EXTERNAL_SKIP_MARKER_SHOW_KIND);
    expect(showCache?.payload).toMatchObject({ coverage: [{ seasonNumber: 1, episodeNumber: 1, status: "hit" }] });
  });

  it("writes cached markers without any request", async () => {
    const lib = newLibrary();
    const show = showRow("lodgers", 901668, "Lodgers");
    lib.details.set("lodgers", showDetails(show, 1, [1]));
    lib.analysis.push({
      mediaId: "lodgers",
      episodeId: null,
      kind: EXTERNAL_SKIP_MARKER_SHOW_KIND,
      payload: createShowSkipCachePayload({
        showTmdbId: 901668,
        fetchedAt: new Date(NOW - 60_000).toISOString(),
        coverage: [{ seasonNumber: 1, episodeNumber: 1, status: "hit", markerTypes: ["intro"] }],
        markersByEpisode: { "1:1": [intro] },
      }),
      updatedAt: new Date(NOW - 60_000).toISOString(),
    });
    const summary = await runSkipMarkerBackfill([show], makeDeps(lib, hitOrMiss([])));
    dump("from-cache", lib);
    expect(lib.requests).toEqual([]);
    expect(summary.writtenFromCache).toBe(1);
    expect(lib.written.get("lodgers/lodgers-ep1")).toEqual([intro]);
  });
});
