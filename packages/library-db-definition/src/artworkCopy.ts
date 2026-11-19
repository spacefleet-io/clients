/**
 * META-ART-01: a matched title's artwork (poster, backdrop, cast photos, season posters, episode stills) is copied
 * into the user's own storage, encrypted, and the library points at those copies instead of catalog paths.
 *
 * Platform-neutral: the library database lists what still holds a catalog path (`listArtworkToCopy`) and swaps in the
 * copies (`applyArtworkCopies`, compare-and-set so a user edit made meanwhile wins); the app supplies `upload`,
 * which fetches the image through the metadata service's `image` op (META-ART-02), encrypts it on the device and
 * stores it under a random name. The copy runs after the match, off its critical path; a failed or skipped image
 * keeps its catalog path and is retried on the next run (next refresh, restore, or opening the title).
 */
import { artworkStorageKey } from "./mediaDetails";

export type ArtworkKind = "poster" | "backdrop" | "profile" | "still";

export type ArtworkTarget = "mediaPoster" | "mediaBackdrop" | "seasonPoster" | "personProfile" | "episodeStill";

/** One stored image field that still holds a catalog path. `id` is the media, season, person or episode row id. */
export type ArtworkSlot = { target: ArtworkTarget; id: string; path: string };

/** The copy for a slot: an asset key, or null when the metadata service says the image does not exist. */
export type ArtworkCopy = ArtworkSlot & { value: string | null };

/**
 * `unapplied`: the copies whose slot was not swapped (the title, season, episode or person is gone, or the slot no
 * longer holds the path the copy was made from). Their stored picture is referenced by nothing.
 */
export type ArtworkApplyResult = { applied: number; skipped: number; unapplied: ArtworkCopy[] };

export type ArtworkUploadOutcome =
  | { status: "ok"; key: string }
  | { status: "missing" }
  | { status: "no_ticket" }
  | { status: "unavailable" }
  /** The metadata service said "slow down" (429). `retryAfterMs` is its Retry-After, when it gave one. */
  | { status: "rate_limited"; retryAfterMs?: number };

export type ArtworkCopyStore = {
  listArtworkToCopy(mediaId: string): ArtworkSlot[] | Promise<ArtworkSlot[]>;
  applyArtworkCopies(mediaId: string, copies: ArtworkCopy[]): ArtworkApplyResult | Promise<ArtworkApplyResult>;
};

export type ArtworkCopyResult = {
  mediaId: string;
  total: number;
  copied: number;
  missing: number;
  failed: number;
  applied: number;
  /** Uploaded pictures deleted again because their slot was not swapped (`discard`). */
  discarded: number;
  /** Stopped before the end: the ticket reserve is empty or at the floor the copy must leave for lookups. */
  stoppedForTickets: boolean;
  /** Stopped before the end: the metadata service kept saying "slow down" (`ARTWORK_COPY_RATE_LIMIT_MAX_RETRIES`). */
  stoppedForRateLimit: boolean;
  /** Stopped between pictures for a title the user acts on (`shouldYield`); the queue resumes this title after it. */
  yielded: boolean;
};

export const ARTWORK_KIND_BY_TARGET: Record<ArtworkTarget, ArtworkKind> = {
  mediaPoster: "poster",
  mediaBackdrop: "backdrop",
  seasonPoster: "poster",
  personProfile: "profile",
  episodeStill: "still",
};

/** Images fetched at the same time: each one is a ticket and an upload. */
export const ARTWORK_COPY_CONCURRENCY = 3;
/** Copies written back per library write: a long series is saved as it goes, not only at the very end. */
export const ARTWORK_COPY_APPLY_BATCH = 40;
/**
 * A rate-limited picture is retried after the service's Retry-After, or after a backoff doubling from this when it
 * gave none. Every worker waits, so the copy slows down as a whole instead of bursting again.
 */
export const ARTWORK_COPY_RATE_LIMIT_BACKOFF_MS = 2_000;
/** Longest single wait, whatever the service asks: the copy runs in the background and retries anyway. */
export const ARTWORK_COPY_RATE_LIMIT_MAX_WAIT_MS = 5 * 60_000;
/** Refusals in a row (no picture answered in between) after which the run stops; the next schedule resumes it. */
export const ARTWORK_COPY_RATE_LIMIT_MAX_RETRIES = 8;

/** A catalog image path (`/abc.jpg`). Asset keys, user URLs and empty values are never copied. */
export const isCatalogImagePath = (value: unknown): value is string => typeof value === "string" && /^\/[^/]/.test(value);

