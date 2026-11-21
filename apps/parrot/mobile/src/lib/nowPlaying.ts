// What plays, for the screens that mark it: the album tile (green ring and equaliser), the album's song list (green
// title and equaliser) and the player's "Playing from album" header (PAR-LOOK-01). Pure, so tests read it without
// the native player.
import type { ParrotCoverKeys } from "@space/parrot-core";

export type NowPlayingTitles = {
  title: string;
  artist: string;
  album: string;
  albumId: string;
  /** The song's artist, for Home's "Your artists" (PAR-HOME-01); absent when the library names none. */
  artistId?: string;
  /** The album's cover keys: the small copy in the mini player, the large one in the player (PAR-META-04). */
  cover?: ParrotCoverKeys | null;
  /** The song's length, for the TV's Up next (PAR-TV-09); null when the library does not know it. */
  durationMs?: number | null;
};

/** Track titles by queued id, so the bar, the player and the library can name what plays. */
export const nowPlayingTitles = new Map<string, NowPlayingTitles>();

export type NowPlaying = {
  trackId: string;
  /** Null when the song was queued without its album (never by Parrot's own screens). */
  albumId: string | null;
  album: string | null;
  /** Sound is coming out: the equaliser moves. Paused, the marks stay but stand still. */
  playing: boolean;
};

/** The queued song and its album, from the player's state; null when nothing is queued. */
export const nowPlayingOf = (
  state: { mediaId: string | null; playing: boolean } | null,
  titles: ReadonlyMap<string, NowPlayingTitles> = nowPlayingTitles
): NowPlaying | null => {
  if (!state?.mediaId) return null;
  const meta = titles.get(state.mediaId);
  return { trackId: state.mediaId, albumId: meta?.albumId ?? null, album: meta?.album || null, playing: state.playing };
};
