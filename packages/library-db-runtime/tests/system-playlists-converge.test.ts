/**
 * @bugfix @regression-proof
 * @req LIB-SYNC-10[badger-desktop] @req LIB-SYNC-10[runtime]
 *
 * A library started on the phone, then a title favorited on the desktop: the phone's sync failed every time on
 * `FOREIGN KEY constraint failed` and showed no titles. Each device created Favorites / Watchlist with its own
 * random id when its library had no row of that slug (the phone's bootstrap snapshot carried none), so the
 * desktop's `playlist.item.add` named a playlist the phone did not have.
 *
 * Drives two REAL LibraryDb instances (two user-data roots) against one fake API:
 *  1. a device whose library lacks the system rows (as after the phone-first bootstrap) favorites a title:
 *     the other device must hold it in its own Favorites;
 *  2. two libraries already diverged by an older build (each device's favorites under its own random id, each
 *     with a favorite the other never got) heal when they open: one Favorites at the shared id on both, holding
 *     both titles, nothing lost.
 *
 * Pre-fix: (1) the favorite never reaches the first device (its sync applies an item for an unknown playlist),
 * (2) each device keeps its random id and its own favorite only.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import * as realApi from "../src/api";
import type { LibraryMeta } from "../src/api";
import { getCoreDbPath } from "../src/libraryDbStorage";
const TAG = "[system-playlists-converge]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

type FakeOp = { version: number; opId: string; payloadCiphertext: string; createdAt: string };
const fake = {
  exists: false,
  version: 0,
  snapshotVersion: 0,
  stateHash: null as string | null,
  lastOpId: null as string | null,
  manifestKey: null as string | null,
  snapshotId: null as string | null,
  ops: [] as FakeOp[],
  objects: new Map<string, Uint8Array>(),
  calls: [] as string[],
  reset() {
    this.exists = false;
    this.version = 0;
    this.snapshotVersion = 0;
    this.stateHash = null;
    this.lastOpId = null;
    this.manifestKey = null;
    this.snapshotId = null;
    this.ops = [];
    this.objects = new Map();
    this.calls = [];
  },
  dump() {
    return { version: this.version, snapshotVersion: this.snapshotVersion, ops: this.ops.length, lastCalls: this.calls.slice(-20) };
  },
  meta(): LibraryMeta {
    return {
      exists: this.exists,
      bootstrapRequired: !this.exists,
      syncUnavailable: false,
      version: this.version,
      snapshotVersion: this.snapshotVersion,
      hash: null,
      stateHash: this.stateHash,
      lastOpId: this.lastOpId,
      consistency: this.exists ? "ok" : "missing_snapshot",
      updatedAt: new Date().toISOString(),
      keyProbe: null,
      keyProbeUpdatedAt: null,
      blobEncoding: "binary",
      snapshotId: this.snapshotId,
      manifestKey: this.manifestKey,
      chunkSize: null,
      snapshotHistory: [],
      opsHistory: [],
      storageFormatVersion: 1,
      opStreamVersion: 1,
    };
  },
};

const originalApi = { ...realApi };
afterAll(() => {
  mock.module("../src/api", () => originalApi);
});
mock.module("../src/api", () => ({
  ...originalApi,
  getLibraryMeta: async () => fake.meta(),
  getLibraryDb: async () => ({
    exists: fake.exists,
    version: fake.version,
    snapshotVersion: fake.snapshotVersion,
    hash: null,
    manifestKey: fake.manifestKey,
    updatedAt: new Date().toISOString(),
    blobEncoding: "binary" as const,
    snapshotId: fake.snapshotId,
    chunkSize: null,
  }),
  getLibraryOps: async (_token: string, since: number) => {
    const ops = fake.ops.filter((op) => op.version > since && op.version > fake.snapshotVersion);
    fake.calls.push(`getLibraryOps since=${since} -> [${ops.map((op) => op.version).join(",")}]`);
    return {
      version: fake.version,
      snapshotVersion: fake.snapshotVersion,
      tooOld: since < fake.snapshotVersion,
      ops: ops.map((op) => ({ ...op, objectKey: `library/ops/${op.opId}`, size: 0 })),
      hasMore: false,
      storageFormatVersion: 1,
      opStreamVersion: 1,
    };
  },
  putLibraryOp: async (
    _token: string,
    baseVersion: number,
    opId: string,
    payload: Uint8Array,
    lineage?: { prevStateHash?: string | null; nextStateHash?: string | null }
  ) => {
    if (baseVersion !== fake.version) {
      fake.calls.push(`putLibraryOp base=${baseVersion} -> 409 current=${fake.version}`);
      throw new realApi.ApiError(409, { error: "version_conflict", version: fake.version });
    }
    fake.version += 1;
    fake.stateHash = lineage?.nextStateHash ?? fake.stateHash;
    fake.lastOpId = opId;
    fake.ops.push({ version: fake.version, opId, payloadCiphertext: Buffer.from(payload).toString("base64"), createdAt: new Date().toISOString() });
    fake.calls.push(`putLibraryOp -> v=${fake.version}`);
    return { version: fake.version, snapshotVersion: fake.snapshotVersion, stateHash: fake.stateHash, lastOpId: opId };
  },
  putLibraryDb: async (
    _token: string,
    expectedVersion: number,
    manifestBase64: string,
    snapshotId: string,
    _chunkSize: number,
    _keyProbe?: string | null,
    _force?: boolean,
    stateHash?: string | null,
    lastOpId?: string | null
  ) => {
    if (expectedVersion !== fake.version) {
      fake.calls.push(`putLibraryDb expected=${expectedVersion} -> 409 current=${fake.version}`);
      throw new realApi.ApiError(409, { error: "version_conflict", version: fake.version });
    }
    fake.version += 1;
    fake.snapshotVersion = fake.version;
    fake.exists = true;
    fake.snapshotId = snapshotId;
    fake.manifestKey = `library/manifests/${snapshotId}`;
    fake.objects.set(fake.manifestKey, new TextEncoder().encode(manifestBase64));
    fake.stateHash = stateHash ?? fake.stateHash ?? `snap-${snapshotId}`;
    fake.lastOpId = lastOpId ?? fake.lastOpId;
    fake.calls.push(`putLibraryDb -> v=${fake.version}`);
    return { version: fake.version, stateHash: fake.stateHash, lastOpId: fake.lastOpId, snapshotVersion: fake.version };
  },
  uploadStorageObjectViaTunnel: async (_token: string, objectKey: string, payload: Uint8Array) => {
    fake.objects.set(objectKey, Uint8Array.from(payload));
    return { ok: true };
  },
  downloadStorageObjectViaTunnel: async (_token: string, objectKey: string) => {
    const bytes = fake.objects.get(objectKey);
    if (!bytes) throw new realApi.ApiError(404, { error: "not_found" });
    return bytes;
  },
  listStorageObjects: async () => ({ keys: [...fake.objects.keys()] }),
  deleteStorageObjects: async (_token: string, keys: string[]) => {
    for (const key of keys) fake.objects.delete(key);
    return { deleted: keys.length };
  },
}));

const { LibraryDb } = await import("../src/libraryDb");
type Db = typeof LibraryDb.prototype;
type Internals = { pendingOps: unknown[]; opsFlushInFlight: boolean };
const drained = (db: Db) => {
  const internals = db as unknown as Internals; // test-only peek at the sync queue
  return internals.pendingOps.length === 0 && !internals.opsFlushInFlight;
};
const waitFor = async (label: string, predicate: () => boolean, timeoutMs = 10_000) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      log(`waitFor:timeout ${label}`, fake.dump());
      throw new Error(`waitFor timeout: ${label}`);
    }
    await Bun.sleep(10);
  }
};

const TOKEN = "token-system-playlists";
const KEY = randomBytes(32).toString("base64");
const movie = (id: number, title: string) => ({
  id,
  type: "movie" as const,
  title,
  originalTitle: null,
  originalLanguage: "en",
  overview: null,
  year: "2026",
  rating: null,
  posterPath: null,
  backdropPath: null,
  genres: [],
  cast: [],
  trailers: [],
  totalEpisodes: null,
  seasons: [],
  episodes: [],
});
const MOVIE = movie(61_161, "System Playlist Movie");
const MOVIE_2 = movie(61_162, "System Playlist Movie Two");

const roots: string[] = [];
const deviceRoot = (name: string) => {
  const root = mkdtempSync(join(tmpdir(), `sf-system-playlists-${name}-`));
  roots.push(root);
  return root;
};
const useDevice = (root: string) => {
  process.env.SF_USER_DATA_PATH = root;
};
const systemIds = (db: Db) =>
  Object.fromEntries(db.listPlaylists().filter((p) => p.slug).map((p) => [p.slug, p.id])) as Record<string, string>;

/** Edits the device's core library file while the device is closed (what an older build left on disk). */
const editCore = (root: string, label: string, edit: (core: Database) => void) => {
  useDevice(root);
  const core = new Database(getCoreDbPath());
  try {
    edit(core);
    log(`${label} core playlists`, {
      playlists: core.query("SELECT id, slug, is_system FROM playlists ORDER BY slug;").all(),
      items: core.query("SELECT playlist_id, media_id FROM playlist_items ORDER BY media_id;").all(),
    });
  } finally {
    core.close();
  }
};

