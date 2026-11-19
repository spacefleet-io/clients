import React, { memo, useEffect, useRef, useState } from "react";
import { ActivityIndicator, BackHandler, StyleSheet, Text, View } from "react-native";
import { Check } from "lucide-react-native";
import { getCurrentLanguage } from "@space/mobile-shell/i18n";
import { fillSubtitleFetchCopy, subtitleFetchCopy, UnreadableSubtitleFileError } from "@space/shared/subtitleFetch";
import { SubtitlePanelButton, subtitlePanelStyles } from "../../components/SubtitleFetchPanel";
import { useLibraryActions } from "../../store/library";
import { pickSubtitleFile } from "../../lib/pickSubtitleFile";
import { storeSubtitleFilePhone, type FetchedSubtitleTrack } from "../../lib/subtitleFetchStore";
import { theme } from "../../theme/theme";
import { PLAYER_SUBTITLE_ADDED_MS } from "./PlayerSubtitleFetch";

type SubtitleFileStep = "picking" | "adding" | "added" | "unreadable" | "failed";

/**
 * "Add a subtitle file…" inside the phone player (PLAY-SUBGET-23, never on TV): the system's file picker, then the file
 * stored in the vault like a fetched subtitle (source "added-file") with one line over the paused video. `onClose` gets
 * the stored track (the player adds it to the menu and turns it on at once, like a fetched one), or null when nothing
 * was added: cancelled, unreadable ("This file isn't a subtitle we can read", nothing saved) or failed.
 */
export const PlayerSubtitleFile = memo(
  ({
    mediaId,
    episodeId,
    onClose,
    pickFile = pickSubtitleFile,
  }: {
    mediaId: string;
    episodeId: string | null;
    onClose: (added: FetchedSubtitleTrack | null) => void;
    /** The document picker; tests pass their own. */
    pickFile?: () => Promise<{ name: string; content: string } | null>;
  }) => {
    const { getMediaDetails, uploadSubtitleContent, addSubtitleTrack, setTrackPrefs } = useLibraryActions();
    const [step, setStep] = useState<SubtitleFileStep>("picking");
    const [name, setName] = useState("");
    /** Set once the track is in the library. */
    const stored = useRef<FetchedSubtitleTrack | null>(null);
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;
    const copy = subtitleFetchCopy(getCurrentLanguage());

    // One pick per open. Leaving (Back) mid-way only stops the line: a save under way still lands in the library.
    useEffect(() => {
      let left = false;
      const startedAt = Date.now();
      void (async () => {
        try {
          const file = await pickFile();
          if (left) return;
          if (!file) {
            console.info("subtitle_file.player.cancelled", JSON.stringify({ mediaId, episodeId }));
            onCloseRef.current(null);
            return;
          }
          setStep("adding");
          const media = await getMediaDetails(mediaId, { chunks: false });
          if (!media) throw new Error("media_not_found");
          const added = await storeSubtitleFilePhone(file, {
            media,
            episodeId,
            uiLanguage: getCurrentLanguage(),
            actions: { uploadSubtitleContent, addSubtitleTrack, setTrackPrefs },
            onTrackAdded: (track) => {
              stored.current = track;
            },
          });
          console.info(
            "subtitle_file.player.added",
            JSON.stringify({ mediaId, episodeId, language: added.language, format: added.format, id: stored.current?.id ?? null, ms: Date.now() - startedAt }),
          );
          if (left) return;
          setName(added.label);
          setStep("added");
        } catch (error) {
          const unreadable = error instanceof UnreadableSubtitleFileError;
          console.warn("subtitle_file.player.failed", JSON.stringify({ mediaId, episodeId, unreadable, error: String(error), ms: Date.now() - startedAt }));
          if (!left) setStep(unreadable ? "unreadable" : "failed");
        }
      })();
      return () => {
        left = true;
      };
      // One pick per open.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mediaId, episodeId]);

    // The new subtitle is on: the line stays a moment, then playback resumes (as "added" in Get subtitles).
    useEffect(() => {
      if (step !== "added") return;
      const timer = setTimeout(() => onCloseRef.current(stored.current), PLAYER_SUBTITLE_ADDED_MS);
      return () => clearTimeout(timer);
    }, [step]);

    // Android Back closes the line (and resumes) before it can close the player: the later listener runs first.
    useEffect(() => {
      const sub = BackHandler.addEventListener("hardwareBackPress", () => {
        console.info("subtitle_file.player.back", JSON.stringify({ added: Boolean(stored.current) }));
        onCloseRef.current(stored.current);
        return true;
      });
      return () => sub.remove();
    }, []);

    // The system picker is on top: nothing to draw under it.
    if (step === "picking") return null;
    const line =
      step === "adding"
        ? copy.addingFile
        : step === "added"
          ? fillSubtitleFetchCopy(copy.added, { name })
          : step === "unreadable"
            ? copy.unreadableFile
            : copy.fileFailed;
    return (
      <View testID="player-subtitle-file" style={styles.backdrop}>
        <View style={styles.card}>
          <View style={subtitlePanelStyles.panel}>
            <Text style={subtitlePanelStyles.title} accessibilityRole="header">
              {copy.addFile}
            </Text>
            <View style={subtitlePanelStyles.busy} accessibilityLiveRegion="polite">
              {step === "adding" ? <ActivityIndicator color={theme.colors.accent} /> : null}
              {step === "added" ? <Check size={20} color={theme.colors.accent} /> : null}
              <Text
                testID={`player-subtitle-file-${step}`}
                style={step === "unreadable" || step === "failed" ? subtitlePanelStyles.error : subtitlePanelStyles.text}
                accessibilityRole={step === "unreadable" || step === "failed" ? "alert" : undefined}
              >
                {line}
              </Text>
            </View>
            {step === "unreadable" || step === "failed" ? (
              <SubtitlePanelButton
                testID="player-subtitle-file-close"
                style={subtitlePanelStyles.secondary}
                onPress={() => onCloseRef.current(stored.current)}
                accessibilityRole="button"
              >
                <Text style={subtitlePanelStyles.secondaryText}>{copy.back}</Text>
              </SubtitlePanelButton>
            ) : null}
          </View>
        </View>
      </View>
    );
  },
);
PlayerSubtitleFile.displayName = "PlayerSubtitleFile";

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
