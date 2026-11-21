import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

/**
 * Badger desktop offline copies (OFFL-FILE-03): the storage's SFV1 objects exactly as stored (still sealed with the
 * library key), each track apart, inside the app's offline dir. Same layout as the phone stores:
 *
 *   <root>/objects/<sha256(objectKey)>             one sealed piece, shared by every item that lists it
 *   <root>/objects/<sha256>.<tag>.part             a piece in flight (never read, swept at start)
 *   <root>/items/<sha256(fileId)>.json             one saved title: what HLS needs to play it, and its pieces
 *
 * An item exists only once its manifest is written, after all its pieces are in place (OFFL-SAFE-01). The runtime
 * writes the store (`apps/runtime/src/modules/badger/steps/offlineDownload.ts`); the desktop playback server reads it
 * (`apps/badger/desktop/src/main/playbackServer.ts`). Node only, no Electron.
 */

export const OFFLINE_PIECES_MANIFEST_VERSION = 2 as const;

export type OfflinePieceChunk = { key: string; sizeBytes: number; startSeconds: number | null };

export type OfflinePieceTrack = {
  initKey: string;
  codecString: string | null;
  durationSeconds: number | null;
  chunks: OfflinePieceChunk[];
};

export type OfflinePieceManifest = {
  version: typeof OFFLINE_PIECES_MANIFEST_VERSION;
  fileId: string;
  mediaId: string;
  formatId: string;
  quality: string;
  savedAt: string;
  video: { id: string; quality: string; bitrateKbps: number | null; track: OfflinePieceTrack };
  audio: Array<{ id: string; language: string; label: string; isDefault: boolean; track: OfflinePieceTrack }>;
  subtitles: Array<{
    id: string;
    language: string;
    label: string;
    format: string | null;
    objectKey: string;
    isDefault: boolean;
  }>;
  /** Every piece of the item, with its sealed size on disk. */
  objects: Array<{ key: string; sizeBytes: number }>;
  totalBytes: number;
};

const OBJECTS_DIR = "objects";
const ITEMS_DIR = "items";
const PART_SUFFIX = ".part";

const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");

export const offlinePiecePath = (root: string, objectKey: string) => join(root, OBJECTS_DIR, sha256Hex(objectKey));

export const offlinePieceItemPath = (root: string, fileId: string) => join(root, ITEMS_DIR, `${sha256Hex(fileId)}.json`);

/** True when `target` is strictly inside `dir` (never `dir` itself, never a relative path). */
export const isPathUnderDir = (dir: string, target: string): boolean => {
  if (!isAbsolute(target)) return false;
  const rel = relative(resolve(dir), resolve(target));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

const sizeOf = async (path: string): Promise<number | null> => {
  try {
    return (await fs.stat(path)).size;
  } catch {
    return null;
  }
};

/** Size of the piece on disk, or null when it is not here. A piece is only ever whole (written to `.part` first). */
export const offlinePieceSize = (root: string, objectKey: string) => sizeOf(offlinePiecePath(root, objectKey));

/** Writes one sealed piece to `.part`, then renames it into place. Returns its size. */
export const writeOfflinePiece = async (
  root: string,
  objectKey: string,
  sealed: Uint8Array,
  options: { tag?: string } = {}
): Promise<number> => {
  const target = offlinePiecePath(root, objectKey);
  await fs.mkdir(join(root, OBJECTS_DIR), { recursive: true });
  const part = `${target}.${(options.tag ?? "w").replace(/[^A-Za-z0-9_-]/g, "_")}${PART_SUFFIX}`;
  await fs.writeFile(part, sealed);
  await fs.rename(part, target);
  return sealed.byteLength;
};

const isTrack = (value: unknown): value is OfflinePieceTrack => {
  const t = value as OfflinePieceTrack | null;
  return Boolean(t) && typeof t!.initKey === "string" && Array.isArray(t!.chunks);
};

const parseManifest = (raw: unknown): OfflinePieceManifest => {
  const m = raw as OfflinePieceManifest | null;
  if (
    !m ||
    m.version !== OFFLINE_PIECES_MANIFEST_VERSION ||
    typeof m.fileId !== "string" ||
    !m.video ||
    !isTrack(m.video.track) ||
    !Array.isArray(m.audio) ||
    !m.audio.every((a) => isTrack(a.track)) ||
    !Array.isArray(m.subtitles) ||
    !Array.isArray(m.objects)
  ) {
    throw new Error("OFFLINE_PIECES_MANIFEST_INVALID");
  }
  return m;
};

export const readOfflinePieceManifest = async (path: string): Promise<OfflinePieceManifest> => {
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(path, "utf8"));
  } catch {
    throw new Error("OFFLINE_PIECES_MANIFEST_INVALID");
  }
  return parseManifest(raw);
};

