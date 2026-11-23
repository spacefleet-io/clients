import React, { memo, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, BackHandler, StyleSheet, View } from "react-native";
import { getCurrentLanguage } from "@space/mobile-shell/i18n";
import type { MediaDetails } from "@space/shared/libraryTypes";
import { SubtitleFetchPanel } from "../../components/SubtitleFetchPanel";
import { useLibraryActions } from "../../store/library";
import { metadataClient } from "../../lib/metadata/runtime";
import { useNetworkOnline } from "../../lib/networkListener";
import { subtitleFetchPhoneInput, type FetchedSubtitleTrack } from "../../lib/subtitleFetchStore";
import { theme } from "../../theme/theme";

/** How long the "added" panel stays before playback resumes (PLAY-SUBGET-02, same as the computer app). */
export const PLAYER_SUBTITLE_ADDED_MS = 1500;

/**
 * "Get more subtitles…" inside the phone player (PLAY-SUBGET-02): the shared flow drawn over the paused video. The title
 * is read again on open, so a subtitle fetched earlier in this playback is listed as already there (PLAY-SUBGET-18).
 * `onClose` gets the stored track, or null when the user left (Back, or the panel's Back) before the track reached the
 * library: nothing is switched on then. Back on the "added" panel skips the wait, like Escape on the computer.
 */
export const PlayerSubtitleFetch = memo(
  ({ mediaId, episodeId, onClose }: { mediaId: string; episodeId: string | null; onClose: (added: FetchedSubtitleTrack | null) => void }) => {
    const online = useNetworkOnline();
    const { getMediaDetails, uploadSubtitleContent, addSubtitleTrack, setTrackPrefs } = useLibraryActions();
    const [media, setMedia] = useState<MediaDetails | null>(null);
    /** Set once the track is in the library (the save can no longer be abandoned); switched on when the panel closes. */
    const stored = useRef<FetchedSubtitleTrack | null>(null);
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;

    useEffect(() => {
      let cancelled = false;
      void getMediaDetails(mediaId, { chunks: false }).then((data) => {
        if (cancelled) return;
        console.info("subtitle_fetch.player.open", JSON.stringify({ mediaId, episodeId, found: Boolean(data), online }));
        if (data) setMedia(data);
        else onCloseRef.current(null);
      });
      return () => {
        cancelled = true;
      };
      // Read once per open; `online` is only logged.
    }, [mediaId, episodeId]);

    // Android Back closes the panel (and resumes) before it can close the player: the later listener runs first.
    useEffect(() => {
      const sub = BackHandler.addEventListener("hardwareBackPress", () => {
        console.info("subtitle_fetch.player.back", JSON.stringify({ added: Boolean(stored.current) }));
        onCloseRef.current(stored.current);
        return true;
      });
      return () => sub.remove();
    }, []);

    const input = useMemo(
      () =>
        media
          ? subtitleFetchPhoneInput({
              media,
              episodeId,
              uiLanguage: getCurrentLanguage(),
              client: metadataClient,
              actions: { uploadSubtitleContent, addSubtitleTrack, setTrackPrefs },
              onTrackAdded: (track) => {
                stored.current = track;
              },
            })
          : null,
      [addSubtitleTrack, episodeId, media, setTrackPrefs, uploadSubtitleContent],
    );

    return (
      <View testID="player-subtitle-fetch" style={styles.backdrop}>
        <View style={styles.card}>
          {input ? (
            <SubtitleFetchPanel
              input={input}
              offline={!online}
              autoCloseAfterAddedMs={PLAYER_SUBTITLE_ADDED_MS}
              onClose={() => onCloseRef.current(stored.current)}
            />
          ) : (
            <ActivityIndicator color={theme.colors.text} />
          )}
        </View>
      </View>
    );
  },
);
PlayerSubtitleFetch.displayName = "PlayerSubtitleFetch";

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
