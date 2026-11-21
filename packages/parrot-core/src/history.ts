// What this device has played, for Home (PAR-HOME-01): "Jump back in", "Recently played" and "Your artists".
// The history stays on the device that played (PAR-HOME-02): it is never uploaded, never shared and never used to
// suggest music (PAR-PROD-02). Immutable, like the queue, so React state, a store or a test hold it the same way.
import { sortTracks } from "./catalog";
import { sortParrotAlbums, type ParrotSortableAlbum } from "./librarySort";

/** One album played on this device, newest first in `ListeningHistory.albums`. */
export type HistoryAlbum = {
  albumId: string;
  /** The song that was playing last in this album, and how far in it was, for "Resume". */
  trackId: string;
  positionMs: number;
  playedAt: number;
};

export type ListeningHistory = {
  version: 1;
  albums: HistoryAlbum[];
  /** How many songs of each artist this device started, for the order of "Your artists". */
  artistPlays: Record<string, number>;
};

/** Albums kept in the history: Home shows at most a row of them. */
export const HISTORY_ALBUM_LIMIT = 24;

/** Where a device keeps one account's history (PAR-HOME-02): localStorage on the desktop and in the browser, AsyncStorage on the phone. */
export const historyStorageKey = (userId: string): string => `parrot.history.${userId}`;

/**
 * Where the phone keeps one profile's history (ACCT-PROF-01): each listener of the account has their own Home. The
 * account's key (`historyStorageKey`) is the main profile's until it adopts it once.
 */
export const profileHistoryStorageKey = (userId: string, profileId: string): string => `parrot.history.${userId}.${profileId}`;

/** Where this computer or browser keeps one account's notification tray (PAR-NAV-01), per account like the history. */
export const notificationsStorageKey = (userId: string): string => `parrot.notifications.${userId}`;

/** How often the playing song's position is written to the history, so Home's "Resume" starts near where it stopped. */
export const HISTORY_POSITION_EVERY_MS = 5000;

export const emptyHistory = (): ListeningHistory => ({ version: 1, albums: [], artistPlays: {} });

/** Reads a stored history; anything unreadable starts a fresh one rather than breaking Home. */
export const parseHistory = (raw: string | null | undefined): ListeningHistory => {
  if (!raw) return emptyHistory();
  try {
    const value = JSON.parse(raw) as Partial<ListeningHistory>;
    if (value.version !== 1 || !Array.isArray(value.albums)) return emptyHistory();
    const albums = value.albums.filter(
      (entry): entry is HistoryAlbum =>
        !!entry &&
        typeof entry.albumId === "string" &&
        typeof entry.trackId === "string" &&
        typeof entry.positionMs === "number" &&
        typeof entry.playedAt === "number"
    );
    const plays: Record<string, number> = {};
    for (const [id, count] of Object.entries(value.artistPlays ?? {})) if (typeof count === "number" && count > 0) plays[id] = count;
    return { version: 1, albums: albums.slice(0, HISTORY_ALBUM_LIMIT), artistPlays: plays };
  } catch {
    return emptyHistory();
  }
};

/** A song that started; `artistId` is '' or missing for a song without an artist, which adds no artist play. */
type PlayedTrack = { id: string; albumId: string; artistId?: string };

/** A song started: its album moves to the front of the history and its artist gains a play. */
export const recordPlay = (history: ListeningHistory, track: PlayedTrack, now: number): ListeningHistory => ({
  version: 1,
  albums: [
    { albumId: track.albumId, trackId: track.id, positionMs: 0, playedAt: now },
    ...history.albums.filter((entry) => entry.albumId !== track.albumId),
  ].slice(0, HISTORY_ALBUM_LIMIT),
  artistPlays: track.artistId ? { ...history.artistPlays, [track.artistId]: (history.artistPlays[track.artistId] ?? 0) + 1 } : history.artistPlays,
});

/** Remembers how far the playing song got, so "Resume" starts there. Only the album's own entry changes. */
export const recordPosition = (history: ListeningHistory, track: Pick<PlayedTrack, "id" | "albumId">, positionMs: number): ListeningHistory => {
  const index = history.albums.findIndex((entry) => entry.albumId === track.albumId);
  if (index < 0) return history;
  const entry = history.albums[index]!;
  const rounded = Math.max(0, Math.floor(positionMs));
  if (entry.trackId === track.id && entry.positionMs === rounded) return history;
  const albums = [...history.albums];
  albums[index] = { ...entry, trackId: track.id, positionMs: rounded };
  return { ...history, albums };
};

/** The history's albums that are still in the library, newest first. */
export const recentAlbums = <A extends { id: string }>(history: ListeningHistory, albums: readonly A[]): { album: A; entry: HistoryAlbum }[] => {
  const byId = new Map(albums.map((album) => [album.id, album]));
  return history.albums.flatMap((entry) => {
    const album = byId.get(entry.albumId);
    return album ? [{ album, entry }] : [];
  });
};

