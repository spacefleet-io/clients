/**
 * The poster grids (Home, Media library, Playlists) host their inline player inside the page. mpv's window is the
 * player, so the Badger window behind it stays usable: leaving the page while a title plays unmounted the player with
 * mpv still open — an orphan window kept playing over the app, with nothing left to close it, and its progress turned
 * into a "Resume" the user never asked for (UX-HOME-01). When the hosting page unmounts with a playback open, stop mpv.
 */
import { useEffect, useRef } from "react";
import { rendererLogger } from "@/logger";

const log = rendererLogger.child({ scope: "inline-playback" });

export const useStopPlaybackOnUnmount = (playbackOpen: boolean) => {
  const openRef = useRef(playbackOpen);
  openRef.current = playbackOpen;
  useEffect(
    () => () => {
      if (!openRef.current) return;
      log.info({ stopCause: "host-page-left" }, "inline playback: host page left while playing — stopping external mpv");
      void window.sf?.stopExternalMpv?.().catch(() => null);
    },
    []
  );
};
