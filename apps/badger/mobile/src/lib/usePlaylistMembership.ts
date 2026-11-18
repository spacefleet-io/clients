import { useCallback, useEffect, useMemo, useState } from "react";
import type { PlaylistRow } from "@space/shared/libraryTypes";
import { useLibraryActions, useLibraryData } from "../store/library";

export type PlaylistMembership = {
  /** Every playlist of the profile, Favorites and Watchlist included (LIB-SYNC-10). */
  playlists: readonly PlaylistRow[];
  /** Playlist id → whether the title is in it; a playlist not read yet is absent. */
  contains: Readonly<Record<string, boolean>>;
  /** Adds the title to the playlist, or takes it out when it is already there. */
  toggle: (playlistId: string) => Promise<void>;
};

/**
 * Which playlists hold one title, and adding it to or taking it out of one: the phone's "Add To Playlist" sheet and the
 * TV title page's Playlist button (UX-TV-41) share it.
 */
export const usePlaylistMembership = (mediaId: string): PlaylistMembership => {
  const { listPlaylistItems, addToPlaylist, removeFromPlaylist } = useLibraryActions();
  const { playlists } = useLibraryData();
  const [contains, setContains] = useState<Record<string, boolean>>({});

  // Keyed on the playlist ids, not the list: a sync hands a new `playlists` array every time, and re-querying every
  // playlist for each one is wasted work when no playlist came or went (membership toggles here update locally).
  const playlistIds = useMemo(() => playlists.map((playlist) => playlist.id).join("\n"), [playlists]);
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const ids = playlistIds ? playlistIds.split("\n") : [];
      if (!ids.length) {
        if (!cancelled) setContains({});
        return;
      }
      const entries = await Promise.all(
        ids.map(async (playlistId) => {
          const items = await listPlaylistItems(playlistId);
          return [playlistId, items.includes(mediaId)] as const;
        }),
      );
      if (!cancelled) setContains(Object.fromEntries(entries));
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [listPlaylistItems, mediaId, playlistIds]);

  const toggle = useCallback(
    async (playlistId: string) => {
      const hasItem = Boolean(contains[playlistId]);
      if (hasItem) await removeFromPlaylist(playlistId, mediaId);
      else await addToPlaylist(playlistId, mediaId);
      console.info("library.playlist.toggle", JSON.stringify({ mediaId, playlistId, added: !hasItem }));
      setContains((prev) => ({ ...prev, [playlistId]: !hasItem }));
    },
    [addToPlaylist, contains, mediaId, removeFromPlaylist],
  );

  return { playlists, contains, toggle };
};
