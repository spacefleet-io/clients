// OFFL-FILE-03, OFFL-SAFE-01: Badger desktop offline copies are the storage's sealed pieces, kept apart, inside the
// app's offline dir. An item counts only once its manifest is written, after every piece is in place.
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  OFFLINE_PIECES_MANIFEST_VERSION,
  deleteOfflinePieceItem,
  offlinePieceSize,
  isPathUnderDir,
  listOfflinePieceManifests,
  offlinePieceItemPath,
  offlinePiecePath,
  readOfflinePieceManifest,
  sweepOfflinePieceStore,
  verifyOfflinePieceItem,
  writeOfflinePiece,
  writeOfflinePieceManifest,
  type OfflinePieceManifest,
} from "../src/offlinePieceStore";

const log = (phase: string, data: unknown) => console.info(`[piece-store:${phase}]`, JSON.stringify(data));

const bytes = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_v, i) => (i * seed) % 256);

const manifestFor = (fileId: string, objects: Array<{ key: string; sizeBytes: number }>): OfflinePieceManifest => ({
  version: OFFLINE_PIECES_MANIFEST_VERSION,
  fileId,
  mediaId: `media-${fileId}`,
  formatId: `format-${fileId}`,
  quality: "1080p",
  savedAt: "2026-11-21T00:00:00.000Z",
  video: {
    id: `format-${fileId}`,
    quality: "1080p",
    bitrateKbps: 4000,
    track: {
      initKey: objects[0]!.key,
      codecString: "avc1.640028",
      durationSeconds: 20,
      chunks: objects.slice(1).map((o, i) => ({ key: o.key, sizeBytes: o.sizeBytes, startSeconds: i * 10 })),
    },
  },
  audio: [],
  subtitles: [],
  objects,
  totalBytes: objects.reduce((s, o) => s + o.sizeBytes, 0),
});

