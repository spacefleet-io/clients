/**
 * LIB-EDIT-01 / LIB-EDIT-02: the `media_editions` table, the `edition_id` and `content_sha256` columns of
 * `media_files`, and the registered metadata migration step that brings an existing library there (desktop and phone
 * both run `editionsMigrationStatements`). New libraries get the table and columns from the metadata baseline DDL.
 *
 * Also the statements every op writer (the shared op applier and the phone's own `media.upsert` path) runs to store a
 * title's editions and its files' editions, so the two cannot drift.
 */
import type { MediaDetails } from "@space/shared/libraryTypes";
import { defaultEditionId } from "@space/shared/mediaEditions";

export const MEDIA_EDITIONS_DDL: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS media_editions (
    id TEXT PRIMARY KEY,
    media_id TEXT NOT NULL,
    season INTEGER,
    episode INTEGER,
    name TEXT NOT NULL DEFAULT '',
    name_user_set INTEGER NOT NULL DEFAULT 0,
    duration_seconds REAL,
    created_at TEXT NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS media_editions_media_id_idx ON media_editions(media_id);`,
];

/** `media_files` columns added by LIB-EDIT-01, in the order the baseline DDL lists them after `template_id`. */
export const MEDIA_FILES_EDITION_COLUMNS: ReadonlyArray<readonly [name: string, type: string]> = [
  ["edition_id", "TEXT"],
  ["content_sha256", "TEXT"],
];

/** SQL twin of `defaultEditionId` over a `media_files` row (`media_id`, `season`, `episode`). */
export const DEFAULT_EDITION_ID_SQL =
  "'ed-' || media_id || '-' || COALESCE(CAST(season AS TEXT), 'x') || '-' || COALESCE(CAST(episode AS TEXT), 'x')";

/**
 * The metadata migration step of LIB-EDIT-01/02, given the columns `media_files` has now (`PRAGMA table_info`):
 * add the missing edition columns, then give every film and every episode with files one unnamed edition holding all
 * of its files (LIB-EDIT-02). Idempotent: a fresh library (columns from the baseline, no files) only gets the index.
 */
export const editionsMigrationStatements = (mediaFilesColumns: ReadonlyArray<string>): string[] => [
  ...MEDIA_EDITIONS_DDL,
  ...MEDIA_FILES_EDITION_COLUMNS.filter(([name]) => !mediaFilesColumns.includes(name)).map(
    ([name, type]) => `ALTER TABLE media_files ADD COLUMN ${name} ${type};`
  ),
  `CREATE INDEX IF NOT EXISTS media_files_edition_id_idx ON media_files(edition_id);`,
  `INSERT OR IGNORE INTO media_editions (id, media_id, season, episode, name, name_user_set, duration_seconds, created_at)
    SELECT ${DEFAULT_EDITION_ID_SQL}, media_id, season, episode, '', 0, NULL,
      COALESCE(MIN(added_at), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    FROM media_files WHERE edition_id IS NULL GROUP BY media_id, season, episode;`,
  `UPDATE media_files SET edition_id = ${DEFAULT_EDITION_ID_SQL} WHERE edition_id IS NULL;`,
];

export type SqlStatement = readonly [sql: string, params: unknown[]];

/**
 * Statements that store a title's editions and its files (after the caller deleted the title's `media_files`). An op
 * that carries `editions` replaces the title's edition rows; one from a client that predates editions leaves them and
 * files each of its files under its unit's unnamed edition, created when missing.
 */
export const mediaFilesAndEditionsStatements = (details: MediaDetails): SqlStatement[] => {
  const mediaId = details.id;
  const statements: SqlStatement[] = [];
  const editionIds = new Set<string>();
  if (Array.isArray(details.editions)) {
    statements.push(["DELETE FROM media_editions WHERE media_id = ?;", [mediaId]]);
    for (const edition of details.editions) {
      editionIds.add(edition.id);
      statements.push([
        "INSERT OR REPLACE INTO media_editions (id, media_id, season, episode, name, name_user_set, duration_seconds, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?);",
        [
          edition.id,
          mediaId,
          edition.season,
          edition.episode,
          edition.name,
          edition.nameUserSet ? 1 : 0,
          edition.durationSeconds,
          edition.createdAt,
        ],
      ]);
    }
  }
  for (const file of details.files ?? []) {
    const editionId = file.editionId ?? defaultEditionId(mediaId, file.season, file.episode);
    if (!editionIds.has(editionId)) {
      editionIds.add(editionId);
      statements.push([
        "INSERT OR IGNORE INTO media_editions (id, media_id, season, episode, name, name_user_set, duration_seconds, created_at) VALUES (?, ?, ?, ?, '', 0, NULL, ?);",
        [editionId, mediaId, file.season, file.episode, details.updatedAt],
      ]);
    }
    statements.push([
      "INSERT OR REPLACE INTO media_files (id, media_id, filename, season, episode, added_at, status, edition_id, content_sha256, original_size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);",
      [
        file.id,
        mediaId,
        file.filename,
        file.season,
        file.episode,
        details.updatedAt,
        "local",
        editionId,
        file.contentSha256 ?? null,
        file.originalSizeBytes ?? null,
      ],
    ]);
  }
  return statements;
};
