/**
 * STOR-BW-07, STOR-BW-08, PLAY-QUAL-07: the renderer's view of the silo serving the playback in progress. The main
 * process pushes the state (`qualityCap`, `refusals`, `stops`) as the silo reports it; the silo already decides per
 * account who is capped, refused or stopped, so nothing here depends on the plan.
 *
 * `refusals` and `stops` count what happened since this hook mounted (the first state heard is the baseline), so a
 * component mounting late never reacts to an old event.
 */
import { useEffect, useState } from "react";
import type { PlaybackSaturationState } from "../../../shared/playbackSaturation";

const IDLE: PlaybackSaturationState = { qualityCap: null, refusals: 0, stops: 0 };

type Heard = { baseline: PlaybackSaturationState; current: PlaybackSaturationState };

export const usePlaybackSaturation = (): PlaybackSaturationState => {
  const [heard, setHeard] = useState<Heard | null>(null);

  useEffect(() => {
    let alive = true;
    const hear = (next: PlaybackSaturationState) => {
      if (alive) setHeard((previous) => ({ baseline: previous?.baseline ?? next, current: next }));
    };
    void window.sf?.getPlaybackSaturationState?.().then(hear);
    const unsubscribe = window.sf?.onPlaybackSaturationChange?.(hear);
    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, []);

  if (heard === null) return IDLE;
  return {
    qualityCap: heard.current.qualityCap,
    refusals: heard.current.refusals - heard.baseline.refusals,
    stops: heard.current.stops - heard.baseline.stops,
  };
};
