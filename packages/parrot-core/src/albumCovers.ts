/**
 * Album covers (PAR-META-07, PAR-META-20): every album with no cover yet whose identity is known (its id in the
 * metadata) is asked for one on its own, without a button press — after the library loads, like the artist
 * photos pass (PAR-META-15). A cover an import could not fetch (the lookup was down, too slow) arrives later this way.
 * A found cover is copied into the user's own storage (PAR-COPY-01: a large and a small sealed copy). The device
 * remembers when it asked (`asked`), so an album the lookup has no cover for is asked again only once
 * `PARROT_ALBUM_COVER_RETRY_MS` has passed; a lookup that fails remembers nothing, so the next pass asks again.
 * The albums still to ask are reported (`onWaiting`) so their tiles shimmer instead of showing "no cover".
 */
import type { MusicCoverSize, MusicImage } from "@space/shared/api";
import { createParrotOp, type AlbumRow, type ParrotLibraryOp } from "@space/parrot-library-db-definition";
import type { ParrotAutoLyricsOnError, ParrotCanSpend } from "./autoLyrics";
import type { ParrotCoverCopies } from "./covers";
import type { ParrotLibraryQuery } from "./manage";

/** An album the lookup had no cover for is asked again after this long (a cover may have been added since). */
export const PARROT_ALBUM_COVER_RETRY_MS = 30 * 24 * 60 * 60_000;
/** One album every 1.5 s, as the lyrics and artist-photo passes. */
export const PARROT_AUTO_ALBUM_COVERS_GAP_MS = 1500;
export const PARROT_AUTO_ALBUM_COVERS_BATCH = 10;
/** The size asked for: the large copy is made from it, the small one too. */
export const PARROT_AUTO_ALBUM_COVER_SIZE: MusicCoverSize = 1200;

const ALBUM_ROW_SQL = `SELECT id, title, album_artist_id AS albumArtistId, year, kind, music_id AS musicId,
  music_edition_id AS musicEditionId, cover_object_key AS coverObjectKey, cover_thumb_object_key AS coverThumbObjectKey,
  created_at AS createdAt FROM albums WHERE id = ?`;

/** Albums with no cover and a known id, in the library's order (artist, then title). */
export const PARROT_ALBUM_COVERS_DUE_SQL = `SELECT al.id AS id FROM albums al LEFT JOIN artists ar ON ar.id = al.album_artist_id
  WHERE al.cover_object_key IS NULL AND al.music_id IS NOT NULL AND trim(al.music_id) <> ''
  ORDER BY ar.sort_name COLLATE NOCASE, al.title COLLATE NOCASE, al.id`;

/** When this device last asked for an album's cover and got an answer (found or none); kept on the device only. */
export type ParrotAlbumCoversAsked = {
  at: (albumId: string) => number | null;
  mark: (albumId: string, at: number) => void;
};

export type ParrotAutoAlbumCoversReport = { asked: number; found: number; none: number; failed: number; stopped: boolean };

export type ParrotAutoAlbumCoversArgs = {
  /** Read fresh at the start of each album, so an album deleted or given a cover meanwhile is not asked. */
  query: () => ParrotLibraryQuery;
  lookup: (albumId: string, size: MusicCoverSize) => Promise<{ cover: MusicImage | null }>;
  fromBase64: (base64: string) => Uint8Array;
  /** The large and small copies; null skips a picture that cannot be kept (counted as none). */
  makeCopies: (bytes: Uint8Array) => ParrotCoverCopies | null | Promise<ParrotCoverCopies | null>;
  /** Seals one copy with the library key and stores it; resolves to its object key. */
  store: (bytes: Uint8Array) => Promise<string>;
  /** Keeps a batch of ops in the library (publishes it); a refusal stops the pass. */
  publish: (ops: ParrotLibraryOp[]) => Promise<boolean>;
  asked: ParrotAlbumCoversAsked;
  /** Shared with the lyrics pass (`parrotAutoLyricsOnError`): a 503 pause is waited out, no ticket stops the pass. */
  onError: ParrotAutoLyricsOnError;
  /** The albums this pass still has to ask (empty at the end): their covers show as on their way. */
  onWaiting?: (albumIds: readonly string[]) => void;
  /** (0, total) once the list is known, (index, total) as each album starts, (total, total) at the end. */
  onProgress?: (done: number, total: number) => void;
  /** The ticket floor (PAR-COPY-01): false stops the pass before that album's lookup. */
  canSpend?: ParrotCanSpend;
  now: () => number;
  newId: () => string;
  sleep: (ms: number) => Promise<void>;
  /** Stops the pass between albums (sign-out, app quit); what was found so far is still published. */
  signal?: AbortSignal;
  gapMs?: number;
  batchSize?: number;
};

