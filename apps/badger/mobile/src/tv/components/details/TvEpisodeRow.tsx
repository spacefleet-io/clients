import React, { memo, useCallback } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { TvViewInstance } from "@space/mobile-shell/tv/tvViewInstance";
import type { MediaEpisode } from "@space/shared/libraryTypes";
import { MediaArtwork } from "../../../components/MediaArtwork";
import { theme } from "../../../theme/theme";
import { UNAVAILABLE_LOOK } from "@space/mobile-shell/theme";
import { TV_RADIUS } from "../../lib/tvLook";
import { useTvStyles } from "@space/mobile-shell/tv/tvScale";
import { TvFocusable } from "@space/mobile-shell/tv/TvFocusable";

export type TvEpisodeRowProps = {
  episode: MediaEpisode;
  hasFile: boolean;
  /** 0-100; the still's bar shows it when above 0. */
  progressPct: number;
  /** "52 min", or null when unknown. */
  durationText: string | null;
  /** "✓ Watched" or "64% watched", or null. */
  watchedText: string | null;
  watched: boolean;
  /** This episode's own qualities, "1080p · 720p" (UX-TV-07). */
  qualitiesText: string | null;
  infoLabel: string;
  onPlay: (episodeId: string) => void;
  onInfo: (episodeId: string) => void;
  /** Receives the ⓘ button, so closing the side panel gives the focus back to it. */
  registerInfo: (episodeId: string, view: TvViewInstance | null) => void;
  /** Receives the row when it is the first of the list (the target of DOWN from the tabs). */
  rowRef?: (view: TvViewInstance | null) => void;
};

/**
 * One episode of a show's Episodes tab (UX-TV-07): still with its progress, "N Title", synopsis, then length, watched
 * state and the episode's qualities. OK plays it (the player asks to resume); the ⓘ button at its end opens the side panel.
 * An episode with no file in the library is greyed out like on desktop and stays reachable; its OK opens the side panel,
 * as a click on it selects it on desktop (UX-TV-08).
 */
export const TvEpisodeRow = memo(
  ({
    episode,
    hasFile,
    progressPct,
    durationText,
    watchedText,
    watched,
    qualitiesText,
    infoLabel,
    onPlay,
    onInfo,
    registerInfo,
    rowRef,
  }: TvEpisodeRowProps) => {
    const styles = useTvStyles(baseStyles);
    const play = useCallback(() => (hasFile ? onPlay(episode.id) : onInfo(episode.id)), [episode.id, hasFile, onInfo, onPlay]);
    const info = useCallback(() => onInfo(episode.id), [episode.id, onInfo]);
    const infoRef = useCallback((view: TvViewInstance | null) => registerInfo(episode.id, view), [episode.id, registerInfo]);
    const meta = [durationText, watchedText, qualitiesText].filter((part): part is string => Boolean(part));
    const testKey = `${episode.seasonNumber}-${episode.episodeNumber}`;
    return (
      <View style={styles.row}>
        <TvFocusable
          ref={rowRef}
          style={styles.episode}
          focusedStyle={styles.focused}
          scale={1.02}
          onPress={play}
          testID={`tv-details-episode-${testKey}`}
          accessibilityLabel={[`${episode.episodeNumber} ${episode.name}`, durationText, watchedText, qualitiesText].filter(Boolean).join(", ")}
        >
          <View style={[styles.still, !hasFile && UNAVAILABLE_LOOK]} testID={`tv-details-episode-still-${testKey}`}>
            <MediaArtwork path={episode.stillPath} kind="still" style={styles.stillImage} />
            {progressPct > 0 ? (
              <View style={styles.bar}>
                <View style={[styles.barFill, { width: `${Math.min(100, progressPct)}%` }]} />
              </View>
            ) : null}
          </View>
          <View style={[styles.text, !hasFile && UNAVAILABLE_LOOK]} testID={`tv-details-episode-text-${testKey}`}>
            <Text style={styles.title} numberOfLines={1}>
              <Text style={styles.number}>{`${episode.episodeNumber}  `}</Text>
              {episode.name}
            </Text>
            {episode.overview ? (
              <Text style={styles.synopsis} numberOfLines={2}>
                {episode.overview}
              </Text>
            ) : null}
            <Text style={styles.meta} numberOfLines={1} testID={`tv-details-episode-meta-${testKey}`}>
              {meta.map((part, index) => (
                <Text key={part} style={watched && part === watchedText ? styles.watched : undefined}>
                  {index > 0 ? ` · ${part}` : part}
                </Text>
              ))}
            </Text>
          </View>
        </TvFocusable>
        <TvFocusable
          ref={infoRef}
          style={styles.info}
          focusedStyle={styles.focused}
          scale={1.05}
          onPress={info}
          testID={`tv-details-episode-info-${testKey}`}
          accessibilityLabel={infoLabel}
        >
          <Text style={[styles.infoGlyph, !hasFile && UNAVAILABLE_LOOK]}>ⓘ</Text>
        </TvFocusable>
      </View>
    );
  },
);
TvEpisodeRow.displayName = "TvEpisodeRow";

/** Sizes in design dp (scaled with the TV, UX-TV-13). */
const baseStyles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  episode: { flex: 1, flexDirection: "row", alignItems: "center", gap: 16, padding: 8, borderRadius: TV_RADIUS.button },
  focused: { borderColor: theme.colors.text },
  still: { width: 160, height: 90, borderRadius: 5, overflow: "hidden", backgroundColor: theme.colors.surfaceRaised },
  stillImage: { width: "100%", height: "100%" },
  bar: { position: "absolute", left: 0, right: 0, bottom: 0, height: 4, backgroundColor: "rgba(0, 0, 0, 0.5)" },
  barFill: { height: "100%", backgroundColor: theme.colors.accent },
  text: { flex: 1, gap: 4 },
  title: { fontSize: 16, fontWeight: "700", color: theme.colors.text },
  number: { color: theme.colors.textDim, fontWeight: "600" },
  synopsis: { fontSize: 13, lineHeight: 18, color: theme.colors.textMuted },
  meta: { fontSize: 12, color: theme.colors.textDim },
  watched: { color: theme.colors.success },
  info: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: TV_RADIUS.button,
    backgroundColor: theme.colors.surfaceRaised,
  },
  infoGlyph: { fontSize: 18, color: theme.colors.textMuted },
});
