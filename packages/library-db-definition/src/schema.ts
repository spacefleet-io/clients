import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const mediaItems = sqliteTable("media_items", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  title: text("title").notNull(),
  originalTitle: text("original_title"),
  originalLanguage: text("original_language"),
  overview: text("overview"),
  year: text("year"),
  rating: real("rating"),
  posterPath: text("poster_path"),
  backdropPath: text("backdrop_path"),
  addedAt: text("added_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  hasFiles: integer("has_files", { mode: "boolean" }).notNull().default(false),
  progressPct: real("progress_pct").notNull().default(0),
  lastWatchedAt: text("last_watched_at"),
  preferredAudioLanguage: text("preferred_audio_language"),
  totalEpisodes: integer("total_episodes"),
});

export const mediaFiles = sqliteTable("media_files", {
  id: text("id").primaryKey(),
  mediaId: text("media_id").notNull(),
  filename: text("filename").notNull(),
  season: integer("season"),
  episode: integer("episode"),
  addedAt: text("added_at").notNull(),
  status: text("status").notNull(),
  templateId: text("template_id"),
  /** LIB-EDIT-01: the file's edition (`media_editions.id`); set on every row since the LIB-EDIT-02 upgrade. */
  editionId: text("edition_id"),
  /** INGS-EDIT-05: SHA-256 of the file, hex; null for files stored before editions. */
  contentSha256: text("content_sha256"),
  /** STOR-USE-02: the size the user's computer showed for the file (`fs.stat`); backfilled from the source copy. */
  originalSizeBytes: integer("original_size_bytes"),
});

/** LIB-EDIT-01: editions (cuts) of a film, or of one episode (`season`/`episode` set). */
export const mediaEditions = sqliteTable("media_editions", {
  id: text("id").primaryKey(),
  mediaId: text("media_id").notNull(),
  season: integer("season"),
  episode: integer("episode"),
  name: text("name").notNull(),
  nameUserSet: integer("name_user_set", { mode: "boolean" }).notNull(),
  durationSeconds: real("duration_seconds"),
  createdAt: text("created_at").notNull(),
});

export const mediaTemplates = sqliteTable("media_templates", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  source: text("source").notNull(),
  signature: text("signature").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const mediaTemplateFormats = sqliteTable("media_template_formats", {
  id: text("id").primaryKey(),
  templateId: text("template_id").notNull(),
  quality: text("quality").notNull(),
  codec: text("codec").notNull(),
  codecString: text("codec_string"),
  bitrateKbps: integer("bitrate_kbps"),
  initKey: text("init_key"),
  initSize: integer("init_size"),
  durationSeconds: real("duration_seconds"),
  totalSize: integer("total_size"),
  sizeMb: integer("size_mb").notNull(),
});

export const mediaTemplateFormatChunks = sqliteTable("media_template_format_chunks", {
  id: text("id").primaryKey(),
  formatId: text("format_id").notNull(),
  chunkKey: text("chunk_key").notNull(),
  orderIndex: integer("order_index").notNull(),
  sizeBytes: integer("size_bytes"),
  startSeconds: real("start_seconds"),
});

export const mediaTemplateAudioTracks = sqliteTable("media_template_audio_tracks", {
  id: text("id").primaryKey(),
  templateId: text("template_id").notNull(),
  language: text("language").notNull(),
  label: text("label").notNull(),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  source: text("source").notNull(),
  codec: text("codec"),
  codecString: text("codec_string"),
  initKey: text("init_key"),
  initSize: integer("init_size"),
  durationSeconds: real("duration_seconds"),
  totalSize: integer("total_size"),
  createdAt: text("created_at").notNull(),
});

export const mediaTemplateAudioChunks = sqliteTable("media_template_audio_chunks", {
  id: text("id").primaryKey(),
  trackId: text("track_id").notNull(),
  chunkKey: text("chunk_key").notNull(),
  orderIndex: integer("order_index").notNull(),
  sizeBytes: integer("size_bytes"),
  startSeconds: real("start_seconds"),
});

export const mediaTemplateSubtitles = sqliteTable("media_template_subtitles", {
  id: text("id").primaryKey(),
  templateId: text("template_id").notNull(),
  language: text("language").notNull(),
  label: text("label").notNull(),
  objectKey: text("object_key"),
  format: text("format"),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  source: text("source").notNull(),
  createdAt: text("created_at").notNull(),
});

export const mediaTemplateChapters = sqliteTable("media_template_chapters", {
  id: text("id").primaryKey(),
  formatId: text("format_id").notNull(),
  title: text("title").notNull(),
  startSeconds: real("start_seconds").notNull(),
});

export const people = sqliteTable("people", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  profilePath: text("profile_path"),
});

