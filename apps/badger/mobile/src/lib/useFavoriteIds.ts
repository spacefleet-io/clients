import { useEffect, useState } from "react";
import { useLibraryActions, useLibraryData } from "../store/library";

/** Ids of the titles in the system "favorites" playlist (empty until loaded, and when the playlist does not exist). */
export const useFavoriteIds = (): ReadonlySet<string> => {
  const { playlists } = useLibraryData();
  const { listPlaylistItems } = useLibraryActions();
  const [favoriteIds, setFavoriteIds] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    const favorites = playlists.find((playlist) => playlist.slug === "favorites");
    if (!favorites) {
      setFavoriteIds(new Set());
      return;
    }
    void listPlaylistItems(favorites.id).then((ids) => setFavoriteIds(new Set(ids)));
  }, [listPlaylistItems, playlists]);

  return favoriteIds;
};
