/**
 * @test-id PARROT-DESKTOP-KEPT-001
 * @level integration
 * @why "Keep on this computer" (PAR-OFFL-01/02/03): keeping an album downloads its songs and reports "Kept · size",
 *   two stored formats make a real copy question and the chosen copy is the one fetched, a song later added to a kept
 *   album arrives on its own, removing the album deletes its files, the kept list survives a restart, a failed
 *   download stops quietly and the next library load resumes, and sign-out forgets everything. The keeping loop and
 *   the library database are the real code; only the sealed-file store is an in-memory stand-in (its own test is
 *   PARROT-INGEST-KEPT-001).
 * @covers apps/parrot/desktop/src/main/kept.ts
 * @req PAR-OFFL-01[parrot]
 * @req PAR-OFFL-02[parrot]
 * @req PAR-OFFL-03[parrot]
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyParrotOps,
  buildParrotTrackOps,
  listParrotAlbums,
  listParrotTracks,
  openParrotLibrary,
  parrotAudioFormatFor,
  parrotTrackIds,
  sha256Hex,
  type ParrotKeptFiles,
  type ParrotLibraryDb,
  type ParrotLibraryFile,
  type ParrotTrackInfo,
} from "@space/parrot-ingest";
import { createDesktopKeeping } from "../src/main/kept";
import type { KeptStatus } from "@space/parrot-core";

const ID = "PARROT-DESKTOP-KEPT-001";
const lines: string[] = [];
const log = (line: string) => {
  lines.push(line);
  console.log(`[${ID}] ${line}`);
};
const dump = (label: string, value: unknown) => console.log(`[${ID}] ${label}: ${JSON.stringify(value, null, 1)}`);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  lines.length = 0;
});

const song = (title: string, number: number, file: string, bitrateKbps: number | null): ParrotTrackInfo => ({
  file,
  title,
  number,
  artist: "Kept Band",
  albumArtist: "Kept Band",
  album: "Offline Album",
  disc: 1,
  year: 2024,
  durationMs: 180_000,
  bitrateKbps,
  sampleRate: 44100,
  format: parrotAudioFormatFor(file)!,
});

/** Adds one stored copy of a song; the same title in another format is a second copy of the same song. */
const addCopy = (db: ParrotLibraryDb, info: ParrotTrackInfo, sizeBytes: number) => {
  const fileHash = sha256Hex(`bytes of ${info.file}`);
  const ids = parrotTrackIds({ ...info, fileHash });
  const chunks = [{ idx: 0, objectKey: `media/kept/${ids.fileId}/chunk-0`, plainOffset: 0, plainSize: sizeBytes }];
  applyParrotOps(db, buildParrotTrackOps({ info, fileHash, sizeBytes, chunks, now: 1_700_000_000_000 }));
  return ids;
};

/** The sealed-file store, in memory: records what was fetched and deleted; while `offline`, every fetch throws. */
const memoryFiles = () => {
  const stored = new Map<string, number>();
  const fetched: string[] = [];
  const removed: string[] = [];
  let failing = false;
  const files: ParrotKeptFiles = {
    fileIds: () => [...stored.keys()],
    storedBytes: (id) => stored.get(id) ?? 0,
    keep: async (file: ParrotLibraryFile, stop) => {
      if (failing) throw new Error("network is down");
      if (stop()) return false;
      fetched.push(file.id);
      stored.set(file.id, file.sizeBytes);
      return true;
    },
    remove: async (ids) => {
      for (const id of ids) {
        stored.delete(id);
        removed.push(id);
      }
    },
    readSealed: async () => null,
    clear: async () => {
      stored.clear();
    },
  };
  return { files, fetched, removed, offline: (value: boolean) => (failing = value) };
};

const setup = async () => {
  const dir = mkdtempSync(join(tmpdir(), "parrot-kept-"));
  dirs.push(dir);
  const db = openParrotLibrary(null);
  const one = addCopy(db, song("One", 1, "/m/one.mp3", 320), 4000);
  const two = addCopy(db, song("Two", 2, "/m/two.mp3", 320), 5000);
  const albumId = listParrotAlbums(db)[0]!.id;
  const store = memoryFiles();
  const changes: KeptStatus[] = [];
  const anyKept: boolean[] = [];
  const open = () =>
    createDesktopKeeping({ dir, files: store.files, library: () => db, onChange: (s) => changes.push(s), onKeptAny: (any) => anyKept.push(any), now: () => 42, log });
  return { dir, db, one, two, albumId, store, changes, anyKept, open };
};

