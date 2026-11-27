/**
 * Artist photos (PAR-META-15): every artist with no photo yet is asked for one on its own, without a button press —
 * after the library loads, the same pass on every app. An artist without an id in the metadata (the file's tag gives it
 * at import when present) gets one first from our music library's match of one of its albums, or of one of its songs
 * when it has no album: the found artist's id is kept only when that artist has the library's name, never from the
 * name alone. A found photo is copied into the user's own storage like an album cover (PAR-COPY-01: a large and a
 * small sealed copy) with its Commons credit; the answer, found or not (no id found included), records when the
 * artist was asked, so it is not asked again at every launch but only once `PARROT_ARTIST_PICTURE_RETRY_MS` has
 * passed. A lookup that fails records nothing: the next pass asks again. An id already set is never replaced.
 */
import type { MusicAlbum, MusicAlbumsQuery, MusicArtistImage, MusicArtistRef, MusicRecording, MusicRecordingsQuery } from "@space/shared/api";
import { createParrotOp, type ArtistRow, type ParrotLibraryOp, type ParrotPhotoCredit } from "@space/parrot-library-db-definition";
import type { ParrotAutoLyricsOnError, ParrotCanSpend } from "./autoLyrics";
import type { ParrotCoverCopies } from "./covers";
import { parrotComparableName } from "./importMatch";
import type { ParrotLibraryQuery } from "./manage";

/** An artist the lookup had no photo for is asked again after this long (a photo may have been added to Commons since). */
export const PARROT_ARTIST_PICTURE_RETRY_MS = 30 * 24 * 60 * 60_000;
/** One artist every 1.5 s, as the lyrics pass: well under the ticket and per-connection limits. */
export const PARROT_AUTO_ARTIST_PICTURES_GAP_MS = 1500;
export const PARROT_AUTO_ARTIST_PICTURES_BATCH = 10;

/** Who to ask (parameter: the oldest asked time still due): artists in the library with no photo, not asked lately. */
const DUE_WHERE = `ar.picture_object_key IS NULL AND (ar.picture_tried_at IS NULL OR ar.picture_tried_at < ?)`;

export const PARROT_ARTIST_PICTURES_DUE_SQL = `SELECT ar.id AS id FROM artists ar WHERE ${DUE_WHERE}
  AND (EXISTS (SELECT 1 FROM albums al WHERE al.album_artist_id = ar.id) OR EXISTS (SELECT 1 FROM tracks t WHERE t.artist_id = ar.id))
  ORDER BY ar.sort_name COLLATE NOCASE, ar.id`;

const ARTIST_ROW_SQL = "SELECT id, music_id AS musicId, name, sort_name AS sortName FROM artists ar WHERE id = ?";

/** How many of an artist's albums (or songs) are asked about to find its id. */
const IDENTIFY_TRIES = 2;
const ARTIST_ALBUMS_SQL = `SELECT title FROM albums WHERE album_artist_id = ? AND trim(title) <> ''
  ORDER BY year IS NULL, year, title COLLATE NOCASE, id LIMIT ${IDENTIFY_TRIES}`;
const ARTIST_SONGS_SQL = `SELECT t.title AS title, t.duration_ms AS durationMs, al.title AS album
  FROM tracks t LEFT JOIN albums al ON al.id = t.album_id WHERE t.artist_id = ? AND trim(t.title) <> ''
  ORDER BY al.title COLLATE NOCASE, t.disc, t.number, t.id LIMIT ${IDENTIFY_TRIES}`;

/** The photo copy for circles and tiles: the small one, or the large one when it is already small; null with no photo. */
export const parrotArtistPictureThumbKey = (row: { pictureObjectKey: string | null; pictureThumbObjectKey: string | null }): string | null =>
  row.pictureObjectKey ? (row.pictureThumbObjectKey ?? row.pictureObjectKey) : null;

/** The credit line's parts as the library stores them; null when the photo needs none (or there is no photo). */
export const parrotArtistPictureCredit = (row: { pictureAuthor: string | null; pictureLicence: string | null; pictureLicenceUrl: string | null }): ParrotPhotoCredit | null =>
  row.pictureAuthor && row.pictureLicence ? { author: row.pictureAuthor, licence: row.pictureLicence, licenceUrl: row.pictureLicenceUrl } : null;

export type ParrotAutoArtistPicturesReport = {
  /** Photo lookups made (artists with an id, found or given one). */
  asked: number;
  found: number;
  none: number;
  failed: number;
  /** Artists without an id that got one from a matched album or song, and those that did not. */
  identified: number;
  unidentified: number;
  stopped: boolean;
};

