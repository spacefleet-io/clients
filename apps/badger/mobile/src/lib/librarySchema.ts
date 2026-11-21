import type { SQLiteDatabase } from "react-native-sqlite-storage";
import {
  ensureLibrarySchemaAsync,
  type AsyncSqliteDb,
  type LibraryDbGroup,
} from "@space/library-db-definition";
import { healSystemPlaylists } from "./library/systemPlaylists";
import {
  coreMigrations,
  ingestMigrations,
  metadataMigrations,
  PACKED_PLAYBACK_LAYOUT_VERSION,
  playbackMigrations,
  playbackMigrationsPacked,
  readPlaybackLayoutVersion,
  runMigrations,
} from "./libraryMigrations";
import { PACKED_PLAYBACK_DDL } from "@space/library-db-definition/packedPlayback";

// Per-DB perf pragmas applied on every open. WAL lets readers continue
// during a writer (vs default `delete` mode where writers block readers
// — meaningful on Android storage during SSE op-apply); synchronous=NORMAL
// trades a tiny power-loss durability gap for ~2-5x faster commits, which
// is acceptable for a derived cache that can be re-bootstrapped from the
// remote snapshot.
const applyPerfPragmas = async (db: SQLiteDatabase) => {
  await db.executeSql("PRAGMA journal_mode=WAL;");
  await db.executeSql("PRAGMA synchronous=NORMAL;");
};

const asAsyncDb = (db: SQLiteDatabase): AsyncSqliteDb => ({
  exec: async (sql) => {
    await db.executeSql(sql);
  },
});

export const ensureGroupSchema = (db: SQLiteDatabase, group: LibraryDbGroup) =>
  ensureLibrarySchemaAsync(asAsyncDb(db), group);

export const ensureSchema = async (db: SQLiteDatabase) => {
  await applyPerfPragmas(db);
  await db.executeSql("PRAGMA foreign_keys=ON;");
  // Combined snapshot DB contains every mobile group in one file; recompose
  // by running each per-group initializer against the same handle.
  await ensureGroupSchema(db, "core");
  await ensureGroupSchema(db, "metadata");
  await ensureGroupSchema(db, "playback");
  await ensureGroupSchema(db, "ingest");
  // LIB-SYNC-10: Favorites / Watchlist under their fixed ids (an older build's random-id rows move onto them).
  await healSystemPlaylists(db);
};

// Every split DB runs its registered migration steps on open, before any op touches it (LIB-FMT-08): an app update
// over an installed library must bring each file to this build's layout. Step 1 of each registry is the
// CREATE-IF-NOT-EXISTS baseline, which is idempotent, so an install still at user_version=0 that already holds the
// baseline tables replays it safely and then gets every later step (metadata v3: `media_files.edition_id`).
export const ensureCoreSchema = async (db: SQLiteDatabase) => {
  await applyPerfPragmas(db);
  await db.executeSql("PRAGMA foreign_keys=ON;");
  await runMigrations(db, coreMigrations, { dbName: "core" });
  await healSystemPlaylists(db);
};

export const ensureMetadataSchema = async (db: SQLiteDatabase) => {
  await applyPerfPragmas(db);
  // Split DBs do not share FK enforcement across files; disable to avoid false failures.
  await db.executeSql("PRAGMA foreign_keys=OFF;");
  await runMigrations(db, metadataMigrations, { dbName: "metadata" });
};

const convertedFileHasNoPendingStep = async () => {
  throw new Error("PLAYBACK_CONVERT_NOT_REACHED");
};

export const ensurePlaybackSchema = async (db: SQLiteDatabase) => {
  await applyPerfPragmas(db);
  await db.executeSql("PRAGMA foreign_keys=OFF;");
  // LIB-FMT-12: a converted file (user_version 6) opens through the packed registry, so its version is known, not
  // "too new"; the conversion step itself never runs here (it is the last step, already applied). An unconverted
  // file gets the plain registry: opening never converts — `convertPlaybackToPacked` does, on a switched account.
  const converted = (await readPlaybackLayoutVersion(db)) >= PACKED_PLAYBACK_LAYOUT_VERSION;
  await runMigrations(db, converted ? playbackMigrationsPacked(convertedFileHasNoPendingStep) : playbackMigrations, {
    dbName: "playback",
  });
  // LIB-FMT-11: the packed tables are in the base DDL but an install already past the baseline step never replays
  // it; create them empty on every open, without a migration step (no user_version bump before the switch).
  for (const statement of PACKED_PLAYBACK_DDL) await db.executeSql(statement);
};

/**
 * LIB-FMT-12: converts the open playback file in place (packs every chunk list, then `user_version` 6). `convert`
 * runs the packing on its own connection (native `convertChunkLists`), so this connection must be idle. Idempotent.
 */
export const convertPlaybackToPacked = async (db: SQLiteDatabase, convert: () => Promise<unknown>) =>
  runMigrations(db, playbackMigrationsPacked(convert), { dbName: "playback" });

export const ensureIngestSchema = async (db: SQLiteDatabase) => {
  await applyPerfPragmas(db);
  await db.executeSql("PRAGMA foreign_keys=OFF;");
  await runMigrations(db, ingestMigrations, { dbName: "ingest" });
};

