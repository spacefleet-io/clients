// The pieces Parrot TV's screens share (PAR-TV-03..09, PAR-TV-13), sized from the approved drafts (`1a-home-topbar`,
// `2-album`, `4-artist`, `6-queue`; design dp = the drafts' px halved, scaled with the TV): the square album card, the
// round artist card, a row of cards with its heading and "See all", a song row, the song's wave and the playing bars.
// Covers and photos are the user's own (`ParrotArt` with the library's keys), as on the phone.
import React, { memo, useCallback, useRef, useState, type ReactNode } from "react";
import { Heart, ListMusic, type LucideIcon } from "lucide-react-native";
import { FlatList, StyleSheet, Text, TVFocusGuideView, View, useWindowDimensions, type StyleProp, type ViewStyle } from "react-native";
import { SkyCover } from "@space/mobile-shell/components";
import { MobileRenderBoundary } from "@space/mobile-shell/render-boundary";
import { useTranslation } from "@space/mobile-shell/i18n";
import { railScrollOffset } from "@space/mobile-shell/tv/focusOrder";
import { TvFocusable } from "@space/mobile-shell/tv/TvFocusable";
import { focusDestination, type TvViewInstance } from "@space/mobile-shell/tv/tvViewInstance";
import { TvTitle } from "@space/mobile-shell/tv/TvText";
import { TV_COLOR, TV_FOCUS, TV_RADII, TV_SHADOW, TV_SPACE, TV_TYPE, tvFocusRing, useTvAccent } from "@space/mobile-shell/tv/tokens";
import { useTvScale, useTvStyles } from "@space/mobile-shell/tv/tvScale";
import { formatDuration, parrotArtistPictureThumbKey, parrotCoverThumbKey, type ArtistRow } from "@space/parrot-core";
import type { AlbumWithCover } from "../lib/library";
import { ParrotArt, WaveBars } from "../screens/art";
import { ParrotEqualizer, PlayingBadge } from "../screens/equalizer";
import { isLikedPlaylist } from "../lib/playlists";
import { tvAlbumCaption } from "./tvModel";

/** Room above and below a row of cards for the focused card's grow and ring, which the list would otherwise clip. */
export const TV_CARD_GROW_ROOM = 12;
/** Picture to caption (draft 14 px), and how far the caption moves when the picture grows under the focus. */
const CAPTION_GAP = 7;
const CAPTION_SHIFT = 6;
const CAPTION_HEIGHT = 14 + 2 + 12;
/** A playlist face's mark, as a share of its side (34 dp on Home's 107 dp card). */
const PLAYLIST_ICON = 0.32;

/** A card's height for its picture's width: the picture, then the two caption lines and the focus shift. */
export const tvCardHeight = (width: number, scale: number) => width + (CAPTION_GAP + CAPTION_SHIFT + CAPTION_HEIGHT) * scale;

type CardProps = {
  /** Picture width on screen (already scaled). */
  width: number;
  title: string;
  subtitle?: string;
  round?: boolean;
  picture: ReactNode;
  onPress: () => void;
  onFocus?: () => void;
  hasTVPreferredFocus?: boolean;
  testID?: string;
};

/**
 * One card (draft `.card` / `.artist`): the picture with rounded corners, or round for an artist, and the caption under
 * it. Under the focus the picture alone takes the accent ring and grows a little, and the caption moves down
 * (UX-A11Y-04, as Badger TV's poster card).
 */
