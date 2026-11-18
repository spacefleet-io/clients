import { useEffect, useState } from "react";
import { AudioPlayback, type AudioPlaybackState } from "@space/mobile-audio-playback";
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