export const copyMediaArtwork = async ({
  store,
  mediaId,
  upload,
  canSpend,
  shouldYield,
  discard,
  concurrency = ARTWORK_COPY_CONCURRENCY,
  applyBatch = ARTWORK_COPY_APPLY_BATCH,
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}: {
  store: ArtworkCopyStore;
  mediaId: string;
  upload: (kind: ArtworkKind, path: string) => Promise<ArtworkUploadOutcome>;
  /** Checked before each image; false stops the run (the reserve is kept for the user's own lookups). */
  canSpend?: () => boolean | Promise<boolean>;
  /** Checked before each picture; true stops the run (the pictures in flight finish and are saved). */
  shouldYield?: () => boolean;
  /**
   * Deletes stored pictures from the user's storage (`/storage/delete`). Called with the keys of uploaded copies the
   * library did not take, most often because the title was deleted while its pictures were uploading: nothing
   * references them, so they would count against the user's storage until the leftover clean-up (STOR-PLACE-10).
   */
  discard?: (keys: string[]) => Promise<unknown>;
  concurrency?: number;
  applyBatch?: number;
  /** The wait after a rate limit (tests pass a fake clock). */
  sleep?: (ms: number) => Promise<void>;
}): Promise<ArtworkCopyResult> => {
  const slots = await store.listArtworkToCopy(mediaId);
  const result: ArtworkCopyResult = {
    mediaId,
    total: slots.length,
    copied: 0,
    missing: 0,
    failed: 0,
    applied: 0,
    discarded: 0,
    stoppedForTickets: false,
    stoppedForRateLimit: false,
    yielded: false,
  };
  if (slots.length === 0) return result;

  let pending: ArtworkCopy[] = [];
  let writing: Promise<void> = Promise.resolve();
  const flush = () => {
    if (pending.length === 0) return writing;
    const batch = pending;
    pending = [];
    writing = writing.then(async () => {
      const applied = await store.applyArtworkCopies(mediaId, batch);
      result.applied += applied.applied;
      const keys = [...new Set(applied.unapplied.map((copy) => artworkStorageKey(copy.value)).filter((key): key is string => key !== null))];
      if (keys.length === 0 || !discard) return;
      try {
        await discard(keys);
        result.discarded += keys.length;
      } catch {
        // Left to the leftover clean-up (STOR-PLACE-06): the copy itself is done.
      }
    });
    return writing;
  };

  // One wait shared by every worker: a refusal holds them all, and refusals answered during it do not stack waits.
  let slowDown: Promise<void> | null = null;
  let refusalsInARow = 0;
  const waitAfterRefusal = (retryAfterMs: number | undefined) => {
    if (slowDown) return slowDown;
    refusalsInARow += 1;
    if (refusalsInARow > ARTWORK_COPY_RATE_LIMIT_MAX_RETRIES) return null;
    const asked = retryAfterMs !== undefined && retryAfterMs > 0 ? retryAfterMs : ARTWORK_COPY_RATE_LIMIT_BACKOFF_MS * 2 ** (refusalsInARow - 1);
    slowDown = sleep(Math.min(asked, ARTWORK_COPY_RATE_LIMIT_MAX_WAIT_MS)).finally(() => {
      slowDown = null;
    });
    return slowDown;
  };
  const stopped = () => result.stoppedForTickets || result.stoppedForRateLimit || result.yielded;

  let next = 0;
  const worker = async () => {
    while (next < slots.length && !stopped()) {
      if (shouldYield?.()) {
        result.yielded = true;
        return;
      }
      const slot = slots[next++]!;
      let outcome: ArtworkUploadOutcome;
      for (;;) {
        if (slowDown) await slowDown;
        if (stopped()) return;
        if (canSpend && !(await canSpend())) {
          result.stoppedForTickets = true;
          return;
        }
        outcome = await upload(ARTWORK_KIND_BY_TARGET[slot.target], slot.path);
        if (outcome.status !== "rate_limited") break;
        const wait = waitAfterRefusal(outcome.retryAfterMs);
        if (!wait) {
          result.stoppedForRateLimit = true;
          break;
        }
        await wait;
      }
      if (outcome.status !== "rate_limited") refusalsInARow = 0;
      if (outcome.status === "ok") {
        result.copied += 1;
        pending.push({ ...slot, value: outcome.key });
      } else if (outcome.status === "missing") {
        result.missing += 1;
        pending.push({ ...slot, value: null });
      } else {
        result.failed += 1;
        if (outcome.status === "no_ticket") result.stoppedForTickets = true;
      }
      if (pending.length >= applyBatch) await flush();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, slots.length)) }, worker));
  await flush();
  return result;
};

