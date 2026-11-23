import { Platform } from "react-native";
import { Buffer } from "buffer";
import RNFS from "react-native-fs";
import { SNAPSHOT_TAIL_BYTES_THRESHOLD } from "@space/library-db-definition/opClass";

export type LibraryCache = {
  version: number;
  snapshotVersion?: number;
  blobBase64?: string;
  blobPath?: string;
  encrypted?: boolean;
  encoding?: "base64" | "binary";
  updatedAt: string | null;
  mode?: "combined" | "split";
};

export type PendingSync = {
  baseVersion: number;
  snapshotId: string;
  chunkSize: number;
  snapshotPath: string;
  manifestPath: string;
  updatedAt: string;
  keyProbe: string | null;
  // Hashes of `snapshotPath` when the pending snapshot was built (PR #143).
  // flushPending publishes them only while the file still hashes to exactly
  // this list. Absent on records written by older builds, whose snapshotPath
  // was the shared cache blob that persist() re-encrypts.
  chunkRefs?: string[];
};

export type PendingOp = {
  id: string;
  createdAt: string;
  type: string;
  payload: Record<string, unknown>;
};

/**
 * Folder for the library's files and (on Apple platforms) its databases. Apple TV only lets an app write to
 * Caches (Documents is read-only on the hardware; the simulator does not enforce it), so the tvOS app keeps
 * everything there; the patched SQLite plugin opens "Documents" databases in Caches on tvOS to match. The system
 * may purge Caches while the app is not running: the library then reloads from the server, as on a fresh install.
 */
const APP_DATA_DIR =
  Platform.OS === "ios" && Platform.isTV ? RNFS.CachesDirectoryPath : RNFS.DocumentDirectoryPath;
const libraryDir = () => `${APP_DATA_DIR}/library`;
const cacheFile = () => `${libraryDir()}/cache.json`;
const cacheBlobFile = () => `${libraryDir()}/cache.blob`;
const cacheOwnerFile = () => `${libraryDir()}/cache.owner.json`;
const pendingFile = () => `${libraryDir()}/pending.json`;
const pendingOpsFile = () => `${libraryDir()}/pending_ops.json`;
const pendingSnapshotFile = () => `${libraryDir()}/pending.snapshot`;
const pendingManifestFile = () => `${libraryDir()}/pending.manifest`;
const snapshotOpCountFile = () => `${libraryDir()}/snapshot_ops.json`;

/**
 * iOS gives the app's data container a new UUID path on every install and update and moves the
 * files, so an absolute path that cache.json / pending.json saved under an earlier install points
 * outside today's sandbox. Writing there failed every launch with `ENCRYPT_FAILED … permission to
 * save the file "library" in the folder "Documents"`, and loadPending took the files for missing.
 * The library folder is flat, so a saved path to a file in a `library` folder resolves to the
 * same file name in today's library folder.
 */
const resolveLibraryFilePath = (savedPath: string) => {
  const dir = libraryDir();
  const slash = savedPath.lastIndexOf("/");
  const savedDir = savedPath.slice(0, slash);
  if (savedDir === dir || !savedDir.endsWith("/library")) return savedPath;
  const resolved = `${dir}${savedPath.slice(slash)}`;
  console.warn("library.storage.path_rebased", JSON.stringify({ from: savedPath, to: resolved }));
  return resolved;
};

const dbFile = (name: string) => {
  if (Platform.OS === "android") {
    const base = RNFS.DocumentDirectoryPath.replace(/\/files$/, "");
    return `${base}/databases/${name}`;
  }
  return `${APP_DATA_DIR}/${name}`;
};
const coreDbFile = () => dbFile("library.core.sqlite");
const metadataDbFile = () => dbFile("library.metadata.sqlite");
const playbackDbFile = () => dbFile("library.playback.sqlite");
const ingestDbFile = () => dbFile("library.ingest.sqlite");
const snapshotDbFile = () => dbFile("library.snapshot.sqlite");

const ensureDir = async () => {
  const dir = libraryDir();
  const exists = await RNFS.exists(dir);
  if (!exists) {
    await RNFS.mkdir(dir);
  }
  return dir;
};

