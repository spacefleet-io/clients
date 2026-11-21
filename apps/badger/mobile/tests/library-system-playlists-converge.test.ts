/**
 * @test-id MOBILE-LIBRARY-SYSTEM-PLAYLISTS-CONVERGE-001
 * @level unit
 * @bugfix
 * @regression-proof
 *
 * Why this exists (LIB-SYNC-10): the phone and the desktop each created the library's Favorites and Watchlist
 * under their own random id. A library started on the phone, then favorited on the desktop, sent the phone a
 * `playlist.item.add` naming a playlist id the phone never had: the op failed the foreign key on every sync, the
 * phone's cursor never moved past it and the library showed no titles.
 *
 * Now every device holds Favorites / Watchlist under the fixed ids `favorites` / `watchlist`; a row an older build
 * created under a random id (on the phone, or carried in by a snapshot) moves onto the fixed id with its items, and
 * the phone re-sends those items so the other devices get them too.
 *
 * Drives the real LibraryDb and the real schema code over real in-memory SQLite dbs (node:sqlite).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type * as SharedApi from "@space/shared/api";
import type { LibraryOp } from "@space/shared/libraryOps";
import type { SQLiteDatabase } from "react-native-sqlite-storage";
import { decodeCompressedFrame } from "@space/library-db-definition/payloadCompression";
import { fflateCodec } from "@space/mobile-shell/libraryOps";
import { LibraryDb } from "../src/lib/libraryDb";
import { ensureCoreSchema } from "../src/lib/librarySchema";
import { takeHealedSystemPlaylists } from "../src/lib/library/systemPlaylists";
import {
  createLibrarySqlite,
  createSnapshotHandle,
  fx,
  readCacheJson,
  resetFixture,
  setServer,
  settle,
  SqliteHandle,
  sqliteRows,
} from "./library-db-fixture";

const TAG = "[library-system-playlists-converge]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("react-native-fs", async () => ({ default: (await import("./library-db-fixture")).fakeRnfs }));
vi.mock("react-native-sqlite-storage", () => ({ default: { enablePromise: () => undefined } }));
vi.mock("react-native-quick-crypto", async () => (await import("./library-db-fixture")).quickCryptoMock());
vi.mock("@space/shared/api", async (importOriginal) =>
  (await import("./library-db-fixture")).sharedApiMock(await importOriginal<typeof SharedApi>())
);
vi.mock("../src/lib/library/transport", async () => {
  const fixture = await import("./library-db-fixture");
  return {
    ...fixture.transportMock(),
    fetchRemoteManifestWithRetry: async () => ({
      remote: {
        exists: true,
        version: fixture.fx.serverVersion,
        snapshotVersion: fixture.fx.serverSnapshotVersion,
        updatedAt: "2026-11-01T00:00:00.000Z",
        manifestKey: "library/manifest",
      },
      manifestBytes: new Uint8Array(),
    }),
  };
});
vi.mock("../src/lib/library/dbFiles", async () => (await import("./library-db-fixture")).sqliteDbFilesMock());
vi.mock("../src/lib/library/snapshot", async () => {
  const fixture = await import("./library-db-fixture");
  return {
    ...fixture.snapshotMock(),
    decodeStoredManifest: async () => new TextEncoder().encode("{}"),
    decryptFileToDb: async (_key: string, _source: string, target: string) => {
      fixture.fx.files.set(target, "db");
    },
  };
});
vi.mock("../src/lib/crypto", async () => (await import("./library-db-fixture")).cryptoMock());

const CORE = "library.core.sqlite";
const PENDING_OPS = "/docs/library/pending_ops.json";
const T = "2026-11-01T00:00:00.000Z";
const DESKTOP_FAVORITES = "63725383-desktop";

type LibraryDbSeam = Pick<LibraryDb, keyof LibraryDb> & { secondaryOpsInFlight: Promise<void> | null };

const seedTitles = (db: DatabaseSync, mediaIds: string[]) => {
  for (const mediaId of mediaIds) {
    db.prepare("INSERT INTO media_items (id, type, title, added_at, updated_at) VALUES (?, 'movie', ?, ?, ?);").run(
      mediaId,
      `Movie ${mediaId}`,
      T,
      T
    );
  }
};

/** Favorites + Watchlist as a pre-LIB-SYNC-10 build created them: random ids. */
const seedRandomSystemPlaylists = (db: DatabaseSync, favoritesId: string, favorites: string[]) => {
  db.prepare("INSERT INTO playlists (id, name, slug, is_system, created_at) VALUES (?, 'Favorites', 'favorites', 1, ?);").run(favoritesId, T);
  db.prepare("INSERT INTO playlists (id, name, slug, is_system, created_at) VALUES (?, 'Watchlist', 'watchlist', 0, ?);").run(`${favoritesId}-watchlist`, T);
  for (const mediaId of favorites) {
    db.prepare("INSERT INTO playlist_items (id, playlist_id, media_id, added_at) VALUES (?, ?, ?, ?);").run(`item-${mediaId}`, favoritesId, mediaId, T);
  }
};

