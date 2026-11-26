import RNFS from "react-native-fs";
import SQLite from "react-native-sqlite-storage";
import {
  ensureSchema,
  ensureCoreSchema,
  ensureMetadataSchema,
  ensurePlaybackSchema,
  ensureIngestSchema,
} from "../librarySchema";
import {
  getCacheBlobPath,
  getCoreDbPath,
  getMetadataDbPath,
  getPlaybackDbPath,
  getIngestDbPath,
  getSnapshotDbPath,
  librarySqliteDb,
} from "../libraryStorage";

export const CORE_DB_NAME = "library.core.sqlite";
export const METADATA_DB_NAME = "library.metadata.sqlite";
export const PLAYBACK_DB_NAME = "library.playback.sqlite";
export const INGEST_DB_NAME = "library.ingest.sqlite";
export const SNAPSHOT_DB_NAME = "library.snapshot.sqlite";

export const openSqliteDb = async (name: string) =>
  await SQLite.openDatabase({ name, location: librarySqliteDb(name).location });

export const openCoreDb = async () => {
  const db = await openSqliteDb(CORE_DB_NAME);
  await ensureCoreSchema(db);
  return db;
};

export const openMetadataDb = async () => {
  const db = await openSqliteDb(METADATA_DB_NAME);
  await ensureMetadataSchema(db);
  return db;
};

export const openPlaybackDb = async () => {
  const db = await openSqliteDb(PLAYBACK_DB_NAME);
  await ensurePlaybackSchema(db);
  return db;
};

export const openIngestDb = async () => {
  const db = await openSqliteDb(INGEST_DB_NAME);
  await ensureIngestSchema(db);
  return db;
};

/**
 * The combined-snapshot handle that is currently open, if any.
 *
 * Both layers of react-native-sqlite-storage key connections by db name: the JS layer resolves
 * `openDatabase` with the existing object while that name is open, and the native layer reuses the
 * existing `sqlite3*`. A rebuild that threw before its `snapshotDb.close()` (persist, flush, export,
 * snapshot split) therefore left a connection that the next `removeSnapshotDbFile()` unlinked the
 * files under (db, -wal and -shm) and that the next `openSnapshotDb()` handed back. On iOS its first
 * statement, `PRAGMA journal_mode=WAL;`, then fails with "disk I/O error", and so did every later
 * persist, so each sync ended in `library.stream.sync.failed`.
 */
let liveSnapshotDb: SQLite.SQLiteDatabase | null = null;

const releaseLiveSnapshotDb = async (where: "open" | "remove") => {
  const db = liveSnapshotDb;
  if (!db) return;
  liveSnapshotDb = null;
  console.warn("library.db.snapshot.stale_handle_closed", JSON.stringify({ where }));
  try {
    await db.close();
  } catch (error) {
    console.warn(
      "library.db.snapshot.stale_handle_close_failed",
      JSON.stringify({ where, error: error instanceof Error ? error.message : JSON.stringify(error) })
    );
  }
};

export const openSnapshotDb = async () => {
  await releaseLiveSnapshotDb("open");
  const db = await openSqliteDb(SNAPSHOT_DB_NAME);
  const close = db.close.bind(db);
  db.close = async () => {
    if (liveSnapshotDb === db) liveSnapshotDb = null;
    return await close();
  };
  // Tracked before the schema runs: a failing pragma must not leave an untracked connection either.
  liveSnapshotDb = db;
  await ensureSchema(db);
  return db;
};

export const ensureLibraryDir = async () => {
  const blobPath = getCacheBlobPath();
  const dir = blobPath.slice(0, blobPath.lastIndexOf("/"));
  if (!(await RNFS.exists(dir))) {
    await RNFS.mkdir(dir);
  }
};

export const removeDbFile = async (path: string) => {
  const candidates = [path, `${path}-wal`, `${path}-shm`];
  for (const candidate of candidates) {
    if (await RNFS.exists(candidate)) {
      await RNFS.unlink(candidate);
    }
  }
};

