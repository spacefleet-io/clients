import React, { useEffect, useRef, useState } from "react";
import { Image, StyleSheet, TVFocusGuideView, View } from "react-native";
import { Info, Play, RotateCcw } from "lucide-react-native";
import { SkyCover } from "@space/mobile-shell/components";
import { useTranslation } from "@space/mobile-shell/i18n";
import type { MediaRow } from "@space/shared/libraryTypes";
import { unitDurationSeconds } from "../../lib/phoneHome";
import { useMediaImage } from "../../lib/useMediaImage";
import { MediaArtwork } from "../../components/MediaArtwork";
import { useLibraryActions } from "../../store/library";
import { minutesLeft, runtimeParts } from "../lib/detailsMedia";
import type { TvViewInstance } from "../lib/tvViewInstance";
import { useFocusAfterScreenAppears } from "../lib/useFocusAfterScreenAppears";
import { useTvStyles } from "../lib/tvScale";
import { TvPillButton } from "../ui/TvPillButton";
import { TvBody, TvEyebrow, TvTitle } from "../ui/TvText";
import { TV_COLOR, TV_SHADOW, TV_SPACE, tvCardStyle } from "../ui/tokens";

export type TvHeroAction = "resume" | "startOver" | "details";

type Translate = (key: string, options?: Record<string, unknown>) => string;

const pad2 = (value: number) => String(value).padStart(2, "0");

/** The point a film resumes at, as a clock: "41:12" under an hour, "1:02:05" past it; null when the length is unknown. */
export const resumeClock = (progressPct: number, durationSeconds: number | null): string | null => {
  if (durationSeconds === null || durationSeconds <= 0) return null;
  const pct = Math.max(0, Math.min(100, progressPct));
  const total = Math.floor((durationSeconds * pct) / 100);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0 ? `${hours}:${pad2(minutes)}:${pad2(seconds)}` : `${minutes}:${pad2(seconds)}`;
};

/**
 * The card's line under the title and its Resume label (UX-TV-05). With the film's length: "1926 · 1 h 18 min · 37 min
 * left" and "Resume 41:12". Without it (a show, or details not loaded yet): "1926 · 53% watched" and "Resume".
 */
export const heroText = (
  item: Pick<MediaRow, "year" | "progressPct">,
  durationSeconds: number | null,
  t: Translate,
): { meta: string; resume: string } => {
  const percent = Math.round(Math.max(0, Math.min(100, item.progressPct)));
  const runtime = runtimeParts(durationSeconds);
  const left = minutesLeft(item.progressPct, durationSeconds);
  const clock = resumeClock(item.progressPct, durationSeconds);
  if (runtime === null || left === null || clock === null) {
    return {
      meta: [item.year, t("tvShell.home.percentWatched", { percent })].filter(Boolean).join(" · "),
      resume: t("tvShell.home.resume"),
    };
  }
  const length =
    runtime.hours > 0
      ? t("tvShell.details.runtimeHours", { hours: runtime.hours, minutes: runtime.minutes })
      : t("tvShell.details.runtimeMinutes", { minutes: runtime.minutes });
  return {
    meta: [item.year, length, t("home.hero.minutesLeft", { count: left })].filter(Boolean).join(" · "),
    resume: t("tvShell.home.resumeAt", { time: clock }),
  };
};

/**
 * Home's Continue watching card (UX-TV-05): the last title started, its poster's colours glowing softly behind the card,
 * then the amber eyebrow, the title, "year · length · N min left", the amber bar and Resume (the first focus, named after
 * the point it resumes at), Start over and Details. The buttons sit in a full-width guide so UP from any card of the row
 * below lands back on them. On tvOS, UIKit's own focus update when Home finishes appearing lands on the top tabs, so
 * Resume takes the focus back then, like the first poster card does without a hero (TV-HOME-HERO-FOCUS-001).
 */