export type ParrotAutoArtistPicturesArgs = {
  /** Read fresh at the start of each artist, so an artist deleted or given a photo meanwhile is not asked. */
  query: () => ParrotLibraryQuery;
  lookup: (artistId: string) => Promise<{ image: MusicArtistImage | null }>;
  /** The album and song lookups (PAR-META-18) that give an artist without an id the matched artist's. */
  albums: (question: MusicAlbumsQuery) => Promise<{ results: MusicAlbum[] }>;
  recordings: (question: MusicRecordingsQuery) => Promise<{ results: MusicRecording[] }>;
  fromBase64: (base64: string) => Uint8Array;
  /** The large and small copies, as for an album cover; null skips a picture that cannot be kept (recorded as none). */
  makeCopies: (bytes: Uint8Array) => ParrotCoverCopies | null | Promise<ParrotCoverCopies | null>;
  /** Seals one copy with the library key and stores it; resolves to its object key. */
  store: (bytes: Uint8Array) => Promise<string>;
  /** Keeps a batch of ops in the library (publishes it); a refusal stops the pass. */
  publish: (ops: ParrotLibraryOp[]) => Promise<boolean>;
  /** Shared with the lyrics pass (`parrotAutoLyricsOnError`): a 503 pause is waited out, no ticket stops the pass. */
  onError: ParrotAutoLyricsOnError;
  now: () => number;
  newId: () => string;
  sleep: (ms: number) => Promise<void>;
  /** Stops the pass between artists (sign-out, app quit); what was found so far is still published. */
  signal?: AbortSignal;
  /** PAR-META-20: the artists the pass still has to answer for (empty at its end), so their photos shimmer meanwhile. */
  onWaiting?: (artistIds: readonly string[]) => void;
  gapMs?: number;
  batchSize?: number;
  /** Artists of this pass handled so far, of its total, before each artist (the Jobs panel's background line, UX-JOBS-02). */
  onProgress?: (done: number, total: number) => void;
  /** The ticket floor (PAR-COPY-01): false stops the pass before that artist's lookup. */
  canSpend?: ParrotCanSpend;
};

const dueArtist = async (query: ParrotLibraryQuery, id: string, dueBefore: number): Promise<ArtistRow | null> =>
  (await query<ArtistRow>(`${ARTIST_ROW_SQL} AND ${DUE_WHERE}`, [id, dueBefore]))[0] ?? null;

/**
 * The id of the artist our music library matched for one of `artist`'s albums (or songs, when it has no album),
 * kept only when that artist bears the library's name; null when no match names it. A lookup failure throws.
 */
const identifyArtist = async (args: ParrotAutoArtistPicturesArgs, artist: ArtistRow, gapMs: number): Promise<string | null> => {
  const name = parrotComparableName(artist.name);
  if (!name) return null;
  const query = args.query();
  const albums = await query<{ title: string }>(ARTIST_ALBUMS_SQL, [artist.id]);
  const questions: Array<() => Promise<MusicArtistRef | null>> =
    albums.length > 0
      ? albums.map((album) => async () => (await args.albums({ artist: artist.name, album: album.title, limit: 1 })).results[0]?.artist ?? null)
      : (await query<{ title: string; durationMs: number | null; album: string | null }>(ARTIST_SONGS_SQL, [artist.id])).map(
          (song) => async () =>
            (
              await args.recordings({
                artist: artist.name,
                title: song.title,
                ...(song.album?.trim() ? { album: song.album } : {}),
                ...(song.durationMs && song.durationMs > 0 ? { durationMs: song.durationMs } : {}),
                limit: 1,
              })
            ).results[0]?.artist ?? null
        );
  for (const [index, ask] of questions.entries()) {
    if (index > 0) await args.sleep(gapMs);
    const found = await ask();
    if (found?.id && parrotComparableName(found.name) === name) return found.id;
  }
  return null;
};

