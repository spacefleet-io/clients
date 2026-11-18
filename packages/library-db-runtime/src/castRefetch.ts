/**
 * LIB-CAST-01: a one-time repair of casts the old code merged into one person. Before the fix, some metadata
 * details dropped each cast member's catalog person id and the library turned the missing id into catalog person 0, so
 * every role of the title pointed at one person. New titles are stored right; this pass fetches the cast of each
 * title stored the old way again, the same cast the desktop's "Restore" writes, once per title.
 *
 * Platform-neutral: the library database lists the titles (`listMediaWithCollapsedCast`) and keeps the marker in a
 * synced setting, so a title repaired on one device is not fetched again on another; the app supplies `refetch`,
 * which asks the metadata service for the title's details again and writes
 * the cast. A title whose refetch fails is tried again on a later pass, at most `CAST_REFETCH_MAX_ATTEMPTS` times.
 */

/** One synced setting per title: `done`, or `failed:<attempts>`. */
export const CAST_REFETCH_SETTING_PREFIX = "cast_refetch_v1:";

export const CAST_REFETCH_MAX_ATTEMPTS = 3;

type Awaitable<T> = T | Promise<T>;

export type CastRefetchStore = {
  listMediaWithCollapsedCast(): Awaitable<string[]>;
  getSetting(key: string): Awaitable<{ value: string } | null | undefined>;
  setSetting(key: string, value: string): Awaitable<unknown>;
};

export type CastRefetchResult = {
  /** Titles the library lists as collapsed. */
  found: number;
  refetched: number;
  failed: number;
  /** Already repaired, or out of attempts. */
  skipped: number;
};

const attemptsOf = (marker: string | undefined): number => {
  if (!marker?.startsWith("failed:")) return 0;
  const attempts = Number(marker.slice("failed:".length));
  return Number.isInteger(attempts) && attempts > 0 ? attempts : 0;
};

/**
 * Fetches the cast of every collapsed title not repaired yet, one title at a time. Never rejects for one title: a
 * failure is counted, recorded in the marker and left for a later pass. `shouldStop` lets the app stand down
 * between titles (signed out, library closed).
 */
export async function refetchCollapsedCasts(
  store: CastRefetchStore,
  refetch: (mediaId: string) => Promise<void>,
  options: { shouldStop?: () => boolean; onError?: (mediaId: string, error: unknown) => void } = {}
): Promise<CastRefetchResult> {
  const mediaIds = await store.listMediaWithCollapsedCast();
  const result: CastRefetchResult = { found: mediaIds.length, refetched: 0, failed: 0, skipped: 0 };
  for (const mediaId of mediaIds) {
    if (options.shouldStop?.()) break;
    const key = `${CAST_REFETCH_SETTING_PREFIX}${mediaId}`;
    const marker = (await store.getSetting(key))?.value;
    const attempts = attemptsOf(marker);
    if (marker === "done" || attempts >= CAST_REFETCH_MAX_ATTEMPTS) {
      result.skipped += 1;
      continue;
    }
    try {
      await refetch(mediaId);
      await store.setSetting(key, "done");
      result.refetched += 1;
    } catch (error) {
      options.onError?.(mediaId, error);
      await store.setSetting(key, `failed:${attempts + 1}`);
      result.failed += 1;
    }
  }
  return result;
}