describe("offlinePieceStore", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sf-piece-store-"));
    log("setup", { root });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("writes a sealed piece atomically under objects/<sha256(key)> and leaves no .part", async () => {
    const key = "media/abc/v/1080p/init.mp4";
    const written = await writeOfflinePiece(root, key, bytes(300), { tag: "job-1" });
    const path = offlinePiecePath(root, key);
    const objects = readdirSync(join(root, "objects"));
    log("write", { written, path, objects });
    expect(path.startsWith(join(root, "objects"))).toBe(true);
    expect(path.split(/[\\/]/).pop()).toMatch(/^[0-9a-f]{64}$/);
    expect(written).toBe(300);
    expect(statSync(path).size).toBe(300);
    expect(objects.some((n) => n.endsWith(".part"))).toBe(false);
    expect(await offlinePieceSize(root, key)).toBe(300);
    expect(await offlinePieceSize(root, "other")).toBeNull();
  });

  it("an item only exists once its manifest is written (partial = not counted)", async () => {
    await writeOfflinePiece(root, "k-init", bytes(10));
    const before = await listOfflinePieceManifests(root);
    log("before-manifest", before);
    expect(before).toEqual([]);
    const manifest = manifestFor("file-1", [{ key: "k-init", sizeBytes: 10 }]);
    const manifestPath = await writeOfflinePieceManifest(root, manifest);
    const after = await listOfflinePieceManifests(root);
    log("after-manifest", { manifestPath, after: after.map((m) => m.manifest.fileId) });
    expect(manifestPath).toBe(offlinePieceItemPath(root, "file-1"));
    expect(after.map((m) => m.manifest.fileId)).toEqual(["file-1"]);
    expect(readdirSync(join(root, "items")).some((n) => n.endsWith(".tmp"))).toBe(false);
    expect((await readOfflinePieceManifest(manifestPath)).fileId).toBe("file-1");
  });

  it("rejects a manifest of another version or shape", async () => {
    mkdirSync(join(root, "items"), { recursive: true });
    const bad = join(root, "items", "bad.json");
    writeFileSync(bad, JSON.stringify({ version: 1, fileId: "x" }));
    await expect(readOfflinePieceManifest(bad)).rejects.toThrow(/OFFLINE_PIECES_MANIFEST_INVALID/);
  });

  it("verify reports missing and size-mismatched pieces", async () => {
    await writeOfflinePiece(root, "a", bytes(10));
    await writeOfflinePiece(root, "b", bytes(20));
    const manifest = manifestFor("file-v", [
      { key: "a", sizeBytes: 10 },
      { key: "b", sizeBytes: 21 },
      { key: "c", sizeBytes: 5 },
    ]);
    const result = await verifyOfflinePieceItem(root, manifest);
    log("verify", result);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["c"]);
    expect(result.sizeMismatch).toEqual(["b"]);
    const okManifest = manifestFor("file-ok", [{ key: "a", sizeBytes: 10 }]);
    expect((await verifyOfflinePieceItem(root, okManifest)).ok).toBe(true);
  });

  it("delete keeps a piece another item still lists (refcount)", async () => {
    await writeOfflinePiece(root, "shared-sub", bytes(7));
    await writeOfflinePiece(root, "only-1", bytes(11));
    await writeOfflinePiece(root, "only-2", bytes(13));
    await writeOfflinePieceManifest(root, manifestFor("f1", [{ key: "only-1", sizeBytes: 11 }, { key: "shared-sub", sizeBytes: 7 }]));
    await writeOfflinePieceManifest(root, manifestFor("f2", [{ key: "only-2", sizeBytes: 13 }, { key: "shared-sub", sizeBytes: 7 }]));
    const result = await deleteOfflinePieceItem(root, "f1");
    log("delete-f1", result);
    expect(result).toEqual({ removed: true, removedPieces: 1, keptShared: 1, freedBytes: 11 });
    expect(existsSync(offlinePiecePath(root, "only-1"))).toBe(false);
    expect(existsSync(offlinePiecePath(root, "shared-sub"))).toBe(true);
    expect(existsSync(offlinePieceItemPath(root, "f1"))).toBe(false);
    const second = await deleteOfflinePieceItem(root, "f2");
    log("delete-f2", second);
    expect(second.freedBytes).toBe(20);
    expect(readdirSync(join(root, "objects"))).toEqual([]);
    expect(await deleteOfflinePieceItem(root, "f2")).toEqual({ removed: false, removedPieces: 0, keptShared: 0, freedBytes: 0 });
  });

  it("sweep drops .part leftovers and pieces no item lists, unless a download is live", async () => {
    await writeOfflinePiece(root, "kept", bytes(5));
    await writeOfflinePiece(root, "orphan", bytes(6));
    await writeOfflinePieceManifest(root, manifestFor("f", [{ key: "kept", sizeBytes: 5 }]));
    writeFileSync(join(root, "objects", "deadbeef.job-x.part"), bytes(3));
    const live = await sweepOfflinePieceStore(root, { downloadsInFlight: true });
    log("sweep-live", live);
    expect(live).toEqual({ removedParts: 0, removedOrphans: 0, freedBytes: 0 });
    const idle = await sweepOfflinePieceStore(root, { downloadsInFlight: false });
    log("sweep-idle", { idle, objects: readdirSync(join(root, "objects")) });
    expect(idle).toEqual({ removedParts: 1, removedOrphans: 1, freedBytes: 9 });
    expect(existsSync(offlinePiecePath(root, "kept"))).toBe(true);
    expect(existsSync(offlinePiecePath(root, "orphan"))).toBe(false);
  });

  it("isPathUnderDir guards against escaping the offline root", () => {
    expect(isPathUnderDir(root, join(root, "a", "b.mkv"))).toBe(true);
    expect(isPathUnderDir(root, root)).toBe(false);
    expect(isPathUnderDir(root, join(root, "..", "elsewhere.mkv"))).toBe(false);
    expect(isPathUnderDir(root, "relative.mkv")).toBe(false);
  });
});
