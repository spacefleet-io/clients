import { useEffect, useState } from "react";
import { AudioPlayback, showsPause, type AudioPlaybackState } from "@space/mobile-audio-playback";
import { scopeLogger } from "@space/mobile-shell/logger";
import { nowPlayingOf, type NowPlaying } from "../lib/nowPlaying";

/** The player's state: every change it reports, plus the position polled while something plays. */
export const usePlayerState = (pollMs = 500): AudioPlaybackState | null => {
  const [state, setState] = useState<AudioPlaybackState | null>(null);
  useEffect(() => {
    let live = true;
    const refresh = () =>
      AudioPlayback.getState().then(
        (next) => live && setState(next),
        () => undefined
      );
    void refresh();
    const subscription = AudioPlayback.onState((next) => live && setState(next));
    const timer = setInterval(refresh, pollMs);
    return () => {
      live = false;
      subscription.remove();
      clearInterval(timer);
    };
  }, [pollMs]);
  return state;
};

/** The queued song and its album (see `nowPlayingOf`), for the screens that mark what plays. */
export const useNowPlaying = (pollMs = 1000): NowPlaying | null => nowPlayingOf(usePlayerState(pollMs));

const log = scopeLogger("playback.toggle");

/**
 * Pauses the song playing now, or resumes it: what a tap on its row in a song list does (PAR-PLAY-10). Reads the
 * player's state at the tap, so a row drawn a moment ago never resumes what was just paused.
 */
export const togglePlayback = async (): Promise<void> => {
  try {
    const state = await AudioPlayback.getState();
    const pause = showsPause(state);
    log.info("toggle", { mediaId: state.mediaId, pause });
    await (pause ? AudioPlayback.pause() : AudioPlayback.play());
  } catch (error) {
    log.warn("toggle_failed", { message: error instanceof Error ? error.message : String(error) });
  }
};
