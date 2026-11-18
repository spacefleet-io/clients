/**
 * Refresh through one list per copy (PAR-COPY-01): when our music copy changes an album's details (its title, year or
 * track list), the user's stored copy of that album follows, unless the user edited the album by hand. The app never
 * asks about its albums one by one: at library sync, at most once a day (`PARROT_COPY_CHECK_EVERY_MS`), it asks ONE
 * list — the albums each copy published since the one it last saw changed, the same list for every user — and looks
 * up only the albums it holds that are on it, by their id and against the newest copy. A first check only records
 * where the copies stand. A song keeps a title the user gave it: only a song whose title still is the old track
 * list's takes the new one.
 */
import type { MusicAlbum, MusicAlbumTrack, MusicAlbumsQuery, MusicCopyChanges } from "@space/shared/api";
import {
  createParrotOp,
  parseParrotTracklist,
  type AlbumRow,
  type ParrotLibraryOp,
  type ParrotListedTrack,
  type TrackRow,
} from "@space/parrot-library-db-definition";
import type { ParrotAutoLyricsOnError, ParrotCanSpend } from "./autoLyrics";
import type { ParrotLibraryQuery } from "./manage";

/** A device asks for the list at most once a day; a new copy lands twice a week at most. */
export const PARROT_COPY_CHECK_EVERY_MS = 24 * 60 * 60_000;
/** One album every 1.5 s, as the other lookup passes. */
export const PARROT_COPY_CHANGES_GAP_MS = 1500;
/** Albums refreshed per published batch. */
export const PARROT_COPY_CHANGES_BATCH = 10;

/** What this device remembers (kept on the device only): when it last asked, and the copy it has caught up with. */
export type ParrotCopyCheck = { checkedAt: number | null; version: string | null };

export type ParrotCopyChangesReport = {
  /** False when the last check is less than a day old (nothing asked). */
  checked: boolean;
  /** The copy this device has caught up with after the pass. */
  version: string | null;
  /** Distinct albums on the lists since the remembered copy. */
  listed: number;
  /** Of those, the albums this library holds (edited ones included). */
  held: number;
  refreshed: number;
  /** Looked up, but the copy's details match the stored ones (or the album is no longer in the copy). */
  unchanged: number;
  /** Held, but edited by hand: never looked up. */
  edited: number;
  failed: number;
  stopped: boolean;
};

export type ParrotCopyChangesArgs = {
  /** Read fresh for each album, so an album edited or deleted meanwhile is not refreshed. */
  query: () => ParrotLibraryQuery;
  /** The lists since `since` (`musicCopyChanges`); null asks only where the copies stand. */
  changes: (since: string | null) => Promise<MusicCopyChanges>;
  /** One held album, by its id, against the newest copy (`musicAlbums`). */
  albums: (question: MusicAlbumsQuery) => Promise<{ results: MusicAlbum[] }>;
  /** Keeps a batch of ops in the library (publishes it); a refusal stops the pass. */
  publish: (ops: ParrotLibraryOp[]) => Promise<boolean>;
  memory: { read: () => ParrotCopyCheck; write: (next: ParrotCopyCheck) => void };
  /** Shared with the lyrics pass (`parrotAutoLyricsOnError`): a 503 pause is waited out, no ticket stops the pass. */
  onError: ParrotAutoLyricsOnError;
  /** The ticket floor (PAR-COPY-01): false stops the pass before its next lookup, the list included. */
  canSpend?: ParrotCanSpend;
  now: () => number;
  newId: () => string;
  sleep: (ms: number) => Promise<void>;
  /** Stops the pass between albums (sign-out, app quit); nothing is remembered, the next sync asks again. */
  signal?: AbortSignal;
  gapMs?: number;
  batchSize?: number;
};

type HeldAlbum = AlbumRow & { tracklistJson: string | null; handEdited: number; artistName: string | null };

const HELD_ALBUM_SQL = `SELECT al.id, al.title, al.album_artist_id AS albumArtistId, al.year, al.kind,
  al.music_id AS musicId, al.music_edition_id AS musicEditionId, al.cover_object_key AS coverObjectKey,
  al.cover_thumb_object_key AS coverThumbObjectKey, al.created_at AS createdAt, al.genre, al.tracklist AS tracklistJson,
  (al.edited = 1 OR al.year_edited = 1 OR al.genre_edited = 1) AS handEdited, ar.name AS artistName
  FROM albums al LEFT JOIN artists ar ON ar.id = al.album_artist_id`;

const TRACK_SQL = `SELECT id, album_id AS albumId, disc, number, title, artist_id AS artistId, duration_ms AS durationMs,
  music_id AS musicId, year, genre FROM tracks`;

