import React, { memo, useCallback } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { MediaRow } from "@space/shared/libraryTypes";
import { useTranslation } from "@space/mobile-shell/i18n";
import { ArrowDownToLine, Check } from "lucide-react-native";
import { COMPLETED_PCT_THRESHOLD } from "@space/shared/playbackResume";
import { MediaArtwork } from "./MediaArtwork";
import { logImageError } from "../lib/imageLog";
import { useIsMediaDownloaded } from "../lib/downloads/downloadsStore";
import { useLibraryOnline } from "../lib/useLibraryOnline";
import { unavailableOffline } from "@space/shared/offlineReach";
import { UNAVAILABLE_LOOK } from "@space/mobile-shell/theme";
import { theme } from "../theme/theme";

/** Poster art is 2:3. */
export const POSTER_ASPECT = 3 / 2;
/** Fixed height of the title + year block under a poster (2 lines, explicit lineHeight; the mockup's `.pt` / `.ps`). */
export const POSTER_FOOTER_HEIGHT = 10 + 18 + 2 + 16;
export const RIPPLE = { color: "rgba(219, 223, 240, 0.16)", foreground: true } as const;
const onPosterImageError = logImageError("phone.card.poster");

type PosterCardProps = {
  item: MediaRow;
  width: number;
  onPress: (mediaId: string) => void;
  showProgress?: boolean;
};

/** Total fixed card height for a given width (poster + footer). Used by getItemLayout. */
export const posterCardHeight = (width: number) => Math.round(width * POSTER_ASPECT) + POSTER_FOOTER_HEIGHT;

/** Watch progress of a title, clamped to 0-100 (the bar and the label of a poster). */
export const posterProgress = (item: MediaRow): number => Math.min(100, Math.max(0, item.progressPct));

/** Screen-reader label of a poster: title, year, watch progress (rails that show it) and the offline mark. */
export const posterLabel = (
  t: (key: string, options?: Record<string, unknown>) => string,
  item: MediaRow,
  showProgress: boolean,
  downloaded: boolean,
): string => {
  const progress = posterProgress(item);
  return [
    item.title,
    item.year,
    showProgress && progress > 0 ? t("library.poster.watched", { percent: Math.round(progress) }) : null,
    downloaded ? t("library.poster.downloaded") : null,
  ]
    .filter(Boolean)
    .join(", ");
};

/**
 * Memoised poster tile with a fixed layout (no layout jank while images load),
 * the catalog `w342` art, a ripple, and an accessible label. With `showProgress`, drawn as the mockup's `posterCard`
 * (UX-PHONE-06): an inset progress bar while watching, a yellow check in the top-right corner once watched; the offline
 * mark sits top-left so both can show.
 */
export const PosterCard = memo(({ item, width, onPress, showProgress }: PosterCardProps) => {
  const { t } = useTranslation();
  const downloaded = useIsMediaDownloaded(item.id);
  // OFFL-PLAY-03: offline, a title with nothing downloaded is greyed and does not open.
  const unavailable = unavailableOffline(useLibraryOnline(), downloaded);
  const handlePress = useCallback(() => onPress(item.id), [onPress, item.id]);
  const posterHeight = Math.round(width * POSTER_ASPECT);
  const progress = posterProgress(item);
  const watched = Boolean(showProgress) && progress >= COMPLETED_PCT_THRESHOLD;
  const label = posterLabel(t, item, Boolean(showProgress), downloaded);

  return (
    <Pressable
      style={[styles.card, { width }]}
      onPress={handlePress}
      disabled={unavailable}
      android_ripple={unavailable ? undefined : RIPPLE}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={unavailable ? { disabled: true } : undefined}
      testID={unavailable ? "poster-unavailable" : undefined}
    >
      <View style={[styles.poster, { width, height: posterHeight }, unavailable && UNAVAILABLE_LOOK]}>
        <MediaArtwork path={item.posterPath ?? null} kind="poster" label={item.title} style={styles.image} onImageError={onPosterImageError} />
        {downloaded ? (
          <View style={styles.downloadedBadge} accessible={false} testID="poster-downloaded">
            <ArrowDownToLine size={13} color={theme.accentTextHex} strokeWidth={2.5} />
          </View>
        ) : null}
        {showProgress && progress > 0 && !watched ? (
          <View style={styles.progressTrack} testID="poster-progress">
            <View style={[styles.progressFill, { width: `${progress}%` }]} />
          </View>
        ) : null}
        {watched ? (
          <View style={styles.watchedBadge} accessible={false} testID="poster-watched">
            <Check size={14} color={theme.accentTextHex} strokeWidth={3} />
          </View>
        ) : null}
      </View>
      <Text style={[styles.title, unavailable && UNAVAILABLE_LOOK]} numberOfLines={1}>
        {item.title}
      </Text>
      <Text style={[styles.year, unavailable && UNAVAILABLE_LOOK]} numberOfLines={1}>
        {item.year ?? " "}
      </Text>
    </Pressable>
  );
});
PosterCard.displayName = "PosterCard";

const styles = StyleSheet.create({
  // Only the top corners are rounded: the card clips (ripple shape) and the year sits on its bottom line at x = 0,
  // so a rounded bottom-left corner cut the first digit ("2011" drew as "?011").
  card: {
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    overflow: "hidden",
  },
  poster: {
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  downloadedBadge: {
    position: "absolute",
    top: 8,
    left: 8,
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.accent,
  },
  image: {
    width: "100%",
    height: "100%",
  },
  watchedBadge: {
    position: "absolute",
    top: 8,
    right: 8,
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.accent,
  },
  progressTrack: {
    position: "absolute",
    left: 8,
    right: 8,
    bottom: 8,
    height: 4,
    borderRadius: 2,
    overflow: "hidden",
    backgroundColor: "rgba(255,255,255,0.28)",
  },
  progressFill: {
    height: "100%",
    borderRadius: 2,
    backgroundColor: theme.colors.accent,
  },
  title: {
    marginTop: 10,
    height: 18,
    fontSize: 14,
    lineHeight: 18,
    fontWeight: "600",
    color: theme.colors.text,
  },
  year: {
    marginTop: 2,
    height: 16,
    fontSize: 12.5,
    lineHeight: 16,
    color: theme.colors.textMuted,
  },
});