/** The library's artists, the ones played most on this device first, then by name. */
export const artistsByPlays = <A extends { id: string; name: string }>(history: ListeningHistory, artists: readonly A[]): A[] =>
  [...artists].sort((a, b) => (history.artistPlays[b.id] ?? 0) - (history.artistPlays[a.id] ?? 0) || a.name.localeCompare(b.name));

/** How many albums and artists a Home row shows before "See all". */
export const HOME_ROW_LIMIT = 12;

export type HomeView<A, R, T> = {
  /** The "Jump back in" card; `entry` is null when nothing was played here yet ("Start listening"). */
  jump: { album: A; entry: HistoryAlbum | null } | null;
  /** The song the card resumes, when the history names one still in the library. */
  jumpTrack: T | undefined;
  /** True when the album row shows albums played here ("Recently played"), false for the library's ("Albums"). */
  played: boolean;
  albums: A[];
  artists: R[];
};

/**
 * What Home shows (PAR-HOME-01), the same on every surface: the last album played on this device, else the library's
 * first album; the albums played here newest first, else the library's; the artists played most first.
 */
export const homeView = <A extends { id: string }, R extends { id: string; name: string }, T extends { id: string }>(
  history: ListeningHistory,
  albums: readonly A[],
  artists: readonly R[],
  tracks: readonly T[],
  limit = HOME_ROW_LIMIT,
): HomeView<A, R, T> => {
  const recent = recentAlbums(history, albums);
  const jump = recent[0] ?? (albums[0] ? { album: albums[0], entry: null } : null);
  const entry = jump?.entry;
  return {
    jump,
    jumpTrack: entry ? tracks.find((track) => track.id === entry.trackId) : undefined,
    played: recent.length > 0,
    albums: (recent.length > 0 ? recent.map((row) => row.album) : albums).slice(0, limit),
    artists: artistsByPlays(history, artists).slice(0, limit),
  };
};

/**
 * Home's "Recently added" row (PAR-HOME-01), the same on every surface: the library's albums in its "Recently added"
 * order (`albums.created_at`, newest first, PAR-LOOK-01), whether or not anything was played.
 */
export const homeRecentlyAdded = <A extends ParrotSortableAlbum>(albums: readonly A[], limit = HOME_ROW_LIMIT): A[] =>
  sortParrotAlbums(albums, "recent").slice(0, limit);

/**
 * The line under the album's name on Home's card (PAR-HOME-01), the same on every surface: "artist · year · N songs",
 * leaving out a missing year. `songs` is the surface's own translated count ("12 songs").
 */
export const homeAlbumDetail = (album: { artistName?: string | null; year?: number | null }, unknownArtist: string, songs: string): string =>
  [album.artistName || unknownArtist, album.year, songs].filter(Boolean).join(" · ");

/**
 * Where Home's Play or Shuffle on an album starts (PAR-HOME-01), the same on every surface: the album's songs in album
 * order (whatever order `tracks` comes in, such as the phone's title-ordered Songs list), from the song the history
 * names and its position when there is one, else from the first song; Shuffle from a random song.
 */
export const homeAlbumStart = <T extends { id: string; albumId: string; disc: number; number: number | null; title: string }>(
  tracks: readonly T[],
  albumId: string,
  entry: HistoryAlbum | null,
  shuffle: boolean,
  random: () => number = Math.random,
): { tracks: T[]; index: number; startMs: number } => {
  const songs = sortTracks(tracks.filter((track) => track.albumId === albumId));
  const resume = shuffle || !entry ? -1 : songs.findIndex((track) => track.id === entry.trackId);
  if (resume >= 0) return { tracks: songs, index: resume, startMs: entry?.positionMs ?? 0 };
  return { tracks: songs, index: shuffle && songs.length > 0 ? Math.floor(random() * songs.length) : 0, startMs: 0 };
};

/** The song the player holds right now: its album, how far in it is, and whether sound is coming out. */
export type HomeNowPlaying = { albumId: string | null | undefined; trackId: string; positionMs: number; playing: boolean };

/**
 * What the card's main button shows and does (PAR-HOME-01), the same on every surface. While the card's album is
 * what the player holds, the button follows the player: Pause while it plays, else Resume at the place the player
 * stands, and pressing it pauses or continues that song (`live`). Otherwise it starts from the history: Resume at the
 * saved place, or Play.
 */
export type HomeJumpButton = { kind: "pause" | "resume" | "play"; trackId: string | null; positionMs: number; live: boolean };

export const homeJumpButton = (albumId: string, entry: HistoryAlbum | null, now: HomeNowPlaying | null): HomeJumpButton => {
  if (now && now.albumId === albumId) {
    const kind = now.playing ? "pause" : now.positionMs >= 1000 ? "resume" : "play";
    return { kind, trackId: now.trackId, positionMs: now.positionMs, live: true };
  }
  const positionMs = entry?.positionMs ?? 0;
  return { kind: entry && positionMs >= 1000 ? "resume" : "play", trackId: entry?.trackId ?? null, positionMs, live: false };
};