/** SQLite caps bound parameters; the lists are short, but a long-missed device may hold many listed albums. */
const CHUNK = 400;

const heldAlbums = async (query: ParrotLibraryQuery, albumIds: readonly string[]): Promise<HeldAlbum[]> => {
  const rows: HeldAlbum[] = [];
  for (let i = 0; i < albumIds.length; i += CHUNK) {
    const chunk = albumIds.slice(i, i + CHUNK);
    rows.push(
      ...(await query<HeldAlbum>(
        `${HELD_ALBUM_SQL} WHERE lower(al.music_id) IN (${chunk.map(() => "?").join(", ")})
         ORDER BY al.title COLLATE NOCASE, al.id`,
        chunk
      ))
    );
  }
  return rows;
};

const heldAlbum = async (query: ParrotLibraryQuery, id: string) => (await query<HeldAlbum>(`${HELD_ALBUM_SQL} WHERE al.id = ?`, [id]))[0] ?? null;

const albumTracks = (query: ParrotLibraryQuery, albumId: string) => query<TrackRow>(`${TRACK_SQL} WHERE album_id = ? ORDER BY disc, number`, [albumId]);

const slot = (disc: number, number: number | null) => `${disc}:${number ?? 0}`;

const toListed = (tracks: readonly MusicAlbumTrack[]): ParrotListedTrack[] =>
  tracks.map(({ disc, number, title, durationMs }) => ({ disc, number, title, durationMs }));

/** The album row as an op payload: only the album's own columns, its hand-edit flags left as they are. */
const albumPayload = (album: HeldAlbum): AlbumRow => ({
  id: album.id,
  title: album.title,
  albumArtistId: album.albumArtistId,
  year: album.year,
  kind: album.kind,
  musicId: album.musicId,
  musicEditionId: album.musicEditionId,
  coverObjectKey: album.coverObjectKey,
  coverThumbObjectKey: album.coverThumbObjectKey,
  createdAt: album.createdAt,
  genre: album.genre ?? null,
});

const sameListed = (a: readonly ParrotListedTrack[] | null, b: readonly ParrotListedTrack[]) => JSON.stringify(a ?? []) === JSON.stringify(b);

/**
 * The ops that bring a held album to the copy's details: the album's title, year and track list (its cover and the
 * user's flags kept), and each song whose title still is the old track list's at its place and whose recording the
 * copy keeps there. Empty when nothing differs.
 */
const planRefresh = async (query: ParrotLibraryQuery, album: HeldAlbum, found: MusicAlbum, meta: () => { id: string; createdAt: string }) => {
  const oldListed = parseParrotTracklist(album.tracklistJson);
  const newListed = toListed(found.tracks);
  const ops: ParrotLibraryOp[] = [];
  const newBySlot = new Map(found.tracks.map((t) => [slot(t.disc, t.number), t]));
  const oldBySlot = new Map((oldListed ?? []).map((t) => [slot(t.disc, t.number), t]));
  for (const track of await albumTracks(query, album.id)) {
    const was = oldBySlot.get(slot(track.disc, track.number));
    const now = newBySlot.get(slot(track.disc, track.number));
    if (!was || !now || was.title !== track.title || now.title === track.title) continue;
    if (!track.musicId || now.id !== track.musicId) continue;
    ops.push(createParrotOp("track.upsert", { ...track, title: now.title }, meta()));
  }
  const albumChanged = found.title !== album.title || found.year !== album.year || (newListed.length > 0 && !sameListed(oldListed, newListed));
  if (albumChanged || ops.length > 0) {
    ops.unshift(
      createParrotOp(
        "album.upsert",
        { ...albumPayload(album), title: found.title, year: found.year ?? album.year, tracklist: newListed.length ? newListed : null },
        meta()
      )
    );
  }
  return ops;
};

