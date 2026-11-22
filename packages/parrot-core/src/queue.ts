// The play queue (PAR-SCOPE-01): what plays now, what comes next, play next, add to queue, shuffle and repeat.
// Immutable: every operation returns a new queue, so a React state, a store or a test holds it the same way.

export type RepeatMode = "off" | "all" | "one";

/** One place in the queue. `key` tells two entries of the same song apart (a song can be queued twice). */
export type QueueEntry<T> = { key: number; track: T };

export type PlayQueue<T> = {
  /** Play order: `entries[position]` plays now, the ones before it have played. */
  entries: QueueEntry<T>[];
  /** The same entries in the order they were queued, which shuffle-off returns to. */
  queued: QueueEntry<T>[];
  /** -1 when the queue is empty. */
  position: number;
  shuffle: boolean;
  repeat: RepeatMode;
  nextKey: number;
};

export const emptyQueue = <T>(): PlayQueue<T> => ({
  entries: [],
  queued: [],
  position: -1,
  shuffle: false,
  repeat: "off",
  nextKey: 0,
});

const shuffled = <E>(items: E[], random: () => number): E[] => {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
};

const keyed = <T>(tracks: readonly T[], from: number): QueueEntry<T>[] =>
  tracks.map((track, index) => ({ key: from + index, track }));

/** The entry playing now, or null. */
export const currentEntry = <T>(queue: PlayQueue<T>): QueueEntry<T> | null => queue.entries[queue.position] ?? null;

/** The entries still to play after the current one, in play order. */
export const upcoming = <T>(queue: PlayQueue<T>): QueueEntry<T>[] => queue.entries.slice(queue.position + 1);

/**
 * Starts `tracks[startIndex]` and queues the rest after it (an album or an artist played from a song). Shuffle and
 * repeat carry over from `previous`; with shuffle on, the started song plays first and the rest are mixed.
 */
export const startQueue = <T>(
  tracks: readonly T[],
  startIndex: number,
  previous: Pick<PlayQueue<T>, "shuffle" | "repeat" | "nextKey"> = emptyQueue<T>(),
  random: () => number = Math.random
): PlayQueue<T> => {
  if (tracks.length === 0) return { ...emptyQueue<T>(), shuffle: previous.shuffle, repeat: previous.repeat, nextKey: previous.nextKey };
  const start = Math.min(Math.max(0, startIndex), tracks.length - 1);
  const queued = keyed(tracks, previous.nextKey);
  const first = queued[start]!;
  const entries = previous.shuffle ? [first, ...shuffled(queued.filter((entry) => entry !== first), random)] : queued;
  return {
    entries,
    queued,
    position: previous.shuffle ? 0 : start,
    shuffle: previous.shuffle,
    repeat: previous.repeat,
    nextKey: previous.nextKey + tracks.length,
  };
};

/**
 * Shuffle on an album, an artist or a playlist (its card's menu, "Jump back in"): the queue is cleared and `tracks` play
 * in a random order, starting with a random song, with shuffle left on. Repeat carries over from `previous`.
 */
export const shuffleQueue = <T>(
  tracks: readonly T[],
  previous: Pick<PlayQueue<T>, "repeat" | "nextKey"> = emptyQueue<T>(),
  random: () => number = Math.random
): PlayQueue<T> => startQueue(tracks, Math.floor(random() * tracks.length), { ...previous, shuffle: true }, random);

/**
 * The queue after the current song, or null when playback stops. `ended` is the song finishing on its own: repeat-one
 * plays it again then, while a skip always moves on. At the end, repeat-all starts over and repeat off stops.
 */
export const advance = <T>(queue: PlayQueue<T>, reason: "ended" | "skip"): PlayQueue<T> | null => {
  if (queue.position < 0) return null;
  if (reason === "ended" && queue.repeat === "one") return queue;
  if (queue.position + 1 < queue.entries.length) return { ...queue, position: queue.position + 1 };
  if (queue.repeat === "all") return { ...queue, position: 0 };
  return null;
};

/** The previous song; the first song stays (repeat-all wraps to the last). */
export const goBack = <T>(queue: PlayQueue<T>): PlayQueue<T> => {
  if (queue.position > 0) return { ...queue, position: queue.position - 1 };
  if (queue.repeat === "all" && queue.entries.length > 0) return { ...queue, position: queue.entries.length - 1 };
  return queue;
};

/** Plays the entry at `index` of the play order. */
export const jumpTo = <T>(queue: PlayQueue<T>, index: number): PlayQueue<T> =>
  index >= 0 && index < queue.entries.length ? { ...queue, position: index } : queue;

const insertAfter = <T>(list: QueueEntry<T>[], anchor: QueueEntry<T> | null, added: QueueEntry<T>[]) => {
  const at = anchor ? list.indexOf(anchor) + 1 : list.length;
  return [...list.slice(0, at), ...added, ...list.slice(at)];
};

