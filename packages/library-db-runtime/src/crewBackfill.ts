/**
 * LIB-CREW-01 backfill: a library from before crew was stored gets the director and writers of every title it
 * already holds, once, quietly in the background (Chris 2026-11-09). Only the crew is written: titles, synopsis,
 * artwork and cast stay as the user has them, and a title that already holds any crew (fetched, restored, or edited
 * by the user) is never listed, so it is never overwritten.
 *
 * Platform-neutral like `castRefetch`: the library database lists the titles (`listMediaMissingCrew`) and keeps the
 * progress; the app supplies `fetchCrew`, which asks the metadata service through its ticket pipeline (the same
 * details lookup "Restore from TMDB" uses) and writes the crew.
 *
 * Progress survives a quit or a crash without a cursor: a filled title leaves the list by itself, and a title TMDB
 * credits with no director or writer gets a synced `crew_backfill_v1:<mediaId>` marker (`done`, or `failed:<n>` after
 * a failure). Once a pass ends with nothing left to try, the library-wide `crew_backfill_v1` marker is set and later
 * starts return at once.
 *
 * Pacing: one title at a time with a gap between lookups; while the device is offline or a video plays it waits;
 * when the service answers "not now" (rate limit, no ticket yet) it backs off, longer each time, and retries the same
 * title without counting a failed attempt.
 */

/** Per title: `done` (TMDB credits no director or writer) or `failed:<attempts>`. */
export const CREW_BACKFILL_SETTING_PREFIX = "crew_backfill_v1:";
/** Library-wide: `done` once a pass left nothing to try. */
export const CREW_BACKFILL_COMPLETE_KEY = "crew_backfill_v1";
export const CREW_BACKFILL_MAX_ATTEMPTS = 3;
/** Gap between two lookups: one library never floods the metadata service. */
export const CREW_BACKFILL_REQUEST_GAP_MS = 1_500;
/** How often an offline or busy (video playing) device checks again. */
export const CREW_BACKFILL_IDLE_POLL_MS = 30_000;
/** First wait after a "not now" answer; doubles on each one in a row, up to the cap. */
export const CREW_BACKFILL_BACKOFF_MS = 30_000;
export const CREW_BACKFILL_MAX_BACKOFF_MS = 15 * 60_000;

type Awaitable<T> = T | Promise<T>;

export type CrewBackfillStore = {
  listMediaMissingCrew(): Awaitable<string[]>;
  getSetting(key: string): Awaitable<{ value: string } | null | undefined>;
  setSetting(key: string, value: string): Awaitable<unknown>;
};

export type CrewBackfillDeps = {
  /** Fetches and writes the title's crew; resolves to how many credits the title now holds. */
  fetchCrew(mediaId: string): Promise<number>;
  sleep(ms: number): Promise<void>;
  isOffline(): boolean;
  /** A video is playing on this device: the backfill waits so playback keeps the network and the disk. */
  isPlaying(): Awaitable<boolean>;
  /** For a "not now" answer (rate limit, service busy, no ticket yet): how long the service asked to wait, 0 when it did not say. `null` for any other error. */
  retryAfterMs(error: unknown): number | null;
  shouldStop?(): boolean;
  /** Titles handled so far out of those listed at the start, for a quiet status line. */
  onProgress?(handled: number, total: number): void;
  log?(message: string, details: Record<string, unknown>): void;
};

export type CrewBackfillResult = {
  /** Titles listed at the start of the pass. */
  found: number;
  filled: number;
  /** TMDB credits no director or writer: marked so they are not asked again. */
  empty: number;
  failed: number;
  /** Already marked, or out of attempts. */
  skipped: number;
  /** The library-wide marker is set (now or by an earlier pass). */
  complete: boolean;
};

const attemptsOf = (marker: string | undefined): number => {
  if (!marker?.startsWith("failed:")) return 0;
  const attempts = Number(marker.slice("failed:".length));
  return Number.isInteger(attempts) && attempts > 0 ? attempts : 0;
};