/** Runs one check: asks the list when due, refreshes the held albums on it; resolves with what it did. */
export const runParrotCopyChanges = async (args: ParrotCopyChangesArgs): Promise<ParrotCopyChangesReport> => {
  const remembered = args.memory.read();
  const report: ParrotCopyChangesReport = {
    checked: false,
    version: remembered.version,
    listed: 0,
    held: 0,
    refreshed: 0,
    unchanged: 0,
    edited: 0,
    failed: 0,
    stopped: false,
  };
  if (remembered.checkedAt !== null && args.now() - remembered.checkedAt < PARROT_COPY_CHECK_EVERY_MS) return report;
  if (args.signal?.aborted || (args.canSpend && !(await args.canSpend()))) {
    report.stopped = true;
    return report;
  }
  let answer: MusicCopyChanges;
  try {
    answer = await args.changes(remembered.version);
  } catch (error) {
    report.failed += 1;
    report.stopped = args.onError(error, 1).kind === "stop";
    return report;
  }
  report.checked = true;
  // A first check (or a service with no copy yet) only records where the copies stand.
  if (remembered.version === null || answer.version === null) {
    report.version = answer.version ?? remembered.version;
    args.memory.write({ checkedAt: args.now(), version: report.version });
    return report;
  }
  const listed = [...new Set(answer.changes.flatMap((c) => c.albums.map((a) => a.toLowerCase())))];
  report.listed = listed.length;
  const held = await heldAlbums(args.query(), listed);
  report.held = held.length;

  const gapMs = args.gapMs ?? PARROT_COPY_CHANGES_GAP_MS;
  const batchSize = Math.max(1, args.batchSize ?? PARROT_COPY_CHANGES_BATCH);
  const meta = () => ({ id: args.newId(), createdAt: new Date(args.now()).toISOString() });
  let pending: ParrotLibraryOp[] = [];
  let pendingAlbums = 0;
  const flush = async () => {
    if (pending.length === 0) return true;
    const ops = pending;
    pending = [];
    pendingAlbums = 0;
    return args.publish(ops);
  };
  let first = true;
  let failedInARow = 0;
  for (const listedAlbum of held) {
    if (args.signal?.aborted) {
      report.stopped = true;
      return report;
    }
    // Read again: an album edited or deleted since the list was read is left alone.
    const album = await heldAlbum(args.query(), listedAlbum.id);
    if (!album?.musicId) continue;
    if (album.handEdited) {
      report.edited += 1;
      continue;
    }
    if (!first) await args.sleep(gapMs);
    first = false;
    if (args.signal?.aborted || (args.canSpend && !(await args.canSpend()))) {
      report.stopped = true;
      return report;
    }
    let found: MusicAlbum | undefined;
    try {
      const { results } = await args.albums({
        artist: album.artistName ?? "",
        album: album.title,
        id: album.musicId,
        copyVersion: answer.version,
        limit: 1,
      });
      found = results.find((r) => r.id?.toLowerCase() === album.musicId?.toLowerCase());
    } catch (error) {
      report.failed += 1;
      failedInARow += 1;
      const next = args.onError(error, failedInARow);
      if (next.kind === "stop") {
        report.stopped = true;
        return report;
      }
      if (next.kind === "wait") await args.sleep(next.ms);
      continue;
    }
    failedInARow = 0;
    const ops = found ? await planRefresh(args.query(), album, found, meta) : [];
    if (ops.length === 0) {
      report.unchanged += 1;
      continue;
    }
    report.refreshed += 1;
    pending.push(...ops);
    pendingAlbums += 1;
    if (pendingAlbums >= batchSize && !(await flush())) {
      report.stopped = true;
      return report;
    }
  }
  if (!(await flush())) {
    report.stopped = true;
    return report;
  }
  // A failed lookup keeps the old mark: tomorrow's check asks the same lists again.
  report.version = report.failed > 0 ? remembered.version : answer.version;
  args.memory.write({ checkedAt: args.now(), version: report.version });
  return report;
};

/**
 * The pass's ops planned again on `query`'s library (another device published meanwhile): an album edited by hand or
 * deleted meanwhile is left out with its songs, each op takes the current row, and a song keeps a title given to it
 * meanwhile (only a song whose title still is the stored track list's takes the new one).
 */
export const rebaseParrotCopyRefreshOps = async (query: ParrotLibraryQuery, ops: readonly ParrotLibraryOp[]): Promise<ParrotLibraryOp[]> => {
  const rebased: ParrotLibraryOp[] = [];
  const kept = new Map<string, HeldAlbum>();
  for (const op of ops) {
    if (op.type !== "album.upsert") continue;
    const current = await heldAlbum(query, op.payload.id);
    if (!current || current.handEdited) continue;
    kept.set(current.id, current);
    rebased.push({ ...op, payload: { ...albumPayload(current), title: op.payload.title, year: op.payload.year, tracklist: op.payload.tracklist ?? null } });
  }
  for (const op of ops) {
    if (op.type !== "track.upsert") continue;
    const album = kept.get(op.payload.albumId);
    if (!album) continue;
    const [current] = await query<TrackRow>(`${TRACK_SQL} WHERE id = ?`, [op.payload.id]);
    if (!current || current.albumId !== album.id || current.musicId !== op.payload.musicId) continue;
    const was = parseParrotTracklist(album.tracklistJson)?.find((t) => slot(t.disc, t.number) === slot(current.disc, current.number));
    if (was?.title !== current.title) continue;
    rebased.push({ ...op, payload: { ...current, title: op.payload.title } });
  }
  return rebased;
};
