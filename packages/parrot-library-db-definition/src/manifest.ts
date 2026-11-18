/**
 * Which part of Parrot's library each table belongs to. Milestone 1 ships the whole library as one
 * SQLite file; the groups name what a list screen needs (`catalog`) versus what only playing a song
 * needs (`playback`), so a later split into separate files stays a manifest change.
 *
 * Adding a table to schema.ts means adding it here too: the coverage test asserts every Drizzle
 * table has exactly one group.
 */
export type ParrotLibraryGroup = "catalog" | "playback";

export const PARROT_LIBRARY_GROUPS: readonly ParrotLibraryGroup[] = ["catalog", "playback"];

export const parrotTableGroups: Readonly<Record<string, ParrotLibraryGroup>> = Object.freeze({
  artists: "catalog",
  albums: "catalog",
  tracks: "catalog",
  settings: "catalog",
  playlists: "catalog",
  playlist_tracks: "catalog",
  lyrics: "catalog",
  track_files: "playback",
  track_file_chunks: "playback",
});

export const parrotTablesInGroup = (group: ParrotLibraryGroup): string[] =>
  Object.entries(parrotTableGroups)
    .filter(([, owner]) => owner === group)
    .map(([table]) => table);
