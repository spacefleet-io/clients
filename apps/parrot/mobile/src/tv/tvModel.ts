// The rules of Parrot TV's screens that hold no drawing (PAR-TV-04..10, PAR-TV-13): which pages keep the top bar, how
// the page stack grows, what a remote key does, the lyric lines Now playing shows, the artist's songs, the grid's
// columns, the album card's caption, how Up next jumps to a song, and the Settings groups. Pure, so the tests read
// them without React Native.
import { activeLyricIndex, type TrackRow } from "@space/parrot-core";
import type { AlbumWithCover } from "../lib/library";
import type { TrackLyricsView } from "../state/useTrackLyrics";

/** The pages Parrot TV opens over its sections; Parrot has no navigator on TV, so the shell keeps a stack of them. */
export type TvPage =
  | { kind: "album"; albumId: string }
  | { kind: "playlist"; playlistId: string; name: string }
  | { kind: "artist"; artistId: string; name: string }
  | { kind: "nowPlaying" }
  | { kind: "lyrics" }
  | { kind: "queue" }
  | { kind: "profiles"; mode: "pick" | "manage" };

/** The pages drawn under the top bar (drafts `2-album`, `4-artist`); the others fill the screen. */
export const tvPageHasTopBar = (page: TvPage): boolean => page.kind === "album" || page.kind === "playlist" || page.kind === "artist";

/**
 * PAR-TV-12: the TV stays awake (no screensaver) only while Now playing or the full-screen lyrics are on top; Up next,
 * the profiles and every section let the screensaver start, with the music playing on under it.
 */
export const tvPageKeepsAwake = (top: TvPage | null): boolean => top?.kind === "nowPlaying" || top?.kind === "lyrics";

/** A stable key per page, so the same page is never stacked twice. */
export const tvPageKey = (page: TvPage): string => {
  switch (page.kind) {
    case "album":
      return `album:${page.albumId}`;
    case "playlist":
      return `playlist:${page.playlistId}`;
    case "artist":
      return `artist:${page.artistId}`;
    case "profiles":
      return `profiles:${page.mode}`;
    default:
      return page.kind;
  }
};

/**
 * The stack after opening `page`: a page already open is gone back to rather than stacked again (a song played from Up
 * next returns to Now playing under it, so Back from there still lands where the user was).
 */
export const pushTvPage = (stack: readonly TvPage[], page: TvPage): TvPage[] => {
  const key = tvPageKey(page);
  const at = stack.findIndex((open) => tvPageKey(open) === key);
  return at >= 0 ? stack.slice(0, at + 1) : [...stack, page];
};

export type TvRemoteAction = "playPause" | "next" | "previous";

const ACTION_BY_EVENT: Record<string, TvRemoteAction> = {
  playPause: "playPause",
  play: "playPause",
  pause: "playPause",
  next: "next",
  fastForward: "next",
  previous: "previous",
  rewind: "previous",
};

/**
 * The action of a remote event, on the key's release only (a press sends down then up: one action, not two). Null on
 * Android: the player's media session already answers the remote's media keys there, also while Parrot is in front, so
 * acting here as well would pause and play again at once. tvOS sends the Siri Remote's keys to the app alone.
 */
export const tvRemoteAction = (
  event: { eventType?: string; eventKeyAction?: number | string } | null | undefined,
  os: string,
): TvRemoteAction | null => {
  if (os === "android") return null;
  if (!event || typeof event.eventType !== "string") return null;
  if (Number(event.eventKeyAction) === 0) return null;
  return ACTION_BY_EVENT[event.eventType] ?? null;
};

/** The two lines under Now playing's controls: the one being sung, and the next. Null when the song has no synced lyrics. */
export const lyricsPeek = (view: TrackLyricsView, positionMs: number): { now: string; next: string } | null => {
  if (view.kind !== "synced" || view.lines.length === 0) return null;
  const at = activeLyricIndex(view.lines, positionMs);
  return { now: at >= 0 ? view.lines[at]!.text : "", next: view.lines[at + 1]?.text ?? "" };
};

/** How far into the lyrics window the edge fade reaches, top and bottom (draft 3a `.lyr` mask: 0 → 22%, 78% → 100%). */
export const LYRICS_EDGE_FADE = 0.22;

/**
 * The opacity of a lyric line whose middle sits `center` dp from the top of a window `height` dp high: fully shown in the
 * middle band, fading to nothing at either edge, as the draft's gradient mask (React Native has no mask).
 */
export const lyricsEdgeOpacity = (center: number, height: number): number => {
  if (height <= 0) return 1;
  const band = height * LYRICS_EDGE_FADE;
  return Math.max(0, Math.min(1, center / band, (height - center) / band));
};

type AlbumCoverKeys = Pick<AlbumWithCover, "coverObjectKey" | "coverThumbObjectKey">;

/** The artist's songs in album order (the albums as listed, each album's songs in its own order), each with its album's cover. */
export const artistSongs = (albums: readonly AlbumWithCover[], tracksByAlbum: ReadonlyMap<string, readonly TrackRow[]>): Array<TrackRow & { albumTitle: string } & AlbumCoverKeys> =>
  albums.flatMap((album) =>
    (tracksByAlbum.get(album.id) ?? []).map((track) => ({
      ...track,
      albumTitle: album.title,
      coverObjectKey: album.coverObjectKey,
      coverThumbObjectKey: album.coverThumbObjectKey,
    }))
  );

/** How many cards of `cardWidth` fit across the screen, between its side margins. */
export const tvGridColumnsFor = (windowWidth: number, cardWidth: number, gap: number, screenX: number): number =>
  Math.max(1, Math.floor((windowWidth - 2 * screenX + gap) / (cardWidth + gap)));

/** The album's second line on its card: "artist · year" (draft `.cap small`). */
export const tvAlbumCaption = (album: Pick<AlbumWithCover, "artistName" | "year">, unknownArtist: string): string =>
  [album.artistName || unknownArtist, album.year].filter(Boolean).join(" · ");

/** Plays the song at `index` of Up next now: the player has no jump, so it steps forward `index + 1` songs in its own order. */
export const skipToUpNext = async (index: number, next: () => Promise<unknown>): Promise<void> => {
  for (let step = 0; step <= index; step += 1) await next();
};

export type TvSettingsGroupId = "profiles" | "account" | "playback" | "privacy" | "language" | "about";

const SETTINGS_GROUPS: readonly TvSettingsGroupId[] = ["profiles", "account", "playback", "privacy", "language", "about"];

/** The Settings groups this TV shows: Privacy only where error reports are offered (the app was built with a reporting key). */
export const tvSettingsGroupIds = (privacyOffered: boolean): readonly TvSettingsGroupId[] => SETTINGS_GROUPS.filter((id) => id !== "privacy" || privacyOffered);

/**
 * The Search grid's letter and digit keys, six to a row (draft `5-search`). No accent or symbol keys: search ignores
 * accents and punctuation (`foldSearchText`), so "beyonce" finds "Beyoncé" and "numb encore" finds "Numb/Encore".
 */
export const TV_SEARCH_CHARS: readonly string[] = "abcdefghijklmnopqrstuvwxyz1234567890".split("");

export type TvSearchKey = { kind: "char"; char: string } | { kind: "space" } | { kind: "delete" };

/** The query after one key of the grid: a letter or digit adds itself, Space one space (never first nor doubled), Delete takes off the last character. */
export const typeTvSearchKey = (query: string, key: TvSearchKey): string => {
  if (key.kind === "char") return query + key.char;
  if (key.kind === "delete") return query.slice(0, -1);
  return query.length === 0 || query.endsWith(" ") ? query : `${query} `;
};
