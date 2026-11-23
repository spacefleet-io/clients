import React, { memo, useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Play } from "lucide-react-native";
import type { MediaRow } from "@space/shared/libraryTypes";
import { SkyCover } from "@space/mobile-shell/components";
import { useTranslation } from "@space/mobile-shell/i18n";
import { useLibraryActions, useLibraryStatus } from "../store/library";
import { MediaArtwork } from "./MediaArtwork";
import { continueHeroProgress, type ContinueHeroProgress } from "../lib/phoneHome";
import { playEpisode, uploadedEpisodeKeys } from "../lib/playback/episodeSelection";
import { getLastPlayedEpisodeId } from "../lib/resume";
import { theme } from "../theme/theme";

const POSTER_WIDTH = 92;

type ContinueHeroProps = {
  item: MediaRow;
  onOpen: (mediaId: string) => void;
  onResume: (item: MediaRow) => void;
};

/**
 * Home's "Continue watching" card (UX-PHONE-01): the poster on the left, the amber eyebrow, the title, the year with
 * the episode Resume plays for a show ("S1 E2"), the minutes left (the percent watched only when no length is known),
 * the progress bar and Resume. Read from the stored progress once the library is read, so it says the same after a
 * restart.
 */
export const ContinueHero = memo(({ item, onOpen, onResume }: ContinueHeroProps) => {
  const { t } = useTranslation();
  const { getMediaDetails, getEpisodeResumeMap } = useLibraryActions();
  const { awaitDatasetReady } = useLibraryStatus();
  const [read, setRead] = useState<{ mediaId: string; progress: ContinueHeroProgress } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Read too early after a launch, the details come back empty and the card fell back to "% watched".
      await awaitDatasetReady("metadata");
      const details = await getMediaDetails(item.id, { chunks: false });
      if (item.type !== "tv") return continueHeroProgress(item, details, null, null);
      const [savedEpisodeId, resumeMap] = await Promise.all([getLastPlayedEpisodeId(item.id), getEpisodeResumeMap(item.id).catch(() => null)]);
      const episode = playEpisode(details, savedEpisodeId, uploadedEpisodeKeys(details));
      return continueHeroProgress(item, details, episode, episode ? (resumeMap?.[episode.id] ?? null) : null);
    })()
      .then((progress) => {
        if (!cancelled) setRead({ mediaId: item.id, progress });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // `item` is read for its id, type and progress only: a new row object with the same values must not reload.
  }, [awaitDatasetReady, getEpisodeResumeMap, getMediaDetails, item.id, item.type, item.progressPct]);

  const shown = read?.mediaId === item.id ? read.progress : null;
  const progress = shown?.progressPct ?? Math.min(100, Math.max(0, item.progressPct));
  const status = !shown
    ? null
    : shown.minutesLeft !== null
      ? t("home.hero.minutesLeft", { count: shown.minutesLeft })
      : t("library.poster.watched", { percent: Math.round(progress) });
  const meta = [item.year, shown?.episodeCode, status].filter(Boolean).join(" · ");

  return (
    <SkyCover style={styles.card} testID="home-hero">
      <Pressable onPress={() => onOpen(item.id)} accessibilityRole="button" accessibilityLabel={item.title} testID="home-hero-poster">
        <MediaArtwork path={item.posterPath} kind="poster" style={styles.poster} />
      </Pressable>
      <View style={styles.body}>
        <Text style={styles.eyebrow}>{t("home.sections.continueWatching").toUpperCase()}</Text>
        <Text style={styles.title} numberOfLines={2} accessibilityRole="header">
          {item.title}
        </Text>
        <Text style={styles.meta} testID="home-hero-meta">
          {meta}
        </Text>
        <View style={styles.track}>
          <View style={[styles.fill, { width: `${progress}%` }]} />
        </View>
        <Pressable
          style={styles.resume}
          onPress={() => onResume(item)}
          accessibilityRole="button"
          accessibilityLabel={`${t("home.hero.resume")}, ${item.title}`}
          testID="home-hero-resume"
        >
          <Play size={14} color={theme.accentTextHex} fill={theme.accentTextHex} />
          <Text style={styles.resumeLabel}>{t("home.hero.resume")}</Text>
        </Pressable>
      </View>
    </SkyCover>
  );
});
ContinueHero.displayName = "ContinueHero";

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    gap: 14,
    padding: 14,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    overflow: "hidden",
  },
  poster: {
    width: POSTER_WIDTH,
    height: Math.round(POSTER_WIDTH * 1.5),
    borderRadius: 10,
    overflow: "hidden",
  },
  body: { flex: 1, minWidth: 0 },
  eyebrow: { fontSize: 11, fontWeight: "800", letterSpacing: 1.6, color: theme.colors.accent },
  title: { fontSize: 23, lineHeight: 26, marginTop: 4, fontWeight: "800", color: theme.colors.text, fontFamily: theme.font.family.display },
  meta: { fontSize: 12.5, marginTop: 5, color: theme.colors.textMuted },
  track: { height: 4, borderRadius: 2, marginTop: 10, backgroundColor: "rgba(255,255,255,0.12)", overflow: "hidden" },
  fill: { height: "100%", backgroundColor: theme.colors.accent },
  resume: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 36,
    marginTop: 12,
    paddingHorizontal: 14,
    borderRadius: 999,
    backgroundColor: theme.colors.accent,
  },
  resumeLabel: { fontSize: 13, fontWeight: "700", color: theme.accentTextHex },
});
