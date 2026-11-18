import { useEffect, useRef, useState } from "react";
import { MpvControl, type PlaybackSnapshot } from "@space/mobile-mpv-playback";

/**
 * Single throttled poller for the whole player. One native call per tick (`getPlaybackSnapshot`),
 * 500 ms while the UI is visible, 1 s otherwise; never per frame. Consumers read the React state
 * for rendering and `latest` (a ref) for logic that must not re-render.
 */
export const usePlaybackSnapshot = (enabled: boolean, visible: boolean) => {
  const [snapshot, setSnapshot] = useState<PlaybackSnapshot | null>(null);
  const latest = useRef<PlaybackSnapshot | null>(null);
  const intervalMs = visible ? 500 : 1000;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await MpvControl.getPlaybackSnapshot();
        if (cancelled) return;
        latest.current = next;
        setSnapshot(next);
      } catch {
        // a bad poll is recovered by the next one
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled, intervalMs]);

  return { snapshot, latest };
};
