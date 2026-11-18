/**
 * @bugfix @regression-proof
 *
 * Decouples mediaItems.hasFiles from linkFileToMedia. Reproduces the
 * "delete cancelled job → movie became playable" bug (Orchard) and pins the
 * playability invariant that only markMediaPlayable can flip hasFiles=true.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { LibraryDb, openSqliteDb } from "../src/libraryDb";
import { ensureLibrarySchema } from "@space/library-db-definition/migrations";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-library-playable-"));
  process.env.SF_USER_DATA_PATH = root;
  console.info(`[playable-only-on-source-success:setup] root=${root}`);
});

afterEach(() => {
  console.info(`[playable-only-on-source-success:teardown] removing root=${root}`);
  rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
});

// Suite-id: playable-only-on-source-success
// Dumps the source-job status alongside the hasFiles transitions across the
// invariant boundary. The bug shape is "hasFiles flipped without
// markMediaPlayable" — this snapshot lets you see the exact sequence.
const dumpPlayableSnapshot = (
  label: string,
  ctx: {
    db?: LibraryDb | null;
    mediaIds?: string[];
    jobIds?: string[];
    sourceJobStatuses?: Record<string, string>;
    hasFilesHistory?: Record<string, Array<{ at: string; hasFiles: boolean }>>;
  },
) => {
  try {
    console.error(`=== [playable-only-on-source-success:${label}] snapshot ===`);
    if (ctx.sourceJobStatuses) {
      console.error(`sourceJobStatuses=${JSON.stringify(ctx.sourceJobStatuses)}`);
    }
    if (ctx.hasFilesHistory) {
      console.error(`hasFiles transition history:\n${JSON.stringify(ctx.hasFilesHistory, null, 2)}`);
    }

    if (ctx.db && ctx.mediaIds) {
      const details: Record<string, unknown> = {};
      for (const id of ctx.mediaIds) {
        try {
          const md = ctx.db.getMediaDetails(id);
          details[id] = md
            ? {
                hasFiles: md.hasFiles,
                files: md.files.map((f) => ({ id: f.id, filename: f.filename })),
                formats: md.formats.length,
              }
            : "(null)";
        } catch (err) {
          details[id] = `(getMediaDetails failed: ${err instanceof Error ? err.message : String(err)})`;
        }
      }
      console.error(`current media details:\n${JSON.stringify(details, null, 2)}`);
    }

    if (ctx.db && ctx.jobIds) {
      const jobs: Record<string, unknown> = {};
      for (const jid of ctx.jobIds) {
        try {
          const ev = ctx.db.listIngestJobEvents(jid);
          jobs[jid] = Array.isArray(ev)
            ? { eventsCount: ev.length, last: ev[ev.length - 1]?.message }
            : "(n/a)";
        } catch (err) {
          jobs[jid] = `(listIngestJobEvents failed: ${err instanceof Error ? err.message : String(err)})`;
        }
      }
      console.error(`ingest jobs:\n${JSON.stringify(jobs, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const addMovie = (db: LibraryDb, id: number, title: string) =>
  db.addMediaFromCatalog({
    id,
    type: "movie",
    title,
    originalTitle: null,
    originalLanguage: "en",
    overview: null,
    year: "2026",
    rating: null,
    posterPath: null,
    backdropPath: null,
    genres: [],
    cast: [],
    trailers: [],
    seasons: [],
    episodes: [],
    totalEpisodes: 0,
  } as any);

describe("@bugfix @regression-proof playability decoupling", () => {
  it("linkFileToMedia does NOT flip hasFiles=true (the Orchard bug pre-fix condition)", async () => {
    console.info(`[playable-only-on-source-success:link] opening LibraryDb + adding Orchard`);
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);

    const mediaId = await addMovie(db, 7001, "Orchard");
    const history: Array<{ at: string; hasFiles: boolean }> = [];
    history.push({ at: "addMovie", hasFiles: db.getMediaDetails(mediaId)?.hasFiles ?? false });
    console.info(
      `[playable-only-on-source-success:link] mediaId=${mediaId} initial hasFiles=${history[0].hasFiles}`,
    );

    try {
      expect(history[0].hasFiles).toBe(false);

      console.info(`[playable-only-on-source-success:link] linkFileToMedia(orchard.mkv)`);
      await db.linkFileToMedia(mediaId, "orchard.mkv");
      const afterLink = db.getMediaDetails(mediaId)?.hasFiles ?? false;
      history.push({ at: "linkFileToMedia", hasFiles: afterLink });
      console.info(
        `[playable-only-on-source-success:link] post-link hasFiles=${afterLink} (expect false)`,
      );

      // Pre-fix this would have been true. Post-fix: the file row exists but the
      // media is NOT playable until markMediaPlayable runs.
      expect(afterLink).toBe(false);
    } catch (err) {
      console.error(`[playable-only-on-source-success:link] assertion failed`);
      dumpPlayableSnapshot("link-failure", {
        db,
        mediaIds: [mediaId],
        hasFilesHistory: { [mediaId]: history },
      });
      throw err;
    } finally {
      db.close();
    }
  });

  it("markMediaPlayable sets hasFiles=true (idempotent)", async () => {
    console.info(`[playable-only-on-source-success:mark] opening LibraryDb + adding Orchard 2`);
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);

    const mediaId = await addMovie(db, 7002, "Orchard 2");
    const history: Array<{ at: string; hasFiles: boolean }> = [];

    try {
      await db.linkFileToMedia(mediaId, "orchard2.mkv");
      const afterLink = db.getMediaDetails(mediaId)?.hasFiles ?? false;
      history.push({ at: "linkFileToMedia", hasFiles: afterLink });
      console.info(
        `[playable-only-on-source-success:mark] post-link hasFiles=${afterLink} (expect false)`,
      );
      expect(afterLink).toBe(false);

      console.info(`[playable-only-on-source-success:mark] markMediaPlayable (first time)`);
      await db.markMediaPlayable(mediaId);
      const afterMark1 = db.getMediaDetails(mediaId)?.hasFiles ?? false;
      history.push({ at: "markMediaPlayable-1", hasFiles: afterMark1 });
      console.info(
        `[playable-only-on-source-success:mark] post-mark-1 hasFiles=${afterMark1} (expect true)`,
      );
      expect(afterMark1).toBe(true);

      console.info(`[playable-only-on-source-success:mark] markMediaPlayable (second time, idempotent)`);
      // Idempotent.
      await db.markMediaPlayable(mediaId);
      const afterMark2 = db.getMediaDetails(mediaId)?.hasFiles ?? false;
      history.push({ at: "markMediaPlayable-2", hasFiles: afterMark2 });
      console.info(
        `[playable-only-on-source-success:mark] post-mark-2 hasFiles=${afterMark2} (expect true)`,
      );
      expect(afterMark2).toBe(true);
    } catch (err) {
      console.error(`[playable-only-on-source-success:mark] assertion failed`);
      dumpPlayableSnapshot("mark-failure", {
        db,
        mediaIds: [mediaId],
        hasFilesHistory: { [mediaId]: history },
      });
      throw err;
    } finally {
      db.close();
    }
  });

  it("deleting a cancelled job record does not flip playable (Orchard bug repro)", async () => {
    console.info(`[playable-only-on-source-success:cancelled] opening LibraryDb + adding Orchard 3`);
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);

    const mediaId = await addMovie(db, 7003, "Orchard 3");
    const history: Array<{ at: string; hasFiles: boolean }> = [];

    try {
      // Simulate the legacy ingest having linked a file mid-flight.
      console.info(`[playable-only-on-source-success:cancelled] linkFileToMedia(orchard3.mkv)`);
      await db.linkFileToMedia(mediaId, "orchard3.mkv");
      history.push({
        at: "linkFileToMedia",
        hasFiles: db.getMediaDetails(mediaId)?.hasFiles ?? false,
      });

      console.info(`[playable-only-on-source-success:cancelled] upserting cancelled job-orchard-3`);
      // Simulate a cancelled ingest job sitting in the table.
      db.upsertIngestJob({
        id: "job-orchard-3",
        mediaId,
        workerPeerId: "worker-1",
        kind: "source_upload",
        status: "cancelled",
        progressPct: 25,
        meta: { title: "Orchard 3" },
      });

      const beforeDelete = db.getMediaDetails(mediaId)?.hasFiles ?? false;
      history.push({ at: "upsertIngestJob(cancelled)", hasFiles: beforeDelete });
      console.info(
        `[playable-only-on-source-success:cancelled] hasFiles before deleteIngestJob=${beforeDelete} (expect false)`,
      );
      expect(beforeDelete).toBe(false);

      console.info(`[playable-only-on-source-success:cancelled] deleteIngestJob(job-orchard-3)`);
      // User clicks "remove from history" on the cancelled record.
      db.deleteIngestJob("job-orchard-3");

      const afterDelete = db.getMediaDetails(mediaId)?.hasFiles ?? false;
      history.push({ at: "deleteIngestJob", hasFiles: afterDelete });
      console.info(
        `[playable-only-on-source-success:cancelled] hasFiles after deleteIngestJob=${afterDelete} (expect false — pre-fix this would have been true)`,
      );

      // Pre-fix bug: this assertion would have FAILED (hasFiles flipped via
      // legacy linkFileToMedia side-effect, became visible once the cancelled
      // sentinel was cleared). Post-fix: hasFiles is still false because
      // markMediaPlayable was never called.
      expect(afterDelete).toBe(false);
    } catch (err) {
      console.error(`[playable-only-on-source-success:cancelled] assertion failed`);
      dumpPlayableSnapshot("cancelled-failure", {
        db,
        mediaIds: [mediaId],
        jobIds: ["job-orchard-3"],
        sourceJobStatuses: { "job-orchard-3": "cancelled-then-deleted" },
        hasFilesHistory: { [mediaId]: history },
      });
      throw err;
    } finally {
      db.close();
    }
  });

  it("mediaHasVideoFiles returns true only for video-bearing media", async () => {
    console.info(`[playable-only-on-source-success:video-files] opening LibraryDb`);
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);

    const mediaIdA = await addMovie(db, 7004, "Has Video");
    const mediaIdB = await addMovie(db, 7005, "No Video");
    console.info(
      `[playable-only-on-source-success:video-files] mediaA=${mediaIdA} (will get format) mediaB=${mediaIdB} (file only)`,
    );

    const fileIdA = await db.linkFileToMedia(mediaIdA, "has-video.mkv");
    await db.addMediaFormat(
      mediaIdA,
      fileIdA,
      "1080p",
      "h264",
      100,
      [{ key: "k1", sizeBytes: 1000, startSeconds: 0 }],
      2000
    );

    // mediaB has only a file row, no video format → not video-bearing.
    await db.linkFileToMedia(mediaIdB, "stub.mkv");

    try {
      const hasA = db.mediaHasVideoFiles(mediaIdA);
      const hasB = db.mediaHasVideoFiles(mediaIdB);
      console.info(
        `[playable-only-on-source-success:video-files] mediaHasVideoFiles A=${hasA} B=${hasB}`,
      );
      expect(hasA).toBe(true);
      expect(hasB).toBe(false);
    } catch (err) {
      console.error(`[playable-only-on-source-success:video-files] assertion failed`);
      dumpPlayableSnapshot("video-files-failure", {
        db,
        mediaIds: [mediaIdA, mediaIdB],
      });
      throw err;
    } finally {
      db.close();
    }
  });

  it("backfill migration preserves existing playable media", () => {
    console.info(
      `[playable-only-on-source-success:backfill] building fresh staging DB under ${root}`,
    );
    // Build a fresh DB without going through LibraryDb.openLocal (which
    // already runs ensureLibrarySchema). We need a DB where:
    //   1. The schema exists.
    //   2. A media + file + format row exist with has_files=0
    //      (simulating data that existed before the playability decoupling).
    //   3. The backfill marker is NOT set.
    // Then we invoke ensureLibrarySchema again and assert hasFiles flipped
    // back to 1, mirroring what happens on the first new-build boot.
    // ensureLibrarySchema is ~270 autocommit writes. On a default connection
    // (rollback journal, synchronous=FULL) each one fsyncs: 1.4-2.2 s on a busy
    // disk (18 ms with WAL+NORMAL), > 5 s on a loaded CI host (#326). Open it the
    // way the product opens the legacy staging DB it runs this on.
    const sqlite = openSqliteDb();
    expect(sqlite.query("PRAGMA synchronous").get()).toEqual({ synchronous: 0 });
    const adapter = {
      exec: (sql: string) => sqlite.exec(sql),
      prepare: (sql: string) => {
        const stmt = sqlite.prepare(sql);
        return {
          all: (...params: unknown[]) => stmt.all(...(params as any[])),
          run: (...params: unknown[]) => stmt.run(...(params as any[])),
        };
      },
    };

    ensureLibrarySchema(adapter as any);

    // Simulate legacy state: hasFiles=0 even though media has a video file.
    const now = new Date().toISOString();
    sqlite.run(
      `INSERT INTO media_items (id, type, title, added_at, updated_at, has_files, progress_pct)
       VALUES ('m1', 'movie', 'Legacy Movie', ?, ?, 0, 0);`,
      [now, now]
    );
    sqlite.run(
      `INSERT INTO media_files (id, media_id, filename, added_at, status)
       VALUES ('f1', 'm1', 'legacy.mkv', ?, 'local');`,
      [now]
    );
    sqlite.run(
      `INSERT INTO media_formats (id, media_id, file_id, quality, codec, size_mb)
       VALUES ('fmt1', 'm1', 'f1', '1080p', 'h264', 100);`
    );

    // Wipe the backfill marker so the next ensureLibrarySchema runs the
    // backfill (the first ensureLibrarySchema call already set it).
    sqlite.run(`DELETE FROM app_settings WHERE key = 'migration_v1_has_files_backfill';`);
    console.info(
      `[playable-only-on-source-success:backfill] seeded media+file+format with has_files=0; marker wiped`,
    );

    try {
      const beforeRows = sqlite.query(`SELECT has_files FROM media_items WHERE id = 'm1';`).all() as Array<{
        has_files: number;
      }>;
      console.info(
        `[playable-only-on-source-success:backfill] pre-rerun has_files=${beforeRows[0].has_files}`,
      );
      expect(beforeRows[0].has_files).toBe(0);

      // Re-run schema setup (which now includes the backfill).
      console.info(`[playable-only-on-source-success:backfill] re-running ensureLibrarySchema`);
      ensureLibrarySchema(adapter as any);

      const afterRows = sqlite.query(`SELECT has_files FROM media_items WHERE id = 'm1';`).all() as Array<{
        has_files: number;
      }>;
      console.info(
        `[playable-only-on-source-success:backfill] post-rerun has_files=${afterRows[0].has_files} (expect 1)`,
      );
      expect(afterRows[0].has_files).toBe(1);
    } catch (err) {
      console.error(`[playable-only-on-source-success:backfill] assertion failed`);
      // Direct-SQLite snapshot — no LibraryDb instance available.
      try {
        const rows = sqlite.query(`SELECT id, has_files FROM media_items;`).all();
        console.error(
          `=== [playable-only-on-source-success:backfill-failure] direct sqlite dump ===`,
        );
        console.error(`media_items rows:\n${JSON.stringify(rows, null, 2)}`);
        const marker = sqlite
          .query(`SELECT value FROM app_settings WHERE key = 'migration_v1_has_files_backfill';`)
          .get() as { value?: string } | undefined;
        console.error(`backfill marker=${JSON.stringify(marker)}`);
      } catch (dumpErr) {
        console.error(
          `(direct snapshot failed: ${dumpErr instanceof Error ? dumpErr.message : String(dumpErr)})`,
        );
      }
      throw err;
    } finally {
      sqlite.close();
    }
  });
});