const TvCard = memo(({ width, title, subtitle, round, picture, onPress, onFocus, hasTVPreferredFocus, testID }: CardProps) => {
  const styles = useTvStyles(baseStyles);
  const accent = useTvAccent().color;
  const [focused, setFocused] = useState(false);
  return (
    <TvFocusable
      ring="none"
      scale={1}
      style={[styles.card, { width }]}
      onPress={onPress}
      onFocus={() => {
        setFocused(true);
        onFocus?.();
      }}
      onBlur={() => setFocused(false)}
      hasTVPreferredFocus={hasTVPreferredFocus}
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
      testID={testID}
    >
      <View
        style={[
          styles.picture,
          { width, height: width, borderRadius: round ? width / 2 : TV_RADII.poster * 2 },
          focused && { ...tvFocusRing(accent, false), transform: [{ scale: TV_FOCUS.posterScale }], boxShadow: TV_SHADOW.posterFocused },
        ]}
      >
        {picture}
      </View>
      <View style={[styles.caption, round && styles.captionRound, focused && styles.captionFocused]}>
        <Text style={[styles.title, round && styles.centered, focused && styles.titleFocused]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={[styles.subtitle, round && styles.centered]} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
    </TvFocusable>
  );
});
TvCard.displayName = "TvCard";

/** The square album card of Home, the library, the artist page and the playlists (draft `.card`). */
export const TvAlbumCard = memo(
  ({
    album,
    width,
    playing,
    onOpen,
    onFocus,
    hasTVPreferredFocus,
  }: {
    album: AlbumWithCover;
    width: number;
    /** The album plays now: the green badge in the corner, moving while sound comes out. */
    playing: { animated: boolean } | null;
    onOpen: (albumId: string) => void;
    onFocus?: () => void;
    hasTVPreferredFocus?: boolean;
  }) => {
    const { t } = useTranslation();
    return (
      <TvCard
        width={width}
        title={album.title}
        subtitle={tvAlbumCaption(album, t("shell.library.unknownArtist"))}
        onPress={() => onOpen(album.id)}
        onFocus={onFocus}
        hasTVPreferredFocus={hasTVPreferredFocus}
        testID={`tv-album-${album.id}`}
        picture={
          <>
            <ParrotArt seed={album.id} size={width} radius={0} coverKey={parrotCoverThumbKey(album)} />
            {playing ? <PlayingBadge size={width} animated={playing.animated} /> : null}
          </>
        }
      />
    );
  }
);
TvAlbumCard.displayName = "TvAlbumCard";

/** The round artist card of Home's "Your artists" and the library's Artists (draft `.artist`). */
export const TvArtistCard = memo(
  ({ artist, width, subtitle, onOpen, onFocus }: { artist: ArtistRow; width: number; subtitle?: string; onOpen: (artist: ArtistRow) => void; onFocus?: () => void }) => (
    <TvCard
      round
      width={width}
      title={artist.name}
      subtitle={subtitle}
      onPress={() => onOpen(artist)}
      onFocus={onFocus}
      testID={`tv-artist-${artist.id}`}
      picture={<ParrotArt seed={artist.id} size={width} radius={width / 2} coverKey={parrotArtistPictureThumbKey(artist)} />}
    />
  )
);
TvArtistCard.displayName = "TvArtistCard";

/** A playlist's drawn face (it has no cover of its own): its heart (Liked songs) or list mark on the app's colours. */
export const TvPlaylistFace = ({ playlistId, size, radius }: { playlistId: string; size: number; radius: number }) => {
  const styles = useTvStyles(baseStyles);
  const liked = isLikedPlaylist(playlistId);
  const Icon = liked ? Heart : ListMusic;
  return (
    <View style={{ width: size, height: size }}>
      <ParrotArt seed={playlistId} size={size} radius={radius} />
      <View style={styles.iconFace}>
        <Icon size={size * PLAYLIST_ICON} color="#ffffff" fill={liked ? "#ffffff" : "none"} />
      </View>
    </View>
  );
};

/** A playlist's square card, its face for a picture. */
export const TvPlaylistCard = memo(
  ({ playlistId, width, title, subtitle, onPress }: { playlistId: string; width: number; title: string; subtitle?: string; onPress: () => void }) => (
    <TvCard width={width} title={title} subtitle={subtitle} onPress={onPress} testID={`tv-card-${playlistId}`} picture={<TvPlaylistFace playlistId={playlistId} size={width} radius={0} />} />
  )
);
TvPlaylistCard.displayName = "TvPlaylistCard";

/**
 * A row of cards straight on the sky (draft `.rowhead` + `.cards`): the heading with "See all" at its right, and the
 * cards under it in a full-width focus guide, so Up or Down into the row lands on its last focused card (Badger TV's
 * rail, TV-RAIL-FOCUS-001). Right past the last card goes to "See all" (a short row has nothing else to its right, and
 * Up leaves for the row above). The row scrolls itself to keep the focused card in view.
 */
export const TvCardRow = <T,>({
  title,
  items,
  keyOf,
  cardWidth,
  gap,
  renderCard,
  onSeeAll,
  testID,
}: {
  title: string;
  items: readonly T[];
  keyOf: (item: T) => string;
  /** Picture width on screen (already scaled). */
  cardWidth: number;
  /** Gap between cards in design dp. */
  gap: number;
  renderCard: (item: T, index: number, onFocus: () => void) => ReactNode;
  onSeeAll?: () => void;
  testID?: string;
}) => {
  const { t } = useTranslation();
  const { width: windowWidth } = useWindowDimensions();
  const scale = useTvScale();
  const styles = useTvStyles(baseStyles);
  const listRef = useRef<FlatList<T>>(null);
  const [seeAllView, setSeeAllView] = useState<TvViewInstance | null>(null);
  const itemLength = cardWidth + gap * scale;
  const focusAt = useCallback(
    (index: number) => {
      const offset = railScrollOffset({ focusedIndex: index, itemLength, itemCount: items.length, viewportWidth: windowWidth - TV_SPACE.screenX * scale });
      listRef.current?.scrollToOffset({ offset, animated: true });
    },
    [itemLength, items.length, scale, windowWidth]
  );
  return (
    <View testID={testID}>
      <View style={styles.rowHead}>
        <TvTitle size="section" numberOfLines={1} style={styles.rowTitle}>
          {title}
        </TvTitle>
        {onSeeAll ? (
          <TvFocusable ref={setSeeAllView} onPress={onSeeAll} style={styles.seeAll} testID={testID ? `${testID}-see-all` : undefined} accessibilityLabel={`${t("shell.home.seeAll")}, ${title}`}>
            <Text style={styles.seeAllText}>{t("shell.home.seeAll")}</Text>
          </TvFocusable>
        ) : null}
      </View>
      <TVFocusGuideView autoFocus>
        <FlatList
          ref={listRef}
          horizontal
          data={items}
          keyExtractor={keyOf}
          renderItem={({ item, index }) => (
            <SkyCover>
              {/* UX-CRASH-01: a card that throws shows a placeholder in its place; the rest of the row stays. */}
              <MobileRenderBoundary name={`tv-card:${keyOf(item)}`} variant="item" style={{ width: cardWidth, margin: 0 }}>
                {() => renderCard(item, index, () => focusAt(index))}
              </MobileRenderBoundary>
            </SkyCover>
          )}
          ItemSeparatorComponent={() => <View style={{ width: gap * scale }} />}
          ListFooterComponent={
            onSeeAll ? <TVFocusGuideView destinations={focusDestination(seeAllView)} style={{ width: cardWidth, height: tvCardHeight(cardWidth, scale) }} testID={testID ? `${testID}-to-see-all` : undefined} /> : undefined
          }
          style={{ height: tvCardHeight(cardWidth, scale) + TV_CARD_GROW_ROOM * 2 * scale }}
          contentContainerStyle={styles.rowContent}
          showsHorizontalScrollIndicator={false}
          initialNumToRender={items.length}
          windowSize={21}
        />
      </TVFocusGuideView>
    </View>
  );
};

/** The playing song's green bars, at the TV's size. */
export const TvPlayingBars = ({ animated, color }: { animated: boolean; color?: string }) => {
  const scale = useTvScale();
  return (
    <View style={{ transform: [{ scale: scale * 0.75 }] }}>
      <ParrotEqualizer animated={animated} color={color} />
    </View>
  );
};

/** The song's wave (PAR-LOOK-01) with the played part in green, read only: the TV seeks with the remote's keys. */
export const TvWave = ({ seed, progress, height, bars = 64, style }: { seed: string; progress: number; height: number; bars?: number; style?: StyleProp<ViewStyle> }) => {
  const scale = useTvScale();
  return (
    <View testID="tv-wave" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[{ flexDirection: "row", alignItems: "center", gap: 1.5 * scale, height: height * scale }, style]}>
      <WaveBars seed={seed} progress={progress} bars={bars} height={height * scale} />
    </View>
  );
};

