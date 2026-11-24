// TV artist page (PAR-TV-05, draft `4-artist`), under the top bar: the artist's round photo (the library's own, as on the
// phone), "ARTIST", the name, the album count, Play and Shuffle (every song of the artist's albums), then the "Albums"
// row of album cards; OK on an album opens its page. No playing strip (agent reading, approved by Main 2026-11-20).
import React from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { Play, Shuffle } from "lucide-react-native";
import { useSkyScroll } from "@space/mobile-shell/components";
import { useTranslation } from "@space/mobile-shell/i18n";
import { scopeLogger } from "@space/mobile-shell/logger";
import { TvPillButton } from "@space/mobile-shell/tv/TvPillButton";
import { TvBody, TvEyebrow, TvTitle } from "@space/mobile-shell/tv/TvText";
import { TV_SPACE, TV_TYPE } from "@space/mobile-shell/tv/tokens";
import { useTvScale, useTvStyles } from "@space/mobile-shell/tv/tvScale";
import { listAlbumTracks, listArtistAlbums, readArtistPicture } from "../lib/library";
import { ParrotArt } from "../screens/art";
import { useSession } from "../state/session";
import { useNowPlaying } from "../state/usePlayerState";
import { useQuery } from "../state/useQuery";
import { TvCardRow } from "@space/mobile-shell/tv/TvCardRow";
import { TvAlbumCard, tvCardHeight } from "./TvMusicParts";
import { artistSongs } from "./tvModel";
import { useTvPages, useTvPlay } from "./tvPages";

const log = scopeLogger("parrot.tv.artist");

/** Draft `.photo` 260 px, `.card` 236 px with a 38 px gap. */
const PHOTO = 130;
const CARD = 118;
const CARD_GAP = 19;

export const TvArtistPage = ({ artistId, name }: { artistId: string; name: string }) => {
  const { t } = useTranslation();
  const { library } = useSession();
  const version = library.status === "ready" ? library.version : -1;
  const albums = useQuery(() => listArtistAlbums(artistId), [artistId, version]);
  const picture = useQuery(() => readArtistPicture(artistId), [artistId, version]);
  const { push } = useTvPages();
  const { play, starting } = useTvPlay();
  const now = useNowPlaying();
  const scale = useTvScale();
  const styles = useTvStyles(baseStyles);
  const skyScroll = useSkyScroll();
  const rows = albums.data ?? [];
  const photo = picture.data ?? null;

  const playAll = async (shuffle: boolean) => {
    const lists = await Promise.all(rows.map(async (album) => [album.id, await listAlbumTracks(album.id)] as const));
    const songs = artistSongs(rows, new Map(lists));
    log.info("play", { artistId, albums: rows.length, songs: songs.length, shuffle });
    if (songs.length === 0) return;
    await play(songs, shuffle ? Math.floor(Math.random() * songs.length) : 0, undefined, { shuffle });
  };

  return (
    <ScrollView contentContainerStyle={styles.page} showsVerticalScrollIndicator={false} {...skyScroll} testID="tv-artist-page">
      <View style={styles.head}>
        <ParrotArt seed={artistId} size={PHOTO * scale} radius={(PHOTO / 2) * scale} coverKey={photo?.pictureObjectKey ?? null} previewKey={photo?.pictureThumbObjectKey ?? null} />
        <View style={styles.headText}>
          <TvEyebrow>{t("shell.manage.field.artist")}</TvEyebrow>
          <TvTitle size="hero" numberOfLines={1} style={styles.name}>
            {name}
          </TvTitle>
          <TvBody muted>{t("parrot.library.albums", { count: rows.length })}</TvBody>
          <View style={styles.actions}>
            <TvPillButton
              testID="tv-artist-play"
              variant="primary"
              icon={Play}
              filledIcon
              hasTVPreferredFocus
              label={t("player.controls.play")}
              disabled={rows.length === 0 || starting !== null}
              onPress={() => void playAll(false)}
            />
            <TvPillButton testID="tv-artist-shuffle" icon={Shuffle} label={t("shell.home.shuffle")} disabled={rows.length === 0 || starting !== null} onPress={() => void playAll(true)} />
          </View>
        </View>
      </View>
      {rows.length > 0 ? (
        <TvCardRow
          testID="tv-artist-albums"
          title={t("parrot.library.view.albums")}
          items={rows}
          keyOf={(album) => album.id}
          cardWidth={CARD * scale}
          cardHeight={tvCardHeight(CARD * scale, scale)}
          gap={CARD_GAP}
          renderCard={(album, _index, onFocus) => (
            <TvAlbumCard
              album={album}
              width={CARD * scale}
              playing={now?.albumId === album.id ? { animated: now.playing } : null}
              onOpen={(albumId) => push({ kind: "album", albumId })}
              onFocus={onFocus}
            />
          )}
        />
      ) : albums.answered ? (
        <TvBody muted style={styles.empty}>
          {t("parrot.library.noAlbums")}
        </TvBody>
      ) : null}
    </ScrollView>
  );
};

/** Sizes in design dp: draft px halved (UX-TV-13 scales them with the TV). */
const baseStyles = StyleSheet.create({
  page: { paddingTop: 20, paddingBottom: 24, gap: 14 },
  // Draft `.ahead`: photo 260px, gap 56px.
  head: { flexDirection: "row", alignItems: "center", gap: 28, paddingHorizontal: TV_SPACE.screenX },
  headText: { flex: 1, gap: 3 },
  name: { ...TV_TYPE.hero, fontSize: 42, lineHeight: 48 },
  actions: { flexDirection: "row", gap: TV_SPACE.buttonGap + 2, marginTop: 10 },
  empty: { paddingHorizontal: TV_SPACE.screenX },
});
