import type { SQLiteDatabase } from "react-native-sqlite-storage";

/**
 * LIB-FMT-10: the combined snapshot DB runs in WAL mode (`applyPerfPragmas`), so its newest rows sit in `-wal` and its
 * header says WAL until it leaves that mode. Leaving it folds the log into the main file, removes `-wal` and writes the
 * rollback-journal header, so the file read for a snapshot (and hashed for its manifest) is the whole library in the
 * form every reader opens: in-memory SQLite refuses a WAL header ("unable to open database file"). It needs the only
 * connection to the file, which the snapshot lock and `liveSnapshotDb` give; a file still in WAL is never exported.
 */
export const leaveWalForExport = async (db: SQLiteDatabase): Promise<string> => {
  const [result] = await db.executeSql("PRAGMA journal_mode=DELETE;");
  const row: { journal_mode?: unknown } | undefined = result.rows.item(0);
  const mode = String(row?.journal_mode ?? "").toLowerCase();
  if (mode === "wal") throw new Error("SNAPSHOT_STILL_WAL");
  return mode;
};
