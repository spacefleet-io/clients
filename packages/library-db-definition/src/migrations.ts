import { randomUUID } from "node:crypto";
import { ALL_LIBRARY_DB_GROUPS, type LibraryDbGroup } from "./manifest";
import { MEDIA_CREW_DDL } from "./crewDdl";
import { MEDIA_EDITIONS_DDL } from "./editionDdl";
import { straySystemPlaylistsQuery, systemPlaylistHealStatements } from "./systemPlaylists";

export type SqliteDb = {
  exec: (sql: string) => unknown;
  prepare: (sql: string) => {
    all: (...params: unknown[]) => unknown[];
    run: (...params: unknown[]) => unknown;
  };
};

/**
 * Minimal async SQLite shape for clients whose driver is Promise-based
 * (e.g. mobile via `react-native-sqlite-storage`). Per-group DDL only —
 * cross-group backfills are not exposed via this API because they assume
 * a single open database.
 */
export type AsyncSqliteDb = {
  exec: (sql: string) => Promise<unknown> | unknown;
};

const nowIso = () => new Date().toISOString();

const parseGenres = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry ?? "").trim())
      .filter((entry) => entry.length > 0);
  }
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => String(entry ?? "").trim())
      .filter((entry) => entry.length > 0);
  } catch {
    return [];
  }
};

const parseExternalIds = (value: unknown): Record<string, string | number | null> | null => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, string | number | null>;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, string | number | null>;
  } catch {
    return null;
  }
};

const resetLegacySchema = (db: SqliteDb) => {
  try {
    const rows = db.prepare("PRAGMA table_info(media_items);").all() as Array<{ name?: string }>;
    if (!rows.length) return;
    const columns = rows.map((row) => String(row?.name ?? ""));
    const hasLegacyTmdb = columns.includes("tmdb_id");
    const hasExternalIds = columns.includes("external_ids");
    if (!hasLegacyTmdb || hasExternalIds) return;

    [
      "playlist_items",
      "playlists",
      "ingest_job_events",
      "ingest_jobs",
      "media_formats",
      "media_audio_tracks",
      "media_subtitles",
      "media_trailers",
      "media_files",
      "media_episodes",
      "media_seasons",
      "media_roles",
      "media_format_chunks",
      "media_file_desired_formats",
      "media_external_ids",
      "media_genres",
      "people_external_ids",
      "people",
      "media_cast",
      "media_items",
    ].forEach((table) => {
      db.exec(`DROP TABLE IF EXISTS ${table};`);
    });
  } catch {
    // Ignore legacy detection failures.
  }
};

const tableHasColumn = (db: SqliteDb, table: string, column: string) => {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table});`).all() as Array<{ name?: string }>;
    return rows.some((row) => String(row?.name ?? "") === column);
  } catch {
    return false;
  }
};

const tableColumnType = (db: SqliteDb, table: string, column: string) => {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table});`).all() as Array<{ name?: string; type?: string }>;
    const match = rows.find((row) => String(row?.name ?? "") === column);
    if (!match) return null;
    return String(match?.type ?? "").trim();
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Per-group base DDL — the single source of truth for CREATE TABLE + CREATE
// INDEX statements. Both the sync `ensure*Tables` (desktop) and the async
// `ensure*TablesAsync` (mobile) iterate these arrays in order. Sync paths
// additionally run legacy ALTER-column branches; async paths skip those
// because mobile evolves via per-DB user_version migrations in
// apps/badger/mobile/src/lib/libraryMigrations.ts (no legacy column drift
// is reachable on a fresh-install client).
// ---------------------------------------------------------------------------

