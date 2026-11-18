/**
 * @test-id LIB-SUBTITLE-OCR-TWIN-001
 * @level integration (real LibraryDb + bun:sqlite)
 *
 * PLAY-TRACK-05: a picture subtitle (PGS / VobSub / DVB) gets an OCR text twin row. This pins, on
 * the real LibraryDb:
 *   1. `addOcrSubtitleTwin` stores an SRT row linked by `derived_from_subtitle_id`, copying the
 *      picture row's scope, never default, and is idempotent;
 *   2. `getMediaDetails` and the queued `media.upsert` carry the link, and the op replays it into
 *      a fresh library (the column syncs);
 *   3. `listSubtitleOcrCandidates` lists only picture rows without a twin, outside the retry window
 *      of their last attempt;
 *   4. the attempt bookkeeping is per-device: exported empty, kept across a remote snapshot,
 *      dropped with its media.
 *
 * @req PLAY-TRACK-05[runtime]
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ensureLibrarySchema, type SqliteDb } from "@space/library-db-definition/migrations";
import { buildOpStatements } from "@space/library-db-definition/ops";
import type { LibraryOp } from "@space/shared/libraryOps";
import type { LibraryMeta } from "../src/api";
import { LibraryDb } from "../src/libraryDb";

const TAG = "[LIB-SUBTITLE-OCR-TWIN-001]";
let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-ocr-twin-"));
  process.env.SF_USER_DATA_PATH = root;
  console.info(`${TAG} setup root=${root}`);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
});

const MOVIE = {
  id: 77_001,
  type: "movie" as const,
  title: "OCR Twin Movie",
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

const addTrack = (db: LibraryDb, mediaId: string, id: string, language: string, format: string, source = "upload") =>
  db.addSubtitleTrackWithObject({
    id,
    mediaId,
    fileId: "file-1",
    season: null,
    episode: null,
    language,
    label: `${language} (${format})`,
    objectKey: `${PLACEMENT}/subtitles/${id}.${format}`,
    format,
    isDefault: language === "en",
    source,
  });

const openFresh = async () => {
  const db = await LibraryDb.openLocal("token", "key");
  db.setSyncEnabled(false);
  return db;
};

const FAR_PAST = "2000-01-01T00:00:00.000Z";
const FAR_FUTURE = "2999-01-01T00:00:00.000Z";

describe("OCR text twin rows (PLAY-TRACK-05)", () => {
  it("stores a twin linked to its picture row, idempotently, and getMediaDetails carries the link", async () => {
    const db = await openFresh();
    try {
      const mediaId = await db.addMediaFromTmdb(MOVIE);
      await addTrack(db, mediaId, "pic-fr", "fr", "mkv");
      const first = db.addOcrSubtitleTwin({ pictureSubtitleId: "pic-fr", objectKey: `${PLACEMENT}/subtitles/fr-ocr.srt` });
      const second = db.addOcrSubtitleTwin({ pictureSubtitleId: "pic-fr", objectKey: `${PLACEMENT}/subtitles/other.srt` });
      const missing = db.addOcrSubtitleTwin({ pictureSubtitleId: "nope", objectKey: "x" });
      const tracks = db.getMediaDetails(mediaId)?.subtitleTracks ?? [];
      console.info(`${TAG} twin first=${JSON.stringify(first)} second=${JSON.stringify(second)} missing=${JSON.stringify(missing)} tracks=${JSON.stringify(tracks)}`);
      expect(first.created).toBe(true);
      if (!first.created) return;
      expect(second).toEqual({ created: false, reason: "twin_exists", id: first.id });
      expect(missing).toEqual({ created: false, reason: "picture_missing", id: null });
      expect(tracks).toHaveLength(2);
      const picture = tracks.find((track) => track.id === "pic-fr");
      const twin = tracks.find((track) => track.id === first.id);
      expect(picture?.derivedFromSubtitleId).toBeNull();
      expect(twin).toMatchObject({
        mediaId,
        fileId: "file-1",
        episodeId: picture?.episodeId ?? null,
        language: "fr",
        label: "fr (mkv)",
        objectKey: `${PLACEMENT}/subtitles/fr-ocr.srt`,
        format: "srt",
        isDefault: false,
        source: "ocr",
        derivedFromSubtitleId: "pic-fr",
      });
    } finally {
      db.close();
    }
  });

  it("the queued media.upsert carries the link and replays it into a fresh library", async () => {
    const db = await LibraryDb.openLocal("token", "key");
    try {
      db.setSyncEnabled(true);
      const mediaId = await db.addMediaFromTmdb(MOVIE);
      await addTrack(db, mediaId, "pic-de", "de", "sup");
      const twin = db.addOcrSubtitleTwin({ pictureSubtitleId: "pic-de", objectKey: `${PLACEMENT}/subtitles/de-ocr.srt` });
      // Test seam: the op queue the sync uploads (PendingOp rows are LibraryOps on the wire).
      const internals = db as unknown as { pendingOps: LibraryOp[] };
      const ops = internals.pendingOps;
      const upserts = ops.filter((op) => op.type === "media.upsert");
      const last = upserts[upserts.length - 1];
      console.info(`${TAG} pending=${ops.length} upserts=${upserts.length} lastType=${last?.type}`);
      expect(last?.type).toBe("media.upsert");
      if (last?.type !== "media.upsert") return;
      const wireTwin = last.payload.details.subtitleTracks.find((track) => track.id === twin.id);
      expect(wireTwin?.derivedFromSubtitleId).toBe("pic-de");

      // Replay the playback statements of that op into an empty schema: the column lands.
      const fresh = new Database(":memory:");
      ensureLibrarySchema(fresh as unknown as SqliteDb, "playback");
      let seq = 0;
      const statements = buildOpStatements(last, () => `gen-${++seq}`);
      for (const statement of statements.playback ?? []) {
        fresh.prepare(statement.sql).run(...(statement.params as Array<string | number | null>));
      }
      const replayed = fresh
        .prepare("SELECT id, format, source, derived_from_subtitle_id AS derived FROM media_subtitles ORDER BY id;")
        .all() as Array<{ id: string; format: string; source: string; derived: string | null }>;
      console.info(`${TAG} replayed=${JSON.stringify(replayed)}`);
      fresh.close();
      expect(replayed.find((row) => row.id === twin.id)).toEqual({ id: twin.id!, format: "srt", source: "ocr", derived: "pic-de" });
      expect(replayed.find((row) => row.id === "pic-de")?.derived).toBeNull();
    } finally {
      db.close();
    }
  });

  it("lists only picture rows still owed a twin, honouring each status' retry window", async () => {
    const db = await openFresh();
    try {
      const mediaId = await db.addMediaFromTmdb(MOVIE);
      await addTrack(db, mediaId, "pic-a", "en", "sup");
      await addTrack(db, mediaId, "pic-b", "fr", "mkv");
      await addTrack(db, mediaId, "pic-c", "de", "PGS");
      await addTrack(db, mediaId, "pic-d", "it", "mkv");
      await addTrack(db, mediaId, "text-e", "es", "srt");
      await addTrack(db, mediaId, "ocr-f", "pt", "sup", "ocr");
      db.addOcrSubtitleTwin({ pictureSubtitleId: "pic-a", objectKey: `${PLACEMENT}/subtitles/a.srt` });
      expect(db.recordSubtitleOcrAttempt({ subtitleId: "pic-b", mediaId, status: "failed", error: "boom" })).toEqual({ attempts: 1 });
      expect(db.recordSubtitleOcrAttempt({ subtitleId: "pic-b", mediaId, status: "failed", error: "boom again" })).toEqual({ attempts: 2 });
      db.recordSubtitleOcrAttempt({ subtitleId: "pic-c", mediaId, status: "no_text" });

      const ids = (failedRetryBefore: string, noTextRetryBefore: string, limit = 50) =>
        db.listSubtitleOcrCandidates({ limit, failedRetryBefore, noTextRetryBefore }).map((row) => row.id).sort();
      const insideBoth = ids(FAR_PAST, FAR_PAST);
      const failedDue = ids(FAR_FUTURE, FAR_PAST);
      const allDue = db.listSubtitleOcrCandidates({ limit: 50, failedRetryBefore: FAR_FUTURE, noTextRetryBefore: FAR_FUTURE });
      const limited = ids(FAR_FUTURE, FAR_FUTURE, 1);
      console.info(`${TAG} candidates insideBoth=${JSON.stringify(insideBoth)} failedDue=${JSON.stringify(failedDue)} allDue=${JSON.stringify(allDue)} limited=${JSON.stringify(limited)}`);
      expect(insideBoth).toEqual(["pic-d"]);
      expect(failedDue).toEqual(["pic-b", "pic-d"]);
      expect(allDue.map((row) => row.id).sort()).toEqual(["pic-b", "pic-c", "pic-d"]);
      expect(limited).toHaveLength(1);
      expect(allDue.find((row) => row.id === "pic-b")).toMatchObject({ attempts: 2, format: "mkv", language: "fr", fileId: "file-1" });
      expect(allDue.find((row) => row.id === "pic-c")).toMatchObject({ attempts: 1, format: "pgs" });

      // A twin clears the bookkeeping: pic-b leaves the list for good.
      db.addOcrSubtitleTwin({ pictureSubtitleId: "pic-b", objectKey: `${PLACEMENT}/subtitles/b.srt` });
      expect(ids(FAR_FUTURE, FAR_FUTURE)).toEqual(["pic-c", "pic-d"]);
    } finally {
      db.close();
    }
  });

  it("attempts never travel: exported empty, kept across a remote snapshot, dropped with their media", async () => {
    const db = await openFresh();
    try {
      const mediaId = await db.addMediaFromTmdb(MOVIE);
      await addTrack(db, mediaId, "pic-x", "fr", "mkv");
      db.recordSubtitleOcrAttempt({ subtitleId: "pic-x", mediaId, status: "failed", error: "decode" });
      const versionBefore = db.getVersion();
      db.recordSubtitleOcrAttempt({ subtitleId: "pic-x", mediaId, status: "failed", error: "decode" });
      expect(db.getVersion()).toBe(versionBefore);

      const bytes = db.exportBytes();
      const exportPath = join(root, "export.sqlite");
      writeFileSync(exportPath, bytes);
      const exported = new Database(exportPath);
      const exportedRows = Number(
        (exported.prepare("SELECT COUNT(*) AS n FROM subtitle_ocr_attempts;").get() as { n: number }).n
      );
      const exportedColumn = (exported.prepare("PRAGMA table_info(media_subtitles);").all() as Array<{ name: string }>).some(
        (column) => column.name === "derived_from_subtitle_id"
      );
      exported.close();
      console.info(`${TAG} export rows=${exportedRows} column=${exportedColumn}`);
      expect(exportedRows).toBe(0);
      expect(exportedColumn).toBe(true);

      const internals = db as unknown as { remoteVersion: number };
      const outcome = await db.applyPreparedRemoteSync({
        kind: "snapshot",
        meta: { stateHash: null, lastOpId: null, updatedAt: null } as unknown as LibraryMeta,
        fromVersion: internals.remoteVersion,
        snapshotVersion: internals.remoteVersion + 1,
        updatedAt: null,
        bytes,
      });
      const afterSnapshot = db.listSubtitleOcrCandidates({ limit: 10, failedRetryBefore: FAR_FUTURE, noTextRetryBefore: FAR_FUTURE });
      const insideWindow = db.listSubtitleOcrCandidates({ limit: 10, failedRetryBefore: FAR_PAST, noTextRetryBefore: FAR_PAST });
      console.info(`${TAG} snapshot outcome=${outcome} afterSnapshot=${JSON.stringify(afterSnapshot)} insideWindow=${insideWindow.length}`);
      expect(outcome).toBe(true);
      expect(afterSnapshot.map((row) => [row.id, row.attempts])).toEqual([["pic-x", 2]]);
      expect(insideWindow).toHaveLength(0);

      // deleteMedia asks the storage API to drop the media's objects: answer locally, never reach the network.
      const originalFetch = globalThis.fetch;
      globalThis.fetch = Object.assign(async () => new Response(JSON.stringify({ deleted: 1 }), { status: 200, headers: { "content-type": "application/json" } }), {
        preconnect: originalFetch.preconnect,
      });
      try {
        await db.deleteMedia(mediaId);
      } finally {
        globalThis.fetch = originalFetch;
      }
      await addTrack(db, await db.addMediaFromTmdb({ ...MOVIE, id: 77_002 }), "pic-x", "fr", "mkv");
      const afterDelete = db.listSubtitleOcrCandidates({ limit: 10, failedRetryBefore: FAR_FUTURE, noTextRetryBefore: FAR_FUTURE });
      console.info(`${TAG} afterDelete=${JSON.stringify(afterDelete)}`);
      expect(afterDelete.map((row) => [row.id, row.attempts])).toEqual([["pic-x", 0]]);
    } finally {
      db.close();
    }
  });
});