const itemAdd = (id: string, playlistId: string, mediaId: string): LibraryOp => ({
  id,
  type: "playlist.item.add",
  createdAt: T,
  payload: { id: `pli-${id}`, playlistId, mediaId, addedAt: T },
});

/** Every op this phone uploaded or still queues. */
const sentOps = () => [
  ...fx.postedOps.map((bytes) => JSON.parse(new TextDecoder().decode(decodeCompressedFrame(bytes, fflateCodec))) as LibraryOp),
  ...(JSON.parse(fx.files.get(PENDING_OPS) ?? "[]") as LibraryOp[]),
];

const corePlaylists = () => ({
  playlists: sqliteRows(CORE, "SELECT id, slug, is_system FROM playlists ORDER BY id;"),
  items: sqliteRows(CORE, "SELECT playlist_id, media_id FROM playlist_items ORDER BY playlist_id, media_id;"),
});

beforeEach(() => {
  resetFixture();
  takeHealedSystemPlaylists();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("Favorites and Watchlist converge on one id across devices (LIB-SYNC-10)", () => {
  // @req LIB-SYNC-10[badger-mobile] @req LIB-SYNC-10[badger-tv] (the TV app is the phone app's binary and runs this library code)
  it("@bugfix @regression-proof opening a library an older build made moves its random-id Favorites onto the fixed id, items kept", async () => {
    const db = createLibrarySqlite(["core"], { foreignKeys: true });
    seedTitles(db, ["m1", "m2"]);
    seedRandomSystemPlaylists(db, "61c16101-phone", ["m1", "m2"]);
    log("phone core before open", { playlists: db.prepare("SELECT id, slug FROM playlists;").all() });
    await ensureCoreSchema(new SqliteHandle(CORE, db) as unknown as SQLiteDatabase);
    const after = {
      playlists: db.prepare("SELECT id, slug, is_system FROM playlists ORDER BY id;").all(),
      items: db.prepare("SELECT playlist_id, media_id FROM playlist_items ORDER BY media_id;").all(),
    };
    log("phone core after open", after);
    expect(after.playlists).toEqual([
      { id: "favorites", slug: "favorites", is_system: 1 },
      { id: "watchlist", slug: "watchlist", is_system: 0 },
    ]);
    expect(after.items).toEqual([
      { playlist_id: "favorites", media_id: "m1" },
      { playlist_id: "favorites", media_id: "m2" },
    ]);
    expect(takeHealedSystemPlaylists().sort(), "the moved slugs are handed to the LibraryDb to re-send").toEqual([
      "favorites",
      "watchlist",
    ]);
  });

  // @req LIB-SYNC-10[badger-mobile] @req LIB-SYNC-10[badger-tv]
  it("@bugfix @regression-proof a phone bootstrapping from a snapshot with the desktop's random Favorites keeps syncing and re-sends the items", async () => {
    // The desktop (older build) published the snapshot: its Favorites under its own random id, holding m1.
    const snapshot = createSnapshotHandle();
    seedTitles(snapshot.db, ["m1", "m2", "m3"]);
    seedRandomSystemPlaylists(snapshot.db, DESKTOP_FAVORITES, ["m1"]);
    fx.snapshots.push(snapshot);
    setServer({
      version: 6,
      snapshotVersion: 3,
      ops: [
        // From the desktop before it updated: names its random id, unknown here once healed. Must not stall sync.
        { opId: "op-4", version: 4, op: itemAdd("op-4", DESKTOP_FAVORITES, "m2") },
        // From a device on the fixed ids.
        { opId: "op-5", version: 5, op: itemAdd("op-5", "favorites", "m3") },
        // An item for a playlist nobody has: dropped, the cursor moves on.
        { opId: "op-6", version: 6, op: itemAdd("op-6", "ghost-playlist", "m1") },
      ],
    });

    log("phase: phone opens the library (no cache: bootstraps from the snapshot)");
    const db = (await LibraryDb.open("token", "key")) as unknown as LibraryDbSeam;
    await settle(db);
    log("phone core after bootstrap", corePlaylists());
    log("phase: phone syncs the op stream");
    await db.syncFromRemoteIfNewer(fx.meta ?? undefined);
    await settle(db);
    const after = corePlaylists();
    const resent = sentOps().filter((op) => op.type === "playlist.item.add");
    log("phone after sync", { ...after, cache: readCacheJson(), resent: resent.map((op) => op.payload) });

    expect(after.playlists).toEqual([
      { id: "favorites", slug: "favorites", is_system: 1 },
      { id: "watchlist", slug: "watchlist", is_system: 0 },
    ]);
    expect(after.items, "m1 from the snapshot moved over, m3 from the fixed-id op applied").toEqual([
      { playlist_id: "favorites", media_id: "m1" },
      { playlist_id: "favorites", media_id: "m3" },
    ]);
    expect(readCacheJson()?.version, "the cursor passed every op instead of stalling on the foreign key").toBe(6);
    expect(
      resent.map((op) => op.type === "playlist.item.add" && [op.payload.playlistId, op.payload.mediaId]),
      "the moved item is re-sent under the fixed id for the other devices"
    ).toEqual([["favorites", "m1"]]);
  });
});