const coreDdl: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS media_items (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    original_title TEXT,
    original_language TEXT,
    overview TEXT,
    year TEXT,
    rating REAL,
    poster_path TEXT,
    backdrop_path TEXT,
    added_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    has_files INTEGER NOT NULL DEFAULT 0,
    progress_pct REAL NOT NULL DEFAULT 0,
    last_watched_at TEXT,
    total_episodes INTEGER,
    preferred_audio_language TEXT
  );`,
  `CREATE INDEX IF NOT EXISTS media_items_type_idx ON media_items(type);`,
  `CREATE INDEX IF NOT EXISTS media_items_added_at_idx ON media_items(added_at);`,
  `CREATE INDEX IF NOT EXISTS media_items_updated_at_idx ON media_items(updated_at);`,
  `CREATE TABLE IF NOT EXISTS media_genres (
    id TEXT PRIMARY KEY,
    media_id TEXT NOT NULL,
    genre_id INTEGER NOT NULL,
    FOREIGN KEY(media_id) REFERENCES media_items(id) ON DELETE CASCADE
  );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS media_genres_unique_idx ON media_genres(media_id, genre_id);`,
  `CREATE INDEX IF NOT EXISTS media_genres_media_id_idx ON media_genres(media_id);`,
  `CREATE TABLE IF NOT EXISTS media_external_ids (
    id TEXT PRIMARY KEY,
    media_id TEXT NOT NULL,
    media_type TEXT NOT NULL,
    source TEXT NOT NULL,
    external_id TEXT NOT NULL,
    FOREIGN KEY(media_id) REFERENCES media_items(id) ON DELETE CASCADE
  );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS media_external_ids_unique_idx ON media_external_ids(media_type, source, external_id);`,
  `CREATE INDEX IF NOT EXISTS media_external_ids_media_id_idx ON media_external_ids(media_id);`,
  `CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS playlists (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT,
    is_system INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS playlists_slug_idx ON playlists(slug);`,
  `CREATE TABLE IF NOT EXISTS playlist_items (
    id TEXT PRIMARY KEY,
    playlist_id TEXT NOT NULL,
    media_id TEXT NOT NULL,
    added_at TEXT NOT NULL,
    UNIQUE(playlist_id, media_id),
    FOREIGN KEY(playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
    FOREIGN KEY(media_id) REFERENCES media_items(id) ON DELETE CASCADE
  );`,
  `CREATE INDEX IF NOT EXISTS playlist_items_playlist_id_idx ON playlist_items(playlist_id);`,
  `CREATE INDEX IF NOT EXISTS playlist_items_media_id_idx ON playlist_items(media_id);`,
];

const metadataDdl: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS media_files (
    id TEXT PRIMARY KEY,
    media_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    season INTEGER,
    episode INTEGER,
    added_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'local',
    template_id TEXT,
    edition_id TEXT,
    content_sha256 TEXT,
    original_size_bytes INTEGER,
    FOREIGN KEY(media_id) REFERENCES media_items(id) ON DELETE CASCADE
  );`,
  `CREATE INDEX IF NOT EXISTS media_files_media_id_idx ON media_files(media_id);`,
  `CREATE INDEX IF NOT EXISTS media_files_template_id_idx ON media_files(template_id);`,
  `CREATE TABLE IF NOT EXISTS people (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    profile_path TEXT
  );`,
  `CREATE INDEX IF NOT EXISTS people_name_idx ON people(name);`,
  `CREATE TABLE IF NOT EXISTS media_roles (
    id TEXT PRIMARY KEY,
    media_id TEXT NOT NULL,
    person_id TEXT NOT NULL,
    role TEXT,
    order_index INTEGER,
    FOREIGN KEY(media_id) REFERENCES media_items(id) ON DELETE CASCADE,
    FOREIGN KEY(person_id) REFERENCES people(id) ON DELETE CASCADE
  );`,
  `CREATE INDEX IF NOT EXISTS media_roles_media_id_idx ON media_roles(media_id);`,
  `CREATE INDEX IF NOT EXISTS media_roles_person_id_idx ON media_roles(person_id);`,
  ...MEDIA_CREW_DDL,
  ...MEDIA_EDITIONS_DDL,
  `CREATE TABLE IF NOT EXISTS people_external_ids (
    id TEXT PRIMARY KEY,
    person_id TEXT NOT NULL,
    source TEXT NOT NULL,
    external_id TEXT NOT NULL,
    FOREIGN KEY(person_id) REFERENCES people(id) ON DELETE CASCADE
  );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS people_external_ids_unique_idx ON people_external_ids(source, external_id);`,
  `CREATE INDEX IF NOT EXISTS people_external_ids_person_id_idx ON people_external_ids(person_id);`,
  `CREATE TABLE IF NOT EXISTS media_file_desired_formats (
    id TEXT PRIMARY KEY,
    media_id TEXT NOT NULL,
    file_id TEXT NOT NULL,
    quality TEXT NOT NULL,
    codec TEXT NOT NULL,
    bitrate_kbps INTEGER,
    FOREIGN KEY(media_id) REFERENCES media_items(id) ON DELETE CASCADE,
    FOREIGN KEY(file_id) REFERENCES media_files(id) ON DELETE CASCADE
  );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS media_file_desired_formats_unique_idx ON media_file_desired_formats(file_id, quality, codec);`,
  `CREATE INDEX IF NOT EXISTS media_file_desired_formats_media_id_idx ON media_file_desired_formats(media_id);`,
  `CREATE INDEX IF NOT EXISTS media_file_desired_formats_file_id_idx ON media_file_desired_formats(file_id);`,
  `CREATE TABLE IF NOT EXISTS media_seasons (
    id TEXT PRIMARY KEY,
    media_id TEXT NOT NULL,
    season_number INTEGER NOT NULL,
    title TEXT NOT NULL,
    overview TEXT,
    poster_path TEXT,
    episode_count INTEGER,
    air_date TEXT,
    FOREIGN KEY(media_id) REFERENCES media_items(id) ON DELETE CASCADE
  );`,
  `CREATE INDEX IF NOT EXISTS media_seasons_media_id_idx ON media_seasons(media_id);`,
  `CREATE TABLE IF NOT EXISTS media_episodes (
    id TEXT PRIMARY KEY,
    media_id TEXT NOT NULL,
    season_number INTEGER NOT NULL,
    episode_number INTEGER NOT NULL,
    title TEXT NOT NULL,
    overview TEXT,
    still_path TEXT,
    air_date TEXT,
    FOREIGN KEY(media_id) REFERENCES media_items(id) ON DELETE CASCADE
  );`,
  `CREATE INDEX IF NOT EXISTS media_episodes_media_id_idx ON media_episodes(media_id);`,
  `CREATE TABLE IF NOT EXISTS media_trailers (
    id TEXT PRIMARY KEY,
    media_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    key TEXT NOT NULL,
    name TEXT,
    language TEXT,
    FOREIGN KEY(media_id) REFERENCES media_items(id) ON DELETE CASCADE
  );`,
  `CREATE INDEX IF NOT EXISTS media_trailers_media_id_idx ON media_trailers(media_id);`,
  `CREATE TABLE IF NOT EXISTS media_skip_markers (
    id TEXT PRIMARY KEY,
    media_id TEXT NOT NULL,
    episode_id TEXT,
    type TEXT NOT NULL,
    start_seconds REAL NOT NULL,
    end_seconds REAL NOT NULL,
    source TEXT NOT NULL,
    confidence REAL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(media_id) REFERENCES media_items(id) ON DELETE CASCADE
  );`,
  `CREATE INDEX IF NOT EXISTS media_skip_markers_media_id_idx ON media_skip_markers(media_id);`,
  `CREATE INDEX IF NOT EXISTS media_skip_markers_episode_id_idx ON media_skip_markers(episode_id);`,
];

const playbackDdl: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS media_formats (
    id TEXT PRIMARY KEY,
    media_id TEXT NOT NULL,
    file_id TEXT NOT NULL,
    quality TEXT NOT NULL,
    codec TEXT NOT NULL,
    codec_string TEXT,
    bitrate_kbps INTEGER,
    init_key TEXT,
    init_size INTEGER,
    duration_seconds REAL,
    total_size INTEGER,
    size_mb INTEGER NOT NULL,
    is_source INTEGER NOT NULL DEFAULT 0,
    preview_sheets TEXT,
    FOREIGN KEY(media_id) REFERENCES media_items(id) ON DELETE CASCADE,
    FOREIGN KEY(file_id) REFERENCES media_files(id) ON DELETE CASCADE
  );`,
  `CREATE INDEX IF NOT EXISTS media_formats_media_id_idx ON media_formats(media_id);`,
  `CREATE INDEX IF NOT EXISTS media_formats_file_id_idx ON media_formats(file_id);`,
  `CREATE TABLE IF NOT EXISTS media_format_chunks (
    id TEXT PRIMARY KEY,
    format_id TEXT NOT NULL,
    chunk_key TEXT NOT NULL,
    order_index INTEGER NOT NULL,
    size_bytes INTEGER,
    start_seconds REAL,
    FOREIGN KEY(format_id) REFERENCES media_formats(id) ON DELETE CASCADE
  );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS media_format_chunks_unique_idx ON media_format_chunks(format_id, order_index);`,
  `CREATE TABLE IF NOT EXISTS media_audio_tracks (
    id TEXT PRIMARY KEY,
    media_id TEXT NOT NULL,
    file_id TEXT,
    episode_id TEXT,
    language TEXT NOT NULL,
    label TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL,
    codec TEXT,
    codec_string TEXT,
    init_key TEXT,
    init_size INTEGER,
    duration_seconds REAL,
    total_size INTEGER,
    created_at TEXT NOT NULL,
    FOREIGN KEY(media_id) REFERENCES media_items(id) ON DELETE CASCADE
  );`,
  `CREATE INDEX IF NOT EXISTS media_audio_tracks_media_id_idx ON media_audio_tracks(media_id);`,
  `CREATE INDEX IF NOT EXISTS media_audio_tracks_episode_id_idx ON media_audio_tracks(episode_id);`,
  `CREATE TABLE IF NOT EXISTS media_audio_chunks (
    id TEXT PRIMARY KEY,
    track_id TEXT NOT NULL,
    chunk_key TEXT NOT NULL,
    order_index INTEGER NOT NULL,
    size_bytes INTEGER,
    start_seconds REAL,
    FOREIGN KEY(track_id) REFERENCES media_audio_tracks(id) ON DELETE CASCADE
  );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS media_audio_chunks_unique_idx ON media_audio_chunks(track_id, order_index);`,
  `CREATE TABLE IF NOT EXISTS media_chapters (
    id TEXT PRIMARY KEY,
    format_id TEXT NOT NULL,
    title TEXT NOT NULL,
    start_seconds REAL NOT NULL,
    FOREIGN KEY(format_id) REFERENCES media_formats(id) ON DELETE CASCADE
  );`,
  `CREATE INDEX IF NOT EXISTS media_chapters_format_id_idx ON media_chapters(format_id);`,
  `CREATE TABLE IF NOT EXISTS media_subtitles (
    id TEXT PRIMARY KEY,
    media_id TEXT NOT NULL,
    file_id TEXT,
    episode_id TEXT,
    language TEXT NOT NULL,
    label TEXT NOT NULL,
    object_key TEXT,
    format TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    derived_from_subtitle_id TEXT,
    FOREIGN KEY(media_id) REFERENCES media_items(id) ON DELETE CASCADE
  );`,
  `CREATE INDEX IF NOT EXISTS media_subtitles_media_id_idx ON media_subtitles(media_id);`,
  `CREATE INDEX IF NOT EXISTS media_subtitles_episode_id_idx ON media_subtitles(episode_id);`,
  // media_local_downloads — per-device, never synced. One row per locally-saved
  // file (single muxed container; tracks are embedded in the container, not
  // separately persisted). FK cascade on file_id ensures library-side delete
  // wipes the local-download bookkeeping (the runtime delete handler is still
  // responsible for unlinking the on-disk file before the FK fires).
  `CREATE TABLE IF NOT EXISTS media_local_downloads (
    id TEXT PRIMARY KEY,
    file_id TEXT NOT NULL UNIQUE,
    media_id TEXT NOT NULL,
    quality TEXT NOT NULL,
    format_id TEXT NOT NULL,
    container TEXT NOT NULL,
    local_path TEXT NOT NULL,
    total_bytes INTEGER NOT NULL,
    downloaded_at TEXT NOT NULL,
    last_verified_at TEXT,
    runtime_job_id TEXT,
    schema_version INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY(file_id) REFERENCES media_files(id) ON DELETE CASCADE,
    FOREIGN KEY(format_id) REFERENCES media_formats(id) ON DELETE CASCADE
  );`,
  `CREATE INDEX IF NOT EXISTS media_local_downloads_media_id_idx ON media_local_downloads(media_id);`,
];

const ingestDdl: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS ingest_jobs (
    id TEXT PRIMARY KEY,
    media_id TEXT NOT NULL,
    file_id TEXT,
    worker_peer_id TEXT NOT NULL,
    owner_client_id TEXT,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    progress_pct INTEGER NOT NULL DEFAULT 0,
    error_code TEXT,
    error_message TEXT,
    meta_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    FOREIGN KEY(media_id) REFERENCES media_items(id) ON DELETE CASCADE
  );`,
  `CREATE INDEX IF NOT EXISTS ingest_jobs_media_id_idx ON ingest_jobs(media_id);`,
  `CREATE INDEX IF NOT EXISTS ingest_jobs_file_id_idx ON ingest_jobs(file_id);`,
  `CREATE INDEX IF NOT EXISTS ingest_jobs_status_idx ON ingest_jobs(status);`,
  `CREATE INDEX IF NOT EXISTS ingest_jobs_worker_peer_id_idx ON ingest_jobs(worker_peer_id);`,
  `CREATE INDEX IF NOT EXISTS ingest_jobs_updated_at_idx ON ingest_jobs(updated_at);`,
  `CREATE TABLE IF NOT EXISTS ingest_job_events (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    meta_json TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(job_id) REFERENCES ingest_jobs(id) ON DELETE CASCADE
  );`,
  `CREATE INDEX IF NOT EXISTS ingest_job_events_job_id_idx ON ingest_job_events(job_id);`,
  `CREATE INDEX IF NOT EXISTS ingest_job_events_created_at_idx ON ingest_job_events(created_at);`,
];

