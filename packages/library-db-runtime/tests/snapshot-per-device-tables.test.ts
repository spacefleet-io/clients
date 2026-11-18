/**
 * @test-id LIB-SNAPSHOT-PER-DEVICE-001
 * @level integration (real LibraryDb + bun:sqlite)
 *
 * LIB-FMT-07: the saved copy of the library ships only shared state. This pins, on the real
 * LibraryDb:
 *   1. `media_local_downloads` (files saved on THIS disk) is exported as an empty table, never
 *      with rows: another device would only see paths that mean nothing to it,
 *   2. the exported copy has no free pages,
 *   3. applying a remote copy (which may come from an older app and still carry another device's
 *      download rows) keeps THIS device's rows and drops the foreign ones,
 *   4. recording or dropping a download queues no sync op and bumps no version, so the op
 *      stream never carries it either (OFFL-SAFE-03: the download list never leaves the device).
 *
 * @req LIB-FMT-07[badger-desktop,runtime]
 * @req OFFL-SAFE-03[badger-desktop,runtime]
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { LibraryMeta } from "../src/api";
import { LibraryDb } from "../src/libraryDb";

const TAG = "[LIB-SNAPSHOT-PER-DEVICE-001]";
let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-per-device-"));
  process.env.SF_USER_DATA_PATH = root;
  console.info(`${TAG} setup root=${root}`);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
});

const MOVIE = {
  id: 66_302,
  type: "movie" as const,
  title: "Per Device Movie",
  originalTitle: null,
  originalLanguage: "en",
  overview: "x".repeat(20_000),
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

const download = (mediaId: string, id: string, localPath: string) => ({
  id,
  fileId: `file-${id}`,
  mediaId,
  quality: "1080p",
  formatId: `format-${id}`,
  container: "mkv",
  localPath,
  totalBytes: 123,
  downloadedAt: new Date().toISOString(),
  runtimeJobId: null,
});

const open = (bytes: Uint8Array, name: string) => {
  const path = join(root, name);
  writeFileSync(path, bytes);
  return new Database(path);
};

const count = (db: Database, table: string) =>
  Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table};`).get() as { n: number }).n);

describe("per-device tables stay out of snapshots (LIB-FMT-07)", () => {
  it("exports media_local_downloads empty, and with no free pages", async () => {
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);
    const mediaId = await db.addMediaFromCatalog(MOVIE);
    db.registerLocalDownload(download(mediaId, "mine", "/home/me/Videos/a.mkv"));
    expect(db.listLocalDownloads().length).toBe(1);
    const bytes = db.exportBytes();
    db.close();

    const snapshot = open(bytes, "export.sqlite");
    try {
      const tableExists = Boolean(
        snapshot.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='media_local_downloads';").get()
      );
      const freelist = Number((snapshot.prepare("PRAGMA freelist_count;").get() as { freelist_count: number }).freelist_count);
      const rows = tableExists ? count(snapshot, "media_local_downloads") : -1;
      console.info(`${TAG} export bytes=${bytes.length} tableExists=${tableExists} rows=${rows} freelist=${freelist}`);
      expect(tableExists).toBe(true);
      expect(rows).toBe(0);
      expect(freelist).toBe(0);
    } finally {
      snapshot.close();
    }
  });

  it("applying a remote copy keeps this device's downloads and drops a foreign device's rows", async () => {
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);
    const mediaId = await db.addMediaFromCatalog(MOVIE);
    db.registerLocalDownload(download(mediaId, "mine", "/home/me/Videos/a.mkv"));

    // A copy saved by an older app on ANOTHER device: it still carries that device's download row.
    const remotePath = join(root, "remote.sqlite");
    writeFileSync(remotePath, db.exportBytes());
    const remote = new Database(remotePath);
    remote
      .prepare(
        `INSERT INTO media_local_downloads (id, file_id, media_id, quality, format_id, container, local_path, total_bytes, downloaded_at, schema_version)
         VALUES ('foreign', 'file-foreign', ?, '720p', 'format-foreign', 'mkv', 'D:\\\\Other\\\\b.mkv', 9, ?, 1);`
      )
      .run(mediaId, new Date().toISOString());
    console.info(`${TAG} foreign remote rows=${count(remote, "media_local_downloads")}`);
    remote.close();
    const remoteBytes = new Uint8Array(await Bun.file(remotePath).arrayBuffer());

    const internals = db as unknown as { remoteVersion: number };
    const outcome = await db.applyPreparedRemoteSync({
      kind: "snapshot",
      meta: { stateHash: null, lastOpId: null, updatedAt: null } as unknown as LibraryMeta,
      fromVersion: internals.remoteVersion,
      snapshotVersion: internals.remoteVersion + 1,
      updatedAt: null,
      bytes: remoteBytes,
    });
    const after = db.listLocalDownloads().map((row) => row.id).sort();
    console.info(`${TAG} applied outcome=${outcome} downloadsAfter=${JSON.stringify(after)}`);
    try {
      expect(outcome).toBe(true);
      expect(after).toEqual(["mine"]);
      expect(db.getMediaDetails(mediaId)?.title).toBe(MOVIE.title);
    } finally {
      db.close();
    }
  });

  it("OFFL-SAFE-03 recording and dropping a download queues no sync op and bumps no version", async () => {
    const db = await LibraryDb.openLocal("token", "key");
    const internals = db as unknown as {
      pendingOps: Array<{ type: string }>;
      syncEnabled: boolean;
      scheduleOpsFlush: () => void;
      flushOps: () => Promise<void>;
    };
    // Queue ops as a signed-in device does, but never upload them (no server here).
    internals.scheduleOpsFlush = () => {};
    internals.flushOps = async () => {};
    internals.syncEnabled = true;
    const mediaId = await db.addMediaFromCatalog(MOVIE);
    await Promise.resolve();
    const opsBefore = internals.pendingOps.map((op) => op.type);
    const versionBefore = db.getVersion();
    console.info(`${TAG} OFFL-SAFE-03 phase=before ops=${JSON.stringify(opsBefore)} version=${versionBefore}`);
    try {
      // Control: a shared library change does reach the op stream.
      expect(opsBefore.length).toBeGreaterThan(0);
      db.registerLocalDownload(download(mediaId, "mine", "/home/me/Videos/a.mkv"));
      const opsAfterAdd = internals.pendingOps.map((op) => op.type);
      console.info(`${TAG} OFFL-SAFE-03 phase=after-add ops=${JSON.stringify(opsAfterAdd)} version=${db.getVersion()}`);
      expect(opsAfterAdd).toEqual(opsBefore);
      expect(db.getVersion()).toBe(versionBefore);

      db.dropLocalDownloads({ type: "media", mediaId });
      const opsAfterDrop = internals.pendingOps.map((op) => op.type);
      console.info(`${TAG} OFFL-SAFE-03 phase=after-drop ops=${JSON.stringify(opsAfterDrop)} version=${db.getVersion()} rows=${db.listLocalDownloads().length}`);
      expect(db.listLocalDownloads().length).toBe(0);
      expect(opsAfterDrop).toEqual(opsBefore);
      expect(db.getVersion()).toBe(versionBefore);
    } finally {
      db.close();
    }
  });
});
