/**
 * Short-lived cache of the reads a play start waits on (library key, gateway candidates, track prefs), filled while
 * the details page is open so the tap on Play finds them done or in flight (#934, port of desktop #928).
 *
 * One in-flight promise per key: a second caller joins the running read instead of starting another. An entry lives
 * `PLAY_START_WARM_TTL_MS`; a read that rejects is dropped at once so the next caller retries. Entries belong to the
 * auth token they were read under: a different token (login as someone else) or `clearPlayStartWarm()` (logout, key
 * change) empties the cache. No imports on purpose: the modules that must invalidate it (key storage, auth) stay free
 * of the playback modules that fill it.
 */
export const PLAY_START_WARM_TTL_MS = 30_000;

type Entry = { promise: Promise<unknown>; at: number };

const entries = new Map<string, Entry>();
let entriesToken: string | null = null;

const fresh = (entry: Entry | undefined, now: number): entry is Entry =>
  entry !== undefined && now - entry.at < PLAY_START_WARM_TTL_MS;

/** The cached read for `key`, or `start()`'s promise (cached) when there is none or it expired. */
export const rememberPlayStartRead = <T>(key: string, start: () => Promise<T>, now: number = Date.now()): Promise<T> => {
  const hit = entries.get(key);
  if (fresh(hit, now)) return hit.promise as Promise<T>;
  const promise = start();
  const entry: Entry = { promise, at: now };
  entries.set(key, entry);
  promise.catch(() => {
    if (entries.get(key) === entry) entries.delete(key);
  });
  return promise;
};

/** The cached read for `key` (kept for later callers), or null when none is fresh. */
export const peekPlayStartRead = <T>(key: string, now: number = Date.now()): Promise<T> | null => {
  const hit = entries.get(key);
  return fresh(hit, now) ? (hit.promise as Promise<T>) : null;
};

/** The cached read for `key` (removed: used once), or null when none is fresh. */
export const takePlayStartRead = <T>(key: string, now: number = Date.now()): Promise<T> | null => {
  const hit = entries.get(key);
  entries.delete(key);
  return fresh(hit, now) ? (hit.promise as Promise<T>) : null;
};

/** Empties the cache when `token` is not the one the entries were read under. */
export const scopePlayStartReadsToToken = (token: string): void => {
  if (entriesToken === token) return;
  entries.clear();
  entriesToken = token;
};

/** Forget everything: logout, library key stored or cleared. */
export const clearPlayStartWarm = (): void => {
  entries.clear();
  entriesToken = null;
};