export const mediaRoles = sqliteTable("media_roles", {
  id: text("id").primaryKey(),
  mediaId: text("media_id").notNull(),
  personId: text("person_id").notNull(),
  role: text("role"),
  orderIndex: integer("order_index"),
});

/** LIB-CREW-01: director and writer credits; `job` is the catalog's crew job ("Director", "Screenplay", "Writer"). */
export const mediaCrew = sqliteTable("media_crew", {
  id: text("id").primaryKey(),
  mediaId: text("media_id").notNull(),
  personId: text("person_id").notNull(),
  job: text("job").notNull(),
  orderIndex: integer("order_index"),
});

export const mediaGenres = sqliteTable("media_genres", {
  id: text("id").primaryKey(),
  mediaId: text("media_id").notNull(),
  genreId: integer("genre_id").notNull(),
});

export const mediaExternalIds = sqliteTable("media_external_ids", {
  id: text("id").primaryKey(),
  mediaId: text("media_id").notNull(),
  mediaType: text("media_type").notNull(),
  source: text("source").notNull(),
  externalId: text("external_id").notNull(),
});

export const peopleExternalIds = sqliteTable("people_external_ids", {
  id: text("id").primaryKey(),
  personId: text("person_id").notNull(),
  source: text("source").notNull(),
  externalId: text("external_id").notNull(),
});

export const mediaFileDesiredFormats = sqliteTable("media_file_desired_formats", {
  id: text("id").primaryKey(),
  mediaId: text("media_id").notNull(),
  fileId: text("file_id").notNull(),
  quality: text("quality").notNull(),
  codec: text("codec").notNull(),
  bitrateKbps: integer("bitrate_kbps"),
});

export const mediaSeasons = sqliteTable("media_seasons", {
  id: text("id").primaryKey(),
  mediaId: text("media_id").notNull(),
  seasonNumber: integer("season_number").notNull(),
  title: text("title").notNull(),
  overview: text("overview"),
  posterPath: text("poster_path"),
  episodeCount: integer("episode_count"),
  airDate: text("air_date"),
});

export const mediaEpisodes = sqliteTable("media_episodes", {
  id: text("id").primaryKey(),
  mediaId: text("media_id").notNull(),
  seasonNumber: integer("season_number").notNull(),
  episodeNumber: integer("episode_number").notNull(),
  title: text("title").notNull(),
  overview: text("overview"),
  stillPath: text("still_path"),
  airDate: text("air_date"),
});

export const mediaFormats = sqliteTable("media_formats", {
  id: text("id").primaryKey(),
  mediaId: text("media_id").notNull(),
  fileId: text("file_id").notNull(),
  quality: text("quality").notNull(),
  codec: text("codec").notNull(),
  codecString: text("codec_string"),
  bitrateKbps: integer("bitrate_kbps"),
  initKey: text("init_key"),
  initSize: integer("init_size"),
  durationSeconds: real("duration_seconds"),
  totalSize: integer("total_size"),
  sizeMb: integer("size_mb").notNull(),
  isSource: integer("is_source").notNull().default(0),
  /** Seek-bar preview sheets (MPV-PREV-01), JSON `MediaPreviewSheets`; set on the source format only. */
  previewSheets: text("preview_sheets"),
});

export const mediaFormatChunks = sqliteTable("media_format_chunks", {
  id: text("id").primaryKey(),
  formatId: text("format_id").notNull(),
  chunkKey: text("chunk_key").notNull(),
  orderIndex: integer("order_index").notNull(),
  sizeBytes: integer("size_bytes"),
  startSeconds: real("start_seconds"),
});

export const mediaAudioTracks = sqliteTable("media_audio_tracks", {
  id: text("id").primaryKey(),
  mediaId: text("media_id").notNull(),
  fileId: text("file_id"),
  episodeId: text("episode_id"),
  language: text("language").notNull(),
  label: text("label").notNull(),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  source: text("source").notNull(),
  codec: text("codec"),
  codecString: text("codec_string"),
  initKey: text("init_key"),
  initSize: integer("init_size"),
  durationSeconds: real("duration_seconds"),
  totalSize: integer("total_size"),
  createdAt: text("created_at").notNull(),
});

