import React, { useEffect } from "react";
import { BackHandler, ScrollView, StyleSheet, Text, TVFocusGuideView, View } from "react-native";
import { Play } from "lucide-react-native";
import { useTranslation } from "@space/mobile-shell/i18n";
import type { MediaEpisode } from "@space/shared/libraryTypes";
import { MediaArtwork } from "../../../components/MediaArtwork";
import { theme } from "../../../theme/theme";
import type { MediaTracksBlock } from "../../lib/detailsMedia";
import { TV_PANEL_BORDER, TV_RADIUS } from "../../lib/tvLook";
import { useTvScale, useTvStyles } from "../../lib/tvScale";
import { TvFocusable } from "../TvFocusable";
import { TvMediaTracksBlock } from "./TvMediaTracksBlock";

type Props = {
  episode: MediaEpisode;
  block: MediaTracksBlock | null;
  /** "52 min · aired 12 Mar 2022", or null. */
  metaText: string | null;
  /** Resume when the episode has a resume point, else Play; the player asks "Resume at …" / "Start over" either way. */
  resumable: boolean;
  /** False for an episode with no file in the library: no Play, a Close button instead (UX-TV-08). */
  hasFile: boolean;
  onPlay: (episodeId: string) => void;
  onClose: () => void;
};

/**
 * An episode's side panel (UX-TV-07): its still, "S1 · E3 · Title", length and air date, synopsis, its own Play or
 * Resume button, and its own qualities and tracks. A square panel at the right; the focus stays inside it and Back
 * closes it (the screen then gives the focus back to the episode's ⓘ button). An episode with no file has nothing to
 * play, so its panel offers Close in place of Play, which keeps a focus target inside the panel.
 */
export const TvEpisodePanel = ({ episode, block, metaText, resumable, hasFile, onPlay, onClose }: Props) => {
  const { t } = useTranslation();
  const scale = useTvScale();
  const styles = useTvStyles(baseStyles);

  useEffect(() => {
    console.info("tv.details.episodePanel.open", JSON.stringify({ episodeId: episode.id, hasMedia: block !== null, hasFile }));
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      console.info("tv.details.episodePanel.back", JSON.stringify({ episodeId: episode.id }));
      onClose();
      return true;
    });
    return () => subscription.remove();
  }, [block, episode.id, hasFile, onClose]);

  const playLabel = resumable ? t("tvShell.details.resume") : t("details.play");
  return (
    <View style={styles.layer} testID="tv-details-episode-panel">
      <TVFocusGuideView style={styles.panel} autoFocus trapFocusUp trapFocusDown trapFocusLeft trapFocusRight>
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <View style={styles.still}>
            <MediaArtwork path={episode.stillPath} kind="still" style={styles.stillImage} />
          </View>
          <Text style={styles.heading} accessibilityRole="header">
            {t("tvShell.details.episodeHeading", { season: episode.seasonNumber, episode: episode.episodeNumber, name: episode.name })}
          </Text>
          {metaText ? <Text style={styles.meta}>{metaText}</Text> : null}
          {episode.overview ? <Text style={styles.synopsis}>{episode.overview}</Text> : null}
          {hasFile ? (
            <TvFocusable
              style={styles.play}
              focusedStyle={styles.playFocused}
              hasTVPreferredFocus
              onPress={() => onPlay(episode.id)}
              testID="tv-details-episode-panel-play"
              accessibilityLabel={playLabel}
            >
              <Play size={16 * scale} color={theme.colors.bg} fill={theme.colors.bg} />
              <Text style={styles.playLabel}>{playLabel}</Text>
            </TvFocusable>
          ) : (
            <TvFocusable
              style={styles.close}
              focusedStyle={styles.playFocused}
              hasTVPreferredFocus
              onPress={onClose}
              testID="tv-details-episode-panel-close"
              accessibilityLabel={t("tvShell.details.close")}
            >
              <Text style={styles.closeLabel}>{t("tvShell.details.close")}</Text>
            </TvFocusable>
          )}
          <Text style={styles.section}>{t("tvShell.details.tabs.tracks")}</Text>
          <TvMediaTracksBlock block={block} compact testID="tv-details-episode-panel-tracks" />
        </ScrollView>
      </TVFocusGuideView>
    </View>
  );
};

/** Sizes in design dp (scaled with the TV, UX-TV-13). */
const baseStyles = StyleSheet.create({
  layer: { ...StyleSheet.absoluteFill, backgroundColor: "rgba(0, 0, 0, 0.6)" },
  panel: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    width: 470,
    borderRadius: TV_RADIUS.panel,
    backgroundColor: "rgba(27, 29, 43, 0.97)",
    borderLeftWidth: 1,
    borderLeftColor: TV_PANEL_BORDER,
  },
  content: { paddingHorizontal: 28, paddingVertical: 26, gap: 8 },
  still: { height: 110, borderRadius: TV_RADIUS.picture, overflow: "hidden", backgroundColor: theme.colors.surfaceRaised },
  stillImage: { width: "100%", height: "100%" },
  heading: { marginTop: 6, fontSize: 20, fontWeight: "700", color: theme.colors.text, fontFamily: theme.font.family.display },
  meta: { fontSize: 12, color: theme.colors.textDim },
  synopsis: { fontSize: 13, lineHeight: 20, color: theme.colors.textMuted },
  play: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    height: 38,
    paddingHorizontal: 22,
    marginTop: 4,
    borderRadius: TV_RADIUS.pill,
    backgroundColor: theme.colors.accent,
  },
  playFocused: { borderColor: theme.colors.text },
  playLabel: { fontSize: 15, fontWeight: "800", color: theme.colors.bg },
  close: {
    alignSelf: "flex-start",
    justifyContent: "center",
    height: 38,
    paddingHorizontal: 22,
    marginTop: 4,
    borderRadius: TV_RADIUS.button,
    backgroundColor: theme.colors.surfaceRaised,
  },
  closeLabel: { fontSize: 15, fontWeight: "700", color: theme.colors.text },
  section: {
    marginTop: 12,
    fontSize: 11,
    letterSpacing: 2.2,
    textTransform: "uppercase",
    fontWeight: "800",
    color: theme.colors.textDim,
  },
});
