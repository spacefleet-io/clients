/**
 * @test-id PARROT-CORE-KEEPING-001
 * @level unit
 * @why The phone and the desktop run one keeping loop (PAR-OFFL-01/03). The phone hands songs to a download queue, so a
 *   queued song must count as on the phone without counting as complete, and songs a library load finds missing must
 *   wait for Wi-Fi while a song kept by hand goes at once. The phone reads its library once per load into rows; a wrong
 *   index would keep the wrong songs.
 * @covers packages/parrot-core/src/keeping.ts
 * @req PAR-OFFL-01[parrot]
 * @req PAR-OFFL-02[parrot]
 * @req PAR-OFFL-03[parrot]
 * @req OFFL-MANAGE-01[parrot]
 */
import { describe, expect, it } from "bun:test";
import type { TrackFileRow } from "../src/catalog";
import { createParrotKeeping, keepLibraryFromRows, type KeptFileStore, type KeptStatus } from "../src/keeping";

const file = (id: string, trackId: string, over: Partial<TrackFileRow> = {}): TrackFileRow => ({
  id,
  trackId,
  mime: "audio/mpeg",
  lossless: false,
  bitrateKbps: 320,
  sizeBytes: 100,
  lightCopy: false,
  createdAt: 1,
  ...over,
});

const rows = () => ({
  tracks: [
    { id: "t1", albumId: "a1" },
    { id: "t2", albumId: "a1" },
    { id: "t3", albumId: "a2" },
  ],
  playlists: [{ id: "p1", trackIds: ["t3", "t1"] }],
  files: [file("f1", "t1"), file("f1light", "t1", { lightCopy: true, bitrateKbps: 64 }), file("f2", "t2"), file("f3", "t3")],
});

/** A phone-like store: `keep` queues, `finish` completes; `wifi` says whether a library-load run may download. */
const queueStore = (wifi: { on: boolean }) => {
  const queued = new Set<string>();
  const complete = new Set<string>();
  const asked: boolean[] = [];
  const store: KeptFileStore = {
    fileIds: () => [...queued],
    completeIds: () => [...complete],
    mayDownload: async (byHand) => {
      asked.push(byHand);
      return byHand || wifi.on;
    },
    keep: async (keptFile) => {
      queued.add(keptFile.id);
      return true;
    },
    remove: async (ids) => {
      for (const id of ids) {
        queued.delete(id);
        complete.delete(id);
      }
    },
    clear: async () => {
      queued.clear();
      complete.clear();
    },
  };
  return { store, queued, complete, asked, finish: (id: string) => complete.add(id) };
};

const setup = async (wifi = { on: true }, library = keepLibraryFromRows(rows())) => {
  const files = queueStore(wifi);
  let text: string | null = null;
  const statuses: KeptStatus[] = [];
  const keptAny: boolean[] = [];
  const keeping = await createParrotKeeping({
    storage: { read: async () => text, write: async (next) => void (text = next), remove: async () => void (text = null) },
    files: files.store,
    library: () => library,
    onChange: (status) => statuses.push(status),
    onKeptAny: (any) => keptAny.push(any),
    now: () => 10,
    log: (line) => console.log(`[PARROT-CORE-KEEPING-001] ${line}`),
  });
  return { keeping, files, statuses, keptAny, stored: () => text };
};

describe("keepLibraryFromRows", () => {
  it("indexes albums, playlists and files from rows read once", () => {
    console.log("[PARROT-CORE-KEEPING-001] phase=rows");
    const library = keepLibraryFromRows(rows());
    expect(library.albumTrackIds("a1")).toEqual(["t1", "t2"]);
    expect(library.albumTrackIds("missing")).toEqual([]);
    expect(library.playlistTrackIds("p1")).toEqual(["t3", "t1"]);
    expect(library.trackFiles("t1").map((row) => row.id)).toEqual(["f1", "f1light"]);
    expect(library.trackFiles("t9")).toEqual([]);
  });
});

