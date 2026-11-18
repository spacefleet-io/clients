/**
 * Single source of truth for which logical SQLite database each table lives in.
 *
 * Mobile opens four files (core, metadata, playback, ingest). Desktop opens
 * five (the same four plus templates). Both derive their per-DB DDL from this
 * manifest — no hand-maintained mobileSql.ts arrays after Phase 2.
 *
 * Adding a table to schema.ts means adding it here too — the schema-coverage
 * test asserts every Drizzle table has exactly one group.
 */

export type LibraryDbGroup = "core" | "metadata" | "playback" | "ingest" | "templates";

export const tableGroups: Readonly<Record<string, LibraryDbGroup>> = Object.freeze({
  // core — small, blocks library list render on cold start
  media_items: "core",
  media_genres: "core",
  media_external_ids: "core",
  app_settings: "core",
  playlists: "core",
  playlist_items: "core",

  // metadata — details modal data (cast, episodes, files, trailers, skip markers)
  media_files: "metadata",
  media_file_desired_formats: "metadata",
  people: "metadata",
  people_external_ids: "metadata",
  media_roles: "metadata",
  media_crew: "metadata",
  media_editions: "metadata",
  media_seasons: "metadata",
  media_episodes: "metadata",
  media_trailers: "metadata",
  media_skip_markers: "metadata",

  // playback — formats, chunks, tracks needed once a media is selected
  media_formats: "playback",
  media_format_chunks: "playback",
  media_audio_tracks: "playback",
  media_audio_chunks: "playback",
  media_subtitles: "playback",
  media_chapters: "playback",
  // Phase 2 offline downloads (let-s-talk-about-offline). Local-only — never
  // sent through op-stream sync. Lives in the playback group so the same
  // SQLite file the renderer reads for chunk-key lookup also carries the
  // local-availability bookkeeping for badge hydration via
  // `badger.offline.list_local`.
  media_local_downloads: "playback",

  // ingest — job state visible to both clients (mobile shows state without progress %)
  ingest_jobs: "ingest",
  ingest_job_events: "ingest",

  // templates — encoding profile definitions + ML analysis; desktop-only
  media_templates: "templates",
  media_template_formats: "templates",
  media_template_format_chunks: "templates",
  media_template_audio_tracks: "templates",
  media_template_audio_chunks: "templates",
  media_template_subtitles: "templates",
  // Local-only OCR bookkeeping (PLAY-TRACK-05 catch-up pass): never synced,
  // never in a snapshot. Desktop-only like the rest of this group.
  subtitle_ocr_attempts: "templates",
  media_template_chapters: "templates",
  media_skip_analysis: "templates",
});

export const ALL_LIBRARY_DB_GROUPS: ReadonlyArray<LibraryDbGroup> = Object.freeze([
  "core",
  "metadata",
  "playback",
  "ingest",
  "templates",
]);

export const mobileGroups: ReadonlyArray<LibraryDbGroup> = Object.freeze([
  "core",
  "metadata",
  "playback",
  "ingest",
]);

export const desktopGroups: ReadonlyArray<LibraryDbGroup> = ALL_LIBRARY_DB_GROUPS;

export const tablesInGroup = (group: LibraryDbGroup): ReadonlyArray<string> =>
  Object.entries(tableGroups)
    .filter(([, g]) => g === group)
    .map(([name]) => name);

export const isMobileGroup = (group: LibraryDbGroup): boolean => mobileGroups.includes(group);

export const isMobileTable = (tableName: string): boolean => {
  const group = tableGroups[tableName];
  return group !== undefined && isMobileGroup(group);
};
