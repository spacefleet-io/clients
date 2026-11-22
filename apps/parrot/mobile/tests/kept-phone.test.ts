/**
 * @test-id PARROT-MOBILE-KEPT-001
 * @level unit
 * @req PAR-OFFL-01[parrot]
 * @req PAR-OFFL-02[parrot]
 * @why The phone keeps songs through the shared keeping loop and the native download engine. Each kept song file must
 *   reach the engine as one titled "song" download with its chunk objects and gateways, or the notification and the
 *   offline file go wrong; songs a library load finds missing wait for Wi-Fi while a keep by hand goes at once; the
 *   library copy is kept for offline use only while something is kept; and sign-out leaves no kept song on the phone.
 *   The engine, storage and library are mocked; the downloads themselves are tried on a device.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ParrotCore from "@space/parrot-core";
import { groupParrotOfflineTree, type OfflineManageRow } from "@space/shared/offlineManage";
import type * as KeptModule from "../src/lib/kept";

const log = (phase: string, detail: unknown = {}) => console.info(`[PARROT-MOBILE-KEPT-001] phase=${phase}`, JSON.stringify(detail));

const fake = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  network: "cellular",
  items: [] as { id: string; kind: string; status: string }[],
  enqueued: [] as Record<string, unknown>[],
  removed: [] as string[][],
  copyKept: [] as boolean[],
  /** More songs of album a1, with no file: the library lists them but none can play, so keeping never holds them. */
  unplayable: [] as string[],
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => fake.storage.get(key) ?? null,
    setItem: async (key: string, value: string) => void fake.storage.set(key, value),
    removeItem: async (key: string) => void fake.storage.delete(key),
  },
}));
vi.mock("@space/mobile-media-proxy", () => ({ resolveGatewayCandidates: async () => ["https://gw.test"] }));
vi.mock("@space/mobile-media-proxy/downloads", () => ({
  EMPTY_DOWNLOADS_STATE: { items: [] },
  downloadNotificationLabels: () => ({}),
  downloadsNativeAvailable: () => true,
  nativeConfigure: async () => undefined,
  nativeGetState: async () => ({ items: fake.items }),
  nativeGetStatus: async () => ({ networkType: fake.network }),
  nativeResume: async () => undefined,
  parseDownloadsState: (raw: unknown) => raw,
  subscribeNativeState: () => () => undefined,
  nativeEnqueue: async (spec: Record<string, unknown>) => {
    fake.enqueued.push(spec);
    fake.items.push({ id: spec.id as string, kind: spec.kind as string, status: "queued" });
  },
  nativeRemove: async (ids: string[]) => {
    fake.removed.push(ids);
    fake.items = fake.items.filter((item) => !ids.includes(item.id));
  },
}));
vi.mock("@space/mobile-shell/i18n", () => ({ translate: (key: string) => key }));
vi.mock("@space/mobile-shell/logger", () => ({ scopeLogger: () => ({ info: (line: string) => console.info(`[PARROT-MOBILE-KEPT-001] ${line}`) }) }));
vi.mock("../src/lib/library", async () => {
  const { keepLibraryFromRows } = await vi.importActual<typeof ParrotCore>("@space/parrot-core");
  const file = (id: string, trackId: string, mime = "audio/mpeg", lossless = false) => ({
    id,
    trackId,
    mime,
    lossless,
    bitrateKbps: lossless ? null : 320,
    sizeBytes: 1000,
    lightCopy: false,
    createdAt: 1,
  });
  return {
    readKeepLibrary: async () =>
      keepLibraryFromRows({
        tracks: [
          { id: "t1", albumId: "a1" },
          { id: "t2", albumId: "a1" },
          ...fake.unplayable.map((id) => ({ id, albumId: "a1" })),
        ],
        playlists: [{ id: "p1", trackIds: ["t2", ...fake.unplayable] }],
        files: [file("f1", "t1"), file("f1flac", "t1", "audio/flac", true), file("f2", "t2")],
      }),
    fileForDownload: async ({ trackId }: { trackId: string }) => ({
      title: `Song ${trackId}`,
      artistName: "Nova",
      chunks: [{ objectKey: `obj-${trackId}-a` }, { objectKey: `obj-${trackId}-a` }, { objectKey: `obj-${trackId}-b` }],
    }),
    setLibraryCopyKept: async (kept: boolean) => void fake.copyKept.push(kept),
  };
});

/** Keeping runs its downloads after `keepItem` returns; a library-load run waits for that run first. */
const settled = async (kept: typeof KeptModule) => kept.keptLibraryLoaded();

