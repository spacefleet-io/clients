import type { SQLiteDatabase } from "react-native-sqlite-storage";
import {
  ensureLibrarySchemaAsync,
  runMigrationsAsync,
  type AsyncLibraryMigration,
  type AsyncSqliteDb,
  type AsyncSqliteRunnerDb,
  type LibraryDbGroup,
  type MigrationGroupLabel,
  type RunMigrationsResult,
} from "@space/library-db-definition";
import { normalizePlaybackBlobRows } from "./library/playbackBlobMigration";
import { MEDIA_CREW_DDL } from "@space/library-db-definition/crewDdl";
import { editionsMigrationStatements } from "@space/library-db-definition/editionDdl";
import { originalSizeMigrationStatements } from "@space/library-db-definition/originalSize";

/**
 * Mobile-facing migration shape. `up(db)` receives a `SQLiteDatabase`-shaped
 * handle (the proxy adapter that ALSO satisfies the shared runner's
 * `AsyncSqliteRunnerDb` contract), so legacy `db.executeSql(...)` calls keep
 * working unchanged.
 */
export type Migration = AsyncLibraryMigration<SQLiteDatabase>;

const asAsyncDb = (db: SQLiteDatabase): AsyncSqliteDb => ({
  exec: async (sql) => {
    await db.executeSql(sql);
  },
});

/**
 * Adapter: superset that retains the original `react-native-sqlite-storage`
 * `executeSql` so per-migration `up(db)` callbacks keep working unchanged,
 * AND adds the shared runner's `exec`+`query` contract so the runner can
 * read/write `PRAGMA user_version`.
 *
 * The runner calls `migration.up(db)` with whatever `db` it was handed, so
 * migrations defined as `(db) => db.executeSql(...)` need a handle whose
 * `executeSql` is still the mobile driver's. Returning a proxy that exposes
 * BOTH shapes lets the same handle satisfy both call sites.
 */
type MobileRunnerDb = AsyncSqliteRunnerDb & SQLiteDatabase;

const asRunnerDb = (db: SQLiteDatabase): MobileRunnerDb => {
  const exec: AsyncSqliteRunnerDb["exec"] = async (sql) => {
    await db.executeSql(sql);
  };
  const query: AsyncSqliteRunnerDb["query"] = async (sql) => {
    const result = await db.executeSql(sql);
    const rows = result[0]?.rows;
    if (!rows || rows.length === 0) return [];
    const out: Array<Record<string, unknown>> = [];
    for (let i = 0; i < rows.length; i += 1) {
      out.push(rows.item(i) as Record<string, unknown>);
    }
    return out;
  };
  // Preserve the original driver handle's prototype + bound methods (executeSql
  // etc.) by layering exec/query on top via a Proxy. Plain spread breaks bound
  // methods in some RN sqlite drivers.
  return new Proxy(db as unknown as MobileRunnerDb, {
    get: (target, prop, receiver) => {
      if (prop === "exec") return exec;
      if (prop === "query") return query;
      return Reflect.get(target, prop, receiver);
    },
  });
};

const applyGroup = (db: SQLiteDatabase, group: LibraryDbGroup) =>
  ensureLibrarySchemaAsync(asAsyncDb(db), group);

export const coreMigrations: ReadonlyArray<Migration> = [
  {
    version: 1,
    description: "core_baseline_v1",
    up: (db) => applyGroup(db, "core"),
  },
  {
    version: 2,
    description: "media_items_added_at_updated_at_indexes_v2",
    up: async (db) => {
      await db.executeSql("CREATE INDEX IF NOT EXISTS media_items_added_at_idx ON media_items(added_at);");
      await db.executeSql("CREATE INDEX IF NOT EXISTS media_items_updated_at_idx ON media_items(updated_at);");
    },
  },
];

export const metadataMigrations: ReadonlyArray<Migration> = [
  {
    version: 1,
    description: "metadata_baseline_v1",
    up: (db) => applyGroup(db, "metadata"),
  },
  {
    version: 2,
    description: "media_crew_table_v2",
    up: async (db) => {
      // LIB-CREW-01: a title's director and writers. New libraries get the table from the baseline DDL.
      for (const ddl of MEDIA_CREW_DDL) await db.executeSql(ddl);
    },
  },
  {
    version: 3,
    description: "media_editions_v3",
    up: async (db) => {
      // LIB-EDIT-01/02: the editions table and `media_files.edition_id` / `content_sha256`, then one unnamed edition
      // per film and per episode holding all of its files. Same statements as the desktop's metadata step 2.
      const [result] = await db.executeSql("PRAGMA table_info(media_files);");
      const columns: string[] = [];
      for (let i = 0; i < (result?.rows.length ?? 0); i += 1) columns.push(String(result.rows.item(i)?.name ?? ""));
      const statements = editionsMigrationStatements(columns);
      console.info("[library-editions] migration.media_editions", JSON.stringify({ columns: columns.length, statements: statements.length }));
      for (const statement of statements) await db.executeSql(statement);
    },
  },
  {
    version: 4,
    description: "media_files_original_size_v4",
    up: async (db) => {
      // STOR-USE-02: `media_files.original_size_bytes`. Same statement as the desktop's metadata step 3; the phone gets
      // the values from the desktop's ops.
      const [result] = await db.executeSql("PRAGMA table_info(media_files);");
      const columns: string[] = [];
      for (let i = 0; i < (result?.rows.length ?? 0); i += 1) columns.push(String(result.rows.item(i)?.name ?? ""));
      for (const statement of originalSizeMigrationStatements(columns)) await db.executeSql(statement);
    },
  },
];

