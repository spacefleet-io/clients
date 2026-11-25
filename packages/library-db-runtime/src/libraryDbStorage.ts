import { Buffer } from "node:buffer";
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, rmSync } from "node:fs";
import { dirname, join as joinPath } from "node:path";
import { SNAPSHOT_TAIL_BYTES_THRESHOLD } from "@space/library-db-definition/opClass";
import { getApiBaseUrl } from "./apiHost";
import { libraryDir } from "./libraryAccount";

export type LibraryCache = {
  version: number;
  dbPath: string;
  updatedAt: string | null;
  stateHash?: string | null;
  lastOpId?: string | null;
  /** The API server the cached library came from (LIB-STORE-06); absent in caches written before it was recorded. */
  apiOrigin?: string | null;
};

export type PendingSync = {
  baseVersion: number;
  snapshotId: string;
  chunkSize: number;
  manifestPath: string;
  snapshotPath: string;
  updatedAt: string;
  keyProbe: string | null;
  stateHash?: string | null;
  lastOpId?: string | null;
  // Hashes of `snapshotPath` when the pending snapshot was built. The drain
  // publishes them only if the file still hashes to exactly this list.
  // Absent on records written before PR #143.
  chunkRefs?: string[];
  // The op-stream version the snapshot was built in (LIB-FMT-13). Absent on records written before vault v4: those
  // are version 3.
  opStreamVersion?: number;
};

export type PendingOp = {
  id: string;
  createdAt: string;
  type: string;
  payload: Record<string, unknown>;
};

// LIB-STORE-06: the selected account's dir (`library/<server>/<userId>`), else the flat dir.
const cacheFile = () => joinPath(libraryDir(), "cache.json");
const cacheDbFile = () => joinPath(libraryDir(), "library.sqlite");
const pendingFile = () => joinPath(libraryDir(), "pending.json");
const pendingOpsFile = () => joinPath(libraryDir(), "pending_ops.json");
const opsSinceSnapshotFile = () => joinPath(libraryDir(), "ops_since_snapshot.json");
const pendingSnapshotFile = () => joinPath(libraryDir(), "pending.snapshot");
const pendingManifestFile = () => joinPath(libraryDir(), "pending.manifest");

// Phase 3: per-group SQLite files. Desktop opens all five; the legacy
// `library.sqlite` is renamed to `library.sqlite.pre-split.bak` after the
// final per-group commit (Phase 3.5).
const coreDbFile = () => joinPath(libraryDir(), "library.core.sqlite");
const metadataDbFile = () => joinPath(libraryDir(), "library.metadata.sqlite");
const playbackDbFile = () => joinPath(libraryDir(), "library.playback.sqlite");
const ingestDbFile = () => joinPath(libraryDir(), "library.ingest.sqlite");
const templatesDbFile = () => joinPath(libraryDir(), "library.templates.sqlite");
const preSplitBackupFile = () => joinPath(libraryDir(), "library.sqlite.pre-split.bak");

const ensureDir = () => {
  const dir = libraryDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
};

const readJson = <T>(filePath: string): T | null => {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

/**
 * Write via a sibling temp file + rename, so a hard kill (runtime
 * health-kill, crash, power loss of the process) mid-write leaves the
 * previous complete file instead of a truncated one. pending_ops.json and
 * the cache DB are rewritten on every playback-progress save (~2/s), so a
 * torn write was a live way to lose unsent ops or force a cache wipe on the
 * next open. @bugfix @regression-proof issue #25 P7.
 */
export const writeFileAtomicSync = (filePath: string, data: string | Uint8Array) => {
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, data);
  renameSync(tmpPath, filePath);
};

const writeJson = (filePath: string, value: unknown) => {
  ensureDir();
  writeFileAtomicSync(filePath, JSON.stringify(value));
};

