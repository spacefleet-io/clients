import React, { memo, useCallback, useState } from "react";
import { ScrollView, StyleSheet, Text, TVFocusGuideView, View } from "react-native";
import { focusDestination, type TvViewInstance } from "../../lib/tvViewInstance";
import { useTranslation } from "@space/mobile-shell/i18n";
import type { MediaEpisode, MediaSeason } from "@space/shared/libraryTypes";
import { episodeFileKey } from "../../../lib/playback/episodeSelection";
import { COMPLETED_PCT_THRESHOLD, type EpisodeResume } from "@space/shared/playbackResume";
import { MediaArtwork } from "../../../components/MediaArtwork";
import { theme } from "../../../theme/theme";
import { qualitiesLine, type MediaTracksBlock } from "../../lib/detailsMedia";
import { UNAVAILABLE_LOOK } from "@space/mobile-shell/theme";
import { TV_RADIUS } from "../../lib/tvLook";
import { useTvStyles } from "../../lib/tvScale";
import { TvFocusable } from "../TvFocusable";
import { TvEpisodeRow } from "./TvEpisodeRow";

type Props = {
  /** Every season the show has, with or without files (UX-TV-08). */
  seasons: readonly MediaSeason[];
  /** Seasons with at least one episode file; the others are greyed out. */
  seasonsWithFiles: ReadonlySet<number>;
  activeSeason: number;
  onSeason: (seasonNumber: number) => void;
  /** The episodes of the active season. */
  episodes: readonly MediaEpisode[];
  episodeKeys: ReadonlySet<string>;
  resume: Readonly<Record<string, EpisodeResume>>;
  blocks: ReadonlyMap<string, MediaTracksBlock>;
  onPlay: (episodeId: string) => void;
  onInfo: (episodeId: string) => void;
  registerInfo: (episodeId: string, view: TvViewInstance | null) => void;
  /** Receives the first focus target (the active season, else the first row): the target of DOWN from the tabs. */
  firstRef: (view: TvViewInstance | null) => void;
};

/**
 * Episodes tab of a show (UX-TV-06, UX-TV-07, UX-TV-08), the desktop's seasons-then-episodes menus on one screen: a row
 * of season cards, then the selected season's episode rows with their own qualities. A season opens as soon as the
 * highlight lands on it. Seasons and episodes with no file in the library stay reachable but are greyed out, as on desktop.
 */
export const TvDetailsEpisodes = memo(
  ({
    seasons,
    seasonsWithFiles,
    activeSeason,
    onSeason,
    episodes,
    episodeKeys,
    resume,
    blocks,
    onPlay,
    onInfo,
    registerInfo,
    firstRef,
  }: Props) => {
    const { t } = useTranslation();
    const styles = useTvStyles(baseStyles);
    const menu = seasons.length > 0;
    // UP from the episodes lands on the selected season; DOWN from the seasons on the season's first episode.
    const [activeSeasonView, setActiveSeasonView] = useState<TvViewInstance | null>(null);
    const [firstEpisodeView, setFirstEpisodeView] = useState<TvViewInstance | null>(null);
    const activeSeasonRef = useCallback(
      (view: TvViewInstance | null) => {
        firstRef(view);
        setActiveSeasonView(view);
      },
      [firstRef],
    );
    const firstEpisodeRef = useCallback(
      (view: TvViewInstance | null) => {
        if (!menu) firstRef(view);
        setFirstEpisodeView(view);
      },
      [firstRef, menu],
    );
    return (
      <View style={styles.list} testID="tv-details-episodes">
        {menu ? (
          <TVFocusGuideView destinations={focusDestination(activeSeasonView)} testID="tv-details-seasons">
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.seasons}>
              {seasons.map((season) => (
                <TvSeasonCard
                  key={season.id}
                  season={season}
                  available={seasonsWithFiles.has(season.seasonNumber)}
                  selected={season.seasonNumber === activeSeason}
                  episodeCountText={t("tvShell.details.seasonEpisodes", { count: season.episodeCount })}
                  statusText={
                    seasonsWithFiles.has(season.seasonNumber) ? t("tvShell.details.seasonAvailable") : t("tvShell.details.seasonMissing")
                  }
                  onSeason={onSeason}
                  cardRef={season.seasonNumber === activeSeason ? activeSeasonRef : undefined}
                />
              ))}
            </ScrollView>
          </TVFocusGuideView>
        ) : null}
        <TVFocusGuideView
          style={styles.list}
          destinations={focusDestination(firstEpisodeView)}
          testID={`tv-details-season-episodes-${activeSeason}`}
        >
          {episodes.map((episode, index) => {
            const block = blocks.get(episode.id) ?? null;
            const progress = Math.round(resume[episode.id]?.progressPct ?? 0);
            const watched = progress >= COMPLETED_PCT_THRESHOLD;
            const minutes = block?.durationSeconds ? Math.max(1, Math.round(block.durationSeconds / 60)) : null;
            return (
              <TvEpisodeRow
                key={episode.id}
                episode={episode}
                hasFile={episodeKeys.has(episodeFileKey(episode.seasonNumber, episode.episodeNumber))}
                progressPct={progress}
                durationText={minutes !== null ? t("tvShell.details.runtimeMinutes", { minutes }) : null}
                watchedText={watched ? t("tvShell.details.watched") : progress > 0 ? t("details.watchedPercent", { percent: progress }) : null}
                watched={watched}
                qualitiesText={block && block.qualities.length > 0 ? qualitiesLine(block) : null}
                infoLabel={t("tvShell.details.episodeInfo", { number: episode.episodeNumber, name: episode.name })}
                onPlay={onPlay}
                onInfo={onInfo}
                registerInfo={registerInfo}
                rowRef={index === 0 ? firstEpisodeRef : undefined}
              />
            );
          })}
        </TVFocusGuideView>
      </View>
    );
  },
);
TvDetailsEpisodes.displayName = "TvDetailsEpisodes";