const templatesDdl: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS media_templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    source TEXT NOT NULL,
    signature TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS media_template_formats (
    id TEXT PRIMARY KEY,
    template_id TEXT NOT NULL,
    quality TEXT NOT NULL,
    codec TEXT NOT NULL,
    codec_string TEXT,
    bitrate_kbps INTEGER,
    init_key TEXT,
    init_size INTEGER,
    duration_seconds REAL,
    total_size INTEGER,
    size_mb INTEGER NOT NULL,
    FOREIGN KEY(template_id) REFERENCES media_templates(id) ON DELETE CASCADE
  );`,
  `CREATE INDEX IF NOT EXISTS media_template_formats_template_id_idx ON media_template_formats(template_id);`,
  `CREATE TABLE IF NOT EXISTS media_template_format_chunks (
    id TEXT PRIMARY KEY,
    format_id TEXT NOT NULL,
    chunk_key TEXT NOT NULL,
    order_index INTEGER NOT NULL,
    size_bytes INTEGER,
    start_seconds REAL,
    FOREIGN KEY(format_id) REFERENCES media_template_formats(id) ON DELETE CASCADE
  );`,
  `CREATE INDEX IF NOT EXISTS media_template_format_chunks_format_id_idx ON media_template_format_chunks(format_id);`,
  `CREATE TABLE IF NOT EXISTS media_template_audio_tracks (
    id TEXT PRIMARY KEY,
    template_id TEXT NOT NULL,
    language TEXT NOT NULL,
    label TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL,
    codec TEXT,
    codec_string TEXT,
    init_key TEXT,
    init_size INTEGER,
    duration_seconds REAL,
    total_size INTEGER,
    created_at TEXT NOT NULL,
    FOREIGN KEY(template_id) REFERENCES media_templates(id) ON DELETE CASCADE
  );`,
  `CREATE INDEX IF NOT EXISTS media_template_audio_tracks_template_id_idx ON media_template_audio_tracks(template_id);`,
  `CREATE TABLE IF NOT EXISTS media_template_audio_chunks (
    id TEXT PRIMARY KEY,
    track_id TEXT NOT NULL,
    chunk_key TEXT NOT NULL,
    order_index INTEGER NOT NULL,
    size_bytes INTEGER,
    start_seconds REAL,
    FOREIGN KEY(track_id) REFERENCES media_template_audio_tracks(id) ON DELETE CASCADE
  );`,
  `CREATE INDEX IF NOT EXISTS media_template_audio_chunks_track_id_idx ON media_template_audio_chunks(track_id);`,
  `CREATE TABLE IF NOT EXISTS media_template_subtitles (
    id TEXT PRIMARY KEY,
    template_id TEXT NOT NULL,
    language TEXT NOT NULL,
    label TEXT NOT NULL,
    object_key TEXT,
    format TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(template_id) REFERENCES media_templates(id) ON DELETE CASCADE
  );`,
  `CREATE INDEX IF NOT EXISTS media_template_subtitles_template_id_idx ON media_template_subtitles(template_id);`,
  `CREATE TABLE IF NOT EXISTS media_template_chapters (
    id TEXT PRIMARY KEY,
    format_id TEXT NOT NULL,
    title TEXT NOT NULL,
    start_seconds REAL NOT NULL,
    FOREIGN KEY(format_id) REFERENCES media_template_formats(id) ON DELETE CASCADE
  );`,
  `CREATE INDEX IF NOT EXISTS media_template_chapters_format_id_idx ON media_template_chapters(format_id);`,
  `CREATE TABLE IF NOT EXISTS media_skip_analysis (
    id TEXT PRIMARY KEY,
    media_id TEXT NOT NULL,
    episode_id TEXT,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(media_id) REFERENCES media_items(id) ON DELETE CASCADE
  );`,
  `CREATE INDEX IF NOT EXISTS media_skip_analysis_media_id_idx ON media_skip_analysis(media_id);`,
  `CREATE INDEX IF NOT EXISTS media_skip_analysis_episode_id_idx ON media_skip_analysis(episode_id);`,
  // subtitle_ocr_attempts — per-device, never synced (LOCAL_ONLY_TABLES in
  // library-db-runtime). One row per picture subtitle (PGS / VobSub / DVB) the
  // runtime tried to turn into an OCR text twin and could not (PLAY-TRACK-05):
  // `status` is `failed` or `no_text`. A picture row with a twin needs no row
  // here; the catch-up pass reads this to wait out the retry window.
  `CREATE TABLE IF NOT EXISTS subtitle_ocr_attempts (
    subtitle_id TEXT PRIMARY KEY,
    media_id TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    last_attempt_at TEXT NOT NULL
  );`,
];

const groupDdl: Readonly<Record<LibraryDbGroup, ReadonlyArray<string>>> = {
  core: coreDdl,
  metadata: metadataDdl,
  playback: playbackDdl,
  ingest: ingestDdl,
  templates: templatesDdl,
};

// ---------------------------------------------------------------------------
// Per-group sync DDL — iterates the shared constant, then runs legacy column-
// add ALTER paths for desktop's historical schema evolution. Each ALTER is
// wrapped in try/catch and made idempotent.
// ---------------------------------------------------------------------------

const ensureCoreTables = (db: SqliteDb) => {
  for (const stmt of coreDdl) db.exec(stmt);
};

const ensureMetadataTables = (db: SqliteDb) => {
  for (const stmt of metadataDdl) db.exec(stmt);
  try {
    db.exec(`ALTER TABLE media_files ADD COLUMN template_id TEXT;`);
  } catch {
    // Column already exists.
  }
  try {
    db.exec(`ALTER TABLE media_trailers ADD COLUMN language TEXT;`);
  } catch {
    // Column already exists.
  }
};

// Quality ordering for the `is_source` backfill. Mirrors `QUALITY_ORDER` in
// `@space/ingest-core`'s quality.ts — inlined here because library-db-definition
// cannot depend on ingest-core (it is the lower layer). Smaller index = higher
// resolution. Unknown qualities sort to the end (never picked as source).
const QUALITY_RANK: Readonly<Record<string, number>> = {
  "2160p": 0,
  "1080p": 1,
  "720p": 2,
  "480p": 3,
  "360p": 4,
  "240p": 5,
  "144p": 6,
};

export const rankQualityForSourceBackfill = (quality: string): number => {
  const rank = QUALITY_RANK[quality];
  return rank === undefined ? Number.POSITIVE_INFINITY : rank;
};

/**
 * Self-healing `is_source` backfill — runs on EVERY playback-group open
 * (idempotent), not only when the column is freshly added by ALTER.
 *
 * For each file_id that currently has NO `is_source = 1` row, pick the row with
 * the highest available resolution (lowest QUALITY_RANK) and set its
 * is_source = 1. Tie-breaker: deterministic by row id (lowest id wins) so
 * re-runs against the same data are stable.
 *
 * Why every-open instead of only on the column-add ALTER: two paths leave
 * existing media with no protected source row, and the original ALTER-gated
 * backfill never reached either of them —
 *   1. Fresh DBs get `is_source` from the CREATE TABLE DDL (DEFAULT 0), so the
 *      `ALTER TABLE … ADD COLUMN is_source` branch never fires → backfill
 *      never ran.
 *   2. Formats (re-)applied from pre-`is_source` (v1) op-stream entries land as
 *      is_source = 0 — the payload carries no isSource — even on a DB that was
 *      migrated and backfilled earlier.
 * Both leave the post-ingest delete guard inert (it only refuses to delete an
 * `is_source = 1` row), so the highest/only quality becomes deletable and a
 * user can orphan their own media. Since we never up-scale, the highest
 * available resolution IS the de-facto source — so flag it.
 *
 * Non-destructive + idempotent: a file that ALREADY has an `is_source = 1` row
 * is skipped entirely — an explicit/earlier flag is never overridden, even if
 * it sits on a lower-resolution row (someone flagged it deliberately). A file
 * with no rows, or an empty table, is a no-op.
 *
 * Uses `SELECT *` so the read returns the current is_source value alongside
 * id/file_id/quality in a single scan.
 *
 * @bugfix existing-media-source-not-flagged
 */
const backfillMissingIsSourceFlags = (db: SqliteDb) => {
  const rows = db
    .prepare("SELECT * FROM media_formats;")
    .all() as Array<{ id?: string; file_id?: string; quality?: string; is_source?: number }>;
  if (!rows.length) return;

  type Candidate = { id: string; rank: number };
  const winnerByFile = new Map<string, Candidate>();
  const fileHasSource = new Set<string>();
  for (const raw of rows) {
    const id = String(raw?.id ?? "");
    const fileId = String(raw?.file_id ?? "");
    if (!id || !fileId) continue;
    // A file with any flagged source is already protected — never touch it.
    if (Number(raw?.is_source ?? 0) === 1) {
      fileHasSource.add(fileId);
      continue;
    }
    const quality = String(raw?.quality ?? "");
    const candidate: Candidate = { id, rank: rankQualityForSourceBackfill(quality) };
    const current = winnerByFile.get(fileId);
    if (
      !current ||
      candidate.rank < current.rank ||
      (candidate.rank === current.rank && candidate.id < current.id)
    ) {
      winnerByFile.set(fileId, candidate);
    }
  }

  const update = db.prepare("UPDATE media_formats SET is_source = 1 WHERE id = ?;");
  for (const [fileId, winner] of winnerByFile) {
    // Skip files that turned out to already have a flagged source (the source
    // row may have been visited after some of this file's non-source rows).
    if (fileHasSource.has(fileId)) continue;
    update.run(winner.id);
  }
};

const ensurePlaybackTables = (db: SqliteDb) => {
  for (const stmt of playbackDdl) db.exec(stmt);

  try {
    const rows = db.prepare("PRAGMA table_info(media_formats);").all() as Array<{ name?: string }>;
    const columns = rows.map((row) => String(row?.name ?? ""));
    if (!columns.includes("bitrate_kbps")) db.exec(`ALTER TABLE media_formats ADD COLUMN bitrate_kbps INTEGER;`);
    if (!columns.includes("codec_string")) db.exec(`ALTER TABLE media_formats ADD COLUMN codec_string TEXT;`);
    if (!columns.includes("init_key")) db.exec(`ALTER TABLE media_formats ADD COLUMN init_key TEXT;`);
    if (!columns.includes("init_size")) db.exec(`ALTER TABLE media_formats ADD COLUMN init_size INTEGER;`);
    if (!columns.includes("duration_seconds")) db.exec(`ALTER TABLE media_formats ADD COLUMN duration_seconds REAL;`);
    if (!columns.includes("total_size")) db.exec(`ALTER TABLE media_formats ADD COLUMN total_size INTEGER;`);
    if (!columns.includes("is_source")) {
      db.exec(`ALTER TABLE media_formats ADD COLUMN is_source INTEGER NOT NULL DEFAULT 0;`);
    }
    if (!columns.includes("preview_sheets")) db.exec(`ALTER TABLE media_formats ADD COLUMN preview_sheets TEXT;`);
    // Self-healing: flag the highest-quality format as the source for any file
    // that has no protected source row. Runs every open (not gated on the
    // ALTER above) so it also reaches fresh DBs and v1-op-stream-applied rows.
    // See backfillMissingIsSourceFlags for the full rationale.
    backfillMissingIsSourceFlags(db);
  } catch {
    // Ignore media_formats migrations.
  }

  try {
    const rows = db.prepare("PRAGMA table_info(media_format_chunks);").all() as Array<{ name?: string }>;
    const columns = rows.map((row) => String(row?.name ?? ""));
    if (!columns.includes("size_bytes")) db.exec(`ALTER TABLE media_format_chunks ADD COLUMN size_bytes INTEGER;`);
    if (!columns.includes("start_seconds")) db.exec(`ALTER TABLE media_format_chunks ADD COLUMN start_seconds REAL;`);
  } catch {
    // Ignore media_format_chunks migrations.
  }

  try {
    const rows = db.prepare("PRAGMA table_info(media_audio_tracks);").all() as Array<{ name?: string }>;
    const columns = rows.map((row) => String(row?.name ?? ""));
    if (!columns.includes("codec")) db.exec(`ALTER TABLE media_audio_tracks ADD COLUMN codec TEXT;`);
    if (!columns.includes("codec_string")) db.exec(`ALTER TABLE media_audio_tracks ADD COLUMN codec_string TEXT;`);
    if (!columns.includes("init_key")) db.exec(`ALTER TABLE media_audio_tracks ADD COLUMN init_key TEXT;`);
    if (!columns.includes("init_size")) db.exec(`ALTER TABLE media_audio_tracks ADD COLUMN init_size INTEGER;`);
    if (!columns.includes("duration_seconds")) db.exec(`ALTER TABLE media_audio_tracks ADD COLUMN duration_seconds REAL;`);
    if (!columns.includes("total_size")) db.exec(`ALTER TABLE media_audio_tracks ADD COLUMN total_size INTEGER;`);
  } catch {
    // Ignore media_audio_tracks migrations.
  }

  try {
    const rows = db.prepare("PRAGMA table_info(media_subtitles);").all() as Array<{ name?: string }>;
    const columns = rows.map((row) => String(row?.name ?? ""));
    if (!columns.includes("format")) db.exec(`ALTER TABLE media_subtitles ADD COLUMN format TEXT;`);
    if (!columns.includes("derived_from_subtitle_id")) {
      db.exec(`ALTER TABLE media_subtitles ADD COLUMN derived_from_subtitle_id TEXT;`);
    }
  } catch {
    // Ignore media_subtitles migrations.
  }
};

const ensureIngestTables = (db: SqliteDb) => {
  for (const stmt of ingestDdl) db.exec(stmt);
};

const ensureTemplatesTables = (db: SqliteDb) => {
  for (const stmt of templatesDdl) db.exec(stmt);
};

const groupInitializers: Readonly<Record<LibraryDbGroup, (db: SqliteDb) => void>> = {
  core: ensureCoreTables,
  metadata: ensureMetadataTables,
  playback: ensurePlaybackTables,
  ingest: ensureIngestTables,
  templates: ensureTemplatesTables,
};

// ---------------------------------------------------------------------------
// Per-group async DDL — for clients whose SQLite driver returns Promises
// (e.g. mobile via react-native-sqlite-storage). Iterates the SAME shared
// DDL constants as the sync version. No legacy ALTER paths — async consumers
// (mobile) evolve their schema through per-DB user_version migrations.
// ---------------------------------------------------------------------------

const ensureCoreTablesAsync = async (db: AsyncSqliteDb): Promise<void> => {
  for (const stmt of coreDdl) await db.exec(stmt);
};

const ensureMetadataTablesAsync = async (db: AsyncSqliteDb): Promise<void> => {
  for (const stmt of metadataDdl) await db.exec(stmt);
};

const ensurePlaybackTablesAsync = async (db: AsyncSqliteDb): Promise<void> => {
  for (const stmt of playbackDdl) await db.exec(stmt);
};

const ensureIngestTablesAsync = async (db: AsyncSqliteDb): Promise<void> => {
  for (const stmt of ingestDdl) await db.exec(stmt);
};

const ensureTemplatesTablesAsync = async (db: AsyncSqliteDb): Promise<void> => {
  for (const stmt of templatesDdl) await db.exec(stmt);
};

const groupInitializersAsync: Readonly<Record<LibraryDbGroup, (db: AsyncSqliteDb) => Promise<void>>> = {
  core: ensureCoreTablesAsync,
  metadata: ensureMetadataTablesAsync,
  playback: ensurePlaybackTablesAsync,
  ingest: ensureIngestTablesAsync,
  templates: ensureTemplatesTablesAsync,
};

// ---------------------------------------------------------------------------
// Legacy single-DB migrations. These read+write across what will become multiple
// groups; they only work when every table lives in the same SQLite file (today's
// desktop). After Phase 3 splits desktop, the in-place file-split migration moves
// already-normalized rows directly, so these functions are no longer invoked.
// ---------------------------------------------------------------------------

const migrateNormalizedSchema = (db: SqliteDb) => {
  const hasMediaGenres = tableHasColumn(db, "media_items", "genres");
  const hasMediaExternalIds = tableHasColumn(db, "media_items", "external_ids");
  const hasPreferredAudioLanguage = tableHasColumn(db, "media_items", "preferred_audio_language");
  const hasPeopleExternalIds = tableHasColumn(db, "people", "external_ids");
  const hasDesiredFormats = tableHasColumn(db, "media_files", "desired_formats");
  const hasTemplateId = tableHasColumn(db, "media_files", "template_id");
  const hasChunkKeys = tableHasColumn(db, "media_formats", "chunk_keys");
  const hasFormatBitrate = tableHasColumn(db, "media_formats", "bitrate_kbps");
  const hasFormatChunkFormatId = tableHasColumn(db, "media_format_chunks", "format_id");
  const progressType = tableColumnType(db, "media_items", "progress_pct");
  const needsProgressMigration = Boolean(progressType && !progressType.toUpperCase().includes("REAL"));

  if (
    !(
      hasMediaGenres ||
      hasMediaExternalIds ||
      hasPeopleExternalIds ||
      hasDesiredFormats ||
      hasChunkKeys ||
      needsProgressMigration ||
      !hasPreferredAudioLanguage
    )
  ) {
    return;
  }

  const mediaColumns = ["id", "type"];
  if (hasMediaGenres) mediaColumns.push("genres");
  if (hasMediaExternalIds) mediaColumns.push("external_ids");
  const mediaRows = db.prepare(`SELECT ${mediaColumns.join(", ")} FROM media_items;`).all() as Array<{
    id?: string;
    type?: string;
    genres?: string | null;
    external_ids?: string | null;
  }>;
  mediaRows.forEach((row) => {
    const mediaId = String(row.id ?? "");
    const mediaType = String(row.type ?? "");
    if (!mediaId) return;
    const genres = parseGenres(row.genres);
    genres.forEach((genreId) => {
      db.prepare("INSERT OR IGNORE INTO media_genres (id, media_id, genre_id) VALUES (?, ?, ?);").run(
        randomUUID(),
        mediaId,
        genreId
      );
    });
    const externalIds = parseExternalIds(row.external_ids);
    if (externalIds) {
      Object.entries(externalIds).forEach(([source, value]) => {
        if (value === null || value === undefined) return;
        db.prepare(
          "INSERT OR IGNORE INTO media_external_ids (id, media_id, media_type, source, external_id) VALUES (?, ?, ?, ?, ?);"
        ).run(randomUUID(), mediaId, mediaType, source, String(value));
      });
    }
  });

  if (hasPeopleExternalIds) {
    const peopleRows = db.prepare("SELECT id, external_ids FROM people;").all() as Array<{
      id?: string;
      external_ids?: string | null;
    }>;
    peopleRows.forEach((row) => {
      const personId = String(row.id ?? "");
      if (!personId) return;
      const externalIds = parseExternalIds(row.external_ids);
      if (externalIds) {
        Object.entries(externalIds).forEach(([source, value]) => {
          if (value === null || value === undefined) return;
          db.prepare(
            "INSERT OR IGNORE INTO people_external_ids (id, person_id, source, external_id) VALUES (?, ?, ?, ?);"
          ).run(randomUUID(), personId, source, String(value));
        });
      }
    });
  }

  if (hasDesiredFormats) {
    const fileRows = db.prepare("SELECT id, media_id, desired_formats FROM media_files;").all() as Array<{
      id?: string;
      media_id?: string;
      desired_formats?: string | null;
    }>;
    fileRows.forEach((row) => {
      const fileId = String(row.id ?? "");
      const mediaId = String(row.media_id ?? "");
      if (!fileId || !mediaId) return;
      let formats: Array<{ quality?: string; codec?: string; bitrateKbps?: number | null }> = [];
      try {
        const parsed = JSON.parse(String(row.desired_formats ?? "[]"));
        if (Array.isArray(parsed)) formats = parsed;
      } catch {
        formats = [];
      }
      formats.forEach((format) => {
        if (!format?.quality || !format?.codec) return;
        db.prepare(
          "INSERT OR IGNORE INTO media_file_desired_formats (id, media_id, file_id, quality, codec, bitrate_kbps) VALUES (?, ?, ?, ?, ?, ?);"
        ).run(
          randomUUID(),
          mediaId,
          fileId,
          String(format.quality),
          String(format.codec),
          format.bitrateKbps ?? null
        );
      });
    });
  }

  if (!hasFormatChunkFormatId) {
    db.exec("DROP TABLE IF EXISTS media_format_chunks;");
  }

  if (hasChunkKeys) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS media_format_chunks (
        id TEXT PRIMARY KEY,
        format_id TEXT NOT NULL,
        chunk_key TEXT NOT NULL,
        order_index INTEGER NOT NULL,
        size_bytes INTEGER,
        start_seconds REAL,
        FOREIGN KEY(format_id) REFERENCES media_formats(id) ON DELETE CASCADE
      );
    `);
    const formatRows = db.prepare("SELECT id, chunk_keys FROM media_formats;").all() as Array<{
      id?: string;
      chunk_keys?: string | null;
    }>;
    formatRows.forEach((row) => {
      const formatId = String(row.id ?? "");
      if (!formatId) return;
      let keys: string[] = [];
      try {
        const parsed = JSON.parse(String(row.chunk_keys ?? "[]"));
        if (Array.isArray(parsed)) keys = parsed.map((key) => String(key));
      } catch {
        keys = [];
      }
      keys.forEach((key, index) => {
        db.prepare(
          "INSERT OR IGNORE INTO media_format_chunks (id, format_id, chunk_key, order_index) VALUES (?, ?, ?, ?);"
        ).run(randomUUID(), formatId, key, index);
      });
    });
  }

  db.exec("PRAGMA foreign_keys=OFF;");

  if (hasMediaGenres || hasMediaExternalIds || needsProgressMigration) {
    db.exec("DROP TABLE IF EXISTS media_items_new;");
    db.exec(`
      CREATE TABLE IF NOT EXISTS media_items_new (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        original_title TEXT,
        original_language TEXT,
        overview TEXT,
        year TEXT,
        rating REAL,
        poster_path TEXT,
        backdrop_path TEXT,
        added_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        has_files INTEGER NOT NULL DEFAULT 0,
        progress_pct REAL NOT NULL DEFAULT 0,
        last_watched_at TEXT,
        total_episodes INTEGER,
        preferred_audio_language TEXT
      );
    `);
    db.exec(`
      INSERT INTO media_items_new (id, type, title, original_title, original_language, overview, year, rating, poster_path, backdrop_path, added_at, updated_at, has_files, progress_pct, last_watched_at, total_episodes, preferred_audio_language)
      SELECT id, type, title, original_title, original_language, overview, year, rating, poster_path, backdrop_path, added_at, updated_at, has_files, progress_pct, last_watched_at, total_episodes, preferred_audio_language
      FROM media_items;
    `);
    db.exec("DROP TABLE media_items;");
    db.exec("ALTER TABLE media_items_new RENAME TO media_items;");
  }

  if (!hasPreferredAudioLanguage) {
    try {
      db.exec(`ALTER TABLE media_items ADD COLUMN preferred_audio_language TEXT;`);
    } catch {
      // Column already exists.
    }
  }

  if (hasPeopleExternalIds) {
    db.exec("DROP TABLE IF EXISTS people_new;");
    db.exec(`
      CREATE TABLE IF NOT EXISTS people_new (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        profile_path TEXT
      );
    `);
    db.exec(`
      INSERT INTO people_new (id, name, profile_path)
      SELECT id, name, profile_path FROM people;
    `);
    db.exec("DROP TABLE people;");
    db.exec("ALTER TABLE people_new RENAME TO people;");
  }

  if (hasDesiredFormats) {
    db.exec("DROP TABLE IF EXISTS media_files_new;");
    db.exec(`
      CREATE TABLE IF NOT EXISTS media_files_new (
        id TEXT PRIMARY KEY,
        media_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        season INTEGER,
        episode INTEGER,
        added_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'local',
        FOREIGN KEY(media_id) REFERENCES media_items(id) ON DELETE CASCADE
      );
    `);
    db.exec(`
      INSERT INTO media_files_new (id, media_id, filename, season, episode, added_at, status)
      SELECT id, media_id, filename, season, episode, added_at, status FROM media_files;
    `);
    db.exec("DROP TABLE media_files;");
    db.exec("ALTER TABLE media_files_new RENAME TO media_files;");
  }

  if (hasChunkKeys) {
    db.exec("DROP TABLE IF EXISTS media_formats_new;");
    db.exec(`
      CREATE TABLE IF NOT EXISTS media_formats_new (
        id TEXT PRIMARY KEY,
        media_id TEXT NOT NULL,
        file_id TEXT NOT NULL,
        quality TEXT NOT NULL,
        codec TEXT NOT NULL,
        bitrate_kbps INTEGER,
        size_mb INTEGER NOT NULL,
        FOREIGN KEY(media_id) REFERENCES media_items(id) ON DELETE CASCADE,
        FOREIGN KEY(file_id) REFERENCES media_files(id) ON DELETE CASCADE
      );
    `);
    const bitrateColumn = hasFormatBitrate ? "bitrate_kbps" : "NULL AS bitrate_kbps";
    db.exec(`
      INSERT INTO media_formats_new (id, media_id, file_id, quality, codec, bitrate_kbps, size_mb)
      SELECT id, media_id, file_id, quality, codec, ${bitrateColumn}, size_mb FROM media_formats;
    `);
    db.exec("DROP TABLE media_formats;");
    db.exec("ALTER TABLE media_formats_new RENAME TO media_formats;");
  }

  if (!hasTemplateId) {
    try {
      db.exec(`ALTER TABLE media_files ADD COLUMN template_id TEXT;`);
    } catch {
      // Column already exists.
    }
  }

  db.exec("PRAGMA foreign_keys=ON;");
};

