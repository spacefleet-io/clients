/**
 * LIB-SYNC-10: the library's system playlists (Favorites, Watchlist) have one fixed id on every device.
 *
 * Each client used to create them with a random id when its library had no row of that slug. Two devices
 * that each created their own (a phone that bootstrapped the library, then a desktop whose snapshot did not
 * carry the rows) then sent `playlist.item.add` ops naming a playlist the other device did not have: the
 * other device's sync failed on the foreign key every time.
 *
 * `systemPlaylistHealStatements` creates the rows under their fixed id and moves a row created under any
 * other id (with its items) onto it. Every client runs it on its core library db when it opens it and after it
 * replaces it from a snapshot; it changes nothing on a library already in shape. The ids are the ones the
 * non-main profiles already use for their own favorites and watchlist (`profileViewing.ts`).
 */
import { FAVORITES_PLAYLIST_ID, WATCHLIST_PLAYLIST_ID } from "@space/shared/profileViewing";

export type SystemPlaylist = {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  /** Watchlist is listed with the user playlists (`is_system = 0`) but keeps its slug and fixed id. */
  readonly isSystem: 0 | 1;
};

export const SYSTEM_PLAYLISTS: readonly SystemPlaylist[] = [
  { id: FAVORITES_PLAYLIST_ID, slug: "favorites", name: "Favorites", isSystem: 1 },
  { id: WATCHLIST_PLAYLIST_ID, slug: "watchlist", name: "Watchlist", isSystem: 0 },
];

export const systemPlaylistForSlug = (slug: unknown): SystemPlaylist | null =>
  SYSTEM_PLAYLISTS.find((playlist) => playlist.slug === slug) ?? null;

export type SqlStatement = readonly [sql: string, params: readonly unknown[]];

/** Rows holding a system slug under another id (`{ id, slug }`): a library created before LIB-SYNC-10. */
export const straySystemPlaylistsQuery = (): SqlStatement => [
  `SELECT id, slug FROM playlists WHERE ${SYSTEM_PLAYLISTS.map(() => "(slug = ? AND id <> ?)").join(" OR ")};`,
  SYSTEM_PLAYLISTS.flatMap((playlist) => [playlist.slug, playlist.id]),
];

/**
 * Statements (run in order, in one transaction where the driver allows) that leave exactly one row per system
 * slug, under its fixed id, holding the items of every row that had the slug. Idempotent.
 */
export const systemPlaylistHealStatements = (timestamp: string): SqlStatement[] =>
  SYSTEM_PLAYLISTS.flatMap(({ id, slug, name, isSystem }): SqlStatement[] => [
    // The fixed row, slug-less while a stray row still holds the slug (playlists_slug_idx is unique).
    [
      `INSERT OR IGNORE INTO playlists (id, name, slug, is_system, created_at)
       SELECT ?, ?, NULL, ?, COALESCE((SELECT created_at FROM playlists WHERE slug = ?), ?);`,
      [id, name, isSystem, slug, timestamp],
    ],
    // Items move over; one the fixed row already holds (UNIQUE(playlist_id, media_id)) stays behind and goes below.
    [
      "UPDATE OR IGNORE playlist_items SET playlist_id = ? WHERE playlist_id IN (SELECT id FROM playlists WHERE slug = ? AND id <> ?);",
      [id, slug, id],
    ],
    ["DELETE FROM playlist_items WHERE playlist_id IN (SELECT id FROM playlists WHERE slug = ? AND id <> ?);", [slug, id]],
    ["DELETE FROM playlists WHERE slug = ? AND id <> ?;", [slug, id]],
    ["UPDATE playlists SET slug = ?, is_system = ? WHERE id = ?;", [slug, isSystem, id]],
  ]);
