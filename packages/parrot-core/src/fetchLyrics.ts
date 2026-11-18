/**
 * Fetching a song's lyrics when its file carried none (PAR-LYR-05): what the anonymous lookup is asked (the song's
 * names, length and id in the metadata, never the file) and the `lyrics.set` op that keeps the answer in the library.
 * Every app that offers "Fetch lyrics" uses this, so the ask and the saved row are the same everywhere.
 */
import type { MusicLyrics, MusicLyricsQuery } from "@space/shared/api";
import { createParrotOp, type ParrotLibraryOp } from "@space/parrot-library-db-definition";
import { PARROT_LYRICS_FETCHED, PARROT_LYRICS_NOT_FOUND, TRACK_LYRICS_SQL } from "./lyrics";
import type { ParrotLibraryQuery } from "./manage";

type LyricsTrack = { title: string; durationMs: number | null; musicId: string | null; artist: string | null; album: string | null };

/** The lookup's question for one song; null when the song is gone or has no artist or title to ask with. */
export const parrotLyricsQuery = async (query: ParrotLibraryQuery, trackId: string): Promise<MusicLyricsQuery | null> => {
  const [row] = await query<LyricsTrack>(
    `SELECT t.title AS title, t.duration_ms AS durationMs, t.music_id AS musicId, ar.name AS artist, al.title AS album
       FROM tracks t LEFT JOIN artists ar ON ar.id = t.artist_id LEFT JOIN albums al ON al.id = t.album_id
      WHERE t.id = ?`,
    [trackId]
  );
  const title = row?.title.trim();
  const artist = row?.artist?.trim();
  if (!row || !title || !artist) return null;
  const album = row.album?.trim();
  return {
    artist,
    title,
    ...(album ? { album } : {}),
    ...(row.durationMs && row.durationMs > 0 ? { durationMs: row.durationMs } : {}),
    ...(row.musicId ? { id: row.musicId } : {}),
  };
};

/** The op that keeps a found answer; null when the lookup found no words (see {@link planParrotLyricsNotFound}). */
export const planParrotLyrics = (trackId: string, answer: MusicLyrics, ctx: { now: number; newId: () => string }): ParrotLibraryOp | null => {
  const synced = answer.synced?.trim() ? answer.synced : null;
  const plain = answer.plain?.trim() ? answer.plain : null;
  if (!synced && !plain) return null;
  return createParrotOp(
    "lyrics.set",
    { trackId, plain, synced, source: PARROT_LYRICS_FETCHED, fetchedAt: ctx.now },
    { id: ctx.newId(), createdAt: new Date(ctx.now).toISOString() }
  );
};

/**
 * The op that records "looked everywhere, no words" for a song (a row with no words and source "none"): every device
 * then shows the final "No lyrics" state (PAR-LYR-04) and the automatic lookup does not ask again (PAR-LYR-01);
 * "Fetch lyrics" still can (PAR-LYR-05).
 */
export const planParrotLyricsNotFound = (trackId: string, ctx: { now: number; newId: () => string }): ParrotLibraryOp =>
  createParrotOp(
    "lyrics.set",
    { trackId, plain: null, synced: null, source: PARROT_LYRICS_NOT_FOUND, fetchedAt: ctx.now },
    { id: ctx.newId(), createdAt: new Date(ctx.now).toISOString() }
  );

/**
 * `present`: the song already has words (its file's come first, PAR-LYR-01), so nothing is asked or written.
 * `none`: nothing found anywhere; `op` records that (see {@link planParrotLyricsNotFound}).
 */
export type ParrotLyricsFetch = { kind: "missing" } | { kind: "present" } | { kind: "none"; op: ParrotLibraryOp } | { kind: "found"; op: ParrotLibraryOp };

/** Asks the lookup for one song's lyrics; a lookup failure throws so the caller can show why. */
export const fetchParrotLyrics = async (args: {
  query: ParrotLibraryQuery;
  trackId: string;
  lookup: (question: MusicLyricsQuery) => Promise<MusicLyrics>;
  now: () => number;
  newId: () => string;
}): Promise<ParrotLyricsFetch> => {
  const question = await parrotLyricsQuery(args.query, args.trackId);
  if (!question) return { kind: "missing" };
  const [held] = await args.query<{ synced: string | null; plain: string | null }>(TRACK_LYRICS_SQL, [args.trackId]);
  if (held?.synced?.trim() || held?.plain?.trim()) return { kind: "present" };
  const ctx = { now: args.now(), newId: args.newId };
  const op = planParrotLyrics(args.trackId, await args.lookup(question), ctx);
  return op ? { kind: "found", op } : { kind: "none", op: planParrotLyricsNotFound(args.trackId, ctx) };
};
