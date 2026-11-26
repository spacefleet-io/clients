import { useEffect } from "react";

/**
 * PAR-UP-15: how often the window says again that a song still plays. Main's upload gate holds the "playing" state
 * for a lease (content-core `PLAYBACK_LEASE_MS_DEFAULT`, 15 s), so a window that crashed or hung never keeps imports
 * slowed down or paused for ever; renewing well inside the lease keeps it alive while the song plays.
 */
export const PLAYBACK_RENEW_MS = 5_000;

const tell = (active: boolean) => window.parrot?.playbackActive?.(active);

/** Tells main whether a song plays on this computer, renewing it while it plays, so imports follow the gate. */
export function usePlaybackUploadsLease(playing: boolean): void {
  useEffect(() => {
    tell(playing);
    if (!playing) return;
    const renew = setInterval(() => tell(true), PLAYBACK_RENEW_MS);
    return () => {
      clearInterval(renew);
      tell(false);
    };
  }, [playing]);
}
