/**
 * @test-id LIB-PREVIEW-SHEETS-003
 * @level integration (real LibraryDb + bun:sqlite)
 *
 * MPV-PREV-03 (catch-up pass): the runtime's background pass asks the library which videos still have no seek-bar
 * preview sheets. `listPreviewSheetCandidates` lists the source format of every video file none of whose formats
 * has a record, newest file first, and skips the formats the caller excludes (exhausted retries). The source
 * format is the flagged row, or the highest quality when the import flagged none (sheets then sit on that row).
 *
 * @req MPV-PREV-03[runtime]
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
};

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

describe("videos still owed preview sheets (MPV-PREV-03)", () => {
  it("lists the source format of every video without sheets, newest first, minus the excluded ones", async () => {
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
});
