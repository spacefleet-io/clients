/**
 * @test-id LIB-PREVIEW-SHEETS-003
 * @level integration (real LibraryDb + bun:sqlite)
 *
 * MPV-PREV-03 (catch-up pass): the runtime's background pass asks the library which videos still have no seek-bar
 * preview sheets or their skip signature. `listPreviewSheetCandidates` lists the source format of every video file
 * none of whose formats has a record (or, for sheets recorded without a signature, the row holding them; META-SKIP-04),
 * the title watched last first, then the newest file, a show's episodes together in order, and skips the formats the caller excludes (exhausted retries). The source
 * format is the flagged row, or the highest quality when the import flagged none (sheets then sit on that row).
 *
 * MPV-PREV-07 (the Jobs card's detailed list): `listSkipCatchUpVideos` lists every counted video with the format the
 * pass works on, whether its skip signature is made, and whether an intro / credits skip is stored for it.
 *
 * @req MPV-PREV-03[runtime]
 * @req META-SKIP-04[runtime]
 * @req MPV-PREV-07[runtime]
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import type { MediaPreviewSheets } from "@space/shared/previewSheets";
import { LibraryDb } from "../src/libraryDb";

const TAG = "[LIB-PREVIEW-SHEETS-003]";
let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-preview-candidates-"));
  process.env.SF_USER_DATA_PATH = root;
  console.info(`${TAG} setup root=${root}`);
});
afterEach(() => {
  setSystemTime();
  rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
});

const movie = (id: number, title: string) => ({
  id,
  type: "movie" as const,
  title,
  originalTitle: null,
  originalLanguage: "en",
  overview: "",
  year: "2026",
  rating: null,
  posterPath: null,
  backdropPath: null,
  genres: [],
  cast: [],
  trailers: [],
  totalEpisodes: null,
  seasons: [],
  episodes: [],
});

const PLACEMENT = "media/0123456789abcdef0123456789abcdef";

const PREVIEWS: MediaPreviewSheets = {
  version: 1,
  intervalSeconds: 5,
  pictureWidth: 160,
  pictureHeight: 90,
  columns: 10,
  rows: 10,
  pictureCount: 1,
  sheets: [{ objectKey: `${PLACEMENT}/previews/sheet-000`, sizeBytes: 900, firstPicture: 0, pictureCount: 1 }],
  skipSignature: { objectKey: `${PLACEMENT}/previews/skip-signature`, sizeBytes: 4000, version: 1 },
};
/** Sheets recorded before skip signatures existed. */
const { skipSignature: _unused, ...SHEETS_ONLY } = PREVIEWS;

/** One imported video: a file, its source format and a 360p copy. Returns the source format id. */
const importVideo = async (db: LibraryDb, catalogId: number, title: string) => {
  const mediaId = await db.addMediaFromCatalog(movie(catalogId, title));
  const fileId = await db.linkFileToMedia(mediaId, `/videos/${title}.mkv`);
  const sourceId = await db.addMediaFormat(mediaId, fileId, "1080p", "h264", 10, [`${PLACEMENT}/${catalogId}/c0`], 4000, {
    initKey: `${PLACEMENT}/${catalogId}/init`,
    durationSeconds: 600,
    isSource: true,
  });
  await db.addMediaFormat(mediaId, fileId, "360p", "h264", 2, [`${PLACEMENT}/${catalogId}/f0`], 800, {
    initKey: `${PLACEMENT}/${catalogId}/finit`,
    durationSeconds: 600,
  });
  return { mediaId, fileId, sourceId };
};

/** One imported episode (season 1, episode 1 of a show): a file and its source format. */
const importEpisode = async (db: LibraryDb, catalogId: number, title: string) => {
  const mediaId = await db.addMediaFromCatalog({
    ...movie(catalogId, title),
    type: "tv" as const,
    seasons: [{ seasonNumber: 1, name: "Season 1", overview: null, posterPath: null, episodeCount: 1, airDate: null }],
    episodes: [{ seasonNumber: 1, episodeNumber: 1, name: "E1", overview: null, stillPath: null, airDate: null }],
    totalEpisodes: 1,
  } as never);
  const fileId = await db.linkFileToMedia(mediaId, `/videos/${title}.mkv`, 1, 1);
  const sourceId = await db.addMediaFormat(mediaId, fileId, "1080p", "h264", 10, [`${PLACEMENT}/${catalogId}/c0`], 4000, {
    initKey: `${PLACEMENT}/${catalogId}/init`,
    durationSeconds: 1300,
    isSource: true,
  });
  return { mediaId, fileId, sourceId };
};

