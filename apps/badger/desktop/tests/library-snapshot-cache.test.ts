// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
  clearLibrarySnapshotCache,
  loadLibrarySnapshotCache,
  parseLibrarySnapshotCache,
  saveLibrarySnapshotCache,
} from "../src/renderer/src/lib/librarySnapshotCache";

// Dump-on-failure helper: surfaces the parsed/loaded snapshot and the storage
// store contents so a parse/serialize/adapter regression is diagnosable
// offline. try/catch-guarded body.
const dumpCacheSnapshot = (label: string, ctx: Record<string, unknown>) => {
  try {
    console.error(`=== [library-snapshot-cache:${label}] cache snapshot ===`);
    for (const [name, value] of Object.entries(ctx)) {
      console.error(`${name}=${JSON.stringify(value, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("librarySnapshotCache", () => {
  it("parses valid cached snapshots and fills missing optional fields", () => {
    console.info("[library-snapshot-cache:setup] parsing snapshot with media+playlists, missing optionals");
    const snapshot = parseLibrarySnapshotCache(
      JSON.stringify({
        media: [{ id: "m1", title: "Movie" }],
        playlists: [{ id: "p1", name: "Favorites" }],
      })
    );

    const expected = {
      media: [{ id: "m1", title: "Movie" }],
      playlists: [{ id: "p1", name: "Favorites" }],
      playlistItems: {},
      mediaDetails: [],
      ingestJobs: [],
      settings: {},
    };
    if (JSON.stringify(snapshot) !== JSON.stringify(expected)) {
      dumpCacheSnapshot("parse-fill-mismatch", { snapshot, expected });
    }
    expect(snapshot).toEqual(expected);
  });

  it("returns null for malformed or incomplete cached snapshots", () => {
    console.info("[library-snapshot-cache:setup] parsing malformed/incomplete/null inputs (each expects null)");
    const malformed = parseLibrarySnapshotCache("{");
    const incomplete = parseLibrarySnapshotCache(JSON.stringify({ media: [] }));
    const nullInput = parseLibrarySnapshotCache(null);
    if (malformed !== null || incomplete !== null || nullInput !== null) {
      dumpCacheSnapshot("null-guard-mismatch", { malformed, incomplete, nullInput });
    }
    expect(malformed).toBeNull();
    expect(incomplete).toBeNull();
    expect(nullInput).toBeNull();
  });

  const memoryStorage = () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        store.delete(key);
      }),
      key: (index: number) => Array.from(store.keys())[index] ?? null,
      get length() {
        return store.size;
      },
    };
    return { store, storage };
  };

  const snapshotWith = (mediaId: string) => ({
    media: [{ id: mediaId }],
    playlists: [],
    playlistItems: {},
    mediaDetails: [],
    ingestJobs: [],
    settings: {},
  }) as never;

  it("loads, saves, and clears snapshots through the storage adapter", () => {
    console.info("[library-snapshot-cache:setup] building in-memory storage adapter for user-1 / prof-a");
    const { store, storage } = memoryStorage();

    console.info("[library-snapshot-cache:save] saving snapshot for user-1 / prof-a");
    saveLibrarySnapshotCache({ userId: "user-1", profileId: "prof-a" }, snapshotWith("m1"), storage);

    if (!(store.get("sf_library_snapshot_user-1:prof-a") ?? "").includes("\"media\"")) {
      dumpCacheSnapshot("save-mismatch", { setItemCalls: storage.setItem.mock.calls, storeKeys: Array.from(store.keys()) });
    }
    expect(storage.setItem).toHaveBeenCalledWith("sf_library_snapshot_user-1:prof-a", expect.stringContaining("\"media\""));

    console.info("[library-snapshot-cache:load] loading snapshot back for user-1 / prof-a");
    const loaded = loadLibrarySnapshotCache({ userId: "user-1", profileId: "prof-a" }, storage);
    console.info(`[library-snapshot-cache:load] loaded=${JSON.stringify(loaded)}`);
    if (!loaded) dumpCacheSnapshot("load-mismatch", { loaded, storeKeys: Array.from(store.keys()) });
    expect(loaded).toEqual(expect.objectContaining({ media: [{ id: "m1" }], playlists: [] }));

    console.info("[library-snapshot-cache:clear] clearing snapshot for user-1");
    clearLibrarySnapshotCache("user-1", storage);
    const afterClear = loadLibrarySnapshotCache({ userId: "user-1", profileId: "prof-a" }, storage);
    if (afterClear !== null) dumpCacheSnapshot("clear-mismatch", { afterClear, storeKeys: Array.from(store.keys()) });
    expect(afterClear).toBeNull();
  });

  // @req UX-PROF-01[badger-desktop]
  it("@bugfix a profile never opens on another profile's cached view, and a reset drops every profile's view", () => {
    const { store, storage } = memoryStorage();
    store.set("sf_library_snapshot_user-1", JSON.stringify(snapshotWith("legacy")));
    store.set("sf_library_snapshot_user-2:prof-x", JSON.stringify(snapshotWith("other-user")));
    saveLibrarySnapshotCache({ userId: "user-1", profileId: "prof-a" }, snapshotWith("a-show"), storage);
    saveLibrarySnapshotCache({ userId: "user-1", profileId: "prof-kids" }, snapshotWith("kids-show"), storage);
    const views = {
      a: loadLibrarySnapshotCache({ userId: "user-1", profileId: "prof-a" }, storage)?.media,
      kids: loadLibrarySnapshotCache({ userId: "user-1", profileId: "prof-kids" }, storage)?.media,
      neverSaved: loadLibrarySnapshotCache({ userId: "user-1", profileId: "prof-new" }, storage),
    };
    console.info(`[library-snapshot-cache:per-profile] views=${JSON.stringify(views)} keys=${JSON.stringify([...store.keys()])}`);
    try {
      expect(views).toEqual({ a: [{ id: "a-show" }], kids: [{ id: "kids-show" }], neverSaved: null });
      clearLibrarySnapshotCache("user-1", storage);
      expect([...store.keys()]).toEqual(["sf_library_snapshot_user-2:prof-x"]);
    } catch (err) {
      dumpCacheSnapshot("per-profile", { views, storeKeys: [...store.keys()] });
      throw err;
    }
  });
});