/** Who a song is: its id for the apps' song rows; the song itself where the queue holds plain ids (the tests). */
export type SongIdentity<T> = (track: T) => unknown;

const itself = <T>(track: T): unknown => track;

/**
 * PAR-CARD-02: of `tracks`, the songs not yet in `taken` (the song playing and Up next), each once, in their order. Play
 * next and Add to queue add only these, so a song sits in Up next at most once.
 */
export const notYetQueued = <T>(taken: Iterable<unknown>, tracks: readonly T[], idOf: SongIdentity<T> = itself): T[] => {
  const seen = new Set(taken);
  return tracks.filter((track) => {
    const id = idOf(track);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
};

/** The songs of `tracks` that Play next or Add to queue would add to `queue`: none already playing or in Up next. */
export const newToUpNext = <T>(queue: PlayQueue<T>, tracks: readonly T[], idOf: SongIdentity<T> = itself): T[] =>
  notYetQueued(
    queue.entries.slice(Math.max(queue.position, 0)).map((entry) => idOf(entry.track)),
    tracks,
    idOf
  );

/**
 * Puts `tracks` right after the current song (in that order); into an empty queue they start playing. Songs already
 * playing or in Up next stay where they are and are not added again (PAR-CARD-02).
 */
export const playNext = <T>(queue: PlayQueue<T>, tracks: readonly T[], idOf: SongIdentity<T> = itself): PlayQueue<T> => {
  const fresh = newToUpNext(queue, tracks, idOf);
  if (fresh.length === 0) return queue;
  const added = keyed(fresh, queue.nextKey);
  const current = currentEntry(queue);
  return {
    ...queue,
    entries: insertAfter(queue.entries, current, added),
    queued: insertAfter(queue.queued, current, added),
    position: current ? queue.position : queue.entries.length,
    nextKey: queue.nextKey + fresh.length,
  };
};

/**
 * Adds `tracks` at the end of the queue; into an empty queue they start playing. Songs already playing or in Up next
 * are not added again (PAR-CARD-02).
 */
export const addToQueue = <T>(queue: PlayQueue<T>, tracks: readonly T[], idOf: SongIdentity<T> = itself): PlayQueue<T> => {
  const fresh = newToUpNext(queue, tracks, idOf);
  if (fresh.length === 0) return queue;
  const added = keyed(fresh, queue.nextKey);
  return {
    ...queue,
    entries: [...queue.entries, ...added],
    queued: [...queue.queued, ...added],
    position: queue.position < 0 ? queue.entries.length : queue.position,
    nextKey: queue.nextKey + fresh.length,
  };
};

/** Takes one upcoming entry out (the one playing stays). */
export const removeEntry = <T>(queue: PlayQueue<T>, key: number): PlayQueue<T> => {
  const index = queue.entries.findIndex((entry) => entry.key === key);
  if (index < 0 || index === queue.position) return queue;
  return {
    ...queue,
    entries: queue.entries.filter((entry) => entry.key !== key),
    queued: queue.queued.filter((entry) => entry.key !== key),
    position: index < queue.position ? queue.position - 1 : queue.position,
  };
};

/** Clears everything after the current song. */
export const clearUpcoming = <T>(queue: PlayQueue<T>): PlayQueue<T> => {
  const kept = new Set(queue.entries.slice(0, queue.position + 1));
  return {
    ...queue,
    entries: queue.entries.slice(0, queue.position + 1),
    queued: queue.queued.filter((entry) => kept.has(entry)),
  };
};

/**
 * Shuffle on mixes the songs still to come (the current one keeps playing); shuffle off brings back the queued order
 * after the current song, as streaming apps do.
 */
export const setShuffle = <T>(queue: PlayQueue<T>, on: boolean, random: () => number = Math.random): PlayQueue<T> => {
  if (on === queue.shuffle) return queue;
  const current = currentEntry(queue);
  if (!current) return { ...queue, shuffle: on };
  const played = queue.entries.slice(0, queue.position + 1);
  if (on) return { ...queue, shuffle: true, entries: [...played, ...shuffled(upcoming(queue), random)] };
  const rest = queue.queued.slice(queue.queued.indexOf(current) + 1).filter((entry) => !played.includes(entry));
  return { ...queue, shuffle: false, entries: [...played, ...rest] };
};

/** Off, then repeat all, then repeat one, then off again: the order of the repeat button. */
export const nextRepeatMode = (mode: RepeatMode): RepeatMode => (mode === "off" ? "all" : mode === "all" ? "one" : "off");

export const setRepeat = <T>(queue: PlayQueue<T>, repeat: RepeatMode): PlayQueue<T> => ({ ...queue, repeat });