/**
 * Runs copies one title at a time in the background. Scheduling a title already queued or running is a no-op
 * (a title scheduled while it runs is run once more afterwards, so a refresh that added episodes is not lost).
 * A title the user just matched, refreshed or opened goes first; the migration of an existing library schedules
 * with `background` and waits behind them. A user's title never waits for the migration: it cuts the pause between
 * background titles short, and a background title in progress yields after the pictures it is fetching (`run`
 * passes `shouldYield` on to `copyMediaArtwork`) and resumes, first of its lane, once the user's titles are done.
 * Errors go to `onError` and never reach the caller: the copy is never on a user action's critical path.
 */
export type ArtworkCopyQueue = {
  schedule(mediaId: string, options?: { background?: boolean }): void;
  /** Resolves once everything scheduled so far has run. */
  idle(): Promise<void>;
  stop(): void;
};

/** What the queue tells a run: `shouldYield` turns true while a background title runs and a user's title waits. */
export type ArtworkCopyRunControl = { shouldYield: () => boolean };

/** Pause between two titles of a queue: a whole library migrating (META-ART-01) never bursts at the metadata service. */
export const ARTWORK_COPY_PAUSE_MS = 2_000;

export const createArtworkCopyQueue = ({
  run,
  onError,
  pauseMs = 0,
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
}: {
  /** Returns the title's `ArtworkCopyResult`: a `yielded` one is queued again ahead of the other background titles. */
  run: (mediaId: string, control: ArtworkCopyRunControl) => Promise<unknown>;
  onError?: (mediaId: string, error: unknown) => void;
  /** Least time between the end of one title and the start of the next background title (the paced migration of a
   * whole library); a title the user acts on is never held back. */
  pauseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): ArtworkCopyQueue => {
  // Two lanes, each in order: what the user just matched, refreshed or opened, then the background migration.
  const foreground: string[] = [];
  const background: string[] = [];
  const queuedSet = new Set<string>();
  let active: Promise<void> | null = null;
  let stopped = false;
  let lastFinishedAt: number | null = null;
  let runningInBackground = false;
  // Ends the pause between background titles early: a user's title was scheduled.
  let wake: (() => void) | null = null;
  const control: ArtworkCopyRunControl = { shouldYield: () => runningInBackground && foreground.length > 0 };

  const drain = async () => {
    while ((foreground.length > 0 || background.length > 0) && !stopped) {
      if (foreground.length === 0 && pauseMs > 0 && lastFinishedAt !== null) {
        const wait = pauseMs - (now() - lastFinishedAt);
        if (wait > 0) {
          // `Promise.withResolvers` is missing on older Hermes (the phone app runs this file).
          const woken = new Promise<void>((resolve) => {
            wake = resolve;
          });
          await Promise.race([sleep(wait), woken]);
          wake = null;
        }
        if (stopped) return;
        // A user action scheduled during the pause goes first.
      }
      const inBackground = foreground.length === 0;
      const mediaId = (inBackground ? background : foreground).shift();
      if (mediaId === undefined) continue;
      queuedSet.delete(mediaId);
      runningInBackground = inBackground;
      let result: unknown;
      try {
        result = await run(mediaId, control);
      } catch (error) {
        onError?.(mediaId, error);
      }
      runningInBackground = false;
      lastFinishedAt = now();
      // Yielded to a user's title: it picks up where it stopped, ahead of the rest of the migration.
      if ((result as { yielded?: unknown } | undefined)?.yielded === true && !stopped && !queuedSet.has(mediaId)) {
        background.unshift(mediaId);
        queuedSet.add(mediaId);
      }
    }
  };

  return {
    schedule(mediaId: string, options?: { background?: boolean }) {
      if (stopped || !mediaId) return;
      if (queuedSet.has(mediaId)) {
        const waitingInBackground = background.indexOf(mediaId);
        // Already waiting: a background request changes nothing, a user action promotes a background one.
        if (options?.background || waitingInBackground < 0) return;
        background.splice(waitingInBackground, 1);
      }
      (options?.background ? background : foreground).push(mediaId);
      queuedSet.add(mediaId);
      if (!options?.background) wake?.();
      if (!active) {
        active = drain().finally(() => {
          active = null;
        });
      }
    },
    /** Resolves once everything scheduled so far has run. */
    async idle() {
      while (active) await active;
    },
    stop() {
      stopped = true;
      wake?.();
      foreground.length = 0;
      background.length = 0;
      queuedSet.clear();
    },
  };
};

/**
 * META-ART-01/02: where a stored picture is shown from. Browsing and playback show only the user's own encrypted
 * copy (`vault`: the local decrypted cache first, then the user's storage). A catalog path still in the library
 * (`pending`: its copy is not made yet) shows the placeholder and is never asked of the metadata service at display;
 * the copy queue fills it in. Anything else (empty, a user URL) shows the placeholder (`none`).
 */
export type ArtworkDisplaySource = "vault" | "pending" | "none";

export const artworkDisplaySource = (value: string | null | undefined): ArtworkDisplaySource => {
  if (typeof value !== "string" || value.length === 0) return "none";
  if (isCatalogImagePath(value as unknown)) return "pending";
  if (value.startsWith("asset:")) return value.indexOf("::") > 0 ? "vault" : "none";
  return /^[a-z][a-z0-9+.-]*:/i.test(value) ? "none" : "vault";
};

/** The parts of a title's details that carry artwork (`MediaDetails` fits). */
export type ArtworkDetails = {
  id: string;
  posterPath?: string | null;
  backdropPath?: string | null;
  seasons?: { id: string; posterPath?: string | null }[];
  cast?: { personId: string; profilePath?: string | null }[];
  /** A person in both cast and crew has one `people` row; `media.upsert` writes the crew's after the cast's. */
  crew?: { personId: string; profilePath?: string | null }[];
  episodes?: { id: string; stillPath?: string | null }[];
};

/** `listArtworkToCopy` over a details object, same order and dedup as the library database's. */
export const listDetailsArtworkSlots = (details: ArtworkDetails): ArtworkSlot[] => {
  const slots: ArtworkSlot[] = [];
  if (isCatalogImagePath(details.posterPath)) slots.push({ target: "mediaPoster", id: details.id, path: details.posterPath });
  if (isCatalogImagePath(details.backdropPath)) slots.push({ target: "mediaBackdrop", id: details.id, path: details.backdropPath });
  for (const season of details.seasons ?? []) {
    if (isCatalogImagePath(season.posterPath)) slots.push({ target: "seasonPoster", id: season.id, path: season.posterPath });
  }
  const seen = new Set<string>();
  for (const member of details.cast ?? []) {
    if (seen.has(member.personId)) continue;
    seen.add(member.personId);
    if (isCatalogImagePath(member.profilePath)) slots.push({ target: "personProfile", id: member.personId, path: member.profilePath });
  }
  for (const episode of details.episodes ?? []) {
    if (isCatalogImagePath(episode.stillPath)) slots.push({ target: "episodeStill", id: episode.id, path: episode.stillPath });
  }
  return slots;
};

/**
 * `applyArtworkCopies` over a details object: returns a new object with each copy swapped in while its slot still
 * holds the path the copy was made from (compare-and-set: an edit made meanwhile wins), the count applied and the
 * copies that were not.
 */
export const applyArtworkCopiesToDetails = <T extends ArtworkDetails>(
  details: T,
  copies: ArtworkCopy[]
): { details: T; applied: number; unapplied: ArtworkCopy[] } => {
  let applied = 0;
  const unapplied: ArtworkCopy[] = [];
  const next: T = {
    ...details,
    seasons: details.seasons?.map((season) => ({ ...season })),
    cast: details.cast?.map((member) => ({ ...member })),
    crew: details.crew?.map((member) => ({ ...member })),
    episodes: details.episodes?.map((episode) => ({ ...episode })),
  };
  for (const copy of copies) {
    let hit = false;
    switch (copy.target) {
      case "mediaPoster":
        if (copy.id === next.id && next.posterPath === copy.path) {
          next.posterPath = copy.value;
          hit = true;
        }
        break;
      case "mediaBackdrop":
        if (copy.id === next.id && next.backdropPath === copy.path) {
          next.backdropPath = copy.value;
          hit = true;
        }
        break;
      case "seasonPoster": {
        const season = next.seasons?.find((row) => row.id === copy.id && row.posterPath === copy.path);
        if (season) {
          season.posterPath = copy.value;
          hit = true;
        }
        break;
      }
      case "episodeStill": {
        const episode = next.episodes?.find((row) => row.id === copy.id && row.stillPath === copy.path);
        if (episode) {
          episode.stillPath = copy.value;
          hit = true;
        }
        break;
      }
      case "personProfile": {
        // One person may be listed in several roles, cast and crew: every row of that person takes the copy, or the
        // crew row written last puts the provider path back on the shared `people` row (META-ART-01 notes).
        for (const member of [...(next.cast ?? []), ...(next.crew ?? [])]) {
          if (member.personId === copy.id && member.profilePath === copy.path) {
            member.profilePath = copy.value;
            hit = true;
          }
        }
        break;
      }
    }
    if (hit) applied += 1;
    else unapplied.push(copy);
  }
  return { details: next, applied, unapplied };
};

/**
 * An `ArtworkCopyStore` for a client whose library writes whole titles (`media.upsert`): reads the title's details,
 * lists its slots, and writes the swapped details back. `read` must return the library's current copy each time,
 * so a batch applies over the previous one.
 */
export const createDetailsArtworkStore = <T extends ArtworkDetails>({
  read,
  write,
}: {
  read: (mediaId: string) => Promise<T | null> | T | null;
  write: (mediaId: string, details: T) => Promise<void> | void;
}): ArtworkCopyStore => ({
  async listArtworkToCopy(mediaId) {
    const details = await read(mediaId);
    return details ? listDetailsArtworkSlots(details) : [];
  },
  async applyArtworkCopies(mediaId, copies) {
    const details = await read(mediaId);
    if (!details) return { applied: 0, skipped: copies.length, unapplied: copies };
    const result = applyArtworkCopiesToDetails(details, copies);
    if (result.applied > 0) await write(mediaId, result.details);
    return { applied: result.applied, skipped: result.unapplied.length, unapplied: result.unapplied };
  },
});

/**
 * META-ART-01, existing libraries: schedules a copy for every title that still holds a catalog path. Run once a
 * library is open (and again after a sync brought titles in); the queue paces the titles (`pauseMs`) and the
 * uploader's ticket floor keeps the reserve for the user's own lookups. Returns how many titles were scheduled.
 */
export const scheduleArtworkMigration = async ({
  listMediaIds,
  hasArtworkToCopy,
  queue,
}: {
  listMediaIds: () => Promise<string[]> | string[];
  hasArtworkToCopy: (mediaId: string) => Promise<boolean> | boolean;
  queue: Pick<ArtworkCopyQueue, "schedule">;
}): Promise<number> => {
  let scheduled = 0;
  for (const mediaId of await listMediaIds()) {
    if (!(await hasArtworkToCopy(mediaId))) continue;
    queue.schedule(mediaId, { background: true });
    scheduled += 1;
  }
  return scheduled;
};

/** What a client's image fetch answers: the picture's bytes, or why there is none now. */
export type ArtworkFetchOutcome =
  | { status: "ok"; bytes: Uint8Array; contentType: string }
  | { status: "missing" }
  | { status: "no_ticket" }
  | { status: "unavailable" }
  /** 429 from the metadata service; the copy waits `retryAfterMs` (or backs off) and asks again. */
  | { status: "rate_limited"; retryAfterMs?: number };

/**
 * The copy's uploader from two platform pieces: `fetchImage` (the metadata service's `image` op, import/refresh
 * only) and `storeEncrypted` (encrypt with the library key, upload under `assets/<random uuid>.txt`, answer the
 * `asset:<type>::<key>` reference). A store failure is `unavailable`: the path stays for the next run.
 */
export const createVaultArtworkUpload =
  ({
    fetchImage,
    storeEncrypted,
    onError,
  }: {
    fetchImage: (kind: ArtworkKind, path: string) => Promise<ArtworkFetchOutcome>;
    storeEncrypted: (bytes: Uint8Array, contentType: string) => Promise<string>;
    onError?: (stage: "fetch" | "store", error: unknown) => void;
  }) =>
  async (kind: ArtworkKind, path: string): Promise<ArtworkUploadOutcome> => {
    let fetched: ArtworkFetchOutcome;
    try {
      fetched = await fetchImage(kind, path);
    } catch (error) {
      onError?.("fetch", error);
      return { status: "unavailable" };
    }
    if (fetched.status !== "ok") return fetched;
    try {
      return { status: "ok", key: await storeEncrypted(fetched.bytes, fetched.contentType) };
    } catch (error) {
      onError?.("store", error);
      return { status: "unavailable" };
    }
  };

/** `asset:<type>::<object key>`, the reference every client writes for a stored picture. */
export const buildArtworkAssetRef = (objectKey: string, contentType: string) =>
  `asset:${contentType.split(";")[0]?.trim() || "application/octet-stream"}::${objectKey}`;

/** A fresh object key for a stored picture. */
export const newArtworkObjectKey = (uuid: string) => `assets/${uuid}.txt`;