describe("keep on this computer", () => {
  it("keeps an album, reports its size, and plays the kept file", async () => {
    const t = await setup();
    const keeping = await t.open();
    expect(keeping.choices("album", t.albumId).length).toBe(1);
    await keeping.keep("album", t.albumId, null);
    await keeping.reconcile();
    const status = keeping.status();
    dump("status after keeping the album", status);
    expect(t.store.fetched.sort()).toEqual([t.one.fileId, t.two.fileId].sort());
    expect(status.entries).toEqual([{ kind: "album", id: t.albumId, choice: null, keptAt: 42, bytes: 9000, done: 2, total: 2 }]);
    expect(status.songs.every((s) => s.onDevice)).toBe(true);
    expect(status.downloading).toBe(false);
    expect(t.anyKept).toEqual([true]);
    expect(keeping.playableFileId(t.one.fileId)).toBe(t.one.fileId);
    expect(existsSync(join(t.dir, "kept.json"))).toBe(true);
  });

  it("asks which copy when two formats exist and fetches the chosen one", async () => {
    const t = await setup();
    const flacOne = addCopy(t.db, song("One", 1, "/m/one.flac", null), 20_000);
    const flacTwo = addCopy(t.db, song("Two", 2, "/m/two.flac", null), 25_000);
    dump("tracks", listParrotTracks(t.db).map((track) => track.id));
    expect(flacOne.trackId).toBe(t.one.trackId);
    const keeping = await t.open();
    const choices = keeping.choices("album", t.albumId);
    dump("choices", choices);
    expect(choices.map((choice) => choice.label)).toEqual(["FLAC", "MP3 320 kbps"]);
    expect(choices[1]!.bytes).toBe(9000);
    await keeping.keep("album", t.albumId, choices[1]!.key);
    await keeping.reconcile();
    dump("fetched", t.store.fetched);
    expect(t.store.fetched.sort()).toEqual([t.one.fileId, t.two.fileId].sort());
    // Asked to play the FLAC copy offline, the player gets the kept MP3 of the same song.
    expect(keeping.playableFileId(flacTwo.fileId)).toBe(t.two.fileId);
  });

  it("fetches a song added to a kept album, deletes files when removed, and remembers across restarts", async () => {
    const t = await setup();
    const keeping = await t.open();
    await keeping.keep("album", t.albumId, null);
    await keeping.reconcile();
    const three = addCopy(t.db, song("Three", 3, "/m/three.mp3", 320), 3000);
    await keeping.reconcile();
    dump("after a song was added", { fetched: t.store.fetched, status: keeping.status() });
    expect(t.store.fetched).toContain(three.fileId);
    expect(keeping.status().entries[0]).toMatchObject({ bytes: 12_000, done: 3, total: 3 });

    const reopened = await t.open();
    expect(reopened.status().entries.map((entry) => entry.id)).toEqual([t.albumId]);

    await reopened.unkeep("album", t.albumId);
    await reopened.reconcile();
    dump("after removal", { removed: t.store.removed, stored: t.store.files.fileIds() });
    expect(t.store.files.fileIds()).toEqual([]);
    expect(t.store.removed.sort()).toEqual([t.one.fileId, t.two.fileId, three.fileId].sort());
    expect(t.anyKept).toEqual([true, false]);
  });

  it("stops on a failed download and resumes on the next library load", async () => {
    const t = await setup();
    const keeping = await t.open();
    t.store.offline(true);
    await keeping.keep("song", t.one.trackId, null);
    await keeping.reconcile();
    dump("after the failure", { lines, status: keeping.status() });
    expect(lines.some((line) => line.includes("network is down"))).toBe(true);
    expect(keeping.status().entries[0]).toMatchObject({ done: 0, total: 1 });
    t.store.offline(false);
    await keeping.reconcile();
    expect(keeping.status().entries[0]).toMatchObject({ done: 1, total: 1 });
  });

  it("sign-out forgets the kept list and every kept file", async () => {
    const t = await setup();
    const keeping = await t.open();
    await keeping.keep("album", t.albumId, null);
    await keeping.reconcile();
    await keeping.clear();
    dump("after sign-out", { stored: t.store.files.fileIds(), status: keeping.status() });
    expect(t.store.files.fileIds()).toEqual([]);
    expect(keeping.status().entries).toEqual([]);
    expect(existsSync(join(t.dir, "kept.json"))).toBe(false);
    expect((await t.open()).status().entries).toEqual([]);
  });

  it("reports each kept item's song files and their kept bytes for Manage offline content (OFFL-MANAGE-01)", async () => {
    const t = await setup();
    const keeping = await t.open();
    await keeping.keep("album", t.albumId, null);
    await keeping.keep("song", t.one.trackId, null);
    await keeping.reconcile();
    const sizes = keeping.sizes();
    dump("sizes with an album and one of its songs kept", sizes);
    expect(sizes.entries).toEqual([
      { kind: "album", id: t.albumId, fileIds: [t.one.fileId, t.two.fileId].sort() },
      { kind: "song", id: t.one.trackId, fileIds: [t.one.fileId] },
    ]);
    expect(sizes.bytes).toEqual({ [t.one.fileId]: 4000, [t.two.fileId]: 5000 });
  });
});
