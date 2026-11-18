/**
 * The phone's and the TV's local cache of decrypted artwork (META-ART-01/02).
 *
 * Browsing and playback show only the user's own encrypted copy of a picture (`asset:<type>::<key>`): the decrypted
 * file on this device answers first, the user's storage only on a miss, and the metadata service never. The cache
 * survives restarts (files under the app's cache directory), is kept under a byte bound (oldest-used files out first)
 * and is emptied on sign-out (`reset`).
 *
 * Pure logic (files and hash are injected); the React Native wiring is in `assets.ts`.
 */

export type ArtworkCacheFileInfo = { path: string; size: number; /** Last write or use, ms since epoch. */ mtime: number };

export type ArtworkCacheFiles = {
  /** Local file path for a cache file name. */
  pathFor: (fileName: string) => string;
  exists: (path: string) => Promise<boolean>;
  /** Creates the cache directory when missing and writes the base64 payload as binary. */
  writeBase64: (path: string, base64: string) => Promise<void>;
  /** Every cached file (empty when the directory does not exist). */
  list: () => Promise<ArtworkCacheFileInfo[]>;
  remove: (path: string) => Promise<void>;
  /** Deletes the cache directory with everything in it. */
  removeAll: () => Promise<void>;
  /** Marks a file as just used, so the byte bound evicts it last. Optional: without it, oldest-written goes first. */
  touch?: (path: string, mtimeMs: number) => Promise<void>;
};

export type VaultArtworkCacheDeps = {
  files: ArtworkCacheFiles;
  /** Hex digest of a string, used for cache file names (a reference never ends up in a file name). */
  hash: (input: string) => string;
  /** The cache directory is kept under this many bytes. Default 128 MiB. */
  maxBytes?: number;
  now?: () => number;
  /** Event name and counts only, never a reference or a path. */
  onEvent?: (event: string, detail: Record<string, unknown>) => void;
};

export type VaultArtworkCache = {
  /** `file://` URL when the picture was already shown or stored in this session, else null. Synchronous (first-paint seed). */
  getCached: (ref: string) => string | null;
  /**
   * `file://` URL of the decrypted picture: the file on this device first, else `download` (the user's storage,
   * decrypted, as base64) once, written to the cache. Null when it cannot be had now. Never rejects.
   */
  load: (ref: string, download: (objectKey: string) => Promise<string>) => Promise<string | null>;
  /**
   * Stores a picture this device just copied into the user's storage, so showing it needs no download. Pass the
   * `epoch()` read before the copy started: a sign-out meanwhile makes the put write nothing.
   */
  put: (ref: string, base64: string, startedEpoch?: number) => Promise<string | null>;
  /** Bumped by every `reset`; work that began under an older epoch keeps nothing. */
  epoch: () => number;
  /** Sign-out: forget every URL and delete the files; a load still running writes nothing. */
  reset: () => Promise<void>;
};

export const DEFAULT_ARTWORK_CACHE_BYTES = 128 * 1024 * 1024;
/** The cache is trimmed on the first write of a session, then after this fraction of the bound was written. */
const TRIM_EVERY_FRACTION = 16;

/** Object key, content type and cache key of a stored picture's reference (`asset:<type>::<key>` or a bare object key). */
export const parseAssetRef = (value: string) => {
  if (value.startsWith("asset:")) {
    const payload = value.slice("asset:".length);
    const splitIndex = payload.indexOf("::");
    if (splitIndex > 0) {
      return { objectKey: payload.slice(splitIndex + 2), contentType: payload.slice(0, splitIndex), cacheKey: value };
    }
  }
  const lower = value.toLowerCase();
  const contentType = lower.endsWith(".png")
    ? "image/png"
    : lower.endsWith(".webp")
      ? "image/webp"
      : lower.endsWith(".jpg") || lower.endsWith(".jpeg")
        ? "image/jpeg"
        : "application/octet-stream";
  return { objectKey: value, contentType, cacheKey: value };
};

const extensionForContentType = (contentType: string) => {
  const normalized = contentType.split(";")[0]?.trim();
  if (normalized === "image/png") return "png";
  if (normalized === "image/webp") return "webp";
  if (normalized === "image/jpeg") return "jpg";
  return "bin";
};

