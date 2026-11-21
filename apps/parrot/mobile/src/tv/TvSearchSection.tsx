// TV Search (PAR-TV-06, draft `5-search`): at the left the query over the draft's grid of keys (a to z, 0 to 9, Space,
// Delete), typed with the remote; at the right "Songs": the songs of the library that match, as the phone's search finds
// them (`buildParrotSearchGroups`), each with its cover, "artist · album" and length. ▶ moves from the keys to the
// songs; OK on a song plays the songs found from that one on.
import React, { memo, useMemo, useState, type ReactNode } from "react";
import { FlatList, StyleSheet, Text, View } from "react-native";
import { Delete, Search, Space } from "lucide-react-native";
import { SkyCover, useSkyScroll } from "@space/mobile-shell/components";
import { useTranslation } from "@space/mobile-shell/i18n";
import { scopeLogger } from "@space/mobile-shell/logger";
import { TvFocusable } from "@space/mobile-shell/tv/TvFocusable";
import { TvFocusGuide } from "@space/mobile-shell/tv/TvFocusGuide";
import { TvBody, TvTitle } from "@space/mobile-shell/tv/TvText";
import { TV_COLOR, TV_FONT, TV_SPACE, hexAlpha, useTvAccent } from "@space/mobile-shell/tv/tokens";
import { useTvScale, useTvStyles } from "@space/mobile-shell/tv/tvScale";
import { parrotCoverThumbKey, type SongRow } from "@space/parrot-core";
import { phoneSearchStrings } from "@space/shared/searchPaletteStrings";
import { listAlbums, listArtists, listSongs, type WithCoverKeys } from "../lib/library";
import { buildParrotSearchGroups } from "../lib/phoneSearch";
import { ParrotArt } from "../screens/art";
import { useSession } from "../state/session";
import { useNowPlaying } from "../state/usePlayerState";
import { useQuery } from "../state/useQuery";
import { TvListCard, TvSongRow } from "./TvMusicParts";
import { TV_SEARCH_CHARS, typeTvSearchKey, type TvSearchKey } from "./tvModel";
import { useTvPlay } from "./tvPages";

const log = scopeLogger("parrot.tv.search");

type Song = WithCoverKeys<SongRow>;

/** Draft `.res .ph` 64 px; rows 96 px. */
const COVER = 32;
const ROW = 48;
/** The songs listed at most: a TV list is read from the sofa, not scrolled through by the hundred. */
const MAX_SONGS = 50;
/** Draft `.kb`: six columns 12 px apart in the 600 px column, keys 80 px high. */
const KEY_GAP = 6;
const KEY_WIDTH = (300 - 5 * KEY_GAP) / 6;
const WIDE_KEY_WIDTH = 3 * KEY_WIDTH + 2 * KEY_GAP;

/** One key of the grid (draft `.k`): its letter, or Space's and Delete's marks, lifted on the remote's focus. */
const TvSearchKeyButton = memo(
  ({ label, wide, icon, first, onPress }: { label: string; wide?: boolean; icon?: ReactNode; first?: boolean; onPress: () => void }) => {
    const styles = useTvStyles(baseStyles);
    const accent = useTvAccent().color;
    return (
      <TvFocusable
        testID={`tv-search-key-${label}`}
        accessibilityLabel={label}
        hasTVPreferredFocus={first}
        style={[styles.key, wide && styles.wideKey]}
        focusedStyle={{ backgroundColor: hexAlpha(accent, 0.14) }}
        onPress={onPress}
      >
        {icon ?? <Text style={styles.keyText}>{label}</Text>}
      </TvFocusable>
    );
  }
);
TvSearchKeyButton.displayName = "TvSearchKeyButton";