/** Writes the item manifest (tmp + rename): from here on the item counts as saved. Returns its path. */
export const writeOfflinePieceManifest = async (root: string, manifest: OfflinePieceManifest): Promise<string> => {
  const target = offlinePieceItemPath(root, manifest.fileId);
  await fs.mkdir(join(root, ITEMS_DIR), { recursive: true });
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(manifest));
  await fs.rename(tmp, target);
  return target;
};

export const listOfflinePieceManifests = async (
  root: string
): Promise<Array<{ path: string; manifest: OfflinePieceManifest }>> => {
  let names: string[];
  try {
    names = await fs.readdir(join(root, ITEMS_DIR));
  } catch {
    return [];
  }
  const out: Array<{ path: string; manifest: OfflinePieceManifest }> = [];
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    const path = join(root, ITEMS_DIR, name);
    try {
      out.push({ path, manifest: await readOfflinePieceManifest(path) });
    } catch {
      // An unreadable manifest is not an item; its pieces are swept as orphans.
    }
  }
  return out;
};

export const verifyOfflinePieceItem = async (
  root: string,
  manifest: OfflinePieceManifest
): Promise<{ ok: boolean; missing: string[]; sizeMismatch: string[] }> => {
  const missing: string[] = [];
  const sizeMismatch: string[] = [];
  for (const object of manifest.objects) {
    const size = await sizeOf(offlinePiecePath(root, object.key));
    if (size === null) missing.push(object.key);
    else if (size !== object.sizeBytes) sizeMismatch.push(object.key);
  }
  return { ok: missing.length === 0 && sizeMismatch.length === 0, missing, sizeMismatch };
};

/** Removes an item and every piece no other item lists. */
export const deleteOfflinePieceItem = async (
  root: string,
  fileId: string
): Promise<{ removed: boolean; removedPieces: number; keptShared: number; freedBytes: number }> => {
  const path = offlinePieceItemPath(root, fileId);
  let manifest: OfflinePieceManifest | null = null;
  try {
    manifest = await readOfflinePieceManifest(path);
  } catch {
    manifest = null;
  }
  if (!manifest) {
    await fs.rm(path, { force: true });
    return { removed: false, removedPieces: 0, keptShared: 0, freedBytes: 0 };
  }
  const stillListed = new Set<string>();
  for (const other of await listOfflinePieceManifests(root)) {
    if (other.path === path) continue;
    for (const object of other.manifest.objects) stillListed.add(object.key);
  }
  // The manifest goes first: from then on the item no longer counts, whatever happens to its pieces.
  await fs.rm(path, { force: true });
  let removedPieces = 0;
  let keptShared = 0;
  let freedBytes = 0;
  for (const object of new Map(manifest.objects.map((o) => [o.key, o])).values()) {
    if (stillListed.has(object.key)) {
      keptShared += 1;
      continue;
    }
    const piece = offlinePiecePath(root, object.key);
    const size = await sizeOf(piece);
    await fs.rm(piece, { force: true });
    if (size !== null) {
      removedPieces += 1;
      freedBytes += size;
    }
  }
  return { removed: true, removedPieces, keptShared, freedBytes };
};

/**
 * Start-up cleanup (OFFL-SAFE-01): `.part` leftovers and pieces no item lists are what an interrupted download left.
 * While a download is in flight its finished pieces are listed by no item yet, so nothing is touched then.
 */
export const sweepOfflinePieceStore = async (
  root: string,
  options: { downloadsInFlight: boolean }
): Promise<{ removedParts: number; removedOrphans: number; freedBytes: number }> => {
  const result = { removedParts: 0, removedOrphans: 0, freedBytes: 0 };
  if (options.downloadsInFlight) return result;
  let names: string[];
  try {
    names = await fs.readdir(join(root, OBJECTS_DIR));
  } catch {
    return result;
  }
  const listed = new Set<string>();
  for (const item of await listOfflinePieceManifests(root)) {
    for (const object of item.manifest.objects) listed.add(sha256Hex(object.key));
  }
  for (const name of names) {
    const isPart = name.endsWith(PART_SUFFIX);
    if (!isPart && listed.has(name)) continue;
    const path = join(root, OBJECTS_DIR, name);
    const size = await sizeOf(path);
    await fs.rm(path, { force: true });
    result.freedBytes += size ?? 0;
    if (isPart) result.removedParts += 1;
    else result.removedOrphans += 1;
  }
  return result;
};