/** Files to delete so the rest fits in `maxBytes`: least recently used first, never `keep`. */
export const pickEvictions = (entries: readonly ArtworkCacheFileInfo[], maxBytes: number, keep: string): string[] => {
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  const victims: string[] = [];
  for (const entry of [...entries].sort((a, b) => a.mtime - b.mtime)) {
    if (total <= maxBytes) break;
    if (entry.path === keep) continue;
    victims.push(entry.path);
    total -= entry.size;
  }
  return victims;
};

export const createVaultArtworkCache = (deps: VaultArtworkCacheDeps): VaultArtworkCache => {
  const { files } = deps;
  const maxBytes = deps.maxBytes ?? DEFAULT_ARTWORK_CACHE_BYTES;
  const now = deps.now ?? Date.now;
  const urls = new Map<string, string>();
  const inflight = new Map<string, Promise<string | null>>();
  let epoch = 0;
  let bytesSinceTrim = 0;
  let trimmedOnce = false;

  const pathOf = (ref: string) => {
    const { cacheKey, contentType } = parseAssetRef(ref);
    return { cacheKey, path: files.pathFor(`${deps.hash(cacheKey)}.${extensionForContentType(contentType)}`) };
  };

  const trim = async (keep: string, startedEpoch: number) => {
    try {
      const victims = pickEvictions(await files.list(), maxBytes, keep);
      if (startedEpoch !== epoch || victims.length === 0) return;
      const gone = new Set(victims.map((path) => `file://${path}`));
      for (const [key, url] of urls) if (gone.has(url)) urls.delete(key);
      for (const path of victims) await files.remove(path);
      deps.onEvent?.("artwork.cache.trimmed", { files: victims.length });
    } catch {
      deps.onEvent?.("artwork.cache.trim_failed", {});
    }
  };

  /** Writes a decrypted picture and keeps the directory under the bound; the URL, or null after a reset meanwhile. */
  const write = async (cacheKey: string, path: string, base64: string, startedEpoch: number) => {
    await files.writeBase64(path, base64);
    if (startedEpoch !== epoch) {
      await files.remove(path).catch(() => undefined);
      return null;
    }
    const url = `file://${path}`;
    urls.set(cacheKey, url);
    bytesSinceTrim += Math.ceil((base64.length * 3) / 4);
    if (!trimmedOnce || bytesSinceTrim >= maxBytes / TRIM_EVERY_FRACTION) {
      trimmedOnce = true;
      bytesSinceTrim = 0;
      await trim(path, startedEpoch);
    }
    return url;
  };

  return {
    getCached(ref) {
      return urls.get(parseAssetRef(ref).cacheKey) ?? null;
    },

    load(ref, download) {
      const { cacheKey, path } = pathOf(ref);
      const known = urls.get(cacheKey);
      if (known) return Promise.resolve(known);
      const pending = inflight.get(cacheKey);
      if (pending) return pending;
      const startedEpoch = epoch;
      const task = (async (): Promise<string | null> => {
        try {
          if (await files.exists(path)) {
            if (startedEpoch !== epoch) return null;
            await files.touch?.(path, now()).catch(() => undefined);
            const url = `file://${path}`;
            urls.set(cacheKey, url);
            return url;
          }
          const base64 = await download(parseAssetRef(ref).objectKey);
          if (startedEpoch !== epoch) return null;
          const url = await write(cacheKey, path, base64, startedEpoch);
          deps.onEvent?.("artwork.vault.downloaded", { bytes: Math.ceil((base64.length * 3) / 4) });
          return url;
        } catch (error) {
          deps.onEvent?.("artwork.vault.failed", { reason: error instanceof Error ? error.name : "unknown" });
          return null;
        }
      })().finally(() => {
        if (inflight.get(cacheKey) === task) inflight.delete(cacheKey);
      });
      inflight.set(cacheKey, task);
      return task;
    },

    async put(ref, base64, startedEpoch = epoch) {
      if (startedEpoch !== epoch) return null;
      const { cacheKey, path } = pathOf(ref);
      try {
        return await write(cacheKey, path, base64, startedEpoch);
      } catch {
        deps.onEvent?.("artwork.cache.put_failed", {});
        return null;
      }
    },

    epoch: () => epoch,

    async reset() {
      epoch += 1;
      urls.clear();
      inflight.clear();
      bytesSinceTrim = 0;
      trimmedOnce = false;
      await files.removeAll();
    },
  };
};