/** Never rejects for one title: a failure is recorded in its marker and tried again on a later start. */
export async function backfillMissingCrew(store: CrewBackfillStore, deps: CrewBackfillDeps): Promise<CrewBackfillResult> {
  const log = deps.log ?? (() => {});
  const stopped = () => deps.shouldStop?.() ?? false;
  const result: CrewBackfillResult = { found: 0, filled: 0, empty: 0, failed: 0, skipped: 0, complete: false };
  if ((await store.getSetting(CREW_BACKFILL_COMPLETE_KEY))?.value === "done") {
    result.complete = true;
    return result;
  }

  const mediaIds = await store.listMediaMissingCrew();
  result.found = mediaIds.length;
  log("[crew-backfill] pass started", { titles: mediaIds.length });
  let retriesLeft = 0;
  let backoffMs = CREW_BACKFILL_BACKOFF_MS;

  /** Waits while the device is offline or a video plays; false when told to stop meanwhile. */
  const waitUntilFree = async (): Promise<boolean> => {
    let reported = "";
    while (!stopped()) {
      const reason = deps.isOffline() ? "offline" : (await deps.isPlaying()) ? "playing" : "";
      if (!reason) return true;
      if (reason !== reported) log("[crew-backfill] waiting", { reason });
      reported = reason;
      await deps.sleep(CREW_BACKFILL_IDLE_POLL_MS);
    }
    return false;
  };

  for (const [index, mediaId] of mediaIds.entries()) {
    const key = `${CREW_BACKFILL_SETTING_PREFIX}${mediaId}`;
    const marker = (await store.getSetting(key))?.value;
    const attempts = attemptsOf(marker);
    if (marker === "done" || attempts >= CREW_BACKFILL_MAX_ATTEMPTS) {
      result.skipped += 1;
      deps.onProgress?.(index + 1, mediaIds.length);
      continue;
    }
    for (;;) {
      if (!(await waitUntilFree())) break;
      try {
        const credits = await deps.fetchCrew(mediaId);
        backoffMs = CREW_BACKFILL_BACKOFF_MS;
        if (credits > 0) {
          result.filled += 1;
        } else {
          await store.setSetting(key, "done");
          result.empty += 1;
        }
        break;
      } catch (error) {
        const asked = deps.retryAfterMs(error);
        if (asked !== null || deps.isOffline()) {
          // "Not now" or the network dropped: not the title's fault, so no attempt is counted. Offline waits in
          // waitUntilFree; a "not now" answer waits at least what the service asked, longer on each one in a row.
          const waitMs = asked === null ? 0 : Math.max(asked, backoffMs);
          if (asked !== null) backoffMs = Math.min(backoffMs * 2, CREW_BACKFILL_MAX_BACKOFF_MS);
          log("[crew-backfill] service not available, waiting", { mediaId, waitMs, offline: deps.isOffline() });
          if (waitMs > 0) await deps.sleep(waitMs);
          continue;
        }
        log("[crew-backfill] title failed", { mediaId, attempt: attempts + 1, error: String(error) });
        await store.setSetting(key, `failed:${attempts + 1}`);
        result.failed += 1;
        if (attempts + 1 < CREW_BACKFILL_MAX_ATTEMPTS) retriesLeft += 1;
        break;
      }
    }
    if (stopped()) break;
    deps.onProgress?.(index + 1, mediaIds.length);
    if (index < mediaIds.length - 1) await deps.sleep(CREW_BACKFILL_REQUEST_GAP_MS);
  }

  if (!stopped() && retriesLeft === 0) {
    await store.setSetting(CREW_BACKFILL_COMPLETE_KEY, "done");
    result.complete = true;
  }
  log("[crew-backfill] pass ended", { ...result, stopped: stopped() });
  return result;
}
