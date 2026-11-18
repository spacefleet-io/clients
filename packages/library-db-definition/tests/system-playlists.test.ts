/**
 * @bugfix @regression-proof
 * @req LIB-SYNC-10[runtime] @req LIB-SYNC-10[badger-desktop] @req LIB-SYNC-10[badger-mobile]
 *
 * The shared half of LIB-SYNC-10, on a real core library db (node:sqlite, foreign keys on as on the phone):
 *  - `ensureSystemPlaylists` moves a Favorites / Watchlist row an older build created under a random id (and its
 *    items) onto the fixed id, keeps every item, and reports which slugs moved;
 *  - `playlist.item.add` naming a playlist this library does not hold is dropped instead of failing the foreign
 *    key (pre-fix: `FOREIGN KEY constraint failed`, which stopped every later op on the phone);
 *  - `playlist.create` of a system playlist under another id keeps the existing row and its items (pre-fix: the
 *    REPLACE on the unique slug deleted the row and cascaded its items away).
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import type { LibraryOp } from "@space/shared/libraryOps";
import { ensureSystemPlaylists, getGroupDdlStatements, type SqliteDb } from "../src/migrations";
import { buildOpStatements } from "../src/ops";

const TAG = "[system-playlists]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const T = "2026-11-01T00:00:00.000Z";

const coreDb = () => {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  for (const sql of getGroupDdlStatements("core")) db.exec(sql);
  for (const id of ["m1", "m2", "m3"]) {
    db.prepare("INSERT INTO media_items (id, type, title, added_at, updated_at) VALUES (?, 'movie', ?, ?, ?);").run(id, id, T, T);
  }
  return db;
};
const asSqliteDb = (db: DatabaseSync) => db as unknown as SqliteDb;

const state = (db: DatabaseSync) => ({
  playlists: db.prepare("SELECT id, slug, is_system FROM playlists ORDER BY id;").all(),
  items: db.prepare("SELECT playlist_id, media_id FROM playlist_items ORDER BY playlist_id, media_id;").all(),
});

const apply = (db: DatabaseSync, op: LibraryOp) => {
  for (const { sql, params } of buildOpStatements(op, () => "generated").core ?? []) {
    db.prepare(sql).run(...(params as Array<string | number | null>));
  }
};
const op = <K extends LibraryOp["type"]>(type: K, payload: Extract<LibraryOp, { type: K }>["payload"]) =>
  ({ id: `op-${type}`, type, createdAt: T, payload }) as LibraryOp;

describe("system playlists (LIB-SYNC-10)", () => {
  test("a new library gets Favorites and Watchlist under their fixed ids", () => {
    const db = coreDb();
    const moved = ensureSystemPlaylists(asSqliteDb(db));
    log("fresh library", { moved, ...state(db) });
    expect(moved).toEqual([]);
    expect(state(db).playlists).toEqual([
      { id: "favorites", slug: "favorites", is_system: 1 },
      { id: "watchlist", slug: "watchlist", is_system: 0 },
    ]);
    expect(ensureSystemPlaylists(asSqliteDb(db))).toEqual([]);
  });

  test("a row under a random id moves onto the fixed id with every item, nothing lost", () => {
    const db = coreDb();
    db.exec(`INSERT INTO playlists (id, name, slug, is_system, created_at) VALUES
      ('61c16101-phone', 'Favorites', 'favorites', 1, '${T}'),
      ('61c16101-watch', 'Watchlist', 'watchlist', 1, '${T}'),
      ('user-1', 'Mine', NULL, 0, '${T}');`);
    db.exec(`INSERT INTO playlist_items (id, playlist_id, media_id, added_at) VALUES
      ('i1', '61c16101-phone', 'm1', '${T}'),
      ('i2', '61c16101-phone', 'm2', '${T}'),
      ('i3', '61c16101-watch', 'm3', '${T}'),
      ('i4', 'user-1', 'm1', '${T}');`);
    log("diverged library", state(db));
    const moved = ensureSystemPlaylists(asSqliteDb(db));
    log("healed library", { moved, ...state(db) });
    expect(moved.sort()).toEqual(["favorites", "watchlist"]);
    expect(state(db)).toEqual({
      playlists: [
        { id: "favorites", slug: "favorites", is_system: 1 },
        { id: "user-1", slug: null, is_system: 0 },
        { id: "watchlist", slug: "watchlist", is_system: 0 },
      ],
      items: [
        { playlist_id: "favorites", media_id: "m1" },
        { playlist_id: "favorites", media_id: "m2" },
        { playlist_id: "user-1", media_id: "m1" },
        { playlist_id: "watchlist", media_id: "m3" },
      ],
    });
    expect(ensureSystemPlaylists(asSqliteDb(db))).toEqual([]);
  });

  test("an item the fixed row already holds is kept once", () => {
    const db = coreDb();
    ensureSystemPlaylists(asSqliteDb(db));
    db.exec(`INSERT INTO playlist_items (id, playlist_id, media_id, added_at) VALUES ('i1', 'favorites', 'm1', '${T}');`);
    // An older build's snapshot replaced the row: the slug now sits on a random id again, with an overlapping item.
    db.exec("UPDATE playlists SET slug = NULL WHERE id = 'favorites';");
    db.exec(`INSERT INTO playlists (id, name, slug, is_system, created_at) VALUES ('rand', 'Favorites', 'favorites', 1, '${T}');`);
    db.exec(`INSERT INTO playlist_items (id, playlist_id, media_id, added_at) VALUES
      ('i2', 'rand', 'm1', '${T}'), ('i3', 'rand', 'm2', '${T}');`);
    const moved = ensureSystemPlaylists(asSqliteDb(db));
    log("overlap healed", { moved, ...state(db) });
    expect(moved).toEqual(["favorites"]);
    expect(state(db).items).toEqual([
      { playlist_id: "favorites", media_id: "m1" },
      { playlist_id: "favorites", media_id: "m2" },
    ]);
  });

  test("an item for a playlist this library does not hold is dropped, not a foreign-key failure", () => {
    const db = coreDb();
    ensureSystemPlaylists(asSqliteDb(db));
    const unknownPlaylist = op("playlist.item.add", { id: "x1", playlistId: "63725383-desktop", mediaId: "m1", addedAt: T });
    const unknownMedia = op("playlist.item.add", { id: "x2", playlistId: "favorites", mediaId: "gone", addedAt: T });
    const known = op("playlist.item.add", { id: "x3", playlistId: "favorites", mediaId: "m2", addedAt: T });
    expect(() => {
      apply(db, unknownPlaylist);
      apply(db, unknownMedia);
      apply(db, known);
    }).not.toThrow();
    log("after item ops", state(db));
    expect(state(db).items).toEqual([{ playlist_id: "favorites", media_id: "m2" }]);
  });

  test("a system playlist create under another id keeps the existing row and its items", () => {
    const db = coreDb();
    ensureSystemPlaylists(asSqliteDb(db));
    apply(db, op("playlist.item.add", { id: "x1", playlistId: "favorites", mediaId: "m1", addedAt: T }));
    apply(db, op("playlist.create", { id: "rand", name: "Favorites", slug: "favorites", isSystem: true, createdAt: T }));
    log("after old-build create", state(db));
    expect(state(db)).toEqual({
      playlists: [
        { id: "favorites", slug: "favorites", is_system: 1 },
        { id: "watchlist", slug: "watchlist", is_system: 0 },
      ],
      items: [{ playlist_id: "favorites", media_id: "m1" }],
    });
  });
});
