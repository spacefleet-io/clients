// Byte-range reads over a song stored as 1 MiB SFV1 chunks (PAR-FMT-01): the desktop's loopback server and the web
// player's service worker both answer a player's `Range:` request with these bytes.
import type { ChunkedFile } from "./catalog";

/** One chunk object of a stored file. */
export type ParrotChunkRef = ChunkedFile["chunks"][number];

/** Loads one chunk's plaintext (download, then decrypt). */
export type ParrotChunkLoader = (chunk: ParrotChunkRef) => Promise<Uint8Array>;

/**
 * Yields the plaintext bytes `start..end` (inclusive) of a file stored as chunks, chunk by chunk, so a player can
 * start before the whole song has arrived. While the current chunk is being sent, the next `ahead` chunks are fetched
 * (default 1), so at most `ahead + 1` chunks are held at once (PAR-PLAY-08).
 */
export async function* readParrotFileRange(
  chunks: readonly ParrotChunkRef[],
  start: number,
  end: number,
  load: ParrotChunkLoader,
  ahead = 1
): AsyncGenerator<Uint8Array> {
  const needed = chunks.filter((chunk) => chunk.plainOffset + chunk.plainSize > start && chunk.plainOffset <= end);
  const inFlight = 1 + Math.max(0, ahead);
  const pending: Array<Promise<Uint8Array>> = [];
  let requested = 0;
  for (const chunk of needed) {
    while (requested < needed.length && pending.length < inFlight) {
      const loading = load(needed[requested]!);
      // A consumer that stops early (the player seeking away) never awaits a prefetch: keep its failure quiet.
      loading.catch(() => {});
      pending.push(loading);
      requested += 1;
    }
    const plain = await pending.shift()!;
    const from = Math.max(0, start - chunk.plainOffset);
    const to = Math.min(chunk.plainSize, end - chunk.plainOffset + 1);
    yield plain.subarray(from, to);
  }
}

/**
 * The byte range a `Range:` header asks of a file of `size` bytes, as inclusive `[start, end]`; the whole file when
 * there is no header. Null when the range cannot be served (416).
 */
export const parseByteRange = (header: string | null, size: number): { start: number; end: number } | null => {
  if (size <= 0) return null;
  if (!header) return { start: 0, end: size - 1 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return null;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (start >= size || end < start) return null;
  return { start, end };
};

/**
 * Wraps `open` (download, then decrypt one chunk) with a memory cache of the most recent plaintexts up to `maxBytes`
 * and a shared download for a chunk already in flight, so a player's seeks and repeated range requests do not fetch
 * the same chunk twice. A chunk that opens to another size than its row says is refused.
 */
export const cachedChunkLoader = (input: {
  open: (chunk: ParrotChunkRef) => Promise<Uint8Array>;
  maxBytes?: number;
  log?: (message: string) => void;
}): ParrotChunkLoader & { clear: () => void } => {
  const maxBytes = input.maxBytes ?? 48 * 1024 * 1024;
  const cache = new Map<string, Uint8Array>();
  const inFlight = new Map<string, Promise<Uint8Array>>();
  let cachedBytes = 0;

  const remember = (key: string, plain: Uint8Array) => {
    cache.set(key, plain);
    cachedBytes += plain.length;
    for (const [oldKey, oldValue] of cache) {
      if (cachedBytes <= maxBytes || oldKey === key) break;
      cache.delete(oldKey);
      cachedBytes -= oldValue.length;
    }
  };

  const load = (async (chunk: ParrotChunkRef) => {
    const cached = cache.get(chunk.objectKey);
    if (cached) {
      cache.delete(chunk.objectKey);
      cache.set(chunk.objectKey, cached);
      return cached;
    }
    const pending = inFlight.get(chunk.objectKey);
    if (pending) return pending;
    const started = Date.now();
    const promise = (async () => {
      const plain = await input.open(chunk);
      if (plain.length !== chunk.plainSize) {
        throw new Error(`chunk ${chunk.objectKey} decrypted to ${plain.length} bytes, expected ${chunk.plainSize}`);
      }
      input.log?.(`[parrot-chunks] ${chunk.objectKey} ${plain.length} bytes in ${Date.now() - started} ms`);
      remember(chunk.objectKey, plain);
      return plain;
    })();
    inFlight.set(chunk.objectKey, promise);
    try {
      return await promise;
    } finally {
      inFlight.delete(chunk.objectKey);
    }
  }) as ParrotChunkLoader & { clear: () => void };
  load.clear = () => {
    cache.clear();
    cachedBytes = 0;
  };
  return load;
};
