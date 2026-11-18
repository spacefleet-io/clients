/**
 * Pure planning of the operating system media session (PLAY-OSMEDIA-01).
 *
 * Every player (web, Electron renderer, phone) describes what plays as a
 * `MediaSessionState`; `planMediaSession` turns it into what the OS panel shows
 * and which actions it offers. No DOM, React or React Native imports, so the
 * phone apps reuse the same plan to drive their native Media3 session.
 */

/** Seek-backward and seek-forward step (PLAY-OSMEDIA-01 notes, agent reading approved by Main 2026-11-08). */
export const SEEK_STEP_S = 10;

/** The browser Media Session action names this package drives. */
export const MEDIA_ACTIONS = [
  "play",
  "pause",
  "stop",
  "nexttrack",
  "previoustrack",
  "seekto",
  "seekbackward",
  "seekforward",
] as const;
export type MediaAction = (typeof MEDIA_ACTIONS)[number];

/** `none` = nothing loaded or the player was stopped/closed: the session is released. */
export type MediaStatus = "playing" | "paused" | "none";

export interface MediaInfo {
  title: string;
  /** Parrot: the artist. Badger: the show for an episode. */
  artist?: string;
  /** Parrot: the album. Badger: season and episode label. */
  album?: string;
  /** Local `blob:` / `file:` / `data:` URL of the decrypted cover or poster; never a remote URL. */
  artworkUrl?: string;
}

export interface MediaSessionState {
  status: MediaStatus;
  info: MediaInfo | null;
  positionS?: number;
  durationS?: number;
  rate?: number;
  canNext: boolean;
  canPrevious: boolean;
  /** False for live streams or while nothing seekable is loaded. */
  canSeek: boolean;
}

export interface PlannedArtwork {
  src: string;
}

export interface PlannedMetadata {
  title: string;
  artist: string;
  album: string;
  artwork: PlannedArtwork[];
}

export interface PlannedPosition {
  duration: number;
  position: number;
  playbackRate: number;
}

export interface MediaSessionPlan {
  playbackState: MediaStatus;
  metadata: PlannedMetadata | null;
  /** `null` clears the position (unknown duration or not seekable). */
  position: PlannedPosition | null;
  actions: ReadonlySet<MediaAction>;
}

const LOCAL_ARTWORK = /^(blob:|file:|data:image\/)/;

/** True when the URL points at bytes already on this device (PLAY-OSMEDIA-01 item 2: never a remote image). */
export const isLocalArtworkUrl = (url: string): boolean => LOCAL_ARTWORK.test(url);

const finite = (n: number | undefined): n is number => typeof n === "number" && Number.isFinite(n);

export const RELEASED_PLAN: MediaSessionPlan = Object.freeze({
  playbackState: "none",
  metadata: null,
  position: null,
  actions: new Set<MediaAction>(),
});

export const planMediaSession = (state: MediaSessionState): MediaSessionPlan => {
  if (state.status === "none" || !state.info) return RELEASED_PLAN;
  const { info } = state;
  const artwork = info.artworkUrl && isLocalArtworkUrl(info.artworkUrl) ? [{ src: info.artworkUrl }] : [];
  const metadata: PlannedMetadata = {
    title: info.title,
    artist: info.artist ?? "",
    album: info.album ?? "",
    artwork,
  };

  const seekable = state.canSeek && finite(state.durationS) && state.durationS > 0;
  const position: PlannedPosition | null = seekable
    ? {
        duration: state.durationS as number,
        position: Math.min(Math.max(finite(state.positionS) ? state.positionS : 0, 0), state.durationS as number),
        playbackRate: finite(state.rate) && state.rate > 0 ? state.rate : 1,
      }
    : null;

  const actions = new Set<MediaAction>(["play", "pause", "stop"]);
  if (state.canNext) actions.add("nexttrack");
  if (state.canPrevious) actions.add("previoustrack");
  if (seekable) {
    actions.add("seekto");
    actions.add("seekbackward");
    actions.add("seekforward");
  }
  return { playbackState: state.status, metadata, position, actions };
};

/** Target time for a seek-backward/forward press, clamped to the media. */
export const steppedSeekTarget = (
  positionS: number,
  durationS: number,
  direction: "backward" | "forward",
  offsetS: number = SEEK_STEP_S,
): number => {
  const target = direction === "forward" ? positionS + offsetS : positionS - offsetS;
  return Math.min(Math.max(target, 0), Math.max(durationS, 0));
};

/** A season/episode pair as `S01E02` (two digits at least). */
export const episodeCode = (seasonNumber: number, episodeNumber: number) =>
  `S${String(seasonNumber).padStart(2, "0")}E${String(episodeNumber).padStart(2, "0")}`;

/**
 * What a Badger player shows in the OS media panel (PLAY-OSMEDIA-01 item 2), on every Badger surface: a movie shows
 * its title; an episode shows `S01E02 · <episode name>` (`S01E02` without a name) with the show as artist. The
 * artwork is the poster's local URL when the app has one (`planMediaSession` drops anything else).
 */
export const videoMediaInfo = (
  media: { title: string; episode: { seasonNumber: number; episodeNumber: number; name: string | null } | null },
  artworkUrl: string | null,
): MediaInfo => {
  const artwork = artworkUrl ? { artworkUrl } : {};
  const episode = media.episode;
  if (!episode) return { title: media.title, ...artwork };
  const code = episodeCode(episode.seasonNumber, episode.episodeNumber);
  return { title: episode.name ? `${code} · ${episode.name}` : code, artist: media.title, ...artwork };
};