export const TvSearchSection = () => {
  const { t, i18n } = useTranslation();
  const strings = useMemo(() => phoneSearchStrings("parrot", i18n.language), [i18n.language]);
  const { library } = useSession();
  const version = library.status === "ready" ? library.version : -1;
  const read = useQuery(
    () => (version < 0 ? Promise.resolve(null) : Promise.all([listArtists(), listAlbums(), listSongs()]).then(([artists, albums, songs]) => ({ artists, albums, songs }))),
    [version]
  );
  const songIndex = useMemo(() => (read.data ? buildParrotSearchGroups(read.data).find((group) => group.id === "songs")?.index : undefined), [read.data]);
  const [query, setQuery] = useState("");
  const { play } = useTvPlay();
  const now = useNowPlaying();
  const scale = useTvScale();
  const styles = useTvStyles(baseStyles);
  const accent = useTvAccent().color;
  const skyScroll = useSkyScroll();

  const press = (key: TvSearchKey) =>
    setQuery((typed) => {
      const next = typeTvSearchKey(typed, key);
      log.info("key", { kind: key.kind, length: next.length });
      return next;
    });

  const songs = useMemo(() => {
    const needle = query.trim();
    if (!songIndex || needle.length === 0) return [];
    return songIndex
      .search(needle, MAX_SONGS)
      .map((hit) => (hit.item.kind === "song" ? hit.item.song : null))
      .filter((song): song is Song => song !== null);
  }, [songIndex, query]);

  const searched = query.trim().length > 0;
  return (
    <View style={styles.screen}>
      <View style={styles.keysColumn}>
        <SkyCover style={styles.field} testID="tv-search-field">
          <Search size={17 * scale} color={TV_COLOR.muted} />
          {query.length > 0 ? (
            <Text style={styles.query} numberOfLines={1} testID="tv-search-query">
              {query}
            </Text>
          ) : null}
          <View style={[styles.caret, { backgroundColor: accent }]} />
          {query.length === 0 ? (
            <Text style={[styles.query, styles.placeholder]} numberOfLines={1}>
              {strings.placeholder}
            </Text>
          ) : null}
        </SkyCover>
        {/* One guide over the keys, so ◀ from the songs comes back to the key last pressed. */}
        <TvFocusGuide autoFocus style={styles.keys}>
          {TV_SEARCH_CHARS.map((char, index) => (
            <TvSearchKeyButton key={char} label={char} first={index === 0} onPress={() => press({ kind: "char", char })} />
          ))}
          <TvSearchKeyButton label={t("parrot.tvSearch.space")} wide icon={<Space size={15 * scale} color={TV_COLOR.text} />} onPress={() => press({ kind: "space" })} />
          <TvSearchKeyButton label={t("parrot.tvSearch.delete")} wide icon={<Delete size={15 * scale} color={TV_COLOR.text} />} onPress={() => press({ kind: "delete" })} />
        </TvFocusGuide>
      </View>
      <View style={styles.results}>
        <TvTitle size="page">{strings.groups.songs}</TvTitle>
        {searched && songs.length === 0 ? (
          <TvBody muted testID="tv-search-empty">
            {strings.empty}
          </TvBody>
        ) : songs.length > 0 ? (
          <TvListCard style={styles.list} testID="tv-search-results">
            <FlatList
              data={songs}
              keyExtractor={(song) => song.id}
              removeClippedSubviews={false}
              showsVerticalScrollIndicator={false}
              {...skyScroll}
              renderItem={({ item, index }) => (
                <TvSongRow
                  testID={`tv-search-song-${index}`}
                  height={ROW}
                  cover={<ParrotArt seed={item.albumId} size={COVER * scale} radius={5 * scale} coverKey={parrotCoverThumbKey(item)} />}
                  title={item.title}
                  subtitle={[item.artistName, item.albumTitle].filter(Boolean).join(" · ")}
                  durationMs={item.durationMs}
                  playing={now?.trackId === item.id ? { animated: now.playing } : null}
                  onPress={() => {
                    log.info("play", { index, count: songs.length });
                    void play(songs, index);
                  }}
                />
              )}
            />
          </TvListCard>
        ) : null}
        <TvBody muted style={styles.hint}>
          {t("parrot.tvSearch.hint")}
        </TvBody>
      </View>
    </View>
  );
};

/** Sizes in design dp: draft px halved (UX-TV-13 scales them with the TV). */
const baseStyles = StyleSheet.create({
  // Draft `.pg`: padding 44px 72px 0, columns 600px + the rest, gap 72px.
  screen: { flex: 1, flexDirection: "row", gap: TV_SPACE.screenX, paddingTop: 22, paddingBottom: 20, paddingHorizontal: TV_SPACE.screenX },
  keysColumn: { width: 300 },
  // Draft `.field`: height 88px, padding 0 30px, radius 20, gap 18, text 38px semibold, caret 3×42 px.
  field: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    height: 44,
    paddingHorizontal: 15,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: TV_COLOR.borderSoft,
    backgroundColor: TV_COLOR.cardOnSky,
  },
  query: { flexShrink: 1, fontFamily: TV_FONT.body, fontSize: 19, fontWeight: "600", color: TV_COLOR.text },
  placeholder: { color: TV_COLOR.muted, fontWeight: "400" },
  caret: { width: 1.5, height: 21, marginLeft: -6 },
  // Draft `.kb` / `.k`: 14 px under the field, keys 80 px high, radius 16, letters 32px bold.
  keys: { flexDirection: "row", flexWrap: "wrap", gap: KEY_GAP, marginTop: 14 },
  key: {
    width: KEY_WIDTH,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: TV_COLOR.borderSoft,
    backgroundColor: TV_COLOR.secondaryOnSky,
  },
  wideKey: { width: WIDE_KEY_WIDTH },
  keyText: { fontFamily: TV_FONT.body, fontSize: 16, fontWeight: "700", color: TV_COLOR.text },
  results: { flex: 1, gap: 9 },
  list: { flexShrink: 1 },
  // Draft hint: 21px, 26px under the songs.
  hint: { fontSize: 10.5, lineHeight: 15, marginTop: 4 },
});