/** The time played and the time left under a wave (draft `.times`). */
export const TvTimes = ({ positionMs, durationMs, size = 11 }: { positionMs: number; durationMs: number; size?: number }) => {
  const scale = useTvScale();
  const style = { fontFamily: TV_TYPE.body.fontFamily, fontSize: size * scale, color: TV_COLOR.muted, fontVariant: ["tabular-nums" as const] };
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
      <Text style={style}>{formatDuration(positionMs)}</Text>
      <Text style={style}>{`-${formatDuration(Math.max(0, durationMs - positionMs))}`}</Text>
    </View>
  );
};

/**
 * A song in a list (draft `2-album` `.row`, `6-queue` `.qrow`, `5-search` `.res`): its number or cover first, the title
 * (with a second line when given) and the length at the right. The playing song shows the green bars in place of its
 * number and its title in green. The focus draws the ring inside the row, which spans the list.
 */
export const TvSongRow = memo(
  ({
    lead,
    cover,
    title,
    subtitle,
    durationMs,
    playing,
    onPress,
    hasTVPreferredFocus,
    height = 37,
    testID,
    focusable = true,
  }: {
    /** The track number (album pages); ignored when `cover` is given. */
    lead?: string | number | null;
    cover?: ReactNode;
    title: string;
    subtitle?: string;
    durationMs: number | null;
    playing: { animated: boolean } | null;
    onPress: () => void;
    hasTVPreferredFocus?: boolean;
    /** Row height in design dp. */
    height?: number;
    testID?: string;
    /** False for a row that only informs (a listed song the library does not have): dimmed and skipped by the remote. */
    focusable?: boolean;
  }) => {
    const styles = useTvStyles(baseStyles);
    const scale = useTvScale();
    const accent = useTvAccent().color;
    return (
      <TvFocusable
        ring="inside"
        scale={1}
        style={[styles.songRow, { height: height * scale }, !focusable && { opacity: 0.45 }]}
        focusable={focusable}
        disabled={!focusable}
        focusedStyle={styles.songRowFocused}
        onPress={onPress}
        hasTVPreferredFocus={hasTVPreferredFocus}
        accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
        accessibilityState={{ selected: playing !== null }}
        testID={testID}
      >
        {cover ? (
          <View style={styles.songCover}>{cover}</View>
        ) : (
          <View style={styles.songNumber}>
            {playing ? <TvPlayingBars animated={playing.animated} color={accent} /> : <Text style={styles.songNumberText}>{lead ?? "·"}</Text>}
          </View>
        )}
        <View style={styles.songText}>
          <Text style={[styles.songTitle, playing && { color: accent }]} numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? (
            <Text style={styles.songSubtitle} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        {cover && playing ? <TvPlayingBars animated={playing.animated} color={accent} /> : null}
        <Text style={styles.songLength}>{durationMs ? formatDuration(durationMs) : ""}</Text>
      </TvFocusable>
    );
  }
);
TvSongRow.displayName = "TvSongRow";

/**
 * A round player button (draft `3b` `.ctl`, `3a` `.bar .ctl`): previous, next, shuffle, repeat, the heart, and the big
 * green play button (`primary`). `active` paints the icon green (shuffle or repeat on, the heart on).
 */
export const TvRoundButton = memo(
  ({
    icon: Icon,
    size,
    label,
    onPress,
    primary,
    active,
    filled,
    hasTVPreferredFocus,
    testID,
  }: {
    icon: LucideIcon;
    /** Diameter in design dp. */
    size: number;
    label: string;
    onPress: () => void;
    primary?: boolean;
    active?: boolean;
    /** Draw the icon filled (play, pause, previous, next, the heart). */
    filled?: boolean;
    hasTVPreferredFocus?: boolean;
    testID?: string;
  }) => {
    const scale = useTvScale();
    const accent = useTvAccent();
    const color = primary ? accent.onColor : active ? accent.color : TV_COLOR.text;
    return (
      <TvFocusable
        testID={testID}
        accessibilityLabel={label}
        accessibilityState={{ selected: active === true }}
        hasTVPreferredFocus={hasTVPreferredFocus}
        onPress={onPress}
        style={{
          width: size * scale,
          height: size * scale,
          borderRadius: (size * scale) / 2,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: primary ? accent.color : TV_COLOR.secondaryOnSky,
          borderWidth: primary ? 0 : 0.75 * scale,
          borderColor: TV_COLOR.borderSoft,
          boxShadow: primary ? accent.glow : undefined,
        }}
      >
        <Icon size={size * 0.42 * scale} color={color} fill={filled ? color : "none"} strokeWidth={2.2} />
      </TvFocusable>
    );
  }
);
TvRoundButton.displayName = "TvRoundButton";

/** The card a song list sits on (draft `2-album` `.list`, `5-search` `.results`): rounded, on the sky, a thin border. */
export const TvListCard = ({ children, style, testID }: { children: ReactNode; style?: StyleProp<ViewStyle>; testID?: string }) => {
  const styles = useTvStyles(baseStyles);
  return (
    <View style={[styles.listCard, style]} testID={testID}>
      {children}
    </View>
  );
};

/** Sizes in design dp (the drafts' px halved, scaled with the TV, UX-TV-13). */
const baseStyles = StyleSheet.create({
  card: { borderRadius: 0 },
  picture: { overflow: "hidden", backgroundColor: TV_COLOR.card, boxShadow: TV_SHADOW.poster },
  iconFace: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, alignItems: "center", justifyContent: "center" },
  caption: { marginTop: CAPTION_GAP, height: CAPTION_HEIGHT },
  captionRound: { alignItems: "center" },
  captionFocused: { transform: [{ translateY: CAPTION_SHIFT }] },
  centered: { textAlign: "center" },
  title: { ...TV_TYPE.caption, height: 14, lineHeight: 14, color: TV_COLOR.text },
  titleFocused: { color: "#ffffff" },
  subtitle: { fontFamily: TV_TYPE.small.fontFamily, fontSize: 9, lineHeight: 12, marginTop: 2, color: TV_COLOR.muted },
  rowHead: { flexDirection: "row", alignItems: "center", paddingHorizontal: TV_SPACE.screenX, marginBottom: TV_SPACE.headingGap - TV_CARD_GROW_ROOM },
  rowTitle: { flex: 1 },
  seeAll: { paddingHorizontal: 6, paddingVertical: 2 },
  seeAllText: { fontFamily: TV_TYPE.body.fontFamily, fontSize: 10, fontWeight: "600", color: TV_COLOR.muted },
  rowContent: { paddingHorizontal: TV_SPACE.screenX, paddingVertical: TV_CARD_GROW_ROOM },
  songRow: { flexDirection: "row", alignItems: "center", gap: 13, paddingHorizontal: 14, borderRadius: TV_RADII.control },
  songRowFocused: { backgroundColor: "rgba(255, 255, 255, 0.06)" },
  songNumber: { width: 17, alignItems: "flex-end", justifyContent: "center" },
  songNumberText: { fontFamily: TV_TYPE.body.fontFamily, fontSize: 11, color: TV_COLOR.muted, fontVariant: ["tabular-nums"] },
  songCover: { borderRadius: 5, overflow: "hidden" },
  songText: { flex: 1, gap: 1 },
  songTitle: { fontFamily: TV_TYPE.body.fontFamily, fontSize: 12, fontWeight: "500", color: TV_COLOR.text },
  songSubtitle: { fontFamily: TV_TYPE.body.fontFamily, fontSize: 9.5, color: TV_COLOR.muted },
  songLength: { fontFamily: TV_TYPE.body.fontFamily, fontSize: 11, color: TV_COLOR.muted, fontVariant: ["tabular-nums"] },
  listCard: { borderRadius: 10, padding: 4, backgroundColor: TV_COLOR.cardOnSky, borderWidth: 0.75, borderColor: TV_COLOR.borderSoft, overflow: "hidden" },
});
