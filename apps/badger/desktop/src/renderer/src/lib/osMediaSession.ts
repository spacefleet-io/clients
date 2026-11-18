/**
 * PLAY-OSMEDIA-01 for the Badger desktop app. The video plays in an external mpv, outside the page, so Chromium has no
 * media element to build its media session (MPRIS on Linux, SMTC on Windows, Now Playing on macOS) from. The shared
 * hook therefore loops a silent audio element while mpv plays (`keepAlive`), and this module feeds it the mpv state:
 * pause and time-pos straight from mpv, the episode and its neighbours from the controller. The OS actions come back
 * to mpv through the same paths the in-app controls and the mpv OSC use.
 */
import { useEffect, useState } from "react";
import { getSharedPreloadMpvClient } from "@space/desktop-mpv-playback";
import { videoMediaInfo, type MediaSessionHandlers, type MediaSessionState } from "@space/media-session";
import { useMediaSession } from "@space/media-session/react";

export type BadgerNowPlayingInput = {
  open: boolean;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  title: string;
  episode: { seasonNumber: number; episodeNumber: number; name?: string | null } | null;
  hasNext: boolean;
  hasPrevious: boolean;
  artworkUrl: string | null;
};

/** What the OS panel shows: the shared Badger format (`S01E02 · name` with the show as artist, or the movie). */
export const buildBadgerMediaSessionState = (input: BadgerNowPlayingInput): MediaSessionState => {
  if (!input.open) return { status: "none", info: null, canNext: false, canPrevious: false, canSeek: false };
  const episode = input.episode ? { ...input.episode, name: input.episode.name?.trim() || null } : null;
  const duration = Number.isFinite(input.duration) && input.duration > 0 ? input.duration : undefined;
  return {
    status: input.isPlaying ? "playing" : "paused",
    info: videoMediaInfo({ title: input.title, episode }, input.artworkUrl),
    positionS: Number.isFinite(input.currentTime) ? input.currentTime : 0,
    durationS: duration,
    canNext: input.hasNext,
    canPrevious: input.hasPrevious,
    canSeek: duration !== undefined,
  };
};

/** Binds the external mpv's state to the OS media controls while the playback controller is mounted. */
export const useBadgerOsMediaSession = (input: BadgerNowPlayingInput, handlers: MediaSessionHandlers): void => {
  // The engine's React time and play state are coalesced while the app window is hidden (mpv in front), so the
  // live mpv pushes (`time-pos` at 1 Hz, `pause`) win: the OS panel stays true with the window hidden.
  const [live, setLive] = useState<{ time: number | null; paused: boolean | null }>({ time: null, paused: null });
  const { open } = input;
  const episodeKey = input.episode ? `${input.episode.seasonNumber}:${input.episode.episodeNumber}` : "";
  useEffect(() => {
    setLive({ time: null, paused: null });
    if (!open) return;
    const client = getSharedPreloadMpvClient();
    const unsubscribers = [
      client.observe(
        "time-pos",
        (value) => {
          if (typeof value === "number") setLive((prev) => ({ ...prev, time: value }));
        },
        { throttleMs: 1_000 }
      ),
      client.observe("pause", (value) => {
        if (typeof value === "boolean") setLive((prev) => ({ ...prev, paused: value }));
      }),
    ];
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [open, episodeKey]);

  const state = buildBadgerMediaSessionState({
    ...input,
    currentTime: live.time ?? input.currentTime,
    isPlaying: live.paused === null ? input.isPlaying : !live.paused,
  });
  useMediaSession(state, handlers, { keepAlive: true });
};