export const mediaAudioChunks = sqliteTable("media_audio_chunks", {
  id: text("id").primaryKey(),
  trackId: text("track_id").notNull(),
  chunkKey: text("chunk_key").notNull(),
  orderIndex: integer("order_index").notNull(),
  sizeBytes: integer("size_bytes"),
  startSeconds: real("start_seconds"),
});

export const mediaChapters = sqliteTable("media_chapters", {
  id: text("id").primaryKey(),
  formatId: text("format_id").notNull(),
  title: text("title").notNull(),
  startSeconds: real("start_seconds").notNull(),
});

export const mediaSkipMarkers = sqliteTable("media_skip_markers", {
  id: text("id").primaryKey(),
  mediaId: text("media_id").notNull(),
  episodeId: text("episode_id"),
  type: text("type").notNull(),
  startSeconds: real("start_seconds").notNull(),
  endSeconds: real("end_seconds").notNull(),
  source: text("source").notNull(),
  confidence: real("confidence"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const mediaSkipAnalysis = sqliteTable("media_skip_analysis", {
  id: text("id").primaryKey(),
  mediaId: text("media_id").notNull(),
  episodeId: text("episode_id"),
  kind: text("kind").notNull(),
  payloadJson: text("payload_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const mediaSubtitles = sqliteTable("media_subtitles", {
  id: text("id").primaryKey(),
  mediaId: text("media_id").notNull(),
  fileId: text("file_id"),
  episodeId: text("episode_id"),
  language: text("language").notNull(),
  label: text("label").notNull(),
  objectKey: text("object_key"),
  format: text("format"),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  source: text("source").notNull(),
  createdAt: text("created_at").notNull(),
  /** OCR twin (`source: "ocr"`): id of the picture subtitle row its SRT text was recognised from (PLAY-TRACK-05). */
  derivedFromSubtitleId: text("derived_from_subtitle_id"),
});

// Local-only — one row per picture subtitle the runtime failed to OCR (or
// found no text in), so the catch-up pass waits out a retry window instead of
// re-running it every start. Never synced, never in a snapshot.
export const subtitleOcrAttempts = sqliteTable("subtitle_ocr_attempts", {
  subtitleId: text("subtitle_id").primaryKey(),
  mediaId: text("media_id").notNull(),
  status: text("status").notNull(),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  lastAttemptAt: text("last_attempt_at").notNull(),
});

// Local-only — one row per file that has been saved to disk for offline use.
// `container` is "mkv" or "mp4". `local_path` is the absolute path to the
// single muxed file (all audio + subs embedded). Never synced to the
// op-stream — per-device state.
export const mediaLocalDownloads = sqliteTable("media_local_downloads", {
  id: text("id").primaryKey(),
  fileId: text("file_id").notNull().unique(),
  mediaId: text("media_id").notNull(),
  quality: text("quality").notNull(),
  formatId: text("format_id").notNull(),
  container: text("container").notNull(),
  localPath: text("local_path").notNull(),
  totalBytes: integer("total_bytes").notNull(),
  downloadedAt: text("downloaded_at").notNull(),
  lastVerifiedAt: text("last_verified_at"),
  runtimeJobId: text("runtime_job_id"),
  schemaVersion: integer("schema_version").notNull().default(1),
});

export const mediaTrailers = sqliteTable("media_trailers", {
  id: text("id").primaryKey(),
  mediaId: text("media_id").notNull(),
  provider: text("provider").notNull(),
  key: text("key").notNull(),
  name: text("name"),
  language: text("language"),
});

export const ingestJobs = sqliteTable("ingest_jobs", {
  id: text("id").primaryKey(),
  mediaId: text("media_id").notNull(),
  fileId: text("file_id"),
  workerPeerId: text("worker_peer_id").notNull(),
  ownerClientId: text("owner_client_id"),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  progressPct: integer("progress_pct").notNull().default(0),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  metaJson: text("meta_json"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  completedAt: text("completed_at"),
});

export const ingestJobEvents = sqliteTable("ingest_job_events", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull(),
  level: text("level").notNull(),
  message: text("message").notNull(),
  metaJson: text("meta_json"),
  createdAt: text("created_at").notNull(),
});

export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const playlists = sqliteTable("playlists", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug"),
  isSystem: integer("is_system", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
});

export const playlistItems = sqliteTable("playlist_items", {
  id: text("id").primaryKey(),
  playlistId: text("playlist_id").notNull(),
  mediaId: text("media_id").notNull(),
  addedAt: text("added_at").notNull(),
});
