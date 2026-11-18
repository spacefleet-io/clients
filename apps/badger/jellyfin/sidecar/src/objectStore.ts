import { setTimeout as sleep } from "node:timers/promises";
import { decryptMediaObject } from "./mediaCrypto";

export type ObjectPurpose = "playback" | "export";

/**
 * Downloads one stored object. `onChunk` is awaited after each received chunk: while the promise it returns is
 * pending, the download takes no more data, which is how a prefetch steps aside for a wanted object (INTG-JF-06).
 */
export type ObjectFetcher = (key: string, purpose: ObjectPurpose, onChunk?: () => Promise<void> | void) => Promise<Uint8Array<ArrayBuffer>>;

export type ObjectStoreOptions = {
  fetcher: ObjectFetcher;
  /** HKDF-derived media master key (null = payloads are served as stored). */
  masterKey: Buffer | null;
  maxBytes?: number;
  /** How many segments after the one being played are fetched ahead. */
  prefetchCount?: number;
  /** How many of those prefetches may download at the same time. */
  prefetchParallel?: number;
  retryAttempts?: number;
  retryDelayMs?: number;
  log?: (message: string, meta?: Record<string, unknown>) => void;
};

/** Errors that must surface unchanged (auth, unpaid, missing): retrying cannot help. */
const isTerminal = (error: unknown) => {
  const status = (error as { status?: number } | null)?.status;
  if (status === 401 || status === 402 || status === 403 || status === 404) return true;
  return error instanceof Error && error.message === "download_source_missing";
};

/**
 * Decrypted-object cache for HLS segments: tunnel download + SFV1 decrypt, byte-bounded LRU,
 * in-flight de-duplication and sequential prefetch (the next segments of the playlist being played).
 *
 * The object a player is waiting for always goes first (INTG-JF-06): a request that finds its object neither cached nor
 * loading drops the queued prefetches (they are for the position the player just left), no queued prefetch starts while
 * a wanted object loads, and a prefetch already downloading pauses at its next chunk until no wanted object is loading.
 */
export class ObjectStore {
  private readonly cache = new Map<string, Buffer<ArrayBuffer>>();
  private readonly inflight = new Map<string, Promise<Buffer<ArrayBuffer>>>();
  private readonly nextKeys = new Map<string, string[]>();
  private readonly prefetchQueue: string[] = [];
  /** Keys a caller is waiting for, with the number of waiters. */
  private readonly wanted = new Map<string, number>();
  private wantedSettled: { promise: Promise<void>; resolve: () => void } | null = null;
  private prefetchRunning = 0;
  private cachedBytes = 0;
  private readonly maxBytes: number;
  private readonly prefetchCount: number;
  private readonly prefetchParallel: number;
  private readonly retryAttempts: number;
  private readonly retryDelayMs: number;
  private masterKey: Buffer | null;

  constructor(private readonly options: ObjectStoreOptions) {
    this.masterKey = options.masterKey;
    this.maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
    this.prefetchCount = options.prefetchCount ?? 3;
    this.prefetchParallel = Math.max(1, options.prefetchParallel ?? this.prefetchCount);
    this.retryAttempts = options.retryAttempts ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 150;
  }

  get stats() {
    return {
      entries: this.cache.size,
      bytes: this.cachedBytes,
      inflight: this.inflight.size,
      prefetchQueued: this.prefetchQueue.length,
      prefetchRunning: this.prefetchRunning,
    };
  }

  setMasterKey(masterKey: Buffer | null) {
    this.masterKey = masterKey;
    this.cache.clear();
    this.cachedBytes = 0;
  }

  /** Remember playlist order so a request for segment N warms segment N+1.. */
  registerSequence(keys: readonly string[]) {
    keys.forEach((key, index) => {
      this.nextKeys.set(key, keys.slice(index + 1, index + 1 + this.prefetchCount));
    });
  }

  /** Queue keys for background loading; they start only while no wanted object is loading. */
  prefetch(keys: readonly string[]) {
    for (const key of keys) {
      if (this.cache.has(key) || this.inflight.has(key) || this.prefetchQueue.includes(key)) continue;
      this.prefetchQueue.push(key);
    }
    this.pumpPrefetch();
  }