export const loadCache = async (): Promise<LibraryCache | null> => {
  const cache = readJson<LibraryCache & { blobBase64?: string }>(cacheFile());
  if (!cache || typeof cache !== "object") return null;
  if (!Number.isFinite(Number(cache.version))) return null;
  const canonicalDbPath = cacheDbFile();
  // Only a file of this library dir: a dbPath written under another dir (the flat layout, another userData) is stale.
  let dbPath = typeof cache.dbPath === "string" && dirname(cache.dbPath) === libraryDir() ? cache.dbPath : canonicalDbPath;
  if (typeof cache.blobBase64 === "string" && cache.blobBase64) {
    const bytes = Buffer.from(cache.blobBase64, "base64");
    ensureDir();
    writeFileSync(canonicalDbPath, bytes);
    const migrated = {
      version: Number(cache.version),
      dbPath: canonicalDbPath,
      updatedAt: typeof cache.updatedAt === "string" ? cache.updatedAt : null,
      stateHash: typeof cache.stateHash === "string" ? cache.stateHash : null,
      lastOpId: typeof cache.lastOpId === "string" ? cache.lastOpId : null,
      apiOrigin: typeof cache.apiOrigin === "string" ? cache.apiOrigin : null,
    };
    writeJson(cacheFile(), migrated);
    return migrated;
  }
  if (!existsSync(dbPath) && dbPath !== canonicalDbPath && existsSync(canonicalDbPath)) {
    dbPath = canonicalDbPath;
  }
  // Phase 3.6: the legacy single-file `library.sqlite` is renamed to
  // `library.sqlite.pre-split.bak` after the per-group split. cache.json's
  // dbPath may still point at the legacy file — if so, treat it as
  // informational when per-group core data exists. Returning null here would
  // lose the user's sync version + state hash and force a fresh-install reset
  // on next boot (regression: orphaned cache.json after retire).
  const postSplit = existsSync(coreDbFile());
  if (!existsSync(dbPath)) {
    if (!postSplit) return null;
    dbPath = canonicalDbPath;
  } else if (dbPath !== canonicalDbPath) {
    ensureDir();
    writeFileSync(canonicalDbPath, readFileSync(dbPath));
    dbPath = canonicalDbPath;
  }
  const normalized = {
    version: Number(cache.version),
    dbPath,
    updatedAt: typeof cache.updatedAt === "string" ? cache.updatedAt : null,
    stateHash: typeof cache.stateHash === "string" ? cache.stateHash : null,
    lastOpId: typeof cache.lastOpId === "string" ? cache.lastOpId : null,
    apiOrigin: typeof cache.apiOrigin === "string" ? cache.apiOrigin : null,
  };
  if (cache.dbPath !== normalized.dbPath) {
    writeJson(cacheFile(), normalized);
  }
  return normalized;
};

/** Stamps the API server the library belongs to, so a cache is never taken for another server's library. */
export const saveCache = async (cache: LibraryCache) => {
  writeJson(cacheFile(), { ...cache, apiOrigin: cache.apiOrigin ?? getApiBaseUrl() });
};

export const clearCache = async () => {
  if (existsSync(cacheFile())) {
    rmSync(cacheFile(), { force: true });
  }
};

export const loadPending = async (): Promise<PendingSync | null> => {
  const pending = readJson<PendingSync>(pendingFile());
  if (!pending || typeof pending !== "object") return null;
  if (!pending.snapshotId || typeof pending.snapshotId !== "string") return null;
  if (!Number.isFinite(Number(pending.chunkSize))) return null;
  if (!Number.isFinite(Number(pending.baseVersion))) return null;
  if (!pending.updatedAt || typeof pending.updatedAt !== "string") return null;
  if (!pending.manifestPath || typeof pending.manifestPath !== "string") return null;
  if (!pending.snapshotPath || typeof pending.snapshotPath !== "string") return null;
  if (!existsSync(pending.manifestPath) || !existsSync(pending.snapshotPath)) return null;
  return {
    baseVersion: Number(pending.baseVersion),
    snapshotId: pending.snapshotId,
    chunkSize: Number(pending.chunkSize),
    manifestPath: pending.manifestPath,
    snapshotPath: pending.snapshotPath,
    updatedAt: pending.updatedAt,
    keyProbe: typeof pending.keyProbe === "string" ? pending.keyProbe : null,
    stateHash: typeof pending.stateHash === "string" ? pending.stateHash : null,
    lastOpId: typeof pending.lastOpId === "string" ? pending.lastOpId : null,
    ...(Array.isArray(pending.chunkRefs) && pending.chunkRefs.every((ref) => typeof ref === "string")
      ? { chunkRefs: pending.chunkRefs }
      : {}),
  };
};