export const TvContinueHero = ({ item, onAction }: { item: MediaRow; onAction: (action: TvHeroAction, item: MediaRow) => void }) => {
  const { t } = useTranslation();
  const styles = useTvStyles(baseStyles);
  const resumeRef = useRef<TvViewInstance>(null);
  const onResumeBlur = useFocusAfterScreenAppears(resumeRef, true);
  const poster = useMediaImage(item.posterPath ?? null, "poster");
  const { getMediaDetails } = useLibraryActions();
  const [duration, setDuration] = useState<number | null>(null);
  const percent = Math.round(Math.max(0, Math.min(100, item.progressPct)));

  // A film's length comes from its details, like the phone's card (longest format).
  useEffect(() => {
    setDuration(null);
    if (item.type !== "movie") return undefined;
    let cancelled = false;
    void getMediaDetails(item.id, { chunks: false })
      .then((details) => {
        if (!cancelled) setDuration(unitDurationSeconds(details, null));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [getMediaDetails, item.id, item.type]);

  const { meta, resume } = heroText(item, duration, t);

  const press = (action: TvHeroAction) => () => {
    console.info("tv.home.hero", JSON.stringify({ action, mediaId: item.id, type: item.type }));
    onAction(action, item);
  };

  return (
    <SkyCover style={poster ? [styles.hero, styles.heroUnderGlow] : styles.hero} testID="tv-home-hero">
      {poster ? (
        <>
          <Image source={{ uri: poster }} style={styles.glow} blurRadius={40} resizeMode="cover" accessible={false} testID="tv-home-hero-glow" />
          <View style={styles.scrim} pointerEvents="none" testID="tv-home-hero-scrim" />
        </>
      ) : null}
      <View style={styles.poster}>
        <MediaArtwork path={item.posterPath ?? null} kind="poster" style={styles.posterImage} label={item.title} />
      </View>
      <View style={styles.text}>
        <TvEyebrow>{t("home.sections.continueWatching")}</TvEyebrow>
        <TvTitle size="hero" style={styles.title} numberOfLines={2}>
          {item.title}
        </TvTitle>
        <TvBody muted style={styles.meta} testID="tv-home-hero-meta">
          {meta}
        </TvBody>
        <View style={styles.track} accessibilityLabel={t("tvShell.home.percentWatched", { percent })}>
          <View style={[styles.fill, { width: `${percent}%` }]} />
        </View>
        <TVFocusGuideView autoFocus style={styles.actions}>
          <TvPillButton
            ref={resumeRef}
            variant="primary"
            icon={Play}
            filledIcon
            label={resume}
            hasTVPreferredFocus
            onBlur={onResumeBlur}
            onPress={press("resume")}
            testID="tv-home-resume"
          />
          <TvPillButton icon={RotateCcw} label={t("tvShell.home.startOver")} onPress={press("startOver")} testID="tv-home-startover" />
          <TvPillButton icon={Info} label={t("tvShell.home.details")} onPress={press("details")} testID="tv-home-details" />
        </TVFocusGuideView>
      </View>
    </SkyCover>
  );
};

/**
 * The card's dark side fading into the glow (UX-HOME-04): the mockup's card (96 % → 84 % → 50 %) composed with its glow
 * at 33 %, eased so no stop shows as a line. The glow lies under it, past every edge of the card.
 */
export const TV_HERO_SCRIM =
  "linear-gradient(100deg, rgba(36, 38, 56, 0.96) 0%, rgba(36, 38, 56, 0.93) 20%, rgba(36, 38, 56, 0.87) 32%, rgba(36, 38, 56, 0.78) 41%, rgba(36, 38, 56, 0.66) 49%, rgba(36, 38, 56, 0.55) 57%, rgba(36, 38, 56, 0.46) 66%, rgba(36, 38, 56, 0.39) 78%, rgba(36, 38, 56, 0.35) 90%, rgba(36, 38, 56, 0.34) 100%)";

/** Sizes in design dp (mockup `.hero` px halved, scaled with the TV, UX-TV-13). */
const baseStyles = StyleSheet.create({
  hero: {
    ...tvCardStyle,
    flexDirection: "row",
    alignItems: "center",
    gap: 24,
    marginTop: 22,
    marginHorizontal: TV_SPACE.screenX,
    paddingVertical: 20,
    paddingHorizontal: 24,
    borderRadius: 12,
    overflow: "hidden",
  },
  // With a glow the scrim paints the card's colour; the card itself stays clear so the glow sits on the sky under it.
  heroUnderGlow: { backgroundColor: "transparent" },
  // Mockup `.glow`: the poster blown up and blurred. React Native's `blurRadius` blurs only inside the image's box, so
  // the box runs past all four edges of the card and none of its hard edges is ever inside it; the scrim above keeps
  // the glow to the right side.
  // Opacity 0.5: the scrim dims it again, to about the mockup's 33 % on the right.
  glow: { position: "absolute", left: -60, right: -60, top: -100, bottom: -100, opacity: 0.5 },
  scrim: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, experimental_backgroundImage: TV_HERO_SCRIM },
  poster: {
    width: 110,
    aspectRatio: 2 / 3,
    borderRadius: 7,
    overflow: "hidden",
    backgroundColor: TV_COLOR.card,
    boxShadow: TV_SHADOW.poster,
  },
  posterImage: { width: "100%", height: "100%" },
  text: { flex: 1, justifyContent: "center" },
  title: { marginTop: 5, lineHeight: 37 },
  meta: { marginTop: 7, fontSize: 12.5 },
  track: { width: 310, height: 3, marginTop: 11, borderRadius: 1.5, backgroundColor: "rgba(255, 255, 255, 0.16)", overflow: "hidden" },
  fill: { height: "100%", backgroundColor: TV_COLOR.amber },
  actions: { flexDirection: "row", gap: 11, marginTop: 17 },
});