describe("createParrotKeeping with a download queue", () => {
  it("queues the best copy of each song of a kept album; queued is not yet on the phone", async () => {
    console.log("[PARROT-CORE-KEEPING-001] phase=keep-album");
    const { keeping, files, keptAny, stored } = await setup();
    await keeping.keep("album", "a1", null);
    await keeping.reconcile();
    expect([...files.queued].sort()).toEqual(["f1", "f2"]);
    expect(keptAny).toEqual([true]);
    expect(JSON.parse(stored()!).entries).toHaveLength(1);
    const queuedStatus = keeping.status();
    expect(queuedStatus.entries[0]).toMatchObject({ kind: "album", id: "a1", done: 0, total: 2, bytes: 200 });
    expect(queuedStatus.songs.every((song) => !song.onDevice)).toBe(true);
    expect(queuedStatus.downloading).toBe(true);
    expect(keeping.keptFileId("t1")).toBeNull();

    console.log("[PARROT-CORE-KEEPING-001] phase=finish-downloads");
    files.finish("f1");
    files.finish("f2");
    const done = keeping.status();
    expect(done.entries[0]).toMatchObject({ done: 2, total: 2 });
    expect(done.downloading).toBe(false);
    expect(keeping.keptFileId("t1")).toBe("f1");
  });

  it("asks the store by hand for a keep, and holds a library load's new songs off Wi-Fi", async () => {
    console.log("[PARROT-CORE-KEEPING-001] phase=wifi-gate");
    const wifi = { on: false };
    const { keeping, files } = await setup(wifi);
    await keeping.keep("song", "t3", null);
    await keeping.reconcile();
    expect(files.asked).toEqual([true]);
    expect([...files.queued]).toEqual(["f3"]);

    await keeping.keep("playlist", "p1", null);
    await keeping.reconcile();
    expect(files.queued.has("f1")).toBe(true);

    console.log("[PARROT-CORE-KEEPING-001] phase=load-on-cellular");
    await files.store.remove(["f1"]);
    await keeping.reconcile();
    expect(files.asked.at(-1)).toBe(false);
    expect(files.queued.has("f1")).toBe(false);

    console.log("[PARROT-CORE-KEEPING-001] phase=load-on-wifi");
    wifi.on = true;
    await keeping.reconcile();
    expect(files.queued.has("f1")).toBe(true);
  });

  it("removes what no kept item holds and clears everything on sign-out", async () => {
    console.log("[PARROT-CORE-KEEPING-001] phase=unkeep");
    const { keeping, files, keptAny, stored } = await setup();
    await keeping.keep("album", "a1", null);
    await keeping.keep("song", "t1", null);
    await keeping.reconcile();
    await keeping.unkeep("album", "a1");
    await keeping.reconcile();
    expect([...files.queued]).toEqual(["f1"]);

    console.log("[PARROT-CORE-KEEPING-001] phase=clear");
    await keeping.clear();
    expect(files.queued.size).toBe(0);
    expect(stored()).toBeNull();
    expect(keeping.status().entries).toEqual([]);
    expect(keptAny).toEqual([true, false]);
  });

  it("removes one song by hand: its file goes, a playlist's copy of another song stays", async () => {
    console.log("[PARROT-CORE-KEEPING-001] phase=leaveOut");
    const { keeping, files, stored } = await setup();
    await keeping.keep("album", "a1", null);
    await keeping.keep("playlist", "p1", null);
    await keeping.reconcile();
    expect([...files.queued].sort()).toEqual(["f1", "f2", "f3"]);
    const status = await keeping.leaveOut(["t1", "t2"], "library");
    await keeping.reconcile();
    console.log(`[PARROT-CORE-KEEPING-001] after leaveOut stored=${stored()} queued=${[...files.queued].join(",")}`);
    expect(status.entries.map((entry) => `${entry.kind}:${entry.id}`)).toEqual(["playlist:p1"]);
    expect([...files.queued].sort()).toEqual(["f1", "f3"]);
    await keeping.leaveOut(["t1"], { playlist: "p1" });
    await keeping.reconcile();
    expect([...files.queued]).toEqual(["f3"]);
    expect(JSON.parse(stored() ?? "{}").entries).toEqual([{ kind: "playlist", id: "p1", choice: null, keptAt: 10, except: ["t1"] }]);
  });
});
