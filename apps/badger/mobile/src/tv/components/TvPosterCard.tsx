import React, { memo, useCallback, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { TvViewInstance } from "../lib/tvViewInstance";
import { Check, Film, Tv } from "lucide-react-native";
import type { MediaRow } from "@space/shared/libraryTypes";
import { COMPLETED_PCT_THRESHOLD } from "@space/shared/playbackResume";
import { useTranslation } from "@space/mobile-shell/i18n";
import { POSTER_ASPECT, posterLabel, posterProgress } from "../../components/PosterCard";
import { MediaArtwork } from "../../components/MediaArtwork";
import { TvFocusable } from "./TvFocusable";
import { useFocusAfterScreenAppears } from "../lib/useFocusAfterScreenAppears";
import { logImageError } from "../../lib/imageLog";
import { useTvScale, useTvStyles } from "../lib/tvScale";
import { TV_COLOR, TV_FOCUS, TV_RADII, TV_SHADOW, TV_TYPE, tvFocusRing } from "../ui/tokens";

/** Sizes in design dp (mockup px halved, scaled with the TV, UX-TV-13). Room between the poster and its title (mockup 14 px). */
export const TV_CAPTION_GAP = 7;
/** How far the title moves down when the poster grows under the focus (mockup 14 px -> 26 px); the card keeps that room. */
export const TV_CAPTION_FOCUS_SHIFT = 6;
const TITLE_LINE_HEIGHT = 14;
const SECOND_LINE_GAP = 2;
const SECOND_LINE_HEIGHT = 12;
const CHECK_SIZE = 18;
const BAR_HEIGHT = 3;
const BAR_INSET = 6;

const onPosterImageError = logImageError("tv.card.poster");

/**
 * Total card height for a width (on screen) at this TV scale: the poster, then the title and the year, plus the room the
 * title takes when the focused poster grows. The progress bar sits inside the poster, so it adds nothing.
 */
export const tvPosterCardHeight = (width: number, scale: number) =>
  Math.round(width * POSTER_ASPECT) +
  (TV_CAPTION_GAP + TV_CAPTION_FOCUS_SHIFT + TITLE_LINE_HEIGHT + SECOND_LINE_GAP + SECOND_LINE_HEIGHT) * scale;

type TvPosterCardProps = {
  item: MediaRow;
  width: number;
  onPress: (mediaId: string) => void;
  /** Show the watch state: the bar inside the poster while watching, the amber check once watched. */
  showProgress?: boolean;
  /** Home rows: a film / TV-show mark before the year (the library's tab already says it). */
  showType?: boolean;
  hasTVPreferredFocus?: boolean;
  /** Called with the title when the card takes the focus (a rail scrolls to it, the Home banner follows it). */
  onFocusItem?: (mediaId: string) => void;
};

/**
 * The poster card on TV (mockup `.pc`, UX-TV-11, UX-TV-34): a 2:3 poster with rounded corners and a soft shadow, the title
 * on one line and the year in grey under it. With the watch state, a thin amber bar inside the poster's bottom edge while
 * watching and a round amber check in its top-right corner once watched. Under the focus the poster alone takes the amber
 * ring with a gap and grows slightly, its shadow deepens, and the title turns white and moves down (UX-A11Y-04).
 */
export const TvPosterCard = memo(({ item, width, onPress, showProgress, showType, hasTVPreferredFocus, onFocusItem }: TvPosterCardProps) => {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onPress(item.id), [onPress, item.id]);
  const handleFocus = useCallback(() => {
    setFocused(true);
    onFocusItem?.(item.id);
  }, [onFocusItem, item.id]);
  const progress = posterProgress(item);
  const watched = Boolean(showProgress) && progress >= COMPLETED_PCT_THRESHOLD;
  const watching = Boolean(showProgress) && progress > 0 && !watched;
  const ref = useRef<TvViewInstance>(null);
  const [focused, setFocused] = useState(false);
  const blurAfterScreen = useFocusAfterScreenAppears(ref, Boolean(hasTVPreferredFocus));
  const handleBlur = useCallback(() => {
    setFocused(false);
    blurAfterScreen();
  }, [blurAfterScreen]);
  const TypeIcon = item.type === "tv" ? Tv : Film;
  const scale = useTvScale();
  const styles = useTvStyles(baseStyles);

  return (
    <TvFocusable
      ref={ref}
      ring="none"
      scale={1}
      style={[styles.card, { width }]}
      onPress={handlePress}
      onFocus={handleFocus}
      onBlur={handleBlur}
      hasTVPreferredFocus={hasTVPreferredFocus}
      accessibilityLabel={posterLabel(t, item, Boolean(showProgress), false)}
    >
      <View style={[styles.picture, { height: Math.round(width * POSTER_ASPECT) }, focused && styles.pictureFocused]} testID="tv-card-picture">
        <View style={styles.clip}>
          {/* Every row, Continue watching included, shows the poster (Chris 2026-10-28, UX-TV-05); a spinner while it comes (UX-WAIT-03). */}
          <MediaArtwork path={item.posterPath ?? null} kind="poster" style={styles.image} label={item.title} onImageError={onPosterImageError} />
          {watching ? (
            <View style={styles.progressTrack} testID="tv-card-progress">
              <View style={[styles.progressFill, { width: `${progress}%` }]} />
            </View>
          ) : null}
        </View>
        {watched ? (
          <View style={styles.check} testID="tv-card-watched">
            <Check size={10 * scale} color={TV_COLOR.onAmber} strokeWidth={3.2} />
          </View>
        ) : null}
      </View>
      <View style={[styles.caption, focused && styles.captionFocused]} testID="tv-card-caption">
        <Text style={[styles.title, focused && styles.titleFocused]} numberOfLines={1}>
          {item.title}
        </Text>
        <View style={styles.secondLine}>
          {showType ? (
            <View testID="tv-card-type">
              <TypeIcon size={9 * scale} color={TV_COLOR.muted} />
            </View>
          ) : null}
          <Text style={styles.year} numberOfLines={1}>
            {item.year ?? "—"}
          </Text>
        </View>
      </View>
    </TvFocusable>
  );
});
TvPosterCard.displayName = "TvPosterCard";

