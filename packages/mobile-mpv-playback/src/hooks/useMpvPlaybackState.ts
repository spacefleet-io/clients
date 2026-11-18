import { useEffect, useState } from "react";
import { MpvControl } from "../MpvControl";
import type { MpvTrack, PlaybackState } from "../types";

const DEFAULT_STATE: PlaybackState = {
  position: 0,
  duration: 0,
  paused: false,
  cacheEnd: 0,
};

/**
 * Polls `MpvControl.getPlaybackState()` and `MpvControl.getTrackList()`
 * every `intervalMs` (default 500ms) and surfaces the latest snapshot to
 * the caller. Pause polling by passing `paused: true` (e.g. while the user
 * is dragging the seek bar — the seek-bar UI manages its own optimistic
 * position state during a drag).
 *
 * Errors from the native side are swallowed silently — a single bad poll
 * does not break the UI; the next interval recovers.
 */
export const useMpvPlaybackState = (options?: {
  intervalMs?: number;
  paused?: boolean;
}): { state: PlaybackState; tracks: MpvTrack[] } => {
  const intervalMs = options?.intervalMs ?? 500;
  const paused = options?.paused ?? false;
  const [state, setState] = useState<PlaybackState>(DEFAULT_STATE);
  const [tracks, setTracks] = useState<MpvTrack[]>([]);

  useEffect(() => {
    if (paused) return;
    const tick = async () => {
      try {
        const snapshot = await MpvControl.getPlaybackState();
        setState(snapshot);
      } catch {
        // ignore
      }
      try {
        const list = await MpvControl.getTrackList();
        if (Array.isArray(list)) setTracks(list);
      } catch {
        // ignore
      }
    };
    const id = setInterval(tick, intervalMs);
    void tick();
    return () => clearInterval(id);
  }, [intervalMs, paused]);

  return { state, tracks };
};
