/**
 * A library snapshot is one self-contained SQLite file in rollback-journal mode (LIB-FMT-10). A phone's library file
 * runs in WAL mode; once its log is folded in (a checkpoint), the file holds every row and only the header's
 * file-format bytes (offset 18: write version, 19: read version) still say WAL (2) instead of rollback journal (1).
 * In-memory SQLite (`sqlite3_deserialize`: node:sqlite, bun:sqlite, Electron) refuses a WAL header with "unable to
 * open database file", so writers ship the rollback-journal header and readers set it on a snapshot already stored
 * in WAL mode. Platform-neutral: no node:fs, no Buffer.
 */
const SQLITE_HEADER = "SQLite format 3\0";
const SQLITE_HEADER_BYTES = 100;
const WRITE_VERSION_OFFSET = 18;
const READ_VERSION_OFFSET = 19;
const ROLLBACK_JOURNAL = 1;

const isSqliteImage = (bytes: Uint8Array): boolean => {
  if (bytes.length < SQLITE_HEADER_BYTES) return false;
  for (let index = 0; index < SQLITE_HEADER.length; index += 1) {
    if (bytes[index] !== SQLITE_HEADER.charCodeAt(index)) return false;
  }
  return true;
};

/** True when `bytes` is a SQLite file whose header says WAL mode. */
export const isWalSqliteImage = (bytes: Uint8Array): boolean =>
  isSqliteImage(bytes) && (bytes[WRITE_VERSION_OFFSET] !== ROLLBACK_JOURNAL || bytes[READ_VERSION_OFFSET] !== ROLLBACK_JOURNAL);

/**
 * The same SQLite file with a rollback-journal header: a copy with bytes 18 and 19 set to 1 when `bytes` is a WAL-mode
 * SQLite file, else `bytes` itself (a rollback-journal file, or anything that is not SQLite, such as an op payload).
 * The caller's bytes are never changed.
 */
export const asRollbackJournalImage = (bytes: Uint8Array): Uint8Array => {
  if (!isWalSqliteImage(bytes)) return bytes;
  const image = bytes.slice();
  image[WRITE_VERSION_OFFSET] = ROLLBACK_JOURNAL;
  image[READ_VERSION_OFFSET] = ROLLBACK_JOURNAL;
  return image;
};