type SeasonCardProps = {
  season: MediaSeason;
  available: boolean;
  selected: boolean;
  episodeCountText: string;
  statusText: string;
  onSeason: (seasonNumber: number) => void;
  cardRef?: (view: TvViewInstance | null) => void;
};

/** One season of the menu, like the desktop's season card: poster, name, episode count, "Available" or "Missing files". */
const TvSeasonCard = memo(({ season, available, selected, episodeCountText, statusText, onSeason, cardRef }: SeasonCardProps) => {
  const styles = useTvStyles(baseStyles);
  const open = useCallback(() => onSeason(season.seasonNumber), [onSeason, season.seasonNumber]);
  return (
    <TvFocusable
      ref={cardRef}
      style={[styles.season, selected && styles.seasonSelected]}
      focusedStyle={styles.focused}
      scale={1.04}
      onFocus={open}
      onPress={open}
      accessibilityState={{ selected }}
      accessibilityLabel={[season.name, episodeCountText, statusText].join(", ")}
      testID={`tv-details-season-${season.seasonNumber}`}
    >
      <View style={[styles.seasonContent, !available && UNAVAILABLE_LOOK]} testID={`tv-details-season-content-${season.seasonNumber}`}>
        <View style={styles.seasonPoster}>
          <MediaArtwork path={season.posterPath} kind="poster" style={styles.seasonPosterImage} label={season.name} />
        </View>
        <View style={styles.seasonText}>
          <Text style={[styles.seasonName, selected && styles.seasonNameSelected]} numberOfLines={1}>
            {season.name}
          </Text>
          <Text style={styles.seasonMeta} numberOfLines={1}>
            {episodeCountText}
          </Text>
          <Text style={styles.seasonMeta} numberOfLines={1}>
            {statusText}
          </Text>
        </View>
      </View>
    </TvFocusable>
  );
});
TvSeasonCard.displayName = "TvSeasonCard";

/** Sizes in design dp (scaled with the TV, UX-TV-13). */
const baseStyles = StyleSheet.create({
  list: { gap: 4 },
  seasons: { flexDirection: "row", gap: 10, paddingVertical: 6, paddingHorizontal: 4, marginBottom: 6 },
  season: { width: 196, padding: 6, borderRadius: TV_RADIUS.button, backgroundColor: theme.colors.surfaceRaised },
  seasonSelected: { backgroundColor: `${theme.colors.accent}22` },
  focused: { borderColor: theme.colors.text },
  seasonContent: { flexDirection: "row", alignItems: "center", gap: 10 },
  seasonPoster: { width: 40, height: 60, borderRadius: TV_RADIUS.picture, overflow: "hidden", backgroundColor: theme.colors.surface },
  seasonPosterImage: { width: "100%", height: "100%" },
  seasonText: { flex: 1, gap: 2 },
  seasonName: { fontSize: 14, fontWeight: "700", color: theme.colors.text },
  seasonNameSelected: { color: theme.colors.accent },
  seasonMeta: { fontSize: 12, color: theme.colors.textMuted },
});
