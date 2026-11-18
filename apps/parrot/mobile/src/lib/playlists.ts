// The library's playlists on the phone (Playlists tab and chip), read with the shared `@space/parrot-core` playlist
// helpers from the snapshot's `playlists` and `playlist_tracks` tables when the library has them, else none. Edits
// (heart, new, add, remove, rename, delete) go through state/playlistEditor and lib/saveEdits, which publish them.
import { buildParrotPlaylists, isLikedPlaylist, PARROT_LIKED_PLAYLIST_ID, type ParrotPlaylist, type ParrotPlaylistRow, type ParrotPlaylistTrackRow } from "@space/parrot-core";

export { isLikedPlaylist };

export const PLAYLIST_TABLE_SQL = "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'playlists'";

/** One playlist's songs in its own order (parameter: playlist id), with each song's album title. */
export const PLAYLIST_SONGS_SQL = `SELECT t.id AS id, t.album_id AS albumId, t.disc AS disc, t.number AS number, t.title AS title,
       COALESCE(ar.name, '') AS artistName, COALESCE(t.artist_id, '') AS artistId, t.duration_ms AS durationMs,
       COALESCE(al.title, '') AS albumTitle
  FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
  LEFT JOIN artists ar ON ar.id = t.artist_id LEFT JOIN albums al ON al.id = t.album_id
 WHERE pt.playlist_id = ?
 ORDER BY pt.position`;

/**
 * The shared order (Liked songs first, then by name), with "Liked songs" always shown, even before the library has
 * it, so the phone always has the Liked songs row of the design.
 */
export const phonePlaylists = (rows: readonly ParrotPlaylistRow[], trackRows: readonly ParrotPlaylistTrackRow[]): ParrotPlaylist[] => {
  const playlists = buildParrotPlaylists(rows, trackRows);
  if (playlists.some((playlist) => isLikedPlaylist(playlist.id))) return playlists;
  return [{ id: PARROT_LIKED_PLAYLIST_ID, name: "", createdAt: 0, updatedAt: 0, trackIds: [], trackCount: 0 }, ...playlists];
};
