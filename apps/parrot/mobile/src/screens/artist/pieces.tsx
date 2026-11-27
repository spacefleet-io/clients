// The artist page's pieces (PAR-LOOK-06). The photo edge to edge (Badger's title hero, UX-PHONE-04) with its credit
// line (PAR-META-15); with no photo, the artist's drawn picture (`ParrotArt`, PAR-LOOK-01) with their initials, never a
// blank box; while a photo may still come, a shimmer (PAR-META-20).
import React from "react";
import { Linking, StyleSheet, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { useTranslation } from "@space/mobile-shell/i18n";
import { parrotCoverThumbKey } from "@space/parrot-core";
import type { ParrotPhotoCredit } from "@space/parrot-library-db-definition/ops";
import { colors, spacing } from "../../theme";
import { ParrotArt } from "../art";
import { PAGE_BACK_ROW } from "../pageBack";
import { Shimmer } from "../shimmer";
import { SongListRow } from "../SongListRow";
import type { ArtistPage, ArtistSong } from "./useArtistPage";

const LICENCE_SLOT = "\u0000";

/** Badger's hero fade (HERO_FADE_STOPS in apps/badger/mobile/src/lib/phoneDetails.ts), as a veil of the page colour. */
const HERO_FADE_STOPS = [
  { offset: 0, opacity: 0 },
  { offset: 0.45, opacity: 0.05 },
  { offset: 0.75, opacity: 0.55 },
  { offset: 1, opacity: 1 },
];

/** "Photo: author, licence", the licence opening its text when the photo's source names it. */
export const PhotoCredit = ({ credit }: { credit: ParrotPhotoCredit }) => {
  const { t } = useTranslation();
  const [before, after = ""] = t("shell.library.photoCredit", { author: credit.author, licence: LICENCE_SLOT }).split(LICENCE_SLOT);
  const licenceUrl = credit.licenceUrl;
  return (
    <Text testID="artist-photo-credit" style={styles.credit} numberOfLines={1}>
      {before}
      {licenceUrl ? (
        <Text accessibilityRole="link" style={{ textDecorationLine: "underline" }} onPress={() => void Linking.openURL(licenceUrl)}>
          {credit.licence}
        </Text>
      ) : (
        credit.licence
      )}
      {after}
    </Text>
  );
};

/** Up to two initials of the name, for the drawn picture of an artist with no photo. */
const initials = (name: string) =>
  name
    .split(/[\s&,]+/)
    .filter((word) => /^[\p{L}\p{N}]/u.test(word))
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join("");

/**
 * The photo edge to edge, fading into the sky at the bottom (Badger's title hero). The fade is drawn at the hero's
 * size in numbers, not "100%": when a large text size grew the hero after its first layout, a percentage fade stayed
 * at its first size and the photo showed unfaded below it (UX-A11Y-05).
 */
export const ArtistHero = ({ artistId, name, page, width, height }: { artistId: string; name: string; page: ArtistPage; width: number; height: number }) => (
  <View testID="artist-hero" style={{ width, height }}>
    {page.photoWaiting ? (
      <Shimmer testID="artist-photo-shimmer" style={StyleSheet.absoluteFill} />
    ) : (
      <ParrotArt
        seed={artistId}
        size={width}
        radius={0}
        style={{ height }}
        coverKey={page.photo?.pictureObjectKey}
        previewKey={page.photo?.pictureThumbObjectKey}
      />
    )}
    {!page.photo && !page.photoWaiting ? (
      <View style={[StyleSheet.absoluteFill, styles.centre]} pointerEvents="none">
        <Text style={[styles.initials, { fontSize: height / 3.2 }]}>{initials(name)}</Text>
      </View>
    ) : null}
    <Svg testID="artist-hero-fade" style={StyleSheet.absoluteFill} width={width} height={height} pointerEvents="none">
      <Defs>
        <LinearGradient id="artistHeroFade" x1="0" y1="0" x2="0" y2="1">
          {HERO_FADE_STOPS.map((stop) => (
            <Stop key={stop.offset} offset={stop.offset} stopColor={colors.bg} stopOpacity={stop.opacity} />
          ))}
        </LinearGradient>
      </Defs>
      <Rect x={0} y={0} width={width} height={height} fill="url(#artistHeroFade)" />
    </Svg>
  </View>
);

export const SectionTitle = ({ children, right }: { children: string; right?: string }) => (
  <View style={styles.sectionRow}>
    <Text style={styles.sectionTitle} accessibilityRole="header">
      {children.toUpperCase()}
    </Text>
    {right ? <Text style={styles.sectionRight}>{right}</Text> : null}
  </View>
);

/** Songs as rows; `withCover` leads each with its album's cover, otherwise with its number in `list`. */
export const SongRows = ({ list, page, withCover = true }: { list: ArtistSong[]; page: ArtistPage; withCover?: boolean }) => (
  <View>
    {list.map((song, index) => (
      <SongListRow
        key={song.id}
        lead={withCover ? <ParrotArt seed={song.albumId} coverKey={parrotCoverThumbKey(song)} size={40} radius={6} /> : index + 1}
        title={song.title}
        subtitle={[song.albumTitle, song.year].filter(Boolean).join(" · ")}
        durationMs={song.durationMs}
        playing={page.now?.trackId === song.id ? { animated: page.now.playing } : null}
        starting={page.starting === song.id}
        disabled={page.starting !== null}
        unavailable={page.reach ? !page.reach.song(song.id) : false}
        accessibilityLabel={page.t("parrot.album.play", { title: song.title })}
        onPress={() => page.playFrom(list, index)}
        onMore={() => page.openSong(song)}
        moreLabel={`${page.t("parrot.player.more")}, ${song.title}`}
      />
    ))}
  </View>
);

/** Whether the page has scrolled `from` or further, re-rendering the page only when that flips. */
export const useTopBarScroll = (from: number) => {
  const [shown, setShown] = React.useState(false);
  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => setShown(event.nativeEvent.contentOffset.y >= from);
  return { shown, onScroll };
};

/**
 * A solid strip behind the status bar and the floating back button, naming the artist, once the hero (with its own
 * back button and the big name) has scrolled away, so nothing scrolls under the button. Render it before the button.
 */
export const ArtistTopBar = ({ name }: { name: string }) => {
  const insets = useSafeAreaInsets();
  return (
    <View
      testID="artist-top-bar"
      pointerEvents="none"
      style={[styles.topBar, { height: insets.top + PAGE_BACK_ROW, paddingTop: insets.top, paddingLeft: insets.left + TOP_BAR_NAME_LEFT }]}
    >
      <Text style={styles.topBarName} numberOfLines={1}>
        {name}
      </Text>
    </View>
  );
};

/** Past the back button (44) and its margins. */
const TOP_BAR_NAME_LEFT = spacing.lg + 44 + spacing.md;

const styles = StyleSheet.create({
  credit: { color: colors.textMuted, fontSize: 11, marginTop: spacing.xs, textAlign: "center" },
  centre: { alignItems: "center", justifyContent: "center" },
  initials: { color: "rgba(255,255,255,0.88)", fontWeight: "800", letterSpacing: 1, textShadowColor: "rgba(0,0,0,0.35)", textShadowRadius: 8 },
  sectionRow: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", paddingHorizontal: spacing.lg },
  sectionTitle: { color: colors.textMuted, fontSize: 11, letterSpacing: 1.5, fontWeight: "900" },
  sectionRight: { color: colors.textMuted, fontSize: 12 },
  topBar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    justifyContent: "center",
    paddingRight: spacing.lg,
    backgroundColor: colors.bg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  topBarName: { color: colors.text, fontSize: 17, fontWeight: "800" },
});