const baseStyles = StyleSheet.create({
  card: { borderRadius: 0 },
  picture: { borderRadius: TV_RADII.poster, backgroundColor: TV_COLOR.card, boxShadow: TV_SHADOW.poster },
  pictureFocused: { ...tvFocusRing(false), transform: [{ scale: TV_FOCUS.posterScale }], boxShadow: TV_SHADOW.posterFocused },
  clip: { flex: 1, borderRadius: TV_RADII.poster, overflow: "hidden" },
  image: { width: "100%", height: "100%" },
  check: {
    position: "absolute",
    top: 6,
    right: 6,
    width: CHECK_SIZE,
    height: CHECK_SIZE,
    borderRadius: CHECK_SIZE / 2,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: TV_COLOR.amber,
    boxShadow: "0px 2px 7px rgba(0, 0, 0, 0.45)",
  },
  progressTrack: {
    position: "absolute",
    left: BAR_INSET,
    right: BAR_INSET,
    bottom: BAR_INSET,
    height: BAR_HEIGHT,
    borderRadius: BAR_HEIGHT / 2,
    overflow: "hidden",
    backgroundColor: "rgba(255, 255, 255, 0.3)",
  },
  progressFill: { height: "100%", borderRadius: BAR_HEIGHT / 2, backgroundColor: TV_COLOR.amber },
  caption: { marginTop: TV_CAPTION_GAP },
  captionFocused: { transform: [{ translateY: TV_CAPTION_FOCUS_SHIFT }] },
  title: { ...TV_TYPE.caption, height: TITLE_LINE_HEIGHT, lineHeight: TITLE_LINE_HEIGHT, color: TV_COLOR.text },
  titleFocused: { color: "#ffffff" },
  secondLine: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: SECOND_LINE_GAP, height: SECOND_LINE_HEIGHT },
  year: { fontFamily: TV_TYPE.small.fontFamily, fontSize: 9, lineHeight: SECOND_LINE_HEIGHT, color: TV_COLOR.muted },
});
