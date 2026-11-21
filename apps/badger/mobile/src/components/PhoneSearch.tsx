// Badger's phone search (UX-PHONE-12): the shared search card over the shell, through the whole library on the device:
// TV shows, Movies and Episodes. A show or a movie opens its page; an episode opens its show's page.
import React, { useEffect, useMemo, useState } from "react";
import { StyleSheet } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { MobileSearchOverlay } from "@space/mobile-shell/components";
import { useTranslation } from "@space/mobile-shell/i18n";
import { phoneSearchStrings } from "@space/shared/searchPaletteStrings";
import { useLibraryActions, useLibraryData } from "../store/library";
import { buildBadgerSearchGroups, episodeCode, type BadgerSearchItem, type SearchEpisode } from "../lib/phoneSearch";
import type { RootStackParamList } from "../navigation/AppNavigator";
import { MediaArtwork } from "./MediaArtwork";

type Nav = NativeStackNavigationProp<RootStackParamList>;

export const PhoneSearch = ({ visible, onClose }: { visible: boolean; onClose: () => void }) => {
  const { i18n } = useTranslation();
  const navigation = useNavigation<Nav>();
  const { media } = useLibraryData();
  const { listEpisodesForSearch } = useLibraryActions();
  const [episodes, setEpisodes] = useState<SearchEpisode[] | null>(null);
  const strings = useMemo(() => phoneSearchStrings("badger", i18n.language), [i18n.language]);

  // Episodes sit in the metadata database: read once the search is first opened, again when the library changes.
  useEffect(() => {
    if (!visible) return undefined;
    let cancelled = false;
    const started = Date.now();
    listEpisodesForSearch()
      .then((rows) => {
        if (cancelled) return;
        console.info("phone-search.episodes", JSON.stringify({ count: rows.length, ms: Date.now() - started }));
        setEpisodes(rows);
      })
      .catch((error: unknown) => {
        console.warn("phone-search.episodes.failed", JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        if (!cancelled) setEpisodes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [visible, listEpisodesForSearch, media]);

  const groups = useMemo(() => buildBadgerSearchGroups(media, episodes ?? []), [media, episodes]);

  return (
    <MobileSearchOverlay<BadgerSearchItem>
      visible={visible}
      onClose={onClose}
      strings={strings}
      groups={groups}
      loading={episodes === null}
      describe={(item) =>
        item.kind === "title"
          ? {
              key: item.media.id,
              title: item.media.title,
              subtitle: item.media.year ?? undefined,
              art: <MediaArtwork path={item.media.posterPath} kind="poster" style={styles.poster} />,
            }
          : {
              key: item.episode.id,
              title: item.episode.title,
              subtitle: `${item.show.title} · ${episodeCode(item.episode)}`,
              art: <MediaArtwork path={item.episode.stillPath ?? item.show.posterPath} kind={item.episode.stillPath ? "still" : "poster"} style={styles.still} />,
            }
      }
      onSelect={(item) => navigation.navigate("MediaDetails", { mediaId: item.kind === "title" ? item.media.id : item.show.id })}
    />
  );
};

const styles = StyleSheet.create({
  poster: { width: 27, height: 40, borderRadius: 4 },
  still: { width: 40, height: 40, borderRadius: 4 },
});