const migrateMovieEpisodeScopes = (db: SqliteDb) => {
  try {
    db.exec(`
      UPDATE media_files
      SET season = NULL,
          episode = NULL
      WHERE media_id IN (SELECT id FROM media_items WHERE type = 'movie');
    `);
    db.exec(`
      UPDATE media_audio_tracks
      SET episode_id = NULL
      WHERE media_id IN (SELECT id FROM media_items WHERE type = 'movie');
    `);
    db.exec(`
      UPDATE media_subtitles
      SET episode_id = NULL
      WHERE media_id IN (SELECT id FROM media_items WHERE type = 'movie');
    `);
    db.exec(`
      DELETE FROM media_episode_progress
      WHERE media_id IN (SELECT id FROM media_items WHERE type = 'movie');
    `);
    db.exec(`
      DELETE FROM media_episodes
      WHERE media_id IN (SELECT id FROM media_items WHERE type = 'movie');
    `);
    db.exec(`
      DELETE FROM media_seasons
      WHERE media_id IN (SELECT id FROM media_items WHERE type = 'movie');
    `);
  } catch {
    // Ignore legacy cleanup failures on partial schemas.
  }
};

const ensureLegacyIndexes = (db: SqliteDb) => {
  // Idempotent re-creation of every index (defensive — per-group initializers
  // also create them). Kept verbatim from the pre-Phase-1 monolithic runner so
  // legacy single-DB behavior is byte-for-byte identical.
  db.exec(`CREATE INDEX IF NOT EXISTS media_items_type_idx ON media_items(type);`);
  db.exec(`CREATE INDEX IF NOT EXISTS media_items_added_at_idx ON media_items(added_at);`);
  db.exec(`CREATE INDEX IF NOT EXISTS media_items_updated_at_idx ON media_items(updated_at);`);
  db.exec(`CREATE INDEX IF NOT EXISTS media_files_media_id_idx ON media_files(media_id);`);
  if (tableHasColumn(db, "media_files", "template_id")) {
    db.exec(`CREATE INDEX IF NOT EXISTS media_files_template_id_idx ON media_files(template_id);`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS people_name_idx ON people(name);`);
  db.exec(`CREATE INDEX IF NOT EXISTS media_roles_media_id_idx ON media_roles(media_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS media_roles_person_id_idx ON media_roles(person_id);`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS media_genres_unique_idx ON media_genres(media_id, genre_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS media_genres_media_id_idx ON media_genres(media_id);`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS media_external_ids_unique_idx ON media_external_ids(media_type, source, external_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS media_external_ids_media_id_idx ON media_external_ids(media_id);`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS people_external_ids_unique_idx ON people_external_ids(source, external_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS people_external_ids_person_id_idx ON people_external_ids(person_id);`);
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS media_file_desired_formats_unique_idx ON media_file_desired_formats(file_id, quality, codec);`
  );
  db.exec(`CREATE INDEX IF NOT EXISTS media_file_desired_formats_media_id_idx ON media_file_desired_formats(media_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS media_file_desired_formats_file_id_idx ON media_file_desired_formats(file_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS media_seasons_media_id_idx ON media_seasons(media_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS media_episodes_media_id_idx ON media_episodes(media_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS media_formats_media_id_idx ON media_formats(media_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS media_formats_file_id_idx ON media_formats(file_id);`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS media_format_chunks_unique_idx ON media_format_chunks(format_id, order_index);`);
  db.exec(`CREATE INDEX IF NOT EXISTS media_audio_tracks_media_id_idx ON media_audio_tracks(media_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS media_audio_tracks_episode_id_idx ON media_audio_tracks(episode_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS media_subtitles_media_id_idx ON media_subtitles(media_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS media_subtitles_episode_id_idx ON media_subtitles(episode_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS media_local_downloads_media_id_idx ON media_local_downloads(media_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS media_template_formats_template_id_idx ON media_template_formats(template_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS media_template_format_chunks_format_id_idx ON media_template_format_chunks(format_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS media_template_audio_tracks_template_id_idx ON media_template_audio_tracks(template_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS media_template_audio_chunks_track_id_idx ON media_template_audio_chunks(track_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS media_template_subtitles_template_id_idx ON media_template_subtitles(template_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS media_template_chapters_format_id_idx ON media_template_chapters(format_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS media_trailers_media_id_idx ON media_trailers(media_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS ingest_jobs_media_id_idx ON ingest_jobs(media_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS ingest_jobs_file_id_idx ON ingest_jobs(file_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS ingest_jobs_status_idx ON ingest_jobs(status);`);
  db.exec(`CREATE INDEX IF NOT EXISTS ingest_jobs_worker_peer_id_idx ON ingest_jobs(worker_peer_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS ingest_jobs_updated_at_idx ON ingest_jobs(updated_at);`);
  db.exec(`CREATE INDEX IF NOT EXISTS ingest_job_events_job_id_idx ON ingest_job_events(job_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS ingest_job_events_created_at_idx ON ingest_job_events(created_at);`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS playlists_slug_idx ON playlists(slug);`);
  db.exec(`CREATE INDEX IF NOT EXISTS playlist_items_playlist_id_idx ON playlist_items(playlist_id);`);
  db.exec(`CREATE INDEX IF NOT EXISTS playlist_items_media_id_idx ON playlist_items(media_id);`);
};

/**
 * LIB-SYNC-10: Favorites and Watchlist exist under their fixed ids, holding the items of any row an older build
 * created under a random id. Returns the slugs whose row moved: the caller re-sends their items so the other
 * devices (which drop items naming a playlist they do not have) get them under the shared id.
 */
export const ensureSystemPlaylists = (db: SqliteDb): string[] => {
  const [strayQuery, strayParams] = straySystemPlaylistsQuery();
  const strays = db.prepare(strayQuery).all(...strayParams) as Array<{ slug?: unknown }>;
  for (const [sql, params] of systemPlaylistHealStatements(nowIso())) db.prepare(sql).run(...params);
  return [...new Set(strays.map((row) => String(row.slug)))];
};

const migrateLegacyCast = (_db: SqliteDb) => {
  // Legacy cast migration removed; retained as a no-op to avoid boot failures.
};

/**
 * One-time backfill for the playability decoupling fix.
 *
 * Background: legacy ingest used to flip `media_items.has_files = 1` inside
 * `linkFileToMedia` whenever any file row was linked. That coupling caused
 * "delete cancelled job → movie became playable" — a partial file row from a
 * mid-flight monolithic ingest pre-flipped the flag. The fix decouples
 * `linkFileToMedia` from `has_files` and routes the flip through a new
 * `markMediaPlayable(mediaId)` called from the source-job's commit step only.
 *
 * Without this backfill, existing user libraries (which are full of media
 * with `has_files=1` set by the legacy ingest path) would silently flip to
 * "not playable" on the first new-build boot. So: any media that today has at
 * least one media_files row joined to a media_formats row (= has a real
 * playable video manifest) is preserved as `has_files=1`.
 *
 * Idempotent via a marker row in app_settings.
 */
const HAS_FILES_BACKFILL_MARKER_KEY = "migration_v1_has_files_backfill";

const backfillHasFilesFromVideoFormats = (db: SqliteDb) => {
  try {
    const markerRows = db
      .prepare(
        `SELECT value FROM app_settings WHERE key = '${HAS_FILES_BACKFILL_MARKER_KEY}';`
      )
      .all() as Array<{ value?: string }>;
    if (markerRows.length > 0) return;

    db.exec(`
      UPDATE media_items
      SET has_files = 1,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE has_files = 0
        AND id IN (
          SELECT DISTINCT mf.media_id
          FROM media_files mf
          INNER JOIN media_formats fmt ON fmt.file_id = mf.id
        );
    `);

    db.prepare(
      "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?);"
    ).run(HAS_FILES_BACKFILL_MARKER_KEY, "1", new Date().toISOString());
  } catch {
    // Older partial schemas may not have all referenced tables yet; safe to skip.
  }
};

// ---------------------------------------------------------------------------
// Cross-DB backfill (Phase 3+ consumers) — equivalent to the legacy single-DB
// backfillHasFilesFromVideoFormats but spans three open DBs. Same idempotency
// marker (stored in core.app_settings).
// ---------------------------------------------------------------------------

const backfillHasFilesAcrossDbs = (coreDb: SqliteDb, metadataDb: SqliteDb, playbackDb: SqliteDb) => {
  try {
    const markerRows = coreDb
      .prepare(
        `SELECT value FROM app_settings WHERE key = '${HAS_FILES_BACKFILL_MARKER_KEY}';`
      )
      .all() as Array<{ value?: string }>;
    if (markerRows.length > 0) return;

    const fileIdsWithFormats = (playbackDb
      .prepare("SELECT DISTINCT file_id FROM media_formats;")
      .all() as Array<{ file_id?: string }>)
      .map((row) => String(row?.file_id ?? ""))
      .filter((id) => id.length > 0);
    if (fileIdsWithFormats.length === 0) {
      coreDb
        .prepare("INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?);")
        .run(HAS_FILES_BACKFILL_MARKER_KEY, "1", new Date().toISOString());
      return;
    }

    const mediaIds = new Set<string>();
    const fileSelect = metadataDb.prepare("SELECT media_id FROM media_files WHERE id = ?;");
    for (const fileId of fileIdsWithFormats) {
      const rows = fileSelect.all(fileId) as Array<{ media_id?: string }>;
      for (const row of rows) {
        const mediaId = String(row?.media_id ?? "");
        if (mediaId) mediaIds.add(mediaId);
      }
    }

    if (mediaIds.size > 0) {
      const updateStmt = coreDb.prepare(
        "UPDATE media_items SET has_files = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE has_files = 0 AND id = ?;"
      );
      for (const mediaId of mediaIds) {
        updateStmt.run(mediaId);
      }
    }

    coreDb
      .prepare("INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?);")
      .run(HAS_FILES_BACKFILL_MARKER_KEY, "1", new Date().toISOString());
  } catch {
    // Defensive: partial schemas may be missing tables; skip silently.
  }
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the library schema.
 *
 * Single-arg signature: creates ALL groups' tables in one SQLite database and
 * runs every legacy cross-group migration. Used by today's monolithic desktop
 * runtime (one library.sqlite file). Behavior is preserved verbatim from
 * pre-Phase-1.
 *
 * Two-arg signature: creates only the named group's tables + indexes in `db`.
 * Used by clients that open one SQLite file per group (mobile today,
 * desktop after Phase 3). Cross-group backfills are NOT run — use
 * `ensureAllLibrarySchemas` for that.
 */
export function ensureLibrarySchema(db: SqliteDb): void;
export function ensureLibrarySchema(db: SqliteDb, group: LibraryDbGroup): void;
export function ensureLibrarySchema(db: SqliteDb, group?: LibraryDbGroup): void {
  if (group !== undefined) {
    groupInitializers[group](db);
    return;
  }

  resetLegacySchema(db);
  for (const g of ALL_LIBRARY_DB_GROUPS) {
    groupInitializers[g](db);
  }
  migrateNormalizedSchema(db);
  migrateMovieEpisodeScopes(db);
  ensureLegacyIndexes(db);
  ensureSystemPlaylists(db);
  migrateLegacyCast(db);
  backfillHasFilesFromVideoFormats(db);
}

/**
 * Async per-group initialization for clients with Promise-based SQLite
 * drivers (e.g. mobile). Iterates the SAME shared DDL constants as
 * `ensureLibrarySchema(db, group)`; only the execution shape differs.
 * No legacy ALTER paths — mobile evolves schema via per-DB user_version
 * migrations in apps/badger/mobile/src/lib/libraryMigrations.ts.
 */
export const ensureLibrarySchemaAsync = (db: AsyncSqliteDb, group: LibraryDbGroup): Promise<void> =>
  groupInitializersAsync[group](db);

export type LibraryDbSet = Partial<Record<LibraryDbGroup, SqliteDb>>;

/**
 * Initialize multiple per-group databases at once. Skips any group whose DB
 * isn't passed (e.g. mobile omits `templates`). Runs cross-group backfills
 * once all required DBs are present.
 */
export const ensureAllLibrarySchemas = (dbs: LibraryDbSet): void => {
  for (const g of ALL_LIBRARY_DB_GROUPS) {
    const db = dbs[g];
    if (db) groupInitializers[g](db);
  }
  if (dbs.core) ensureSystemPlaylists(dbs.core);
  if (dbs.core && dbs.metadata && dbs.playback) {
    backfillHasFilesAcrossDbs(dbs.core, dbs.metadata, dbs.playback);
  }
};

/**
 * Read-only access to the per-group DDL constants — exposed for clients that
 * need to drive their own execution loop (e.g. batching multiple statements
 * into a single transaction). Both `ensureLibrarySchema(db, group)` and
 * `ensureLibrarySchemaAsync(db, group)` iterate these arrays in order.
 */
export const getGroupDdlStatements = (group: LibraryDbGroup): ReadonlyArray<string> =>
  groupDdl[group];
