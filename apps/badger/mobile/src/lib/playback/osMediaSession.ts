/**
 * What the phone's notification-shade and lock-screen card shows (PLAY-OSMEDIA-01), for the three things the Badger
 * phone plays: a title in its own mpv player, a title it drives on a TV ("Play on TV", UX-TV-02), and a title it casts
 * to a Google Cast or AirPlay device (UX-TV-03). Pure: the screens pass what they know; `useOsMediaSession` hands the
 * result to `@space/mobile-media-session`.
 */
import { videoMediaInfo, type MediaSessionHandlers, type MediaSessionState } from "@space/media-session";
import { formatNowPlaying } from "@space/shared/nowPlaying";
import type { MediaEpisode, MediaRow } from "@space/shared/libraryTypes";
import type { RemoteAction, RemoteView } from "../playOnTv/phoneRemote";

const RELEASED: MediaSessionState = { status: "none", info: null, canNext: false, canPrevious: false, canSeek: false };

export type LocalPlaybackInput = {
  /** The player screen has a file loaded (session ready, start position chosen). */
  ready: boolean;
  snapshot: { position: number; duration: number; paused: boolean; voConfigured: boolean } | null;
  details: Pick<MediaRow, "type" | "title" | "year"> | null;
  episode: Pick<MediaEpisode, "seasonNumber" | "episodeNumber" | "name"> | null;
  /** Local `file://` URL of the decrypted poster, when it is already on the device. */
  posterUrl: string | null;
  fallbackDurationSeconds: number;
  hasNextEpisode: boolean;
  hasPreviousEpisode: boolean;
};

/**
 * The phone's own player. An episode reads "S01E02 · Episode name" with the show as artist (`videoMediaInfo`, as on
 * every Badger surface); a movie its title (and year). Next and
 * previous are offered only when there is another episode; the card appears with the first frame (or, for an episode
 * started from the lock screen while the picture is off, once mpv knows its duration) and stays on pause.
 */
export const localPlaybackMediaState = (input: LocalPlaybackInput): MediaSessionState => {
  const snap = input.snapshot;
  if (!input.ready || !snap || !(snap.voConfigured || snap.duration > 0) || !input.details) return RELEASED;
  const { details, episode } = input;
  const durationS = snap.duration > 0 ? snap.duration : input.fallbackDurationSeconds;
  return {
    status: snap.paused ? "paused" : "playing",
    info: videoMediaInfo(
      {
        title: episode ? details.title : formatNowPlaying(details, null),
        episode: episode ? { seasonNumber: episode.seasonNumber, episodeNumber: episode.episodeNumber, name: episode.name?.trim() || null } : null,
      },
      input.posterUrl,
    ),
    positionS: snap.position,
    durationS: durationS > 0 ? durationS : undefined,
    rate: 1,
    canNext: input.hasNextEpisode,
    canPrevious: input.hasPreviousEpisode,
    canSeek: durationS > 0,
  };
};

/**
 * The phone as the remote of a TV: the card follows the TV's own state messages (playing or paused; anything else,
 * or a session the TV ended, releases it). The protocol has no next or previous episode command, so the card offers
 * play, pause, stop and seeking.
 */
export const tvRemoteMediaState = (view: RemoteView, fallbackTitle: string, posterUrl: string | null): MediaSessionState => {
  const tv = view.tv;
  if (view.status === "ended" || !tv || (tv.phase !== "playing" && tv.phase !== "paused")) return RELEASED;
  const durationS = tv.durationSeconds > 0 ? tv.durationSeconds : undefined;
  return {
    status: tv.phase,
    info: { title: tv.title ?? fallbackTitle, artworkUrl: posterUrl ?? undefined },
    positionS: tv.positionSeconds,
    durationS,
    rate: 1,
    canNext: false,
    canPrevious: false,
    canSeek: durationS !== undefined,
  };
};

/** Card and headset presses become the remote's own commands to the TV. */
export const tvRemoteMediaHandlers = (send: (action: RemoteAction) => void): MediaSessionHandlers => ({
  play: () => send({ type: "play" }),
  pause: () => send({ type: "pause" }),
  stop: () => send({ type: "stop" }),
  seekTo: (seconds) => send({ type: "seekTo", positionSeconds: Math.max(0, seconds) }),
});

/** What a cast screen knows (a subset of `CastView`, so this file needs no React Native import). */
export type CastMediaInput = {
  phase: "preparing" | "connecting" | "casting" | "ended" | "refused" | "error";
  title: string;
  episodeLabel: string | null;
  playing: boolean;
  positionSeconds: number;
  durationSeconds: number;
};

/**
 * The phone casting to a device (UX-TV-03): the card stands for the device's playback while it casts, and is released
 * before the device plays and once it ended or failed. While it shows, Android keeps the app in a foreground service,
 * so the phone goes on serving the film with the screen off; and the headset and lock-screen play/pause reach the
 * device through the handlers below.
 */
export const castMediaState = (view: CastMediaInput): MediaSessionState => {
  if (view.phase !== "casting" || !view.title) return RELEASED;
  const durationS = view.durationSeconds > 0 ? view.durationSeconds : undefined;
  return {
    status: view.playing ? "playing" : "paused",
    info: view.episodeLabel ? { title: view.title, album: view.episodeLabel } : { title: view.title },
    positionS: view.positionSeconds,
    durationS,
    rate: 1,
    canNext: false,
    canPrevious: false,
    canSeek: durationS !== undefined,
  };
};

export type CastControls = {
  setPlaying: (playing: boolean) => unknown;
  seekTo: (seconds: number) => unknown;
  stop: () => unknown;
};

/** Card and headset presses become the cast screen's own commands to the device. */
export const castMediaHandlers = (controls: CastControls): MediaSessionHandlers => ({
  play: () => void controls.setPlaying(true),
  pause: () => void controls.setPlaying(false),
  stop: () => void controls.stop(),
  seekTo: (seconds) => void controls.seekTo(Math.max(0, seconds)),
});
