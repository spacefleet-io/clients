import { useState } from "react";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { ParrotCoverKeys, TrackRow } from "@space/parrot-core";
import { useTranslation } from "@space/mobile-shell/i18n";
import { scopeLogger } from "@space/mobile-shell/logger";
import type { AudioQueueInsert } from "@space/mobile-audio-playback";
import { nowPlayingTitles } from "../lib/nowPlaying";
import { playTracks, queueTracks } from "../lib/playback";
import { useSignedIn } from "./session";
import type { RootStack } from "../screens/routes";

const log = scopeLogger("play");

type PlayTrack = TrackRow & { albumTitle?: string } & Partial<ParrotCoverKeys>;

/** The songs as queued, each with its cover, and their titles kept so the bar, the player and the library name them. */
const register = (tracks: PlayTrack[], album?: { title: string; cover?: ParrotCoverKeys | null }) => {
  const queued = tracks.map((track) => ({
    ...track,
    cover:
      track.coverObjectKey !== undefined
        ? { coverObjectKey: track.coverObjectKey ?? null, coverThumbObjectKey: track.coverThumbObjectKey ?? null }
        : (album?.cover ?? null),
  }));
  for (const track of queued) {
    nowPlayingTitles.set(track.id, {
      title: track.title,
      artist: track.artistName,
      album: track.albumTitle ?? album?.title ?? "",
      albumId: track.albumId,
      artistId: track.artistId || undefined,
      cover: track.cover,
      durationMs: track.durationMs,
    });
  }
  return queued;
};

/**
 * Plays a list of songs from one of them on, then opens the player: an album's songs (`album` given, with its cover
 * for the mini player and the player) or the library's songs (each with its own `albumTitle`). `starting` is the song
 * being started, `error` why it failed. The phone's player is the navigator's "Player" screen.
 */
export const usePlay = () => {
  const navigation = useNavigation<NativeStackNavigationProp<RootStack>>();
  return usePlayWith(() => navigation.navigate("Player"));
};

/** `usePlay` with the app's own way to open the player: the TV opens its Now playing page, with no navigator (PAR-TV-07). */
export const usePlayWith = (openPlayer: () => void) => {
  const { t } = useTranslation();
  const { token, libraryKey } = useSignedIn();
  const [starting, setStarting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const play = async (
    tracks: PlayTrack[],
    index: number,
    album?: { title: string; cover?: ParrotCoverKeys | null },
    options: { startPositionMs?: number; shuffle?: boolean; openPlayer?: boolean } = {}
  ) => {
    setError(null);
    setStarting(tracks[index].id);
    try {
      const queued = register(tracks, album);
      await playTracks({ token, libraryKey, albumTitle: album?.title, tracks: queued, startIndex: index, ...options });
      if (options.openPlayer !== false) openPlayer();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Cancel at "Already playing on {device}. Play here instead?" (ACCT-STREAM-02): the music stays as it was.
      if (message === "STREAM_CANCELLED") return log.info("play.stream_cancelled", {});
      log.warn("play.start_failed", { message });
      setError(message === "NO_PLAYABLE_FILE" ? t("parrot.album.noPlayableFile") : t("parrot.album.playFailed", { error: message }));
    } finally {
      setStarting(null);
    }
  };

  /**
   * Play next ("next") or Add to queue ("end", PAR-CARD-01): adds the songs without stopping the one playing and
   * without opening the player; an empty queue starts playing them. Resolves to how many songs were added (0: all were
   * playing or up next already, PAR-CARD-02), null when nothing could be queued.
   */
  const queue = async (tracks: PlayTrack[], where: AudioQueueInsert, album?: { title: string; cover?: ParrotCoverKeys | null }): Promise<number | null> => {
    setError(null);
    try {
      const queued = register(tracks, album);
      return await queueTracks({ token, libraryKey, albumTitle: album?.title, tracks: queued, where });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "STREAM_CANCELLED") {
        log.info("play.stream_cancelled", { where });
        return null;
      }
      log.warn("play.queue_failed", { message, where });
      setError(message === "NO_PLAYABLE_FILE" ? t("parrot.album.noPlayableFile") : t("parrot.album.playFailed", { error: message }));
      return null;
    }
  };

  return { play, queue, starting, error };
};