export const playbackMigrations: ReadonlyArray<Migration> = [
  {
    version: 1,
    description: "playback_baseline_v1",
    up: (db) => applyGroup(db, "playback"),
  },
  {
    version: 2,
    description: "drop_media_playback_blob_v2",
    up: (db) => normalizePlaybackBlobRows(db),
  },
  {
    version: 3,
    description: "drop_duplicate_chunk_indexes_v3",
    up: async (db) => {
      // The composite unique indexes already cover lookups by format_id / track_id.
      await db.executeSql("DROP INDEX IF EXISTS media_format_chunks_format_id_idx;");
      await db.executeSql("DROP INDEX IF EXISTS media_audio_chunks_track_id_idx;");
    },
  },
  {
    version: 4,
    description: "media_subtitles_derived_from_subtitle_id_v4",
    up: async (db) => {
      // OCR twins of picture subtitles name their picture row (PLAY-TRACK-05). A fresh DB already has the column
      // from the v1 baseline DDL; an install already past v1 gets it here.
      const [result] = await db.executeSql("PRAGMA table_info(media_subtitles);");
      const columns: string[] = [];
      for (let i = 0; i < (result?.rows.length ?? 0); i += 1) columns.push(String(result.rows.item(i)?.name ?? ""));
      const present = columns.includes("derived_from_subtitle_id");
      console.info("[mpv-subtitles] migration.derived_from_subtitle_id", JSON.stringify({ present, columns: columns.length }));
      if (!present) await db.executeSql("ALTER TABLE media_subtitles ADD COLUMN derived_from_subtitle_id TEXT;");
    },
  },
  {
    version: 5,
    description: "media_formats_preview_sheets_v5",
    up: async (db) => {
      // Seek-bar preview sheets on the source format (MPV-PREV-01), written by the desktop import and replayed here
      // through `media.upsert`. A fresh DB has the column from the v1 baseline DDL; an install past v1 gets it here.
      const [result] = await db.executeSql("PRAGMA table_info(media_formats);");
      const columns: string[] = [];
      for (let i = 0; i < (result?.rows.length ?? 0); i += 1) columns.push(String(result.rows.item(i)?.name ?? ""));
      const present = columns.includes("preview_sheets");
      console.info("[mpv-previews] migration.preview_sheets", JSON.stringify({ present, columns: columns.length }));
      if (!present) await db.executeSql("ALTER TABLE media_formats ADD COLUMN preview_sheets TEXT;");
    },
  },
];

export const ingestMigrations: ReadonlyArray<Migration> = [
  {
    version: 1,
    description: "ingest_baseline_v1",
    up: (db) => applyGroup(db, "ingest"),
  },
];

// Combined snapshot DB packs every mobile group into one file (cold-bootstrap
// intermediate before splitting into the per-group files). Recompose by
// running each per-group initializer against the same handle.
export const snapshotMigrations: ReadonlyArray<Migration> = [
  {
    version: 1,
    description: "snapshot_baseline_v1",
    up: async (db) => {
      await applyGroup(db, "core");
      await applyGroup(db, "metadata");
      await applyGroup(db, "playback");
      await applyGroup(db, "ingest");
    },
  },
];

export type MigrationLogger = (event: string, data: Record<string, unknown>) => void;

/**
 * Mobile wrapper around the shared `runMigrationsAsync` runner. Keeps the
 * pre-Phase-7 call signature (`runMigrations(db, migrations, { dbName, log })`)
 * and translates the shared runner's `group` payload back to `db` so existing
 * log consumers stay byte-for-byte stable.
 */
/**
 * The shared runner emits errors of the form
 * `<code>:<group>:<...>` (e.g. `duplicate_migration_version:test:1`). Mobile's
 * pre-Phase-7 error format omitted the group segment
 * (`duplicate_migration_version:1`) — strip it back out so callers and tests
 * that match on the legacy regex stay byte-for-byte stable.
 */
const ERROR_CODES = [
  "invalid_migration_version",
  "duplicate_migration_version",
  "non_monotonic_migration_versions",
  "invalid_user_version",
] as const;

const stripGroupFromErrorMessage = (message: string, dbName: string): string => {
  for (const code of ERROR_CODES) {
    const prefix = `${code}:${dbName}:`;
    if (message.startsWith(prefix)) {
      return `${code}:${message.slice(prefix.length)}`;
    }
  }
  return message;
};

export const runMigrations = async (
  db: SQLiteDatabase,
  migrations: ReadonlyArray<Migration>,
  options?: { dbName?: string; log?: MigrationLogger }
): Promise<RunMigrationsResult> => {
  const dbName = options?.dbName ?? "library";
  const log = options?.log;
  const wrappedLog: MigrationLogger | undefined = log
    ? (event, data) => {
        const { group, ...rest } = data as { group?: MigrationGroupLabel } & Record<string, unknown>;
        log(event, { db: group ?? dbName, ...rest });
      }
    : undefined;

  try {
    return await runMigrationsAsync(asRunnerDb(db), dbName, migrations, { log: wrappedLog });
  } catch (error) {
    if (error instanceof Error) {
      error.message = stripGroupFromErrorMessage(error.message, dbName);
    }
    throw error;
  }
};
