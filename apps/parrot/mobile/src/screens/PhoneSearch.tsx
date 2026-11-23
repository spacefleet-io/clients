// Parrot's phone search (UX-PHONE-12): the shared search card over the tabs, through the whole library on the device:
// Artists, Albums and Songs. An artist opens its page, an album its page, a song plays (and opens the player).
import React, { useEffect, useMemo, useState } from "react";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { MobileSearchOverlay } from "@space/mobile-shell/components";
import { useTranslation } from "@space/mobile-shell/i18n";
import { parrotArtistPictureThumbKey, parrotCoverThumbKey } from "@space/parrot-core";
import { phoneSearchStrings } from "@space/shared/searchPaletteStrings";
import { listAlbums, listArtists, listSongs } from "../lib/library";
import { buildParrotSearchGroups, type ParrotSearchItem } from "../lib/phoneSearch";
import { useSession } from "../state/session";
import { useQuery } from "../state/useQuery";
import { usePlay } from "../state/usePlay";
import { ParrotArt } from "./art";
import type { RootStack } from "./routes";

const ART = 40;

export const PhoneSearch = ({ visible, onClose }: { visible: boolean; onClose: () => void }) => {
  const { t, i18n } = useTranslation();
  const navigation = useNavigation<NativeStackNavigationProp<RootStack>>();
  const { library } = useSession();
  const { play, error } = usePlay();
  const strings = useMemo(() => phoneSearchStrings("parrot", i18n.language), [i18n.language]);
  const version = library.status === "ready" ? library.version : -1;
  // Read only once the search is first opened, then again whenever the library changes.
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (visible) setOpened(true);
  }, [visible]);
  const read = useQuery(
    () =>
      version < 0 || !opened
        ? Promise.resolve(null)
        : Promise.all([listArtists(), listAlbums(), listSongs()]).then(([artists, albums, songs]) => ({ artists, albums, songs })),
    [version, opened]
  );
  const groups = useMemo(() => (read.data ? buildParrotSearchGroups(read.data) : []), [read.data]);

  useEffect(() => {
    if (error) console.warn("phone-search.play.failed", JSON.stringify({ error }));
  }, [error]);

  return (
    <MobileSearchOverlay<ParrotSearchItem>
      visible={visible}
      onClose={onClose}
      strings={strings}
      groups={groups}
      loading={read.data === null}
      describe={(item) =>
        item.kind === "artist"
          ? {
              key: item.artist.id,
              title: item.artist.name,
              subtitle: t("parrot.library.albums", { count: item.artist.albumCount }),
              art: <ParrotArt seed={item.artist.id} size={ART} radius={ART / 2} coverKey={parrotArtistPictureThumbKey(item.artist)} />,
            }
          : item.kind === "album"
            ? {
                key: item.album.id,
                title: item.album.title,
                subtitle: [item.album.artistName, item.album.year].filter(Boolean).join(" · "),
                art: <ParrotArt seed={item.album.id} size={ART} radius={6} coverKey={parrotCoverThumbKey(item.album)} />,
              }
            : {
                key: item.song.id,
                title: item.song.title,
                subtitle: [item.song.artistName, item.song.albumTitle].filter(Boolean).join(" · "),
                art: <ParrotArt seed={item.song.albumId} size={ART} radius={6} coverKey={parrotCoverThumbKey(item.song)} />,
              }
      }
      onSelect={(item) => {
        if (item.kind === "artist") navigation.navigate("Artist", { artistId: item.artist.id, name: item.artist.name });
        else if (item.kind === "album")
          navigation.navigate("Album", {
            albumId: item.album.id,
            title: item.album.title,
            artistName: item.album.artistName,
            cover: { coverObjectKey: item.album.coverObjectKey, coverThumbObjectKey: item.album.coverThumbObjectKey },
          });
        else void play([item.song], 0);
      }}
    />
  );
};
