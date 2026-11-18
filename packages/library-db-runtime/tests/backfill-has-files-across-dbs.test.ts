/**
 * @test-id LIB-DB-BACKFILL-CROSS-DBS-001
 * @level integration (real-engine, bun:sqlite, three DBs)
 *
 * Verifies the cross-DB has_files backfill that runs once on the first boot
 * after the desktop split. Pre-existing coverage in
 * @space/library-db-definition is mock-based — it only asserts the marker-
 * lookup SELECT is dispatched on the core DB. This integration test runs
 * three real SQLite files end-to-end and verifies:
 *
 *   - media that have a media_files row joined to a media_formats row are
 *     flipped to has_files=1
 *   - media that have files but NO formats stay at has_files=0
 *   - media with no files at all stay at has_files=0
 *   - the marker row is written into core.app_settings
 *   - reruns are no-ops (marker honored)
 */
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { ensureAllLibrarySchemas, type SqliteDb } from "@space/library-db-definition/migrations";

const open = () => new Database(":memory:") as unknown as SqliteDb;

const insertMedia = (core: SqliteDb, id: string, type: string, initialHasFiles: 0 | 1 = 0) => {
  (core as unknown as { prepare: (s: string) => { run: (...a: unknown[]) => unknown } })
    .prepare(
      `INSERT INTO media_items (id, type, title, added_at, updated_at, has_files, progress_pct)
       VALUES (?, ?, ?, ?, ?, ?, ?);`
    )
    .run(id, type, `Title-${id}`, "t0", "t0", initialHasFiles, 0);
};

const insertFile = (metadata: SqliteDb, fileId: string, mediaId: string) => {
  (metadata as unknown as { prepare: (s: string) => { run: (...a: unknown[]) => unknown } })
    .prepare(
      `INSERT INTO media_files (id, media_id, filename, added_at, status)
       VALUES (?, ?, ?, ?, ?);`
    )
    .run(fileId, mediaId, `${fileId}.mkv`, "t0", "local");
};

const insertFormat = (playback: SqliteDb, formatId: string, mediaId: string, fileId: string) => {
  (playback as unknown as { prepare: (s: string) => { run: (...a: unknown[]) => unknown } })
    .prepare(
      `INSERT INTO media_formats (id, media_id, file_id, quality, codec, size_mb)
       VALUES (?, ?, ?, ?, ?, ?);`
    )
    .run(formatId, mediaId, fileId, "1080p", "h264", 1000);
};

const hasFilesValue = (core: SqliteDb, id: string): number => {
  const row = (core as unknown as { prepare: (s: string) => { get: (...a: unknown[]) => unknown } })
    .prepare("SELECT has_files FROM media_items WHERE id = ?;")
    .get(id) as { has_files?: number } | undefined;
  return Number(row?.has_files ?? 0);
};

const markerValue = (core: SqliteDb): string | undefined => {
  const row = (core as unknown as { prepare: (s: string) => { get: (...a: unknown[]) => unknown } })
    .prepare("SELECT value FROM app_settings WHERE key = 'migration_v1_has_files_backfill';")
    .get() as { value?: string } | undefined;
  return row?.value;
};

