/**
 * Artwork for title lookups (META-ART-02): every poster, backdrop, cast photo and still comes from the
 * metadata service, never from the image source's CDN, so the CDN never sees a request from a SpaceFleet user.
 *
 * The service's `image` op answers `{ url }` where `url` is a self-contained `data:` URI, so an `<img>` can use
 * it as is (an `<img>` cannot send the `PrivateToken` header, and does not need to). One ticket is spent per
 * image fetch, so an image is fetched once: a small in-memory LRU in front of an optional persistent store (the
 * desktop keeps one across launches in IndexedDB), and concurrent requests for the same image share one fetch.
 * Shared by the desktop renderer and the Badger web player.
 *
 * Outcomes are told apart because they call for different handling:
 *  - `ok`        the image;
 *  - `missing`   the service has no such image (a fact about the title: callers may record "no artwork");
 *  - `no_ticket` the reserve is empty (callers must stop spending and must NOT record "no artwork");
 *  - `unavailable` the service or network failed (callers must NOT record "no artwork"; retry later);
 *  - `rate_limited` the service said "slow down" (429/503): ask again after `retryAfterMs` (its Retry-After, or the
 *    failure TTL when it named none); a repeat ask inside that time answers the time still left without a request.
 * A failure is remembered for a short while so a screen of broken images does not retry on every render.
 */
import { MetadataUnavailableError, NoTicketError, type ImageKind, type MetadataClient } from "./client";

/** A persistent image cache keyed by the resolver (values are `data:` URIs). Must never throw: a failure is a miss. */
export interface ArtworkStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  clear(): Promise<void>;
}

export type ImageOutcome =
  | { status: "ok"; url: string }
  | { status: "missing" }
  | { status: "no_ticket" }
  | { status: "unavailable" }
  | { status: "rate_limited"; retryAfterMs?: number };

export interface MetadataImageResolverOptions {
  /** In-memory entries kept in front of the persistent store (each is one data URI: a few hundred KiB at most). */
  maxEntries?: number;
  /** How long a failed lookup is remembered, in ms. */
  failureTtlMs?: number;
  /** Survives restarts; cleared with the resolver. */
  persistent?: ArtworkStore;
  now?: () => number;
}

export interface MetadataImageResolver {
  /** The image as a `data:` URI, or null for any non-`ok` outcome. Never rejects. */
  resolve(kind: ImageKind, path: string, language?: string): Promise<string | null>;
  /** Same lookup, outcome kept. Never rejects. */
  resolveDetailed(kind: ImageKind, path: string, language?: string): Promise<ImageOutcome>;
  /** Sign-out: forget everything, memory and persistent. Resolves when the persistent store is emptied. */
  clear(): Promise<void>;
  /** Tickets came back (a refill landed): the remembered failures may be asked again at once. */
  forgetFailures(): void;
}

export const DEFAULT_IMAGE_CACHE_ENTRIES = 64;
export const DEFAULT_IMAGE_FAILURE_TTL_MS = 60_000;

export const createMetadataImageResolver = (
  client: Pick<MetadataClient, "imageUrl">,
  options: MetadataImageResolverOptions = {}
): MetadataImageResolver => {
  const maxEntries = options.maxEntries ?? DEFAULT_IMAGE_CACHE_ENTRIES;
  const failureTtlMs = options.failureTtlMs ?? DEFAULT_IMAGE_FAILURE_TTL_MS;
  const persistent = options.persistent;
  const now = options.now ?? Date.now;
  // Insertion order is recency order: a hit re-inserts its key.
  const cache = new Map<string, string>();
  const failures = new Map<string, { until: number; outcome: ImageOutcome }>();
  const inflight = new Map<string, Promise<ImageOutcome>>();
  let epoch = 0;

  const remember = (key: string, url: string) => {
    cache.delete(key);
    cache.set(key, url);
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  const fetchFromService = async (kind: ImageKind, path: string, language?: string): Promise<ImageOutcome> => {
    try {
      const { url } = await client.imageUrl(kind, path, language);
      return url ? { status: "ok", url } : { status: "missing" };
    } catch (error) {
      if (error instanceof NoTicketError) return { status: "no_ticket" };
      if (error instanceof MetadataUnavailableError) {
        return error.retryAfterSeconds === undefined ? { status: "rate_limited" } : { status: "rate_limited", retryAfterMs: error.retryAfterSeconds * 1000 };
      }
      // A rejected ticket, a bad status, a network error: all "try again later".
      return { status: "unavailable" };
    }
  };

  const resolveDetailed = (kind: ImageKind, path: string, language?: string): Promise<ImageOutcome> => {
    const key = `${kind}\u0000${language ?? ""}\u0000${path}`;
    const hit = cache.get(key);
    if (hit !== undefined) {
      remember(key, hit);
      return Promise.resolve({ status: "ok", url: hit });
    }
    const failed = failures.get(key);
    if (failed) {
      const left = failed.until - now();
      if (left > 0) return Promise.resolve(failed.outcome.status === "rate_limited" ? { status: "rate_limited", retryAfterMs: left } : failed.outcome);
      failures.delete(key);
    }
    const pending = inflight.get(key);
    if (pending) return pending;

    const startedIn = epoch;
    const task: Promise<ImageOutcome> = (async () => {
      if (persistent) {
        const stored = await persistent.get(key);
        if (stored && startedIn === epoch) {
          remember(key, stored);
          return { status: "ok", url: stored } as const;
        }
      }
      const outcome = await fetchFromService(kind, path, language);
      // A clear() (sign-out) while the fetch ran: hand the answer to this caller, keep nothing.
      if (startedIn === epoch) {
        if (outcome.status === "ok") {
          remember(key, outcome.url);
          if (persistent) await persistent.put(key, outcome.url);
        } else {
          const holdMs = outcome.status === "rate_limited" && outcome.retryAfterMs !== undefined ? outcome.retryAfterMs : failureTtlMs;
          failures.set(key, { until: now() + holdMs, outcome });
        }
      }
      return outcome;
    })().finally(() => {
      if (inflight.get(key) === task) inflight.delete(key);
    });
    inflight.set(key, task);
    return task;
  };

  return {
    resolveDetailed,
    resolve: async (kind, path, language) => {
      const outcome = await resolveDetailed(kind, path, language);
      return outcome.status === "ok" ? outcome.url : null;
    },
    forgetFailures: () => {
      failures.clear();
    },
    clear: async () => {
      epoch += 1;
      cache.clear();
      failures.clear();
      inflight.clear();
      await persistent?.clear();
    },
  };
};
