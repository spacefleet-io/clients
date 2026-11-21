// What plays after the song playing, as the native player holds it: the phone's queue sheet and the TV's Up next page
// read it the same way.
import { useEffect, useState } from "react";
import { AudioPlayback, type AudioPlaybackState } from "@space/mobile-audio-playback";

/** The ids that play after the song playing, in the native player's order; re-read when the queue or its order changes. */
export const useUpNext = (open: boolean, state: AudioPlaybackState): string[] => {
  const [ids, setIds] = useState<string[]>([]);
  const { mediaId, count, shuffle, repeat } = state;
  useEffect(() => {
    if (!open) return;
    let live = true;
    AudioPlayback.getUpNext().then(
      (next) => live && setIds(next),
      () => live && setIds([])
    );
    return () => {
      live = false;
    };
  }, [open, mediaId, count, shuffle, repeat]);
  return ids;
};