// Suite-id: backfill-has-files-across-dbs
// Dumps per-DB row counts, hasFiles values for the seeded ids, and the
// backfill marker. The bug shape is "marker missing OR hasFiles drifted",
// both of which this snapshot makes obvious.
const dumpBackfillSnapshot = (
  label: string,
  ctx: {
    core?: SqliteDb;
    metadata?: SqliteDb;
    playback?: SqliteDb;
    ids?: string[];
  },
) => {
  try {
    console.error(`=== [backfill-has-files-across-dbs:${label}] snapshot ===`);
    const countRows = (db: SqliteDb | undefined, table: string): number | string => {
      if (!db) return "(no db)";
      try {
        const row = (
          db as unknown as { prepare: (s: string) => { get: () => unknown } }
        )
          .prepare(`SELECT COUNT(*) AS n FROM ${table};`)
          .get() as { n?: number } | undefined;
        return Number(row?.n ?? 0);
      } catch (err) {
        return `(count failed: ${err instanceof Error ? err.message : String(err)})`;
      }
    };
    const counts = {
      core_media_items: countRows(ctx.core, "media_items"),
      metadata_media_files: countRows(ctx.metadata, "media_files"),
      playback_media_formats: countRows(ctx.playback, "media_formats"),
    };
    console.error(`counts: ${JSON.stringify(counts)}`);

    if (ctx.ids && ctx.core) {
      const hasFiles: Record<string, number | string> = {};
      for (const id of ctx.ids) {
        try {
          hasFiles[id] = hasFilesValue(ctx.core, id);
        } catch (err) {
          hasFiles[id] = `(read failed: ${err instanceof Error ? err.message : String(err)})`;
        }
      }
      console.error(`has_files per id:\n${JSON.stringify(hasFiles, null, 2)}`);
    }
    if (ctx.core) {
      console.error(
        `backfill marker=${JSON.stringify(markerValue(ctx.core))}`,
      );
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("backfillHasFilesAcrossDbs — via ensureAllLibrarySchemas", () => {
  let core: SqliteDb;
  let metadata: SqliteDb;
  let playback: SqliteDb;
  let ingest: SqliteDb;
  let templates: SqliteDb;

  beforeEach(() => {
    core = open();
    metadata = open();
    playback = open();
    ingest = open();
    templates = open();
    ensureAllLibrarySchemas({ core, metadata, playback, ingest, templates });
    console.info(`[backfill-has-files-across-dbs:setup] 5 fresh in-memory DBs + initial schemas`);
  });

  it("flips has_files=1 ONLY for media that has a file joined to a format", () => {
    insertMedia(core, "m-with-format", "movie");
    insertMedia(core, "m-file-only", "movie");
    insertMedia(core, "m-no-files", "movie");

    insertFile(metadata, "f-with-format", "m-with-format");
    insertFile(metadata, "f-file-only", "m-file-only");

    insertFormat(playback, "fmt-1", "m-with-format", "f-with-format");

    console.info(
      `[backfill-has-files-across-dbs:scoped] 3 media (1 with format, 1 file-only, 1 no-files) — deleting marker + re-running schemas`,
    );
    // Clear the marker that the bootstrap above wrote, then rerun the
    // cross-DB schema entry so the backfill scans the seeded data.
    core.exec("DELETE FROM app_settings WHERE key = 'migration_v1_has_files_backfill';");
    ensureAllLibrarySchemas({ core, metadata, playback, ingest, templates });

    try {
      const withFmt = hasFilesValue(core, "m-with-format");
      const fileOnly = hasFilesValue(core, "m-file-only");
      const noFiles = hasFilesValue(core, "m-no-files");
      console.info(
        `[backfill-has-files-across-dbs:scoped] post-backfill hasFiles{with-format}=${withFmt} {file-only}=${fileOnly} {no-files}=${noFiles}`,
      );
      expect(withFmt).toBe(1);
      expect(fileOnly).toBe(0);
      expect(noFiles).toBe(0);
    } catch (err) {
      console.error(`[backfill-has-files-across-dbs:scoped] assertion failed`);
      dumpBackfillSnapshot("scoped-failure", {
        core,
        metadata,
        playback,
        ids: ["m-with-format", "m-file-only", "m-no-files"],
      });
      throw err;
    }
  });

  it("sets the per-installation marker after the backfill runs", () => {
    insertMedia(core, "m1", "movie");
    insertFile(metadata, "f1", "m1");
    insertFormat(playback, "fmt-1", "m1", "f1");

    console.info(`[backfill-has-files-across-dbs:marker] deleting marker + re-running schemas`);
    core.exec("DELETE FROM app_settings WHERE key = 'migration_v1_has_files_backfill';");
    ensureAllLibrarySchemas({ core, metadata, playback, ingest, templates });

    try {
      const marker = markerValue(core);
      console.info(`[backfill-has-files-across-dbs:marker] post-backfill marker=${marker}`);
      expect(marker).toBe("1");
    } catch (err) {
      console.error(`[backfill-has-files-across-dbs:marker] assertion failed`);
      dumpBackfillSnapshot("marker-failure", { core, metadata, playback, ids: ["m1"] });
      throw err;
    }
  });

  it("is idempotent — a rerun does not re-touch already-flipped rows", () => {
    insertMedia(core, "m1", "movie");
    insertFile(metadata, "f1", "m1");
    insertFormat(playback, "fmt-1", "m1", "f1");

    console.info(`[backfill-has-files-across-dbs:idempotent] first backfill run`);
    core.exec("DELETE FROM app_settings WHERE key = 'migration_v1_has_files_backfill';");
    ensureAllLibrarySchemas({ core, metadata, playback, ingest, templates });

    try {
      const firstHasFiles = hasFilesValue(core, "m1");
      console.info(
        `[backfill-has-files-across-dbs:idempotent] post-first-run hasFiles{m1}=${firstHasFiles}`,
      );
      expect(firstHasFiles).toBe(1);

      // Capture the updated_at after first backfill so we can detect a re-touch.
      const firstRow = (core as unknown as { prepare: (s: string) => { get: () => unknown } })
        .prepare("SELECT updated_at FROM media_items WHERE id = 'm1';")
        .get() as { updated_at?: string };
      console.info(
        `[backfill-has-files-across-dbs:idempotent] firstRow.updated_at=${firstRow?.updated_at}`,
      );

      // Rerun the bootstrap — marker is now set, so backfill must short-circuit.
      console.info(`[backfill-has-files-across-dbs:idempotent] second backfill run (should no-op)`);
      ensureAllLibrarySchemas({ core, metadata, playback, ingest, templates });

      const secondRow = (core as unknown as { prepare: (s: string) => { get: () => unknown } })
        .prepare("SELECT updated_at FROM media_items WHERE id = 'm1';")
        .get() as { updated_at?: string };
      console.info(
        `[backfill-has-files-across-dbs:idempotent] secondRow.updated_at=${secondRow?.updated_at}`,
      );
      expect(secondRow?.updated_at).toBe(firstRow?.updated_at);
      expect(hasFilesValue(core, "m1")).toBe(1);
    } catch (err) {
      console.error(`[backfill-has-files-across-dbs:idempotent] assertion failed`);
      dumpBackfillSnapshot("idempotent-failure", { core, metadata, playback, ids: ["m1"] });
      throw err;
    }
  });

  it("sets the marker even when there are no formats (empty cross-DB join)", () => {
    insertMedia(core, "m1", "movie");
    insertFile(metadata, "f1", "m1");
    // no formats inserted

    console.info(`[backfill-has-files-across-dbs:empty-join] deleting marker + re-running schemas`);
    core.exec("DELETE FROM app_settings WHERE key = 'migration_v1_has_files_backfill';");
    ensureAllLibrarySchemas({ core, metadata, playback, ingest, templates });

    try {
      const marker = markerValue(core);
      const hasFiles = hasFilesValue(core, "m1");
      console.info(
        `[backfill-has-files-across-dbs:empty-join] marker=${marker} hasFiles{m1}=${hasFiles}`,
      );
      expect(marker).toBe("1");
      expect(hasFiles).toBe(0);
    } catch (err) {
      console.error(`[backfill-has-files-across-dbs:empty-join] assertion failed`);
      dumpBackfillSnapshot("empty-join-failure", { core, metadata, playback, ids: ["m1"] });
      throw err;
    }
  });

  it("does NOT clobber has_files=1 already set on media that lacks a format (backfill only flips 0→1, never 1→0)", () => {
    // A media item that's already marked playable by a prior code path, with
    // no playback row joined.  The backfill must not regress it to 0.
    insertMedia(core, "m-prev-marked", "movie", 1);

    console.info(`[backfill-has-files-across-dbs:no-regress] seeded m-prev-marked with hasFiles=1`);
    core.exec("DELETE FROM app_settings WHERE key = 'migration_v1_has_files_backfill';");
    ensureAllLibrarySchemas({ core, metadata, playback, ingest, templates });

    try {
      const hasFiles = hasFilesValue(core, "m-prev-marked");
      console.info(
        `[backfill-has-files-across-dbs:no-regress] post-backfill hasFiles{m-prev-marked}=${hasFiles}`,
      );
      expect(hasFiles).toBe(1);
    } catch (err) {
      console.error(`[backfill-has-files-across-dbs:no-regress] assertion failed`);
      dumpBackfillSnapshot("no-regress-failure", {
        core,
        metadata,
        playback,
        ids: ["m-prev-marked"],
      });
      throw err;
    }
  });
});