export const resetSplitDbFiles = async () => {
  const paths = [getCoreDbPath(), getMetadataDbPath(), getPlaybackDbPath(), getIngestDbPath()];
  for (const path of paths) {
    await removeDbFile(path);
  }
};

export const removeSnapshotDbFile = async () => {
  // Never unlink the files under a connection a failed rebuild left open (see liveSnapshotDb).
  await releaseLiveSnapshotDb("remove");
  await removeDbFile(getSnapshotDbPath());
};

export class IntegrityCheckFailedError extends Error {
  readonly dbName: string;
  readonly result: string;
  constructor(dbName: string, result: string) {
    super(`integrity_check_failed:${dbName}:${result}`);
    this.dbName = dbName;
    this.result = result;
    this.name = "IntegrityCheckFailedError";
  }
}

export type IntegrityLogger = (event: string, data: Record<string, unknown>) => void;

export const runIntegrityCheck = async (
  db: SQLite.SQLiteDatabase,
  dbName: string,
  log?: IntegrityLogger
): Promise<void> => {
  const res = await db.executeSql("PRAGMA integrity_check;");
  const rows = res[0]?.rows;
  const row = rows && rows.length > 0 ? (rows.item(0) as { integrity_check?: string }) : null;
  const value = String(row?.integrity_check ?? "").trim();
  if (value === "ok") {
    log?.("library.db.integrity.ok", { db: dbName });
    return;
  }
  log?.("library.db.integrity.fail", { db: dbName, result: value || "no_result" });
  throw new IntegrityCheckFailedError(dbName, value || "no_result");
};

const closeDbSafely = async (db: SQLite.SQLiteDatabase): Promise<void> => {
  try {
    await db.close();
  } catch {
    // best-effort
  }
};

const RECOVERY_DEPTH_LIMIT = 1;

const openWithIntegrityCheck = async (
  dbName: string,
  open: () => Promise<SQLite.SQLiteDatabase>,
  cleanup: () => Promise<void>,
  log?: IntegrityLogger,
  depth = 0
): Promise<SQLite.SQLiteDatabase> => {
  const db = await open();
  try {
    await runIntegrityCheck(db, dbName, log);
    return db;
  } catch (error) {
    if (!(error instanceof IntegrityCheckFailedError)) {
      throw error;
    }
    await closeDbSafely(db);
    if (depth >= RECOVERY_DEPTH_LIMIT) {
      log?.("library.db.integrity.recovery.exhausted", { db: dbName, depth });
      throw error;
    }
    log?.("library.db.integrity.recovery.start", { db: dbName, depth });
    await cleanup();
    return openWithIntegrityCheck(dbName, open, cleanup, log, depth + 1);
  }
};

export const openCoreDbWithIntegrity = (log?: IntegrityLogger) =>
  openWithIntegrityCheck(
    CORE_DB_NAME,
    openCoreDb,
    async () => {
      await removeDbFile(getCoreDbPath());
    },
    log
  );

export const openMetadataDbWithIntegrity = (log?: IntegrityLogger) =>
  openWithIntegrityCheck(
    METADATA_DB_NAME,
    openMetadataDb,
    async () => {
      await removeDbFile(getMetadataDbPath());
    },
    log
  );

export const openPlaybackDbWithIntegrity = (log?: IntegrityLogger) =>
  openWithIntegrityCheck(
    PLAYBACK_DB_NAME,
    openPlaybackDb,
    async () => {
      await removeDbFile(getPlaybackDbPath());
    },
    log
  );

export const openIngestDbWithIntegrity = (log?: IntegrityLogger) =>
  openWithIntegrityCheck(
    INGEST_DB_NAME,
    openIngestDb,
    async () => {
      await removeDbFile(getIngestDbPath());
    },
    log
  );

export const openSnapshotDbWithIntegrity = (log?: IntegrityLogger) =>
  openWithIntegrityCheck(
    SNAPSHOT_DB_NAME,
    openSnapshotDb,
    async () => {
      await removeDbFile(getSnapshotDbPath());
    },
    log
  );