const favoritesOf = (db: Db) => {
  const id = db.getSystemPlaylistId("favorites");
  return { id, items: id ? [...db.listPlaylistItems(id)].sort() : [] };
};

beforeEach(() => {
  fake.reset();
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
});

describe("system playlists across devices (LIB-SYNC-10)", () => {
  it("a favorite from a device whose library lacked the system rows lands in the other device's favorites", async () => {
    const rootA = deviceRoot("a");
    const rootB = deviceRoot("b");

    log("phase: device A (the phone) starts the library");
    useDevice(rootA);
    const a = await LibraryDb.open(TOKEN, KEY);
    a.setSyncEnabled(true);
    const mediaId = await a.addMediaFromTmdb(MOVIE);
    await waitFor("A seed flushed", () => drained(a));
    log("device A system playlists", { ids: systemIds(a), server: fake.dump() });
    a.close();

    log("phase: device B joins; its bootstrap snapshot carried no system rows, so it made its own (random id)");
    useDevice(rootB);
    const b0 = await LibraryDb.open(TOKEN, KEY);
    b0.close();
    editCore(rootB, "device B", (core) => {
      core.exec("DELETE FROM playlist_items;");
      core.exec("UPDATE playlists SET id = '63725383-dc93-4ae8-9a02-ac5e12dd0984' WHERE slug = 'favorites';");
      core.exec("UPDATE playlists SET id = '7c1f0a52-desktop-watchlist' WHERE slug = 'watchlist';");
    });
    useDevice(rootB);
    const b = await LibraryDb.open(TOKEN, KEY);
    b.setSyncEnabled(true);
    log("device B system playlists", { ids: systemIds(b), playlists: b.listPlaylists() });
    await b.addToPlaylist(b.getSystemPlaylistId("favorites")!, mediaId);
    await waitFor("B favorite flushed", () => drained(b));
    log("device B after favorite", { favorites: favoritesOf(b), server: fake.dump() });
    b.close();

    log("phase: device A syncs");
    useDevice(rootA);
    const a2 = await LibraryDb.open(TOKEN, KEY);
    await a2.syncFromRemoteIfNewer(null);
    log("device A after sync", { favorites: favoritesOf(a2), playlists: a2.listPlaylists(), server: fake.dump() });
    expect(favoritesOf(a2)).toEqual({ id: "favorites", items: [mediaId] });
    a2.close();
  }, 60_000);

  it("two libraries diverged by an older build heal on open and keep both devices' favorites", async () => {
    const rootA = deviceRoot("a");
    const rootB = deviceRoot("b");

    log("phase: both devices hold the library and both titles");
    useDevice(rootA);
    const a = await LibraryDb.open(TOKEN, KEY);
    a.setSyncEnabled(true);
    const first = await a.addMediaFromTmdb(MOVIE);
    const second = await a.addMediaFromTmdb(MOVIE_2);
    await waitFor("A seed flushed", () => drained(a));
    a.close();
    useDevice(rootB);
    const b0 = await LibraryDb.open(TOKEN, KEY);
    log("device B joined", { media: b0.listMedia().map((m) => m.id), server: fake.dump() });
    b0.close();

    log("phase: an older build left each device its own random Favorites id and a favorite the other never got");
    const diverge = (root: string, label: string, ownId: string, mediaFavorited: string) =>
      editCore(root, label, (core) => {
        core.exec("DELETE FROM playlist_items;");
        core.query("UPDATE playlists SET id = ? WHERE slug = 'favorites';").run(ownId);
        core.query("UPDATE playlists SET id = ? WHERE slug = 'watchlist';").run(`${ownId}-watchlist`);
        core
          .query("INSERT INTO playlist_items (id, playlist_id, media_id, added_at) VALUES (?, ?, ?, ?);")
          .run(`${ownId}-item`, ownId, mediaFavorited, "2026-11-01T00:00:00.000Z");
      });
    diverge(rootA, "device A (phone)", "61c16101-phone", first);
    diverge(rootB, "device B (desktop)", "63725383-desktop", second);

    log("phase: device A updates and opens");
    useDevice(rootA);
    const a2 = await LibraryDb.open(TOKEN, KEY);
    a2.setSyncEnabled(true);
    await waitFor("A heal flushed", () => drained(a2));
    log("device A healed", { ids: systemIds(a2), favorites: favoritesOf(a2), server: fake.dump() });
    a2.close();

    log("phase: device B updates, opens and syncs");
    useDevice(rootB);
    const b = await LibraryDb.open(TOKEN, KEY);
    b.setSyncEnabled(true);
    await b.syncFromRemoteIfNewer(null);
    await waitFor("B heal flushed", () => drained(b));
    log("device B healed", { ids: systemIds(b), favorites: favoritesOf(b), server: fake.dump() });
    const expected = { id: "favorites", items: [first, second].sort() };
    expect(favoritesOf(b)).toEqual(expected);
    expect(systemIds(b)).toEqual({ favorites: "favorites", watchlist: "watchlist" });
    b.close();

    log("phase: device A syncs");
    useDevice(rootA);
    const a3 = await LibraryDb.open(TOKEN, KEY);
    await a3.syncFromRemoteIfNewer(null);
    log("device A after sync", { ids: systemIds(a3), favorites: favoritesOf(a3), server: fake.dump() });
    expect(favoritesOf(a3)).toEqual(expected);
    expect(systemIds(a3)).toEqual({ favorites: "favorites", watchlist: "watchlist" });
    a3.close();
  }, 60_000);
});
