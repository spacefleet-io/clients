// The cover cache shared by the apps that show album covers from the user's own storage (PAR-META-04, PAR-COPY-01):
// the web player (a `blob:` address per cover) and the phone (a `file://` address of a decrypted copy in its cache).
// Each app passes in how one cover is fetched, opened and turned into an address; this keeps the rules both share:
// an address is kept per object key for the library's life, two asks for one key share one fetch, at most
// `concurrency` fetches run at once in the order they were asked for, a failure answers null (the drawn picture stays)
// and is tried again on the next ask, and `release()` forgets everything, drops the fetches still waiting and keeps
// nothing a running fetch brings back afterwards.

/** Covers fetched at once: enough to fill a screen of tiles quickly without flooding the storage tunnel. */
export const PARROT_COVER_DOWNLOADS = 4;

export type ParrotCoverCacheInput = {
  /**
   * Fetches, opens and stores the cover under `objectKey`; answers its address, or null when it is not a picture.
   * `current()` turns false once the cache is released: check it before making anything that must be undone (an
   * object URL), since the cache keeps nothing that comes back after a release.
   */
  fetch(objectKey: string, current: () => boolean): Promise<string | null>;
  /** A fetch that threw; the cover answers null. */
  failed(objectKey: string, error: unknown): void;
  concurrency?: number;
};

export type ParrotCoverCache = {
  /** The address of a cover already fetched in this library's life, answered at once; else null. */
  peek(objectKey: string): string | null;
  /** The cover's address, or null when it cannot be shown. Never rejects. */
  load(objectKey: string): Promise<string | null>;
  /** Drops one kept address (its picture turned out broken), so the next `load` fetches that cover again. */
  forget(objectKey: string): void;
  /** Kept covers, fetches running and fetches waiting their turn (for logs). */
  stats(): { kept: number; running: number; waiting: number };
  /** Forgets every kept address and drops the waiting fetches; answers the addresses it kept, for the app to free. */
  release(): string[];
};

export const createParrotCoverCache = (input: ParrotCoverCacheInput): ParrotCoverCache => {
  const concurrency = Math.max(1, input.concurrency ?? PARROT_COVER_DOWNLOADS);
  const kept = new Map<string, string>();
  const inflight = new Map<string, Promise<string | null>>();
  const waiting: Array<(handedSlot: boolean) => void> = [];
  let running = 0;
  // Bumped by release(): a fetch started before it keeps nothing, one still waiting never runs.
  let epoch = 0;

  const fetchInTurn = (objectKey: string, startedIn: number) =>
    // `new Promise`, not `Promise.withResolvers`: the phone's JavaScript engine may lack the latter.
    new Promise<string | null>((resolve) => {
      const current = () => startedIn === epoch;
      const start = (handedSlot: boolean) => {
        if (!current()) {
          resolve(null);
          // A finished fetch handed its slot to this dropped one: pass it on.
          if (handedSlot) waiting.shift()?.(true);
          return;
        }
        running += 1;
        input
          .fetch(objectKey, current)
          .then(
            (address) => {
              if (address && current()) kept.set(objectKey, address);
              return current() ? address : null;
            },
            (error: unknown) => {
              input.failed(objectKey, error);
              return null;
            }
          )
          .then((address) => {
            // The slot is free before the asker hears back, so a cover it asks for next starts at once.
            running -= 1;
            waiting.shift()?.(true);
            resolve(address);
          });
      };
      if (running < concurrency) start(false);
      else waiting.push(start);
    });

  return {
    peek: (objectKey) => kept.get(objectKey) ?? null,
    load(objectKey) {
      const known = kept.get(objectKey);
      if (known) return Promise.resolve(known);
      const pending = inflight.get(objectKey);
      if (pending) return pending;
      const task = fetchInTurn(objectKey, epoch).finally(() => {
        if (inflight.get(objectKey) === task) inflight.delete(objectKey);
      });
      inflight.set(objectKey, task);
      return task;
    },
    forget(objectKey) {
      kept.delete(objectKey);
    },
    stats: () => ({ kept: kept.size, running, waiting: waiting.length }),
    release() {
      epoch += 1;
      const addresses = [...kept.values()];
      kept.clear();
      // Waiting fetches see the new epoch and end at once without fetching.
      for (const start of waiting.splice(0)) start(false);
      return addresses;
    },
  };
};

/**
 * How many bytes of covers a device keeps on disk (PAR-COPY-01: the local copy of the vault's pictures is bounded by
 * bytes, kept across restarts and cleared on sign-out). Past it, the least recently shown covers go; one shown again
 * is fetched from the user's storage, never looked up anew.
 */
export const PARROT_COVER_KEEP_BYTES = { desktop: 300 * 1024 * 1024, phone: 150 * 1024 * 1024 } as const;

export type ParrotKeptCover = { name: string; size: number; usedAt: number };

/** The kept covers to delete so the rest fit in `maxBytes`: least recently shown first, never `keep` (just kept). */
export const parrotCoversToDrop = (kept: readonly ParrotKeptCover[], maxBytes: number, keep?: string): string[] => {
  let total = kept.reduce((sum, cover) => sum + cover.size, 0);
  const drop: string[] = [];
  for (const cover of [...kept].sort((a, b) => a.usedAt - b.usedAt)) {
    if (total <= maxBytes) break;
    if (cover.name === keep) continue;
    drop.push(cover.name);
    total -= cover.size;
  }
  return drop;
};
