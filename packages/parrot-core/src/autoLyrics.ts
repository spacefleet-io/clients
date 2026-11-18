/**
 * The automatic lyrics lookup (PAR-LYR-01): every song whose file carried no words is looked up on its own, without a
 * button press — after an import, and once over the songs already in the library (a song with no `lyrics` row at all
 * was never looked up). Each answer becomes a `lyrics.set` op: the words when found, else the "no lyrics" row
 * (`planParrotLyricsNotFound`), so the song is not asked again on its own. A lookup that fails writes nothing: the
 * next pass asks again. Songs are asked one at a time with a gap between them, and found ops are handed over in
 * batches, so a big library is neither a flood of lookups nor one publish per song.
 */
import type { MusicLyrics, MusicLyricsQuery } from "@space/shared/api";
import type { ParrotLibraryOp } from "@space/parrot-library-db-definition";
import { parrotLyricsQuery, planParrotLyrics, planParrotLyricsNotFound } from "./fetchLyrics";
import type { ParrotLibraryQuery } from "./manage";

/** Songs never looked up: no `lyrics` row at all (neither the file's words, nor fetched ones, nor the "no lyrics" row). */
export const PARROT_LYRICS_UNASKED_SQL = `SELECT t.id AS id FROM tracks t LEFT JOIN lyrics l ON l.track_id = t.id
  WHERE l.track_id IS NULL ORDER BY t.album_id, t.disc, t.number, t.id`;

/**
 * What to do after a failed lookup (`failedInARow` counts this one): skip that song (it is asked again next pass), wait
 * then go on, or stop the pass.
 */
export type ParrotAutoLyricsOnError = (error: unknown, failedInARow: number) => { kind: "skip" } | { kind: "wait"; ms: number } | { kind: "stop" };

export type ParrotAutoLyricsReport = { asked: number; found: number; none: number; failed: number; stopped: boolean };

/**
 * The songs a lookup still has to settle (PAR-LYR-06): queued, being asked, or answered but not yet kept in the
 * library. The Lyrics tab shows "Looking for lyrics…" for them instead of "No lyrics yet" or "No lyrics". Each caller
 * (an automatic pass, one "Fetch lyrics") takes its own hold, and a song stays pending while any hold has it, so one
 * caller letting go never clears a song another still asks (an old pass ending after sign-out and sign-in, a pass
 * ending while an album's "Fetch lyrics" still waits on the same song). `clear` (sign-out) drops every hold; the
 * holds taken before it can no longer touch the set.
 */
export type ParrotLyricsHold = {
  /** This holder is done with these songs. */
  settle: (trackIds: readonly string[]) => void;
  /** This holder is done with all its songs. */
  release: () => void;
};

export type ParrotLyricsPending = {
  has: (trackId: string) => boolean;
  /** A new holder of these songs. */
  hold: (trackIds: readonly string[]) => ParrotLyricsHold;
  /**
   * A ticket to queue songs for the next automatic pass, taken before reading which songs they are. It goes stale once
   * a pass takes the queue over or the set is cleared, so a queue that arrives after the next pass started is dropped
   * instead of holding songs nobody will let go of.
   */
  reserveQueue: () => number;
  /** Songs waiting for the next automatic pass, held until that pass takes them over (`takeQueue`); a no-op on a stale ticket. */
  queue: (trackIds: readonly string[], ticket: number) => void;
  /** The pass that starts (or a pass that cannot start) lets go of the queued songs, and makes every ticket stale. */
  takeQueue: () => void;
  /**
   * PAR-COPY-01: a song played or shown that was never looked up goes first in the automatic pass's line, instead of
   * the screen looking it up itself (screens show only the library's copy and never ask the metadata service). The
   * song is pending from now on (PAR-LYR-06); the app then starts a pass, or asks the running one for another.
   */
  want: (trackId: string) => void;
  /** The next wanted song and its hold (the pass lets go of it once its answer is kept); null when none waits. */
  takeWanted: () => { trackId: string; hold: ParrotLyricsHold } | null;
  /** Some wanted song still waits (a pass that just ended starts another for it). */
  hasWanted: () => boolean;
  /** No pass can start (signed out, no library): the wanted songs are let go, so none stays "Looking for lyrics…". */
  dropWanted: () => void;
  clear: () => void;
  /** Called after every change, so an open Lyrics tab reads its song again. Returns the unsubscribe. */
  onChange: (listener: () => void) => () => void;
};