/** The albums due a cover: no cover, a known id, not answered on this device lately. */
export const parrotAlbumCoversDue = async (query: ParrotLibraryQuery, asked: ParrotAlbumCoversAsked, now: number): Promise<string[]> => {
  const dueBefore = now - PARROT_ALBUM_COVER_RETRY_MS;
  return (await query<{ id: string }>(PARROT_ALBUM_COVERS_DUE_SQL)).map((row) => row.id).filter((id) => (asked.at(id) ?? -Infinity) < dueBefore);
};

const coverlessAlbum = async (query: ParrotLibraryQuery, id: string): Promise<AlbumRow | null> => {
  const row = (await query<AlbumRow>(ALBUM_ROW_SQL, [id]))[0];
  return row && !row.coverObjectKey && row.musicId ? row : null;
};

/** Runs one pass over the albums due a cover; resolves with what it did. */
export const runParrotAutoAlbumCovers = async (args: ParrotAutoAlbumCoversArgs): Promise<ParrotAutoAlbumCoversReport> => {
  const gapMs = args.gapMs ?? PARROT_AUTO_ALBUM_COVERS_GAP_MS;
  const batchSize = Math.max(1, args.batchSize ?? PARROT_AUTO_ALBUM_COVERS_BATCH);
  const report: ParrotAutoAlbumCoversReport = { asked: 0, found: 0, none: 0, failed: 0, stopped: false };
  const due = await parrotAlbumCoversDue(args.query(), args.asked, args.now());
  const waiting = new Set(due);
  const settle = (id: string) => {
    if (waiting.delete(id)) args.onWaiting?.([...waiting]);
  };
  args.onWaiting?.([...waiting]);
  args.onProgress?.(0, due.length);
  let pending: ParrotLibraryOp[] = [];
  const flush = async (): Promise<boolean> => {
    if (pending.length === 0) return true;
    const ops = pending;
    pending = [];
    const kept = await args.publish(ops);
    // A found cover stays "on its way" until its batch is kept, so the tile never flashes "no cover" first.
    for (const op of ops) if (op.type === "album.upsert") settle(op.payload.id);
    return kept;
  };
  let first = true;
  let failedInARow = 0;
  try {
    for (const [index, id] of due.entries()) {
      if (args.signal?.aborted) {
        report.stopped = true;
        break;
      }
      args.onProgress?.(index, due.length);
      const album = await coverlessAlbum(args.query(), id);
      if (!album?.musicId) {
        settle(id);
        continue;
      }
      if (!first) await args.sleep(gapMs);
      first = false;
      if (args.signal?.aborted || (args.canSpend && !(await args.canSpend()))) {
        report.stopped = true;
        break;
      }
      report.asked += 1;
      let keys: { coverObjectKey: string; coverThumbObjectKey: string | null } | null = null;
      try {
        const { cover } = await args.lookup(album.musicId, PARROT_AUTO_ALBUM_COVER_SIZE);
        const copies = cover ? await args.makeCopies(args.fromBase64(cover.base64)) : null;
        keys = copies ? { coverObjectKey: await args.store(copies.large), coverThumbObjectKey: copies.thumb ? await args.store(copies.thumb) : null } : null;
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
      args.asked.mark(id, args.now());
      if (keys) {
        report.found += 1;
        const now = args.now();
        pending.push(createParrotOp("album.upsert", { ...album, ...keys }, { id: args.newId(), createdAt: new Date(now).toISOString() }));
        if (pending.length >= batchSize && !(await flush())) {
          report.stopped = true;
          return report;
        }
      } else {
        report.none += 1;
        settle(id);
      }
    }
    if (!(await flush())) report.stopped = true;
    args.onProgress?.(due.length, due.length);
    return report;
  } finally {
    waiting.clear();
    args.onWaiting?.([]);
  }
};

/**
 * The pass's ops planned again on `query`'s library (another device published meanwhile): albums gone, or given a
 * cover meanwhile, are left out, and each op takes the album's current row, so an edit made elsewhere is never undone.
 */
export const rebaseParrotAlbumCoverOps = async (query: ParrotLibraryQuery, ops: readonly ParrotLibraryOp[]): Promise<ParrotLibraryOp[]> => {
  const rebased: ParrotLibraryOp[] = [];
  for (const op of ops) {
    if (op.type !== "album.upsert") continue;
    const current = await coverlessAlbum(query, op.payload.id);
    if (current) rebased.push({ ...op, payload: { ...current, coverObjectKey: op.payload.coverObjectKey, coverThumbObjectKey: op.payload.coverThumbObjectKey } });
  }
  return rebased;
};
