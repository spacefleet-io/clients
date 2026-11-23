import React, { memo, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, BackHandler, StyleSheet, Text, View } from "react-native";
import { Check } from "lucide-react-native";
import { getCurrentLanguage } from "@space/mobile-shell/i18n";
import type { MediaDetails } from "@space/shared/libraryTypes";
import { subtitleFetchCopy, type FetchedSubtitleTrack as LibraryFetchedSubtitleTrack } from "@space/shared/subtitleFetch";
import { subtitleVersionLine, tryAnotherSubtitleVersion, type SubtitleVersionStep } from "@space/shared/subtitleFetchFlow";
import { SubtitlePanelButton, subtitlePanelStyles } from "../../components/SubtitleFetchPanel";
import { useLibraryActions } from "../../store/library";
import { metadataClient } from "../../lib/metadata/runtime";
import { useNetworkOnline } from "../../lib/networkListener";
import { subtitleTryAnotherPhoneInput, type FetchedSubtitleTrack } from "../../lib/subtitleFetchStore";
import { theme } from "../../theme/theme";
import { PLAYER_SUBTITLE_ADDED_MS } from "./PlayerSubtitleFetch";

/**
 * "Try another version" inside the phone and TV player (PLAY-SUBGET-07): over the paused video, the shared
 * `tryAnotherSubtitleVersion` looks the subtitles up again and puts the next-best file of the same entry in place of
 * `track`, one line per step. `onClose` gets the new track once it is in the library (the player swaps it in and turns
 * it on), or null when nothing changed: Back before the save, none left, unavailable, failed, offline.
 */
export const PlayerSubtitleVersion = memo(
  ({
    mediaId,
    episodeId,
    track,
    onClose,
  }: {
    mediaId: string;
    episodeId: string | null;
    track: LibraryFetchedSubtitleTrack;
    onClose: (replacement: FetchedSubtitleTrack | null) => void;
  }) => {
    const online = useNetworkOnline();
    const { getMediaDetails, uploadSubtitleContent, addSubtitleTrack, removeSubtitleTrack, subtitleObjectInUse, deleteStoredObjects, setTrackPrefs } =
      useLibraryActions();
    const [media, setMedia] = useState<MediaDetails | null>(null);
    const [step, setStep] = useState<SubtitleVersionStep>("looking");
    /** Set once the new track is in the library (the replacement can no longer be abandoned). */
    const stored = useRef<FetchedSubtitleTrack | null>(null);
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;
    const copy = subtitleFetchCopy(getCurrentLanguage());

    useEffect(() => {
      let cancelled = false;
      void getMediaDetails(mediaId, { chunks: false }).then((data) => {
        if (cancelled) return;
        console.info(
          "subtitle_version.player.open",
          JSON.stringify({ mediaId, episodeId, trackId: track.id, language: track.language, found: Boolean(data), online }),
        );
        if (data) setMedia(data);
        else onCloseRef.current(null);
      });
      return () => {
        cancelled = true;
      };
      // Read once per open; `online` is only logged.
    }, [mediaId, episodeId, track.id]);

    const input = useMemo(
      () =>
        media
          ? subtitleTryAnotherPhoneInput({
              media,
              episodeId,
              uiLanguage: getCurrentLanguage(),
              track,
              client: metadataClient,
              actions: { uploadSubtitleContent, addSubtitleTrack, removeSubtitleTrack, subtitleObjectInUse, deleteStoredObjects, setTrackPrefs },
              onTrackAdded: (added) => {
                stored.current = added;
              },
            })
          : null,
      [addSubtitleTrack, deleteStoredObjects, episodeId, media, removeSubtitleTrack, setTrackPrefs, subtitleObjectInUse, track, uploadSubtitleContent],
    );

    // A title without a catalog id has nothing to search by: the line says so (the row is only offered with one).
    useEffect(() => {
      if (media && !input) {
        console.warn("subtitle_version.player.no_target", JSON.stringify({ mediaId, episodeId }));
        setStep("unavailable");
      }
    }, [episodeId, input, media, mediaId]);

    // One run per open; Back (or leaving the player) aborts it.
    const controller = useRef<AbortController | null>(null);
    useEffect(() => {
      if (!input || !online) return;
      const abort = new AbortController();
      controller.current = abort;
      const startedAt = Date.now();
      void tryAnotherSubtitleVersion(
        input,
        (next) => {
          console.info("subtitle_version.player.step", JSON.stringify({ trackId: track.id, step: next, ms: Date.now() - startedAt }));
          setStep(next);
        },
        abort.signal,
      ).then((outcome) => {
        console.info(
          "subtitle_version.player.done",
          JSON.stringify({ trackId: track.id, outcome, newTrackId: stored.current?.id ?? null, ms: Date.now() - startedAt }),
        );
      });
      return () => abort.abort();
      // `online` going away mid-way lets the run end by itself (unavailable / failed).
    }, [input]);

    // The new subtitle is on: the line stays a moment, then playback resumes (as "added" in Get subtitles).
    useEffect(() => {
      if (step !== "replaced") return;
      const timer = setTimeout(() => onCloseRef.current(stored.current), PLAYER_SUBTITLE_ADDED_MS);
      return () => clearTimeout(timer);
    }, [step]);

    // Android Back / the TV remote's Back cancels (nothing changed unless the new track is already saved) and resumes,
    // before it can close the player: the later listener runs first.
    useEffect(() => {
      const sub = BackHandler.addEventListener("hardwareBackPress", () => {
        console.info("subtitle_version.player.back", JSON.stringify({ trackId: track.id, replaced: Boolean(stored.current) }));
        controller.current?.abort();
        onCloseRef.current(stored.current);
        return true;
      });
      return () => sub.remove();
    }, [track.id]);

    const close = () => {
      console.info("subtitle_version.player.close", JSON.stringify({ trackId: track.id, step, replaced: Boolean(stored.current) }));
      controller.current?.abort();
      onCloseRef.current(stored.current);
    };

    // Still running: a spinner and no button (Back cancels).
    const running = online && (step === "looking" || step === "downloading" || step === "saving");
    const line = online ? subtitleVersionLine(copy, step, track.label) : copy.offline;
    return (
      <View testID="player-subtitle-version" style={styles.backdrop}>
        <View style={styles.card}>
          <View style={subtitlePanelStyles.panel}>
            <Text style={subtitlePanelStyles.title} accessibilityRole="header">
              {copy.tryAnother}
            </Text>
            <View style={subtitlePanelStyles.busy} accessibilityLiveRegion="polite">
              {running || (online && !media) ? <ActivityIndicator color={theme.colors.accent} /> : null}
              {step === "replaced" ? <Check size={20} color={theme.colors.accent} /> : null}
              <Text testID="player-subtitle-version-line" style={subtitlePanelStyles.text}>
                {line}
              </Text>
            </View>
            {running || step === "replaced" ? null : (
              <SubtitlePanelButton
                testID="player-subtitle-version-close"
                style={subtitlePanelStyles.secondary}
                onPress={close}
                accessibilityRole="button"
                preferFocus
              >
                <Text style={subtitlePanelStyles.secondaryText}>{copy.back}</Text>
              </SubtitlePanelButton>
            )}
          </View>
        </View>
      </View>
    );
  },
);
PlayerSubtitleVersion.displayName = "PlayerSubtitleVersion";

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "rgba(0,0,0,0.6)",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  card: {
    width: "100%",
    maxWidth: 480,
    maxHeight: "90%",
    backgroundColor: theme.colors.surfaceRaised,
    borderRadius: 16,
    padding: 18,
  },
});