describe("videos still owed preview sheets (MPV-PREV-03)", () => {
  it("lists the source format of every video without sheets, watched last then newest first, minus the excluded ones", async () => {
    const db = await LibraryDb.openLocal("token", "key");
    try {
      db.setSyncEnabled(false);
      // The import order the pass follows is the files' added_at.
      setSystemTime(new Date("2026-10-01T10:00:00Z"));
      const old = await importVideo(db, 88_001, "Old");
      setSystemTime(new Date("2026-10-10T10:00:00Z"));
      const done = await importVideo(db, 88_002, "Done");
      setSystemTime(new Date("2026-10-20T10:00:00Z"));
      const recent = await importVideo(db, 88_003, "Recent");
      await db.setMediaFormatPreviewSheets(done.sourceId, PREVIEWS);

      const all = db.listPreviewSheetCandidates({ limit: 10, excludeFormatIds: [] });
      console.info(`${TAG} all=${JSON.stringify(all)}`);
      expect(all.map((row) => row.formatId)).toEqual([recent.sourceId, old.sourceId]);
      expect(all[0]).toEqual({
        formatId: recent.sourceId,
        mediaId: recent.mediaId,
        fileId: recent.fileId,
        season: null,
        episode: null,
        addedAt: expect.any(String),
        durationSeconds: 600,
        initKey: `${PLACEMENT}/88003/init`,
      });

      const excluded = db.listPreviewSheetCandidates({ limit: 10, excludeFormatIds: [recent.sourceId] });
      const limited = db.listPreviewSheetCandidates({ limit: 1, excludeFormatIds: [] });
      console.info(`${TAG} excluded=${JSON.stringify(excluded.map((r) => r.formatId))} limited=${JSON.stringify(limited.map((r) => r.formatId))}`);
      expect(excluded.map((row) => row.formatId)).toEqual([old.sourceId]);
      expect(limited.map((row) => row.formatId)).toEqual([recent.sourceId]);

      // The title the user watched last goes first: its skips are wanted soonest.
      setSystemTime(new Date("2026-10-21T10:00:00Z"));
      db.setProgress(old.mediaId, 5);
      const watched = db.listPreviewSheetCandidates({ limit: 10, excludeFormatIds: [] });
      console.info(`${TAG} watched=${JSON.stringify(watched.map((r) => r.formatId))}`);
      expect(watched.map((row) => row.formatId)).toEqual([old.sourceId, recent.sourceId]);
      // MPV-PREV-07: the Jobs tab's "N of M" counts every video, done or not.
      expect(db.countPreviewSheetVideos()).toBe(3);
    } finally {
      db.close();
    }
  });

  it("with no flagged source row, picks the highest quality, and skips a file whose sheets sit on another row", async () => {
    const db = await LibraryDb.openLocal("token", "key");
    try {
      db.setSyncEnabled(false);
      // An import that named no source quality flags no row (deps-adapter commit); its sheets go on the first row.
      const unflagged = async (catalogId: number, title: string) => {
        const mediaId = await db.addMediaFromCatalog(movie(catalogId, title));
        const fileId = await db.linkFileToMedia(mediaId, `/videos/${title}.mkv`);
        const low = await db.addMediaFormat(mediaId, fileId, "480p", "h264", 2, [`${PLACEMENT}/${catalogId}/l0`], 800, {
          initKey: `${PLACEMENT}/${catalogId}/linit`,
          durationSeconds: 60,
        });
        const high = await db.addMediaFormat(mediaId, fileId, "720p", "h264", 18, [`${PLACEMENT}/${catalogId}/h0`], 2500, {
          initKey: `${PLACEMENT}/${catalogId}/hinit`,
          durationSeconds: 60,
        });
        return { mediaId, low, high };
      };
      setSystemTime(new Date("2026-10-01T10:00:00Z"));
      const owed = await unflagged(88_011, "Owed");
      setSystemTime(new Date("2026-10-02T10:00:00Z"));
      const made = await unflagged(88_012, "Made");
      await db.setMediaFormatPreviewSheets(made.low, PREVIEWS);

      const all = db.listPreviewSheetCandidates({ limit: 10, excludeFormatIds: [] });
      console.info(`${TAG} unflagged=${JSON.stringify(all.map((r) => r.formatId))} owedHigh=${owed.high} madeLow=${made.low}`);
      expect(all.map((row) => row.formatId)).toEqual([owed.high]);
      expect(all[0]?.initKey).toBe(`${PLACEMENT}/88011/hinit`);
    } finally {
      db.close();
    }
  });

  it("lists an episode whose sheets carry no skip signature, on the row holding them; never a film (META-SKIP-04)", async () => {
    const db = await LibraryDb.openLocal("token", "key");
    try {
      db.setSyncEnabled(false);
      setSystemTime(new Date("2026-10-01T10:00:00Z"));
      const sheetsOnly = await importEpisode(db, 88_021, "SheetsOnly");
      setSystemTime(new Date("2026-10-02T10:00:00Z"));
      const done = await importVideo(db, 88_022, "Done");
      // A film gets no skip signature (Chris 2026-11-24): its sheets alone finish it.
      const film = await importVideo(db, 88_023, "Film");
      await db.setMediaFormatPreviewSheets(sheetsOnly.sourceId, SHEETS_ONLY);
      await db.setMediaFormatPreviewSheets(done.sourceId, PREVIEWS);
      await db.setMediaFormatPreviewSheets(film.sourceId, SHEETS_ONLY);

      const all = db.listPreviewSheetCandidates({ limit: 10, excludeFormatIds: [] });
      console.info(`${TAG} sheetsOnly=${JSON.stringify(all.map((r) => r.formatId))} expected=${sheetsOnly.sourceId}`);
      expect(all.map((row) => row.formatId)).toEqual([sheetsOnly.sourceId]);
      expect(db.listPreviewSheetCandidates({ limit: 10, excludeFormatIds: [sheetsOnly.sourceId] })).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("lists every counted video with its signature and the skips found for it (MPV-PREV-07)", async () => {
    const db = await LibraryDb.openLocal("token", "key");
    try {
      db.setSyncEnabled(false);
      const film = await importVideo(db, 88_031, "Film");
      const showId = await db.addMediaFromCatalog({
        ...movie(88_032, "Show"),
        type: "tv" as const,
        seasons: [{ seasonNumber: 1, name: "Season 1", overview: null, posterPath: null, episodeCount: 3, airDate: null }],
        episodes: [1, 2, 3].map((n) => ({ seasonNumber: 1, episodeNumber: n, name: `E${n}`, overview: null, stillPath: null, airDate: null })),
        totalEpisodes: 3,
      } as never);
      const episode = async (n: number) => {
        const fileId = await db.linkFileToMedia(showId, `/videos/Show-${n}.mkv`, 1, n);
        return db.addMediaFormat(showId, fileId, "1080p", "h264", 10, [`${PLACEMENT}/s${n}/c0`], 4000, {
          initKey: `${PLACEMENT}/s${n}/init`,
          durationSeconds: 1300,
          isSource: true,
        });
      };
      const e1 = await episode(1);
      const e2 = await episode(2);
      const e3 = await episode(3);
      await db.setMediaFormatPreviewSheets(e1, PREVIEWS);
      await db.setMediaFormatPreviewSheets(e2, PREVIEWS);
      await db.setMediaFormatPreviewSheets(e3, SHEETS_ONLY);
      await db.setMediaFormatPreviewSheets(film.sourceId, SHEETS_ONLY);
      const episodes = db.getMediaDetails(showId)?.episodes ?? [];
      const idOf = (n: number) => episodes.find((row) => row.episodeNumber === n)?.id ?? null;
      const marker = (type: "intro" | "credits") => ({ type, startSeconds: 10, endSeconds: 40, source: "detected" });
      db.mergeSkipMarkers(showId, idOf(1), [marker("intro"), marker("credits")]);
      db.mergeSkipMarkers(showId, idOf(2), [marker("intro")]);
      // A film's stored skips (from before films got none, Chris 2026-11-24) are not reported.
      db.mergeSkipMarkers(film.mediaId, null, [marker("credits")]);

      const videos = db.listSkipCatchUpVideos();
      console.info(`${TAG} videos=${JSON.stringify(videos)}`);
      expect(videos).toHaveLength(db.countPreviewSheetVideos());
      const byFormat = new Map(videos.map((row) => [row.formatId, row]));
      expect(byFormat.get(e1)).toMatchObject({ mediaId: showId, season: 1, episode: 1, signed: true, intro: true, credits: true });
      expect(byFormat.get(e2)).toMatchObject({ signed: true, intro: true, credits: false });
      expect(byFormat.get(e3)).toMatchObject({ signed: false, intro: false, credits: false });
      expect(byFormat.get(film.sourceId)).toMatchObject({ season: null, episode: null, signed: true, intro: false, credits: false });
      // The 360p copies are not listed: one row per video, on the row the pass works on.
      expect(videos.map((row) => row.formatId).sort()).toEqual([e1, e2, e3, film.sourceId].sort());
    } finally {
      db.close();
    }
  });
});
