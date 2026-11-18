import type { SQLiteDatabase } from "react-native-sqlite-storage";
import {
  straySystemPlaylistsQuery,
  systemPlaylistHealStatements,
} from "@space/library-db-definition/systemPlaylists";

/**
 * LIB-SYNC-10 on the phone: Favorites and Watchlist live under their fixed ids. A library created by an older
 * build holds them under a random id; `healSystemPlaylists` moves those rows (and their items) onto the fixed
 * ids. Each heal remembers the slugs it moved until `takeHealedSystemPlaylists` collects them: the LibraryDb
 * then re-sends their items, which the other devices dropped while the playlist id was unknown to them.
 */
const healedSlugs = new Set<string>();

export const healSystemPlaylists = async (db: SQLiteDatabase): Promise<string[]> => {
  const [strayQuery, strayParams] = straySystemPlaylistsQuery();
  const res = await db.executeSql(strayQuery, [...strayParams]);
  const rows = res[0]?.rows;
  const moved = new Set<string>();
  for (let i = 0; i < (rows?.length ?? 0); i += 1) moved.add(String(rows!.item(i).slug));
  await db.sqlBatch(
    systemPlaylistHealStatements(new Date().toISOString()).map(([sql, params]) => [sql, [...params]] as [string, unknown[]])
  );
  if (moved.size) {
    console.warn("library.system_playlists.healed", JSON.stringify({ slugs: [...moved] }));
    for (const slug of moved) healedSlugs.add(slug);
  }
  return [...moved];
};

/** Slugs healed since the last call (each returned once). */
export const takeHealedSystemPlaylists = (): string[] => {
  const slugs = [...healedSlugs];
  healedSlugs.clear();
  return slugs;
};
