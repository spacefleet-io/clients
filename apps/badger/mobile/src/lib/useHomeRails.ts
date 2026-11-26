import { useEffect, useMemo, useState } from "react";
import { getCurrentLanguage, useTranslation } from "@space/mobile-shell/i18n";
import { HOME_LAYOUT_KEY, homeLayoutPlaylistIds, parseHomeLayout } from "@space/shared/homeLayout";
import type { MediaRow } from "@space/shared/libraryTypes";
import { useLibraryActions, useLibraryData } from "../store/library";
import { homeRailEntries, type HomeRailEntry } from "./homeRails";

type Loaded = { raw: string | null; favoriteIds: ReadonlySet<string>; playlistItems: ReadonlyMap<string, ReadonlySet<string>> };

const EMPTY: Loaded = { raw: null, favoriteIds: new Set(), playlistItems: new Map() };

/**
 * The phone's and the TV's Home rails (UX-HOME-06): the Home layout the computer saved (`dashboard_layout_v1`, synced
 * as a library setting), with the favorites and the layout's playlists loaded. Read again whenever the library's lists
 * change (a sync, a pull to refresh), so an edit on the computer shows after the next sync.
 */
export const useHomeRails = (media: readonly MediaRow[]): HomeRailEntry[] => {
  const { t } = useTranslation();
  const { playlists } = useLibraryData();
  const { listPlaylistItems, readSetting } = useLibraryActions();
  const [loaded, setLoaded] = useState<Loaded>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const raw = await readSetting(HOME_LAYOUT_KEY);
      const favorites = playlists.find((playlist) => playlist.slug === "favorites");
      const ids = homeLayoutPlaylistIds(parseHomeLayout(raw, playlists, () => "unsaved"));
      const wanted = favorites ? [...new Set([favorites.id, ...ids])] : ids;
      const lists = await Promise.all(wanted.map(async (id) => [id, new Set(await listPlaylistItems(id))] as const));
      const playlistItems = new Map<string, ReadonlySet<string>>(lists);
      if (cancelled) return;
      console.info("home.layout", JSON.stringify({ saved: raw !== null, playlists: ids.length, favorites: favorites ? playlistItems.get(favorites.id)?.size : null }));
      setLoaded({ raw, favoriteIds: (favorites && playlistItems.get(favorites.id)) || new Set(), playlistItems });
    })();
    return () => {
      cancelled = true;
    };
  }, [listPlaylistItems, media, playlists, readSetting]);

  const language = getCurrentLanguage();
  return useMemo(() => {
    // A section saved without an id is numbered by its place in the list, so its id holds across renders.
    let unsaved = 0;
    return homeRailEntries(media, {
      layout: parseHomeLayout(loaded.raw, playlists, () => `section-unsaved-${unsaved++}`),
      favoriteIds: loaded.favoriteIds,
      playlistItems: loaded.playlistItems,
      playlists,
      language,
      t,
    });
  }, [language, loaded, media, playlists, t]);
};