const readJson = async <T>(filePath: string): Promise<T | null> => {
  const exists = await RNFS.exists(filePath);
  if (!exists) return null;
  try {
    const raw = await RNFS.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const writeJson = async (filePath: string, value: unknown) => {
  await ensureDir();
  await RNFS.writeFile(filePath, JSON.stringify(value), "utf8");
};

export const getCoreDbPath = () => coreDbFile();
export const getMetadataDbPath = () => metadataDbFile();
export const getPlaybackDbPath = () => playbackDbFile();
export const getIngestDbPath = () => ingestDbFile();
export const getSnapshotDbPath = () => snapshotDbFile();
export const getDbPath = () => snapshotDbFile();
export const getCacheBlobPath = () => cacheBlobFile();
/** The pending snapshot's own file. */
export const getPendingSnapshotPath = () => pendingSnapshotFile();

export const loadCache = async (): Promise<LibraryCache | null> => {
  const cache = await readJson<LibraryCache>(cacheFile());
  if (!cache || typeof cache !== "object") return null;
  const hasBase64 = typeof cache.blobBase64 === "string" && cache.blobBase64.length > 0;
  const hasPath = typeof cache.blobPath === "string" && cache.blobPath.length > 0;
  if (!Number.isFinite(Number(cache.version))) return null;
  const mode = cache.mode === "split" ? "split" : "combined";
  if (mode === "combined" && !hasBase64 && !hasPath) return null;
  if (mode === "split") {
    const [coreExists, metadataExists, playbackExists] = await Promise.all([
      RNFS.exists(coreDbFile()),
      RNFS.exists(metadataDbFile()),
      RNFS.exists(playbackDbFile()),
    ]);
    if (!coreExists || !metadataExists || !playbackExists) return null;
  }
  const snapshotVersion =
    typeof cache.snapshotVersion === "number" && Number.isFinite(Number(cache.snapshotVersion))
      ? Number(cache.snapshotVersion)
      : undefined;
  return {
    version: Number(cache.version),
    snapshotVersion,
    blobBase64: hasBase64 ? cache.blobBase64 : undefined,
    blobPath: hasPath && cache.blobPath ? resolveLibraryFilePath(cache.blobPath) : undefined,
    encrypted: typeof cache.encrypted === "boolean" ? cache.encrypted : hasPath ? true : false,
    encoding: cache.encoding === "binary" ? "binary" : "base64",
    updatedAt: typeof cache.updatedAt === "string" ? cache.updatedAt : null,
    mode,
  };
};

export const saveCache = async (cache: LibraryCache) => {
  await writeJson(cacheFile(), cache);
};

export const saveCacheBlobFromPath = async (sourcePath: string) => {
  await ensureDir();
  const targetPath = cacheBlobFile();
  if (await RNFS.exists(targetPath)) {
    await RNFS.unlink(targetPath);
  }
  await RNFS.copyFile(sourcePath, targetPath);
  return targetPath;
};

export const clearCache = async () => {
  if (await RNFS.exists(cacheFile())) {
    await RNFS.unlink(cacheFile());
  }
  if (await RNFS.exists(cacheBlobFile())) {
    await RNFS.unlink(cacheBlobFile());
  }
  if (await RNFS.exists(snapshotOpCountFile())) {
    await RNFS.unlink(snapshotOpCountFile());
  }
};

/**
 * Builds before LIB-STORE-05 re-encrypted the whole library into cache.blob after every write.
 * The split databases are the at-rest copy now, so the blob is dead weight once nothing (a
 * legacy pending record) points at it.
 */
export const removeCacheBlob = async () => {
  if (await RNFS.exists(cacheBlobFile())) {
    await RNFS.unlink(cacheBlobFile());
  }
};

/**
 * Non-progress ops since the server's latest snapshot (LIB-SYNC-07): how many, and their ciphertext `bytes`
 * (LIB-SYNC-12). The server only sees opaque versions, so the client keeps this count itself; it is tied to
 * `snapshotVersion` and restarts from zero whenever a newer snapshot exists. `bytesThreshold` is the tail size that
 * makes a snapshot due: `SNAPSHOT_TAIL_BYTES_THRESHOLD`, or the size of a snapshot that came out larger than the tail
 * it would have replaced.
 */
export type SnapshotOpCount = { snapshotVersion: number; count: number; bytes: number; bytesThreshold: number };

export const loadSnapshotOpCount = async (): Promise<SnapshotOpCount | null> => {
  const stored = await readJson<Partial<SnapshotOpCount>>(snapshotOpCountFile());
  if (!stored || !Number.isFinite(stored.snapshotVersion) || !Number.isFinite(stored.count)) return null;
  // A file written before LIB-SYNC-12 has no bytes: the tail counts from now on.
  const bytes = Number(stored.bytes);
  const bytesThreshold = Number(stored.bytesThreshold);
  return {
    snapshotVersion: Number(stored.snapshotVersion),
    count: Math.max(0, Math.floor(Number(stored.count))),
    bytes: Number.isFinite(bytes) && bytes > 0 ? bytes : 0,
    bytesThreshold: Number.isFinite(bytesThreshold) && bytesThreshold > 0 ? bytesThreshold : SNAPSHOT_TAIL_BYTES_THRESHOLD,
  };
};

export const saveSnapshotOpCount = async (value: SnapshotOpCount) => {
  await writeJson(snapshotOpCountFile(), value);
};

/**
 * The account that owns the local library (cache.json, split sqlite files, pending ops). Kept in
 * its own file so every `saveCache` call site stays untouched.
 */
export const loadCacheOwner = async (): Promise<string | null> => {
  const owner = await readJson<{ userId?: unknown }>(cacheOwnerFile());
  return typeof owner?.userId === "string" && owner.userId.length > 0 ? owner.userId : null;
};

export const saveCacheOwner = async (userId: string) => {
  await writeJson(cacheOwnerFile(), { userId });
};

export const clearCacheOwner = async () => {
  if (await RNFS.exists(cacheOwnerFile())) {
    await RNFS.unlink(cacheOwnerFile());
  }
};

export const loadPending = async (): Promise<PendingSync | null> => {
  const pending = await readJson<PendingSync>(pendingFile());
  if (!pending || typeof pending !== "object") return null;
  if (!pending.snapshotId || typeof pending.snapshotId !== "string") return null;
  if (!Number.isFinite(Number(pending.chunkSize))) return null;
  if (!pending.snapshotPath || typeof pending.snapshotPath !== "string") return null;
  if (!pending.manifestPath || typeof pending.manifestPath !== "string") return null;
  if (!Number.isFinite(Number(pending.baseVersion))) return null;
  if (!pending.updatedAt || typeof pending.updatedAt !== "string") return null;
  const snapshotPath = resolveLibraryFilePath(pending.snapshotPath);
  const manifestPath = resolveLibraryFilePath(pending.manifestPath);
  if (!(await RNFS.exists(snapshotPath)) || !(await RNFS.exists(manifestPath))) return null;
  return {
    baseVersion: Number(pending.baseVersion),
    snapshotId: pending.snapshotId,
    chunkSize: Number(pending.chunkSize),
    snapshotPath,
    manifestPath,
    updatedAt: pending.updatedAt,
    keyProbe: typeof pending.keyProbe === "string" ? pending.keyProbe : null,
    ...(Array.isArray(pending.chunkRefs) && pending.chunkRefs.every((ref) => typeof ref === "string")
      ? { chunkRefs: pending.chunkRefs }
      : {}),
  };
};

export const savePending = async (pending: PendingSync) => {
  await writeJson(pendingFile(), pending);
};

export const clearPending = async () => {
  if (await RNFS.exists(pendingFile())) {
    await RNFS.unlink(pendingFile());
  }
  if (await RNFS.exists(pendingSnapshotFile())) {
    await RNFS.unlink(pendingSnapshotFile());
  }
  if (await RNFS.exists(pendingManifestFile())) {
    await RNFS.unlink(pendingManifestFile());
  }
};

export const loadPendingOps = async (): Promise<PendingOp[]> => {
  const pending = await readJson<PendingOp[]>(pendingOpsFile());
  if (!Array.isArray(pending)) return [];
  return pending.filter(
    (entry) =>
      entry &&
      typeof entry.id === "string" &&
      typeof entry.type === "string" &&
      typeof entry.createdAt === "string"
  );
};

export const savePendingOps = async (ops: PendingOp[]) => {
  await writeJson(pendingOpsFile(), ops);
};

export const clearPendingOps = async () => {
  if (await RNFS.exists(pendingOpsFile())) {
    await RNFS.unlink(pendingOpsFile());
  }
};

export const savePendingSnapshotBytes = async (bytes: Uint8Array) => {
  await ensureDir();
  const targetPath = pendingSnapshotFile();
  const base64 = Buffer.from(bytes).toString("base64");
  await RNFS.writeFile(targetPath, base64, "base64");
  return targetPath;
};

export const savePendingManifestBytes = async (bytes: Uint8Array) => {
  await ensureDir();
  const targetPath = pendingManifestFile();
  const base64 = Buffer.from(bytes).toString("base64");
  await RNFS.writeFile(targetPath, base64, "base64");
  return targetPath;
};