const load = async () => {
  vi.resetModules();
  return import("../src/lib/kept");
};

beforeEach(() => {
  fake.storage.clear();
  fake.network = "cellular";
  fake.items = [];
  fake.enqueued = [];
  fake.removed = [];
  fake.copyKept = [];
  fake.unplayable = [];
});

/** The rows Manage offline content shows, built as the screen builds them; then the one row of that kind and id. */
const rowOnScreen = (kept: typeof KeptModule, kind: OfflineManageRow["kind"], id: string): OfflineManageRow => {
  const song = (item: { trackId: string; fileId: string }) => ({ ...item, title: item.trackId, albumId: "a1", artistId: "ar1", artistName: "Nova" });
  const items = kept.keptSongs();
  const { rows } = groupParrotOfflineTree({
    songs: items.filter((item) => item.kind !== "playlist").flatMap((item) => item.songs.map(song)),
    playlists: items.filter((item) => item.kind === "playlist").map((item) => ({ id: item.id, title: item.id, songs: item.songs.map(song) })),
    albumOf: () => ({ title: "Album a1", artistId: "ar1", artistName: "Nova", imagePath: null }),
    bytesOf: () => 1000,
  });
  const all = (row: OfflineManageRow): OfflineManageRow[] => [row, ...row.children.flatMap(all)];
  const found = rows.flatMap(all).find((row) => row.kind === kind && row.id === id && (kind === "playlist" || !row.playlistId));
  if (!found) throw new Error(`no ${kind} row ${id} on screen`);
  return found;
};