export const createParrotLyricsPending = (): ParrotLyricsPending => {
  const holders = new Map<string, Set<symbol>>();
  const listeners = new Set<() => void>();
  let queued: ParrotLyricsHold | null = null;
  let wanted: Array<{ trackId: string; hold: ParrotLyricsHold }> = [];
  let generation = 0;
  const changed = () => {
    for (const listener of [...listeners]) listener();
  };
  const drop = (owner: symbol, trackIds: Iterable<string>) => {
    let removed = false;
    for (const id of trackIds) {
      const owners = holders.get(id);
      if (!owners?.delete(owner)) continue;
      if (owners.size === 0) {
        holders.delete(id);
        removed = true;
      }
    }
    if (removed) changed();
  };
  const hold = (trackIds: readonly string[]): ParrotLyricsHold => {
    const owner = Symbol("lyrics-hold");
    const mine = new Set(trackIds);
    let added = false;
    for (const id of mine) {
      const owners = holders.get(id) ?? new Set<symbol>();
      if (owners.size === 0) added = true;
      owners.add(owner);
      holders.set(id, owners);
    }
    if (added) changed();
    return {
      settle: (ids) => {
        for (const id of ids) mine.delete(id);
        drop(owner, ids);
      },
      release: () => {
        const ids = [...mine];
        mine.clear();
        drop(owner, ids);
      },
    };
  };
  return {
    has: (trackId) => holders.has(trackId),
    hold,
    reserveQueue: () => generation,
    queue: (trackIds, ticket) => {
      if (ticket !== generation) return;
      const before = queued;
      queued = hold(trackIds);
      before?.release();
    },
    takeQueue: () => {
      generation += 1;
      const before = queued;
      queued = null;
      before?.release();
    },
    want: (trackId) => {
      if (wanted.some((entry) => entry.trackId === trackId)) return;
      wanted.push({ trackId, hold: hold([trackId]) });
    },
    takeWanted: () => wanted.shift() ?? null,
    hasWanted: () => wanted.length > 0,
    dropWanted: () => {
      const before = wanted;
      wanted = [];
      for (const entry of before) entry.hold.release();
    },
    clear: () => {
      generation += 1;
      queued = null;
      wanted = [];
      if (holders.size === 0) return;
      holders.clear();
      changed();
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

export type ParrotAutoLyricsArgs = {
  /** Read fresh at the start of each song, so a song deleted or given words meanwhile is not asked. */
  query: () => ParrotLibraryQuery;
  lookup: (question: MusicLyricsQuery) => Promise<MusicLyrics>;
  /** Keeps a batch of ops in the library (publishes it); a refusal stops the pass. */
  publish: (ops: ParrotLibraryOp[]) => Promise<boolean>;
  onError: ParrotAutoLyricsOnError;
  now: () => number;
  newId: () => string;
  sleep: (ms: number) => Promise<void>;
  /** Stops the pass between songs (sign-out, app quit); what was found so far is still published. */
  signal?: AbortSignal;
  /** Pause between two lookups. */
  gapMs?: number;
  /** Songs per publish. */
  batchSize?: number;
  /** Most songs asked in one pass (the rest wait for the next pass). */
  limit?: number;
  /** Holds the songs this pass still has to settle, for the Lyrics tab's searching state (PAR-LYR-06). */
  pending?: ParrotLyricsPending;
  /** Songs of this pass handled so far, of its total, before each song (the Jobs panel's background line, UX-JOBS-02). */
  onProgress?: (done: number, total: number) => void;
  /** The ticket floor (PAR-COPY-01), asked before each background lookup; a song a screen wanted is asked regardless. */
  canSpend?: ParrotCanSpend;
};

/**
 * Whether a background copy pass (lyrics, album covers, artist photos) may spend one more lookup. The apps answer
 * "the ticket reserve holds more than `PARROT_COPY_TICKET_FLOOR`", so the tickets left are kept for what the user asks
 * (PAR-COPY-01, as Badger's artwork copy does). False stops the pass; the next library load starts another.
 */
export type ParrotCanSpend = () => boolean | Promise<boolean>;

/** agent reading, approved by Main (2026-11-16): the same floor as Badger's artwork copy (reserve 600, refill below 300). */
export const PARROT_COPY_TICKET_FLOOR = 100;

/** agent reading, approved by Main (2026-11-10): one song every 1.5 s keeps a backfill well under the ticket and per-connection limits. */
export const PARROT_AUTO_LYRICS_GAP_MS = 1500;
export const PARROT_AUTO_LYRICS_BATCH = 15;

const unaskedSongs = async (query: ParrotLibraryQuery): Promise<string[]> => (await query<{ id: string }>(PARROT_LYRICS_UNASKED_SQL)).map((row) => row.id);

/**
 * The library loaded while a pass runs: its songs never looked up wait for the next pass, and are pending from now on
 * (PAR-LYR-06), not "No lyrics yet" until that pass starts.
 */
export const queueParrotAutoLyrics = async (query: ParrotLibraryQuery, pending: ParrotLyricsPending): Promise<void> => {
  const ticket = pending.reserveQueue();
  pending.queue(await unaskedSongs(query), ticket);
};

const stillUnasked = async (query: ParrotLibraryQuery, trackId: string): Promise<boolean> =>
  (await query<{ n: number }>("SELECT COUNT(*) AS n FROM tracks t WHERE t.id = ? AND NOT EXISTS (SELECT 1 FROM lyrics l WHERE l.track_id = t.id)", [trackId]))[0]?.n === 1;

/** Runs one pass over the songs never looked up; resolves with what it did. */
export const runParrotAutoLyrics = async (args: ParrotAutoLyricsArgs): Promise<ParrotAutoLyricsReport> => {
  const gapMs = args.gapMs ?? PARROT_AUTO_LYRICS_GAP_MS;
  const batchSize = Math.max(1, args.batchSize ?? PARROT_AUTO_LYRICS_BATCH);
  const report: ParrotAutoLyricsReport = { asked: 0, found: 0, none: 0, failed: 0, stopped: false };
  let songs: string[];
  // This pass's own hold: ending it never clears a song a "Fetch lyrics" or a later pass still holds. It takes the
  // queue over even when reading its songs fails, so the queued songs never stay "searching" with no pass to ask them.
  let hold: ParrotLyricsHold | undefined;
  try {
    songs = (await unaskedSongs(args.query())).slice(0, args.limit ?? Number.POSITIVE_INFINITY);
    hold = args.pending?.hold(songs);
  } catch (error) {
    // Nor are the wanted songs left "searching" by a pass that never ran.
    args.pending?.dropWanted();
    throw error;
  } finally {
    args.pending?.takeQueue();
  }
  // Songs a screen wanted (PAR-COPY-01) go first, each held by its own hold until its answer is kept.
  const wantedHolds = new Map<string, ParrotLyricsHold>();
  const settle = (trackIds: readonly string[]) => {
    hold?.settle(trackIds);
    for (const id of trackIds) {
      wantedHolds.get(id)?.release();
      wantedHolds.delete(id);
    }
  };
  let pending: ParrotLibraryOp[] = [];
  const flush = async (): Promise<boolean> => {
    if (pending.length === 0) return true;
    const ops = pending;
    pending = [];
    try {
      return await args.publish(ops);
    } finally {
      settle(ops.flatMap((op) => (op.type === "lyrics.set" ? [op.payload.trackId] : [])));
    }
  };
  let first = true;
  let failedInARow = 0;
  let index = 0;
  const done = new Set<string>();
  const nextSong = (): string | null => {
    for (let wanted = args.pending?.takeWanted(); wanted; wanted = args.pending?.takeWanted()) {
      if (done.has(wanted.trackId) || wantedHolds.has(wanted.trackId)) {
        wanted.hold.release();
        continue;
      }
      wantedHolds.set(wanted.trackId, wanted.hold);
      return wanted.trackId;
    }
    while (index < songs.length) {
      const trackId = songs[index]!;
      index += 1;
      if (!done.has(trackId)) return trackId;
    }
    return null;
  };
  let ended = false;
  try {
    while (true) {
      let trackId = nextSong();
      if (trackId === null) {
        // Answers still waiting are kept first; a song wanted meanwhile is then asked in this same pass.
        if (!(await flush())) {
          report.stopped = true;
          return report;
        }
        trackId = nextSong();
        if (trackId === null) break;
      }
      done.add(trackId);
      args.onProgress?.(Math.min(index, songs.length) - (wantedHolds.has(trackId) ? 0 : 1), songs.length);
      if (args.signal?.aborted) {
        report.stopped = true;
        break;
      }
      const query = args.query();
      if (!(await stillUnasked(query, trackId))) {
        settle([trackId]);
        continue;
      }
      const question = await parrotLyricsQuery(query, trackId);
      // No artist or title to ask with: nothing can be found until the user names the song (PAR-META-16), so it stays unasked.
      if (!question) {
        settle([trackId]);
        continue;
      }
      if (!first) await args.sleep(gapMs);
      first = false;
      if (args.signal?.aborted || (!wantedHolds.has(trackId) && args.canSpend && !(await args.canSpend()))) {
        report.stopped = true;
        break;
      }
      report.asked += 1;
      let answer: MusicLyrics;
      try {
        answer = await args.lookup(question);
      } catch (error) {
        report.failed += 1;
        failedInARow += 1;
        settle([trackId]);
        const next = args.onError(error, failedInARow);
        if (next.kind === "stop") {
          report.stopped = true;
          break;
        }
        if (next.kind === "wait") await args.sleep(next.ms);
        continue;
      }
      failedInARow = 0;
      const ctx = { now: args.now(), newId: args.newId };
      const op = planParrotLyrics(trackId, answer, ctx);
      if (op) report.found += 1;
      else report.none += 1;
      pending.push(op ?? planParrotLyricsNotFound(trackId, ctx));
      if (pending.length >= batchSize && !(await flush())) {
        report.stopped = true;
        return report;
      }
    }
    if (!(await flush())) report.stopped = true;
    ended = true;
    return report;
  } finally {
    // A stopped or failed pass leaves nothing pending: those songs say "No lyrics yet" until the next pass, and the
    // songs a screen wanted meanwhile are let go too (the screen offers "Search again"), never a new pass at once.
    hold?.release();
    for (const wanted of wantedHolds.values()) wanted.release();
    if (!ended || report.stopped) args.pending?.dropWanted();
  }
};

/** Failures in a row after which a pass gives up (the lookup is down or out of tickets): the next pass tries again. */
export const PARROT_AUTO_LYRICS_MAX_FAILURES = 5;
const MAX_WAIT_MS = 10 * 60_000;

/**
 * The polite answer to a failed lookup, shared by every app: no ticket left stops the pass (the reserve refills on its
 * own schedule, META-ANON-02); a busy or rate-limited lookup (429/503) is waited out, longer each time it repeats, as
 * long as it says (`Retry-After`) when it says; anything else skips the song; five failures in a row stop the pass.
 * Errors are told apart by name, as `@space/metadata-client` throws them.
 */
export const parrotAutoLyricsOnError: ParrotAutoLyricsOnError = (error, failedInARow) => {
  const name = error instanceof Error ? error.name : "";
  if (name === "NoTicketError" || failedInARow >= PARROT_AUTO_LYRICS_MAX_FAILURES) return { kind: "stop" };
  if (name === "MetadataUnavailableError") {
    const retryAfter = (error as { retryAfterSeconds?: number }).retryAfterSeconds;
    const backoff = 30_000 * 2 ** (failedInARow - 1);
    return { kind: "wait", ms: Math.min(MAX_WAIT_MS, Math.max(backoff, (retryAfter ?? 0) * 1000)) };
  }
  return { kind: "skip" };
};