export const savePending = async (pending: PendingSync) => {
  writeJson(pendingFile(), pending);
};

export const clearPending = async () => {
  if (existsSync(pendingFile())) {
    rmSync(pendingFile(), { force: true });
  }
  if (existsSync(pendingSnapshotFile())) {
    rmSync(pendingSnapshotFile(), { force: true });
  }
  if (existsSync(pendingManifestFile())) {
    rmSync(pendingManifestFile(), { force: true });
  }
};

export const loadPendingOps = async (): Promise<PendingOp[]> => {
  const pending = readJson<PendingOp[]>(pendingOpsFile());
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
  writeJson(pendingOpsFile(), ops);
};

/**
 * Non-progress ops seen since the snapshot `snapshotVersion` (LIB-SYNC-07): how many, and their ciphertext `bytes`
 * (LIB-SYNC-12). The server cannot tell op types apart (payloads are encrypted), so the client counts;
 * `snapshotVersion` ties the count to one snapshot, a different server snapshotVersion means the count restarts.
 * `bytesThreshold` is the tail size that makes a snapshot due: `SNAPSHOT_TAIL_BYTES_THRESHOLD`, or the size of a
 * snapshot that came out larger than the tail it would have replaced.
 */
export type OpsSinceSnapshot = { snapshotVersion: number; count: number; bytes: number; bytesThreshold: number };

export const loadOpsSinceSnapshot = (): OpsSinceSnapshot => {
  const stored = readJson<Partial<OpsSinceSnapshot>>(opsSinceSnapshotFile());
  const snapshotVersion = Number(stored?.snapshotVersion);
  const count = Number(stored?.count);
  if (!Number.isInteger(snapshotVersion) || !Number.isInteger(count) || count < 0) {
    return { snapshotVersion: -1, count: 0, bytes: 0, bytesThreshold: SNAPSHOT_TAIL_BYTES_THRESHOLD };
  }
  // A file written before LIB-SYNC-12 has no bytes: the tail counts from now on.
  const bytes = Number(stored?.bytes);
  const bytesThreshold = Number(stored?.bytesThreshold);
  return {
    snapshotVersion,
    count,
    bytes: Number.isFinite(bytes) && bytes > 0 ? bytes : 0,
    bytesThreshold: Number.isFinite(bytesThreshold) && bytesThreshold > 0 ? bytesThreshold : SNAPSHOT_TAIL_BYTES_THRESHOLD,
  };
};

export const saveOpsSinceSnapshot = (state: OpsSinceSnapshot) => {
  writeJson(opsSinceSnapshotFile(), state);
};

export const clearOpsSinceSnapshot = () => {
  rmSync(opsSinceSnapshotFile(), { force: true });
};

export const clearPendingOps = async () => {
  if (existsSync(pendingOpsFile())) {
    rmSync(pendingOpsFile(), { force: true });
  }
};

export const savePendingSnapshotBytes = async (bytes: Uint8Array) => {
  ensureDir();
  const targetPath = pendingSnapshotFile();
  writeFileSync(targetPath, bytes);
  return targetPath;
};

export const savePendingManifestBytes = async (bytes: Uint8Array) => {
  ensureDir();
  const targetPath = pendingManifestFile();
  writeFileSync(targetPath, bytes);
  return targetPath;
};

export const getCacheDbPath = () => cacheDbFile();

export const getCoreDbPath = () => coreDbFile();
export const getMetadataDbPath = () => metadataDbFile();
export const getPlaybackDbPath = () => playbackDbFile();
export const getIngestDbPath = () => ingestDbFile();
export const getTemplatesDbPath = () => templatesDbFile();
export const getPreSplitBackupPath = () => preSplitBackupFile();

export const ensureLibraryDir = () => ensureDir();