/** Runs one pass over the artists due a photo; resolves with what it did. */
export const runParrotAutoArtistPictures = async (args: ParrotAutoArtistPicturesArgs): Promise<ParrotAutoArtistPicturesReport> => {
  const gapMs = args.gapMs ?? PARROT_AUTO_ARTIST_PICTURES_GAP_MS;
  const batchSize = Math.max(1, args.batchSize ?? PARROT_AUTO_ARTIST_PICTURES_BATCH);
  const report: ParrotAutoArtistPicturesReport = { asked: 0, found: 0, none: 0, failed: 0, identified: 0, unidentified: 0, stopped: false };
  const dueBefore = args.now() - PARROT_ARTIST_PICTURE_RETRY_MS;
  const artists = (await args.query()<{ id: string }>(PARROT_ARTIST_PICTURES_DUE_SQL, [dueBefore])).map((row) => row.id);
  // PAR-META-20: the artists still to ask, so their photos shimmer rather than look missing until the pass answers.
  const waiting = new Set(artists);
  const settle = (id: string) => {
    if (waiting.delete(id)) args.onWaiting?.([...waiting]);
  };
  args.onWaiting?.([...waiting]);
  let pending: ParrotLibraryOp[] = [];
  const flush = async (): Promise<boolean> => {
    if (pending.length === 0) return true;
    const ops = pending;
    pending = [];
    const kept = await args.publish(ops);
    // An artist stays "on its way" until its batch is kept, so its photo never flashes "no photo" first.
    for (const op of ops) if (op.type === "artist.upsert") settle(op.payload.id);
    return kept;
  };
  let first = true;
  let failedInARow = 0;
  try {
    for (const [index, id] of artists.entries()) {
      args.onProgress?.(index, artists.length);
      if (args.signal?.aborted) {
        report.stopped = true;
        break;
      }
      const artist = await dueArtist(args.query(), id, dueBefore);
      if (!artist) {
        settle(id);
        continue;
      }
      if (!first) await args.sleep(gapMs);
      first = false;
      if (args.signal?.aborted || (args.canSpend && !(await args.canSpend()))) {
        report.stopped = true;
        break;
      }
      let musicId = artist.musicId;
      let picture: Pick<ArtistRow, "pictureObjectKey" | "pictureThumbObjectKey" | "pictureCredit"> | null = null;
      try {
        if (!musicId) {
          musicId = await identifyArtist(args, artist, gapMs);
          if (musicId) {
            report.identified += 1;
            await args.sleep(gapMs);
          } else report.unidentified += 1;
        }
      } catch (error) {
        report.failed += 1;
        failedInARow += 1;
        settle(id);
        const next = args.onError(error, failedInARow);
        if (next.kind === "stop") {
          report.stopped = true;
          break;
        }
        if (next.kind === "wait") await args.sleep(next.ms);
        continue;
      }
      if (musicId) report.asked += 1;
      try {
        const { image } = musicId ? await args.lookup(musicId) : { image: null };
        const copies = image ? await args.makeCopies(args.fromBase64(image.base64)) : null;
        picture = image && copies
          ? { pictureObjectKey: await args.store(copies.large), pictureThumbObjectKey: copies.thumb ? await args.store(copies.thumb) : null, pictureCredit: image.credit }
          : null;
      } catch (error) {
        report.failed += 1;
        failedInARow += 1;
        settle(id);
        const next = args.onError(error, failedInARow);
        if (next.kind === "stop") {
          report.stopped = true;
          break;
        }
        if (next.kind === "wait") await args.sleep(next.ms);
        continue;
      }
      failedInARow = 0;
      if (picture) report.found += 1;
      else if (musicId) report.none += 1;
      const now = args.now();
      pending.push(createParrotOp("artist.upsert", { ...artist, musicId, ...picture, pictureTriedAt: now }, { id: args.newId(), createdAt: new Date(now).toISOString() }));
      if (pending.length >= batchSize && !(await flush())) {
        report.stopped = true;
        return report;
      }
    }
    if (!(await flush())) report.stopped = true;
    return report;
  } finally {
    waiting.clear();
    args.onWaiting?.([]);
  }
};

/**
 * The pass's ops planned again on `query`'s library (another device published meanwhile): artists gone are left out,
 * and each op takes the artist's current name and id, so a rename made elsewhere is never undone by the photo.
 */
export const rebaseParrotArtistPictureOps = async (query: ParrotLibraryQuery, ops: readonly ParrotLibraryOp[]): Promise<ParrotLibraryOp[]> => {
  const rebased: ParrotLibraryOp[] = [];
  for (const op of ops) {
    if (op.type !== "artist.upsert") continue;
    const current = (await query<ArtistRow>(ARTIST_ROW_SQL, [op.payload.id]))[0];
    if (current) rebased.push({ ...op, payload: { ...op.payload, musicId: current.musicId ?? op.payload.musicId, name: current.name, sortName: current.sortName } });
  }
  return rebased;
};