describe("keeping songs on the phone", () => {
  it("hands a kept song to the engine as one titled song download, at once even off Wi-Fi", async () => {
    const kept = await load();
    await kept.startKeeping("token-1");
    await kept.keptLibraryLoaded();
    await kept.keepItem("song", "t2", null);
    await settled(kept);
    log("keep-song", fake.enqueued);
    expect(fake.enqueued).toHaveLength(1);
    expect(fake.enqueued[0]).toMatchObject({
      id: "f2",
      mediaId: "t2",
      title: "Song t2",
      subtitle: "Nova",
      kind: "song",
      formatId: "f2",
      codec: "audio/mpeg",
      estimatedBytes: 1000,
      objects: [
        ["obj-t2-a", 0],
        ["obj-t2-b", 0],
      ],
      gatewayCandidates: ["https://gw.test"],
    });
    expect(fake.storage.has("parrot.kept")).toBe(true);
    expect(fake.copyKept.at(-1)).toBe(true);
    expect(kept.getKeptStatus().entries.map((entry) => [entry.kind, entry.id])).toEqual([["song", "t2"]]);
  });

  it("asks which copy when a song has two, and keeps the one chosen", async () => {
    const kept = await load();
    await kept.startKeeping("token-1");
    await kept.keptLibraryLoaded();
    const choices = await kept.keepChoices("album", "a1");
    log("choices", choices);
    expect(choices.length).toBeGreaterThanOrEqual(2);
    const flac = choices.find((choice) => choice.lossless)!;
    await kept.keepItem("album", "a1", flac.key);
    await settled(kept);
    expect(fake.enqueued.map((spec) => spec.id).sort()).toEqual(["f1flac", "f2"]);
  });

  it("waits for Wi-Fi before a library load downloads what is missing", async () => {
    const first = await load();
    await first.startKeeping("token-1");
    await first.keptLibraryLoaded();
    await first.keepItem("album", "a1", null);
    await settled(first);
    // The engine lost the songs (an app reinstall keeps AsyncStorage on some phones): a reload finds them missing.
    fake.items = [];
    fake.enqueued = [];
    const second = await load();
    await second.startKeeping("token-1");
    await second.keptLibraryLoaded();
    log("cellular-reload", { enqueued: fake.enqueued.length });
    expect(fake.enqueued).toEqual([]);
    fake.network = "wifi";
    await second.keptLibraryLoaded();
    log("wifi-reload", { enqueued: fake.enqueued.map((spec) => spec.id) });
    expect(fake.enqueued.map((spec) => spec.id).sort()).toEqual(["f1flac", "f2"]);
  });

  it("unkeeping drops the song from the engine, and sign-out leaves nothing kept", async () => {
    const kept = await load();
    await kept.startKeeping("token-1");
    await kept.keptLibraryLoaded();
    await kept.keepItem("song", "t1", null);
    await kept.keepItem("song", "t2", null);
    await settled(kept);
    await kept.unkeepItem("song", "t2");
    await settled(kept);
    log("unkeep", { removed: fake.removed, items: fake.items });
    expect(fake.items.map((item) => item.id)).toEqual(["f1flac"]);
    await kept.clearKeeping();
    log("sign-out", { items: fake.items, storage: [...fake.storage.keys()] });
    expect(fake.items).toEqual([]);
    expect(fake.storage.has("parrot.kept")).toBe(false);
    expect(fake.copyKept.at(-1)).toBe(false);
    expect(kept.getKeptStatus()).toBe(kept.EMPTY_KEPT_STATUS);
  });

  // @req OFFL-MANAGE-01[parrot]
  it("OFFL-MANAGE-01: lists each kept item with its songs and files, and Remove all unkeeps everything", async () => {
    const kept = await load();
    await kept.startKeeping("token-1");
    await kept.keptLibraryLoaded();
    await kept.keepItem("album", "a1", null);
    await kept.keepItem("song", "t2", null);
    await settled(kept);
    const items = kept.keptSongs();
    log("kept-songs", items);
    expect(items).toEqual([
      { kind: "album", id: "a1", songs: [{ trackId: "t1", fileId: expect.any(String) }, { trackId: "t2", fileId: "f2" }] },
      { kind: "song", id: "t2", songs: [{ trackId: "t2", fileId: "f2" }] },
    ]);
    await kept.unkeepAll();
    await settled(kept);
    log("remove-all", { entries: kept.getKeptStatus().entries, items: fake.items, copyKept: fake.copyKept.at(-1) });
    expect(kept.getKeptStatus().entries).toEqual([]);
    expect(kept.keptSongs()).toEqual([]);
    expect(fake.items).toEqual([]);
    expect(fake.copyKept.at(-1)).toBe(false);
  });

  // @req OFFL-MANAGE-01[parrot]
  it("OFFL-MANAGE-01: a song's bin removes it from the album and the lone song, leaving the album's other song", async () => {
    const kept = await load();
    await kept.startKeeping("token-1");
    await kept.keptLibraryLoaded();
    await kept.keepItem("album", "a1", null);
    await kept.keepItem("song", "t2", null);
    await settled(kept);
    const t1File = kept.keptSongs()[0].songs[0].fileId;
    await kept.removeKeptRow(rowOnScreen(kept, "song", "t2"));
    await settled(kept);
    log("remove-song", { entries: kept.getKeptStatus().entries, items: fake.items, removed: fake.removed });
    expect(kept.getKeptStatus().entries.map((entry) => ({ kind: entry.kind, id: entry.id, except: entry.except }))).toEqual([
      { kind: "album", id: "a1", except: ["t2"] },
    ]);
    expect(kept.keptSongs()).toEqual([{ kind: "album", id: "a1", songs: [{ trackId: "t1", fileId: t1File }] }]);
    expect(fake.items.map((item) => item.id)).toEqual([t1File]);
    expect(fake.removed.flat()).toContain("f2");
  });

  // @req OFFL-MANAGE-01[parrot]
  it("OFFL-MANAGE-01: a playlist's or an album's bin unsaves it, songs that cannot play included", async () => {
    fake.unplayable = ["t3"];
    const kept = await load();
    await kept.startKeeping("token-1");
    await kept.keptLibraryLoaded();
    await kept.keepItem("album", "a1", null);
    await kept.keepItem("playlist", "p1", null);
    await settled(kept);
    const playlist = rowOnScreen(kept, "playlist", "p1");
    const album = rowOnScreen(kept, "album", "a1");
    log("rows", { playlist: playlist.children.map((song) => song.id), album: album.children.map((song) => song.id) });
    // The rows list only the songs on the phone: t3 has no file, so it is under neither.
    expect(playlist.children.map((song) => song.id)).toEqual(["t2"]);
    expect(album.children.map((song) => song.id).sort()).toEqual(["t1", "t2"]);
    await kept.removeKeptRow(playlist);
    await settled(kept);
    log("playlist-bin", { entries: kept.getKeptStatus().entries, items: fake.items, removed: fake.removed });
    expect(kept.getKeptStatus().entries.map((entry) => [entry.kind, entry.id, entry.except])).toEqual([["album", "a1", undefined]]);
    // The album still holds t2, so its file stays.
    expect(fake.items.map((item) => item.id)).toContain("f2");
    await kept.removeKeptRow(rowOnScreen(kept, "album", "a1"));
    await settled(kept);
    log("album-bin", { entries: kept.getKeptStatus().entries, items: fake.items, removed: fake.removed });
    expect(kept.getKeptStatus().entries).toEqual([]);
    expect(kept.keptSongs()).toEqual([]);
    expect(fake.items).toEqual([]);
  });
});
