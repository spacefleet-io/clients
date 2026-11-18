/**
 * @test-id LIB-PREVIEW-SHEETS-001
 * @level integration (real LibraryDb + bun:sqlite)
 *
 * MPV-PREV-02 (record half): the seek-bar preview sheets made after the source commit are recorded
 * on the video's source format (`media_formats.preview_sheets`, JSON `MediaPreviewSheets`) so every
 * player finds the sheet and the picture for any moment. This pins, on the real LibraryDb:
 *   1. `setMediaFormatPreviewSheets(formatId, record)` round-trips through `getMediaDetails` and
 *      `listMediaFormats`; a format without previews reads `null`; a format that is gone answers
 *      false so the caller releases the sheets;
 *   2. the queued `media.upsert` carries the record and replays it into a fresh library (the column
 *      syncs; additive, no op-stream bump);
 *   3. the sheet keys are owned by the media: `collectMediaStorageKeys` and `getMediaObjectKeys`
 *      list them (delete + storage GC), and `getMediaStorageBytes` is unchanged (quota untouched);
 *   4. a missing sheet clears the previews in `purgeMissingObjects` and keeps the playable format.
 *
 * @req MPV-PREV-02[runtime]
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ensureLibrarySchema, type SqliteDb } from "@space/library-db-definition/migrations";
import { buildOpStatements } from "@space/library-db-definition/ops";
import type { LibraryOp } from "@space/shared/libraryOps";
import { locatePreviewPicture, type MediaPreviewSheets } from "@space/shared/previewSheets";
import { LibraryDb } from "../src/libraryDb";

const TAG = "[LIB-PREVIEW-SHEETS-001]";
let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-preview-sheets-"));
  process.env.SF_USER_DATA_PATH = root;
  console.info(`${TAG} setup root=${root}`);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
});

const MOVIE = {
  id: 77_101,
  type: "movie" as const,
  title: "Preview Sheets Movie",
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
};

const PLACEMENT = "media/0123456789abcdef0123456789abcdef";

// 503 s at one picture per 5 s = 101 pictures: one full 10 x 10 sheet and one with a single picture.
const PREVIEWS: MediaPreviewSheets = {
  version: 1,
  intervalSeconds: 5,
  pictureWidth: 160,
  pictureHeight: 90,
  columns: 10,
  rows: 10,
  pictureCount: 101,
  sheets: [
    { objectKey: `${PLACEMENT}/previews/sheet-000`, sizeBytes: 61_000, firstPicture: 0, pictureCount: 100 },
    { objectKey: `${PLACEMENT}/previews/sheet-001`, sizeBytes: 900, firstPicture: 100, pictureCount: 1 },
  ],
};

const addFormats = async (db: LibraryDb, mediaId: string) => {
  const sourceId = await db.addMediaFormat(
    mediaId,
    "file-1",
    "1080p",
    "h264",
    10,
    [{ key: `${PLACEMENT}/v/c0`, sizeBytes: 5_000_000, startSeconds: 0 }],
    4000,
    { initKey: `${PLACEMENT}/v/init`, initSize: 800, durationSeconds: 503, totalSize: 5_000_800, isSource: true }
  );
  await db.addMediaFormat(
    mediaId,
    "file-1",
    "360p",
    "h264",
    2,
    [{ key: `${PLACEMENT}/f/c0`, sizeBytes: 1_000_000, startSeconds: 0 }],
    800,
    { initKey: `${PLACEMENT}/f/init`, initSize: 700, durationSeconds: 503, totalSize: 1_000_700 }
  );
  const recorded = await db.setMediaFormatPreviewSheets(sourceId, PREVIEWS);
  console.info(`${TAG} setMediaFormatPreviewSheets(${sourceId})=${recorded}`);
  expect(recorded).toBe(true);
};

describe("seek-bar preview sheets in the library (MPV-PREV-02)", () => {
  it("a format that is gone answers false (the caller releases the sheets)", async () => {
    const db = await LibraryDb.openLocal("token", "key");
    try {
      db.setSyncEnabled(false);
      const recorded = await db.setMediaFormatPreviewSheets("no-such-format", PREVIEWS);
      console.info(`${TAG} missing-format recorded=${recorded}`);
      expect(recorded).toBe(false);
    } finally {
      db.close();
    }
  });

  it("getMediaFormatPreviewSheets tells a resumed run whether the format still needs previews", async () => {
    const db = await LibraryDb.openLocal("token", "key");
    try {
      db.setSyncEnabled(false);
      const mediaId = await db.addMediaFromTmdb(MOVIE);
      const pendingId = await db.addMediaFormat(mediaId, "file-1", "1080p", "h264", 10, [`${PLACEMENT}/v/c0`], 4000, { isSource: true });
      const pending = db.getMediaFormatPreviewSheets(pendingId);
      const missing = db.getMediaFormatPreviewSheets("no-such-format");
      await db.setMediaFormatPreviewSheets(pendingId, PREVIEWS);
      const recorded = db.getMediaFormatPreviewSheets(pendingId);
      console.info(`${TAG} resume-check pending=${JSON.stringify(pending)} missing=${JSON.stringify(missing)} recorded=${recorded?.previewSheets?.sheets.length}`);
      expect(pending).toEqual({ previewSheets: null });
      expect(missing).toBeNull();
      expect(recorded).toEqual({ previewSheets: PREVIEWS });
    } finally {
      db.close();
    }
  });

  it("records the sheets on the source format and reads them back; other formats read null", async () => {
    const db = await LibraryDb.openLocal("token", "key");
    try {
      db.setSyncEnabled(false);
      const mediaId = await db.addMediaFromTmdb(MOVIE);
      await addFormats(db, mediaId);
      const formats = db.getMediaDetails(mediaId)?.formats ?? [];
      const listed = db.listMediaFormats(mediaId);
      console.info(`${TAG} details=${JSON.stringify(formats.map((f) => ({ q: f.quality, src: f.isSource, previews: f.previewSheets?.sheets.length ?? null })))}`);
      const source = formats.find((format) => format.isSource);
      expect(source?.previewSheets).toEqual(PREVIEWS);
      expect(formats.find((format) => !format.isSource)?.previewSheets).toBeNull();
      expect(listed.find((format) => format.isSource)?.previewSheets).toEqual(PREVIEWS);

      // What a player does with the record: 7 min 2 s = picture 84, sheet 0, column 4, row 8.
      const at = locatePreviewPicture(source?.previewSheets, 422);
      console.info(`${TAG} locate(422)=${JSON.stringify(at)}`);
      expect(at).toMatchObject({ sheetIndex: 0, pictureIndex: 84, x: 4 * 160, y: 8 * 90, width: 160, height: 90 });
      expect(locatePreviewPicture(source?.previewSheets, 502)).toMatchObject({ sheetIndex: 1, pictureIndex: 100, x: 0, y: 0 });
    } finally {
      db.close();
    }
  });

  it("the queued media.upsert carries the record and replays it into a fresh library", async () => {
    const db = await LibraryDb.openLocal("token", "key");
    try {
      db.setSyncEnabled(true);
      const mediaId = await db.addMediaFromTmdb(MOVIE);
      await addFormats(db, mediaId);
      // Test seam: the op queue the sync uploads (PendingOp rows are LibraryOps on the wire).
      const ops = (db as unknown as { pendingOps: LibraryOp[] }).pendingOps;
      const upserts = ops.filter((op) => op.type === "media.upsert");
      const last = upserts[upserts.length - 1];
      console.info(`${TAG} pending=${ops.length} upserts=${upserts.length} lastType=${last?.type}`);
      expect(last?.type).toBe("media.upsert");
      if (last?.type !== "media.upsert") return;
      expect(last.payload.details.formats?.find((format) => format.isSource)?.previewSheets).toEqual(PREVIEWS);

      const fresh = new Database(":memory:");
      ensureLibrarySchema(fresh as unknown as SqliteDb, "playback");
      let seq = 0;
      for (const statement of buildOpStatements(last, () => `gen-${++seq}`).playback ?? []) {
        fresh.prepare(statement.sql).run(...(statement.params as Array<string | number | null>));
      }
      const replayed = fresh
        .prepare("SELECT quality, is_source AS isSource, preview_sheets AS previews FROM media_formats ORDER BY quality;")
        .all() as Array<{ quality: string; isSource: number; previews: string | null }>;
      console.info(`${TAG} replayed=${JSON.stringify(replayed.map((row) => ({ ...row, previews: row.previews?.length ?? null })))}`);
      fresh.close();
      expect(JSON.parse(replayed.find((row) => row.isSource === 1)?.previews ?? "null")).toEqual(PREVIEWS);
      expect(replayed.find((row) => row.isSource === 0)?.previews).toBeNull();
    } finally {
      db.close();
    }
  });

  it("the sheets belong to the media for deletion and GC, without counting towards its stored bytes", async () => {
    const db = await LibraryDb.openLocal("token", "key");
    try {
      db.setSyncEnabled(false);
      const mediaId = await db.addMediaFromTmdb(MOVIE);
      await addFormats(db, mediaId);
      const sheetKeys = PREVIEWS.sheets.map((sheet) => sheet.objectKey);
      const storageKeys = db.collectMediaStorageKeys(mediaId);
      const objectKeys = db.getMediaObjectKeys(mediaId);
      const bytes = db.getMediaStorageBytes(mediaId);
      console.info(`${TAG} storageKeys=${storageKeys.length} objectKeys=${objectKeys.length} bytes=${bytes}`);
      expect(storageKeys).toEqual(expect.arrayContaining(sheetKeys));
      expect(objectKeys).toEqual(expect.arrayContaining(sheetKeys));
      expect(bytes).toBe(5_000_800 + 1_000_700);
    } finally {
      db.close();
    }
  });

  it("a missing sheet drops the previews and keeps the playable format", async () => {
    const db = await LibraryDb.openLocal("token", "key");
    try {
      db.setSyncEnabled(false);
      const mediaId = await db.addMediaFromTmdb(MOVIE);
      await addFormats(db, mediaId);
      await db.purgeMissingObjects([PREVIEWS.sheets[1]!.objectKey]);
      const formats = db.getMediaDetails(mediaId)?.formats ?? [];
      console.info(`${TAG} afterPurge=${JSON.stringify(formats.map((f) => ({ q: f.quality, previews: f.previewSheets?.sheets.length ?? null })))}`);
      expect(formats).toHaveLength(2);
      expect(formats.find((format) => format.isSource)?.previewSheets).toBeNull();
    } finally {
      db.close();
    }
  });
});
