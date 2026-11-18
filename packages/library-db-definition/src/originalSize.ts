/**
 * STOR-USE-02: `media_files.original_size_bytes`, the size the user's computer showed for the imported file (`fs.stat`,
 * the size the file counts at in the storage allowance). New libraries get the column from the metadata baseline DDL;
 * an existing library gets it from the registered metadata migration step (desktop metadata v3, phone metadata v4),
 * then the desktop runtime fills it for files imported before it existed (`backfillOriginalSizeFromSourceFormats`).
 */
import type { SqliteDb } from "./migrations";

/** The metadata migration step: add the column when the library does not have it yet. Adds only (LIB-FMT-03). */
export const originalSizeMigrationStatements = (mediaFilesColumns: ReadonlyArray<string>): string[] =>
  mediaFilesColumns.includes("original_size_bytes") ? [] : ["ALTER TABLE media_files ADD COLUMN original_size_bytes INTEGER;"];

/** `core.app_settings` key set once the backfill ran, so it runs once per library. */
export const ORIGINAL_SIZE_BACKFILL_MARKER_KEY = "migration_original_size_backfill";

/**
 * Fills `original_size_bytes` for files stored before it existed, from the bytes of the file's source copy
 * (`media_formats.total_size` of its `is_source` row, or of its largest copy when none is marked source). The two
 * tables live in separate files (metadata and playback), so the runtime runs this once both are open. Never
 * overwrites a recorded size; runs once (marker in core's `app_settings`). Returns how many files it filled.
 */
export const backfillOriginalSizeFromSourceFormats = (
  coreDb: SqliteDb,
  metadataDb: SqliteDb,
  playbackDb: SqliteDb,
  now: () => string = () => new Date().toISOString()
): number => {
  const marker = coreDb.prepare("SELECT value FROM app_settings WHERE key = ?;").all(ORIGINAL_SIZE_BACKFILL_MARKER_KEY);
  if (marker.length > 0) return 0;
  const sizes = playbackDb
    .prepare(
      `SELECT file_id, COALESCE(MAX(CASE WHEN is_source = 1 THEN total_size END), MAX(total_size)) AS bytes
       FROM media_formats WHERE total_size > 0 GROUP BY file_id;`
    )
    .all() as Array<{ file_id?: unknown; bytes?: unknown }>;
  const update = metadataDb.prepare(
    "UPDATE media_files SET original_size_bytes = ? WHERE id = ? AND original_size_bytes IS NULL;"
  );
  let filled = 0;
  for (const row of sizes) {
    const fileId = String(row.file_id ?? "");
    const bytes = Math.floor(Number(row.bytes ?? 0));
    if (!fileId || !Number.isFinite(bytes) || bytes <= 0) continue;
    const result = update.run(bytes, fileId) as { changes?: number } | undefined;
    filled += Number(result?.changes ?? 0);
  }
  coreDb
    .prepare("INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?);")
    .run(ORIGINAL_SIZE_BACKFILL_MARKER_KEY, "1", now());
  return filled;
};
