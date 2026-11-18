/**
 * Decrypted artwork kept on the device across launches (META-ART-01/02): display reads this first, the user's
 * vault only on a miss, and the metadata service never. Byte-bounded (least recently used goes first), kept across
 * restarts, and cleared on sign-out (`clear()`). Shared by every browser-based client (desktop renderer, web player).
 *
 * Two layers, so the eviction logic is testable without a browser: `ArtworkBackend` is the dumb persistence
 * (IndexedDB in the app, a Map in tests), `createArtworkStore` is the LRU on top. Every failure degrades to a
 * cache miss; the cache never throws.
 */
import type { ArtworkStore } from "./images";

export interface ArtworkIndexEntry {
  key: string;
  /** Characters of the stored value (a data URI: close enough to bytes for a bound). */
  size: number;
  /** Last use, ms since epoch. */
  at: number;
}

export interface ArtworkBackend {
  /** Every entry's metadata (not the values). */
  loadIndex(): Promise<ArtworkIndexEntry[]>;
  read(key: string): Promise<string | null>;
  /** Stores one value and its entry, and deletes the evicted keys, in one step. */
  write(entry: ArtworkIndexEntry, value: string, evict: string[]): Promise<void>;
  touch(key: string, at: number): Promise<void>;
  clear(): Promise<void>;
}

export const DEFAULT_ARTWORK_CACHE_BYTES = 192 * 1024 * 1024;

export const createArtworkStore = (
  backend: ArtworkBackend,
  options: { maxBytes?: number; now?: () => number } = {}
): ArtworkStore => {
  const maxBytes = options.maxBytes ?? DEFAULT_ARTWORK_CACHE_BYTES;
  const now = options.now ?? Date.now;
  // Insertion order is recency order (oldest first): a use re-inserts its key.
  const index = new Map<string, ArtworkIndexEntry>();
  let totalBytes = 0;
  let ready: Promise<void> | null = null;
  // One operation at a time, so a clear() lands after every write started before it.
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(op: () => Promise<T>, fallback: T): Promise<T> => {
    const run = chain.then(op, op).catch(() => fallback);
    chain = run;
    return run;
  };

  const load = (): Promise<void> => {
    ready ??= (async () => {
      let entries: ArtworkIndexEntry[] = [];
      try {
        entries = await backend.loadIndex();
      } catch {
        entries = [];
      }
      entries.sort((a, b) => a.at - b.at);
      for (const entry of entries) {
        index.set(entry.key, entry);
        totalBytes += entry.size;
      }
    })();
    return ready;
  };

  const forget = (key: string) => {
    const entry = index.get(key);
    if (!entry) return;
    index.delete(key);
    totalBytes -= entry.size;
  };

  return {
    get: (key) =>
      enqueue(async () => {
        await load();
        const entry = index.get(key);
        if (!entry) return null;
        const value = await backend.read(key);
        if (value === null) {
          forget(key);
          return null;
        }
        const at = now();
        index.delete(key);
        index.set(key, { ...entry, at });
        void backend.touch(key, at).catch(() => undefined);
        return value;
      }, null),
    put: (key, value) =>
      enqueue(async () => {
        await load();
        const size = value.length;
        if (size > maxBytes) return;
        forget(key);
        const evict: string[] = [];
        for (const [oldest, entry] of index) {
          if (totalBytes + size <= maxBytes) break;
          evict.push(oldest);
          totalBytes -= entry.size;
        }
        for (const evicted of evict) index.delete(evicted);
        const entry: ArtworkIndexEntry = { key, size, at: now() };
        await backend.write(entry, value, evict);
        index.set(key, entry);
        totalBytes += size;
      }, undefined),
    clear: () =>
      enqueue(async () => {
        await load();
        index.clear();
        totalBytes = 0;
        await backend.clear();
      }, undefined),
  };
};

/** In-memory backend: tests, and the fallback when IndexedDB is unavailable. */
export const createMemoryArtworkBackend = (): ArtworkBackend & { values: Map<string, string> } => {
  const values = new Map<string, string>();
  const meta = new Map<string, ArtworkIndexEntry>();
  return {
    values,
    loadIndex: async () => [...meta.values()],
    read: async (key) => values.get(key) ?? null,
    write: async (entry, value, evict) => {
      for (const key of evict) {
        values.delete(key);
        meta.delete(key);
      }
      values.set(entry.key, value);
      meta.set(entry.key, entry);
    },
    touch: async (key, at) => {
      const entry = meta.get(key);
      if (entry) meta.set(key, { ...entry, at });
    },
    clear: async () => {
      values.clear();
      meta.clear();
    },
  };
};

const DB_NAME = "sf_artwork_cache";
const DB_VERSION = 1;
const DATA = "data";
const META = "meta";

const done = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

const request = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/**
 * IndexedDB backend: values in one object store, their metadata (size, last use) in another, so loading the index
 * at start reads kilobytes, not the images. Its own database, apart from the library snapshot's.
 */
export const createIndexedDbArtworkBackend = (factory: IDBFactory): ArtworkBackend => {
  let dbPromise: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const opening = factory.open(DB_NAME, DB_VERSION);
      opening.onupgradeneeded = () => {
        const db = opening.result;
        if (!db.objectStoreNames.contains(DATA)) db.createObjectStore(DATA);
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
      };
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    return dbPromise;
  };
  return {
    loadIndex: async () => {
      const db = await open();
      const tx = db.transaction(META, "readonly");
      const entries = (await request(tx.objectStore(META).getAll())) as ArtworkIndexEntry[];
      return entries.filter((entry) => typeof entry?.key === "string" && typeof entry.size === "number" && typeof entry.at === "number");
    },
    read: async (key) => {
      const db = await open();
      const value = await request(db.transaction(DATA, "readonly").objectStore(DATA).get(key));
      return typeof value === "string" ? value : null;
    },
    write: async (entry, value, evict) => {
      const db = await open();
      const tx = db.transaction([DATA, META], "readwrite");
      const completed = done(tx);
      for (const key of evict) {
        tx.objectStore(DATA).delete(key);
        tx.objectStore(META).delete(key);
      }
      tx.objectStore(DATA).put(value, entry.key);
      tx.objectStore(META).put(entry, entry.key);
      await completed;
    },
    touch: async (key, at) => {
      const db = await open();
      const tx = db.transaction(META, "readwrite");
      const completed = done(tx);
      const store = tx.objectStore(META);
      const entry = (await request(store.get(key))) as ArtworkIndexEntry | undefined;
      if (entry) store.put({ ...entry, at }, key);
      await completed;
    },
    clear: async () => {
      const db = await open();
      const tx = db.transaction([DATA, META], "readwrite");
      const completed = done(tx);
      tx.objectStore(DATA).clear();
      tx.objectStore(META).clear();
      await completed;
    },
  };
};