  async get(key: string, purpose: ObjectPurpose = "playback"): Promise<Buffer<ArrayBuffer>> {
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      this.warmNext(key);
      return hit;
    }
    this.markWanted(key);
    try {
      let pending = this.inflight.get(key);
      if (!pending) {
        // Nobody is loading it: the player moved (a seek) or prefetch fell behind. What is still queued is for the old
        // position and would only compete with this request.
        this.prefetchQueue.length = 0;
        pending = this.startLoad(key, purpose);
      }
      const payload = await pending;
      this.warmNext(key);
      return payload;
    } finally {
      this.unmarkWanted(key);
    }
  }

  private warmNext(key: string) {
    const next = this.nextKeys.get(key);
    if (next && next.length > 0) this.prefetch(next);
  }

  private pumpPrefetch() {
    while (this.wanted.size === 0 && this.prefetchRunning < this.prefetchParallel && this.prefetchQueue.length > 0) {
      const key = this.prefetchQueue.shift()!;
      if (this.cache.has(key) || this.inflight.has(key)) continue;
      this.prefetchRunning += 1;
      this.startLoad(key, "playback")
        .catch((error) => {
          this.options.log?.("object prefetch failed", {
            key,
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          this.prefetchRunning -= 1;
          this.pumpPrefetch();
        });
    }
  }

  private startLoad(key: string, purpose: ObjectPurpose): Promise<Buffer<ArrayBuffer>> {
    const pending = this.load(key, purpose).finally(() => this.inflight.delete(key));
    this.inflight.set(key, pending);
    return pending;
  }

  private markWanted(key: string) {
    if (this.wanted.size === 0) this.wantedSettled = Promise.withResolvers<void>();
    this.wanted.set(key, (this.wanted.get(key) ?? 0) + 1);
  }

  private unmarkWanted(key: string) {
    const count = (this.wanted.get(key) ?? 1) - 1;
    if (count > 0) this.wanted.set(key, count);
    else this.wanted.delete(key);
    if (this.wanted.size > 0) return;
    this.wantedSettled?.resolve();
    this.wantedSettled = null;
    this.pumpPrefetch();
  }

  /** Called between chunks of a download: holds a download nobody waits for while a wanted object is loading. */
  private yieldTo(key: string): Promise<void> | undefined {
    if (this.wanted.size === 0 || this.wanted.has(key)) return undefined;
    return this.wantedSettled?.promise;
  }

  private async load(key: string, purpose: ObjectPurpose): Promise<Buffer<ArrayBuffer>> {
    let lastError: unknown = null;
    const onChunk = () => this.yieldTo(key);
    for (let attempt = 1; attempt <= this.retryAttempts; attempt += 1) {
      try {
        const startedAt = Date.now();
        const encrypted = await this.options.fetcher(key, purpose, onChunk);
        const plain = this.masterKey ? decryptMediaObject(this.masterKey, encrypted) : Buffer.from(encrypted);
        this.options.log?.("object loaded", {
          key,
          attempt,
          encryptedBytes: encrypted.byteLength,
          plainBytes: plain.byteLength,
          ms: Date.now() - startedAt,
        });
        this.remember(key, plain);
        return plain;
      } catch (error) {
        lastError = error;
        if (isTerminal(error) || attempt === this.retryAttempts) break;
        this.options.log?.("object load retry", {
          key,
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
        await sleep(this.retryDelayMs * attempt);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("object_load_failed");
  }

  private remember(key: string, payload: Buffer<ArrayBuffer>) {
    if (payload.byteLength > this.maxBytes) return;
    const previous = this.cache.get(key);
    if (previous) this.cachedBytes -= previous.byteLength;
    this.cache.set(key, payload);
    this.cachedBytes += payload.byteLength;
    for (const [oldKey, value] of this.cache) {
      if (this.cachedBytes <= this.maxBytes) break;
      if (oldKey === key) continue;
      this.cache.delete(oldKey);
      this.cachedBytes -= value.byteLength;
    }
  }
}
