export type DevStorageIndex = {
  version: number;
  createdAt: string;
  sourceDir: string;
  qualities: Record<
    string,
    {
      map: string;
      totalSize: number;
      chunkKeys: string[];
      chunkSizes: number[];
    }
  >;
  subtitle?: { key: string; language: string; label: string; sourceFile: string };
};

export type DevChunkMap = {
  quality: string;
  totalSize: number;
  sourceFile: string;
  durationSeconds?: number;
  init?: { key: string; size: number };
  chunks: { key: string; size: number; startSeconds?: number }[];
};

const STORAGE_PREFIX = "/__storage";
let indexCache: DevStorageIndex | null = null;
let indexPromise: Promise<DevStorageIndex> | null = null;
const mapCache = new Map<string, DevChunkMap>();
const mapPromiseCache = new Map<string, Promise<DevChunkMap>>();

export const loadDevStorageIndex = async () => {
  if (indexCache) return indexCache;
  if (indexPromise) return indexPromise;
  indexPromise = (async () => {
    const response = await fetch(`${STORAGE_PREFIX}/index.json`, { cache: "no-store" });
    if (!response.ok) {
      throw new Error("DEV_STORAGE_INDEX_NOT_FOUND");
    }
    const data = (await response.json()) as DevStorageIndex;
    indexCache = data;
    indexPromise = null;
    return data;
  })();
  return indexPromise;
};

export const loadDevStorageMap = async (quality: string) => {
  if (mapCache.has(quality)) return mapCache.get(quality)!;
  if (mapPromiseCache.has(quality)) return mapPromiseCache.get(quality)!;
  const index = await loadDevStorageIndex();
  const entry = index.qualities[quality];
  if (!entry) {
    throw new Error("DEV_STORAGE_MAP_NOT_FOUND");
  }
  const promise = (async () => {
    const response = await fetch(`${STORAGE_PREFIX}/${entry.map}`, { cache: "no-store" });
    if (!response.ok) {
      throw new Error("DEV_STORAGE_MAP_NOT_FOUND");
    }
    const data = (await response.json()) as DevChunkMap;
    mapCache.set(quality, data);
    mapPromiseCache.delete(quality);
    return data;
  })();
  mapPromiseCache.set(quality, promise);
  return promise;
};

export const fetchDevChunk = async (chunkKey: string, signal?: AbortSignal) => {
  const response = await fetch(`${STORAGE_PREFIX}/chunks/${encodeURIComponent(chunkKey)}`, { signal });
  if (!response.ok) {
    throw new Error("DEV_STORAGE_CHUNK_NOT_FOUND");
  }
  return await response.arrayBuffer();
};

export const fetchDevSubtitle = async (subtitleKey: string, signal?: AbortSignal) => {
  const response = await fetch(`${STORAGE_PREFIX}/subtitles/${encodeURIComponent(subtitleKey)}`, { signal });
  if (!response.ok) {
    throw new Error("DEV_STORAGE_SUBTITLE_NOT_FOUND");
  }
  return await response.text();
};

export const getDevSourceUrl = (quality: string) =>
  `${STORAGE_PREFIX}/source/${encodeURIComponent(quality)}`;
