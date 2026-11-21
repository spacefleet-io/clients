/**
 * @test-id PARROT-INGEST-KEPT-001
 * @level integration
 * @why A song kept on the computer must play with no connection (PAR-OFFL-03): its chunks are on disk still sealed,
 *      the player reads them from there and never asks the storage, a song another kept file shares a chunk with
 *      keeps it, and the library itself opens from its sealed copy. A plain file on disk would break the encrypted
 *      storage promise (OFFL-FILE-03).
 * @covers packages/parrot-ingest/src/kept.ts
 * @covers packages/parrot-ingest/src/chunkReader.ts
 * @req PAR-OFFL-03[parrot]
 * @req OFFL-FILE-03[parrot]
 */
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { sealMediaObjectWithPadding } from "@space/media-crypto";
import { readParrotFileRange } from "@space/parrot-core";
import { createParrotChunkLoader } from "../src/chunkReader";
import { createParrotKeptFiles, openParrotLibraryCopy, parrotKeepLibrary, saveParrotLibraryCopy } from "../src/kept";
import { openParrotLibrary, serializeParrotLibrary, type ParrotLibraryFile } from "../src/library";
import { makeTempDir, testLog } from "./helpers";

const log = testLog("PARROT-INGEST-KEPT-001");
type Download = NonNullable<Parameters<typeof createParrotKeptFiles>[0]["download"]>;

const storeFile = (id: string, size: number, chunkSize: number, key: Buffer, objects: Map<string, Uint8Array>): { file: ParrotLibraryFile; plain: Uint8Array } => {
  const plain = new Uint8Array(randomBytes(size));
  const chunks = [];
  for (let offset = 0, idx = 0; offset < size; offset += chunkSize, idx += 1) {
    const part = plain.subarray(offset, offset + chunkSize);
    const objectKey = `media/parrot-test/${id}/chunk-${idx}`;
    objects.set(objectKey, new Uint8Array(sealMediaObjectWithPadding(part, key)));
    chunks.push({ idx, objectKey, plainOffset: offset, plainSize: part.length });
  }
  return {
    file: { id, trackId: `t-${id}`, mime: "audio/flac", sizeBytes: size, headerBytes: null, sourceSizeBytes: null, tagsObjectKey: null, chunks },
    plain,
  };
};

describe("songs kept on the computer", () => {
  it("keeps a file sealed on disk and plays it back with no connection", async () => {
    const dir = await makeTempDir("kept");
    const key = randomBytes(32);
    const objects = new Map<string, Uint8Array>();
    const { file, plain } = storeFile("f1", 2500, 1000, key, objects);
    const calls: string[] = [];
    let online = true;
    const download = (async (_token: string, objectKey: string, options?: { purpose?: string }) => {
      calls.push(`${objectKey} ${options?.purpose ?? ""}`);
      if (!online) throw new Error("offline");
      return objects.get(objectKey)!;
    }) as unknown as Download;
    const kept = await createParrotKeptFiles({ dir, token: () => "tok", clientType: "test", appId: "parrot", download, log });
    expect(await kept.keep(file, () => false)).toBe(true);
    log("downloaded", calls);
    expect(calls).toEqual(file.chunks.map((chunk) => `${chunk.objectKey} export`));
    expect(kept.fileIds()).toEqual(["f1"]);

    // On disk: sealed bytes only, never the song.
    const stored = await fs.readdir(path.join(dir, "objects"));
    expect(stored.length).toBe(3);
    for (const name of stored) {
      const bytes = new Uint8Array(await fs.readFile(path.join(dir, "objects", name)));
      expect(Buffer.from(bytes).includes(Buffer.from(plain.subarray(0, 64)))).toBe(false);
    }

    online = false;
    const reopened = await createParrotKeptFiles({ dir, token: () => "tok", clientType: "test", appId: "parrot", download, log });
    expect(reopened.fileIds()).toEqual(["f1"]);
    const loader = createParrotChunkLoader({
      token: () => "tok",
      libraryKeyBase64: () => key.toString("base64"),
      profileId: async () => {
        throw new Error("no profile offline");
      },
      clientType: "test",
      openSession: (() => ({ download: (key: string) => download("tok", key), close: async () => undefined })) as never,
      readKept: reopened.readSealed,
    });
    const parts: Uint8Array[] = [];
    for await (const part of readParrotFileRange(file.chunks, 0, file.sizeBytes - 1, loader)) parts.push(part);
    const back = Buffer.concat(parts);
    log("played offline", { bytes: back.length, downloadsAfterOffline: calls.length - 3 });
    expect(back.equals(Buffer.from(plain))).toBe(true);
    expect(calls.length).toBe(3);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("removing a file keeps the chunks another kept file lists, and stops quietly when unkept mid-download", async () => {
    const dir = await makeTempDir("kept-remove");
    const key = randomBytes(32);
    const objects = new Map<string, Uint8Array>();
    const a = storeFile("a", 2000, 1000, key, objects).file;
    const b = { ...a, id: "b", chunks: [a.chunks[1]!] };
    const download = (async (_t: string, objectKey: string) => objects.get(objectKey)!) as unknown as Download;
    const kept = await createParrotKeptFiles({ dir, token: () => "tok", clientType: "test", appId: "parrot", download, log });
    await kept.keep(a, () => false);
    await kept.keep(b, () => false);
    await kept.remove(["a"]);
    expect(kept.fileIds()).toEqual(["b"]);
    expect(await kept.readSealed(a.chunks[0]!.objectKey)).toBeNull();
    expect(await kept.readSealed(a.chunks[1]!.objectKey)).not.toBeNull();
    const c = storeFile("c", 3000, 1000, key, objects).file;
    let fetched = 0;
    const stopAfterOne = () => fetched++ > 0;
    expect(await kept.keep(c, stopAfterOne)).toBe(false);
    expect(kept.fileIds()).toEqual(["b"]);
    await kept.clear();
    expect(kept.fileIds()).toEqual([]);
    await expect(fs.stat(dir)).rejects.toThrow();
  });

  it("opens the library from its sealed copy, and reads it the way the keeping rules need", async () => {
    const dir = await makeTempDir("kept-library");
    const key = randomBytes(32).toString("base64");
    const db = openParrotLibrary(null);
    const bytes = serializeParrotLibrary(db);
    await saveParrotLibraryCopy(dir, key, bytes, 7);
    const sealed = new Uint8Array(await fs.readFile(path.join(dir, "library.sealed")));
    expect(Buffer.from(sealed).includes(Buffer.from("SQLite format"))).toBe(false);
    const copy = await openParrotLibraryCopy(dir, key);
    expect(copy?.version).toBe(7);
    expect(Buffer.from(copy!.dbBytes).equals(Buffer.from(bytes))).toBe(true);
    expect(await openParrotLibraryCopy(dir, randomBytes(32).toString("base64"))).toBeNull();
    const library = parrotKeepLibrary(openParrotLibrary(copy!.dbBytes));
    expect(library.albumTrackIds("none")).toEqual([]);
    expect(library.playlistTrackIds("none")).toEqual([]);
    expect(library.trackFiles("none")).toEqual([]);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
