/**
 * Desktop per-group migrations for the SpaceBadger library DB.
 *
 * Phase 7 of the library-db unification (plan: when-we-change-how-happy-otter.md):
 * each per-group SQLite file evolves via the shared
 * `@space/library-db-definition` `runMigrations` runner, with `user_version`
 * tracking. Baseline (`user_version=0`) is "post-`ensureLibrarySchema(db, group)`"
 * — i.e. the schema as it ships after `splitGroupFromLegacy` populates the
 * file. Migrations v1+ live HERE.
 *
 * Every desktop schema change up to and including Phase 6 is reachable via
 * `ensureLibrarySchema(db, group)`'s CREATE-IF-NOT-EXISTS + idempotent legacy
 * ALTER paths. What feature-detection cannot express (dropping an index the
 * DDL no longer creates, column drops, renames, data backfills) lands as
 * entries in these arrays. Groups with no entry stay at the baseline.
 *
 * Parity slot: the mobile playback v2 (`drop_media_playback_blob_v2`) does
 * NOT have a desktop equivalent because desktop never had `media_playback_blob`
 * — it always used the normalized tables that mobile is migrating toward.
 */
import type { LibraryMigration } from "@space/library-db-definition/migrationRunner";
import type { SqliteDb } from "@space/library-db-definition/migrations";
import { MEDIA_CREW_DDL } from "@space/library-db-definition/crewDdl";
import { editionsMigrationStatements } from "@space/library-db-definition/editionDdl";
import { originalSizeMigrationStatements } from "@space/library-db-definition/originalSize";
import { catalogSourceMigrationStatements } from "@space/library-db-definition/legacyFormat";

export const desktopCoreMigrations: ReadonlyArray<LibraryMigration<SqliteDb>> = [
  {
    version: 1,
    description: "media_items_added_at_updated_at_indexes",
    up: (db) => {
      // Libraries created before LIB-FMT-07's layout pass have no index on these
      // two columns; the baseline DDL creates them for new files. Indexes only.
      db.exec("CREATE INDEX IF NOT EXISTS media_items_added_at_idx ON media_items(added_at);");
      db.exec("CREATE INDEX IF NOT EXISTS media_items_updated_at_idx ON media_items(updated_at);");
    },
  },
  {
    version: 2,
    description: "catalog_id_source",
    up: (db) => {
      // META-SRC-09: the title's catalog id under the neutral source; other sites' ids are no longer kept.
      for (const statement of catalogSourceMigrationStatements("core")) db.exec(statement);
    },
  },
];

export const desktopMetadataMigrations: ReadonlyArray<LibraryMigration<SqliteDb>> = [
  {
    version: 1,
    description: "media_crew_table",
    up: (db) => {
      // LIB-CREW-01: a title's director and writers. New libraries get the table from the baseline DDL.
      for (const ddl of MEDIA_CREW_DDL) db.exec(ddl);
    },
  },
  {
    version: 2,
    description: "media_editions",
    up: (db) => {
      // LIB-EDIT-01/02: the editions table and `media_files.edition_id` / `content_sha256`, then one unnamed edition
      // per film and per episode holding all of its files. New libraries get table and columns from the baseline DDL.
      const columns = (db.prepare("PRAGMA table_info(media_files);").all() as Array<{ name?: string }>).map((row) =>
        String(row?.name ?? "")
      );
      for (const statement of editionsMigrationStatements(columns)) db.exec(statement);
    },
  },
  {
    version: 3,
    description: "media_files_original_size",
    up: (db) => {
      // STOR-USE-02: `media_files.original_size_bytes`, the size the user's computer showed for the file. Adds only;
      // the runtime fills it for older files from their source copy once the playback file is open too.
      const columns = (db.prepare("PRAGMA table_info(media_files);").all() as Array<{ name?: string }>).map((row) =>
        String(row?.name ?? "")
      );
      for (const statement of originalSizeMigrationStatements(columns)) db.exec(statement);
    },
  },
  {
    version: 4,
    description: "catalog_id_source",
    up: (db) => {
      // META-SRC-09: each person's catalog id under the neutral source; other sites' ids are no longer kept.
      for (const statement of catalogSourceMigrationStatements("metadata")) db.exec(statement);
    },
  },
];

export const desktopPlaybackMigrations: ReadonlyArray<LibraryMigration<SqliteDb>> = [
  {
    version: 1,
    description: "drop_duplicate_chunk_indexes",
    up: (db) => {
      // `media_format_chunks_unique_idx(format_id, order_index)` and
      // `media_audio_chunks_unique_idx(track_id, order_index)` already serve every
      // lookup by format_id / track_id (leftmost prefix), so the single-column
      // twins only cost bytes. Indexes only: no column is touched (LIB-FMT-03).
      db.exec("DROP INDEX IF EXISTS media_format_chunks_format_id_idx;");
      db.exec("DROP INDEX IF EXISTS media_audio_chunks_track_id_idx;");
    },
  },
];

export const desktopIngestMigrations: ReadonlyArray<LibraryMigration<SqliteDb>> = [];

export const desktopTemplatesMigrations: ReadonlyArray<LibraryMigration<SqliteDb>> = [];
