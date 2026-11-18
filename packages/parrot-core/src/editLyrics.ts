/**
 * The edit panel's Lyrics section (PAR-LYR-05, PAR-META-20): what it shows for a song or an album, shared by every
 * Parrot app that has the panel. Like Badger's intro and credits lookup, the lyrics are looked up on their own: the
 * panel asks for a song that was never looked up as soon as it opens, shows a shimmer while the answer is on its way,
 * then the words or an explicit "No lyrics found" with "Search again". Loading never looks like "nothing found".
 */
import type { ParrotLyrics } from "./lyrics";

/** How many lines of the found words the section shows. */
export const PARROT_EDIT_LYRICS_PREVIEW_LINES = 4;

export type ParrotEditLyricsState =
  /** Being read, being looked up, or never looked up yet (the panel asks at once): a shimmer. */
  | { status: "loading" }
  | { status: "found"; synced: boolean; preview: string[] }
  /** The lookup came back empty: "No lyrics found" and "Search again". */
  | { status: "none" }
  /** The panel's own lookup failed (offline, signed out): the reason and "Search again". */
  | { status: "failed"; reason: string };

/**
 * The section's state for one song. `lyrics`: undefined while the library is read, null when the song has no lyrics
 * row (never looked up). `lookup`: the panel's own lookup, if it asked.
 */
export const parrotEditLyricsState = (
  lyrics: ParrotLyrics | null | undefined,
  lookup: { status: "idle" | "busy" } | { status: "failed"; reason: string } = { status: "idle" }
): ParrotEditLyricsState => {
  const lines = lyrics?.synced?.length ? lyrics.synced.map((line) => line.text) : lyrics?.plain ? lyrics.plain.split(/\r?\n/) : null;
  if (lines) return { status: "found", synced: Boolean(lyrics?.synced?.length), preview: lines.map((line) => line.trim()).filter(Boolean).slice(0, PARROT_EDIT_LYRICS_PREVIEW_LINES) };
  if (lookup.status === "busy") return { status: "loading" };
  if (lookup.status === "failed") return { status: "failed", reason: lookup.reason };
  if (lyrics === undefined || lyrics === null || lyrics.searching) return { status: "loading" };
  return { status: "none" };
};

/**
 * Whether the panel asks for the song's lyrics as it opens: only when it has never been looked up (no row, nothing
 * pending). A song whose lookup found nothing is asked again only on "Search again".
 */
export const parrotEditLyricsNeedsLookup = (lyrics: ParrotLyrics | null | undefined): boolean => lyrics === null;

export type ParrotEditAlbumLyricsState =
  | { status: "loading" }
  /** `missing`: songs without words, never looked up or found none (the button looks for them). */
  | { status: "counted"; found: number; count: number; missing: number };

/**
 * The section's state for an album: loading while any song is read or looked up, else how many songs have words.
 * `songs`: each song's lyrics as `parrotEditLyricsState` takes them; `busy`: the panel's own lookup is running.
 */
export const parrotEditAlbumLyricsState = (songs: readonly (ParrotLyrics | null | undefined)[], busy = false): ParrotEditAlbumLyricsState => {
  if (busy) return { status: "loading" };
  let found = 0;
  for (const lyrics of songs) {
    if (lyrics === undefined || lyrics?.searching) return { status: "loading" };
    if (parrotEditLyricsState(lyrics).status === "found") found += 1;
  }
  return { status: "counted", found, count: songs.length, missing: songs.length - found };
};

/** The album's songs the panel asks for as it opens: those never looked up. */
export const parrotEditAlbumLyricsToAsk = <T>(songs: readonly { id: T; lyrics: ParrotLyrics | null | undefined }[]): T[] =>
  songs.filter((song) => parrotEditLyricsNeedsLookup(song.lyrics)).map((song) => song.id);
