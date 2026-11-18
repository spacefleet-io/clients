/**
 * @test-id LIB-ACCOUNT-ISOLATION-001
 * @level integration (real LibraryDb.open, bun:sqlite, fake API per server + account)
 * @bugfix @regression-proof
 * @req LIB-STORE-06
 *
 * Badger desktop kept ONE flat `library/` dir per userData dir, shared by every account and (with the shared dev /
 * release userData) every API server. `pickBlob` preferred any local cache at or ahead of the server's version, so:
 * - account B, signing in after A on the same computer, opened A's library and later pushed it into B's account;
 * - a dev build's library (local API, higher version) opened instead of the release server's library.
 * The library now lives in `library/<server>/<userId>/` stamped with `owner.json`; a cache that is ahead of the
 * server, or at its version with another last op, is another lineage and is set aside; the old flat dir is adopted
 * only when its cache matches the server head exactly, else moved to `_orphaned-<ts>/`; sign-out removes the dir.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import * as realApi from "../src/api";
import type { LibraryMeta } from "../src/api";

const SUITE = "library-account-isolation";
const log = (phase: string, data?: unknown) =>
  console.info(`[${SUITE}:${phase}]${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

// ---------------------------------------------------------------------------
// Fake API: one library per (API origin, token), like one account on one server.
// ---------------------------------------------------------------------------
type FakeServer = {
  exists: boolean;
  version: number;
  snapshotVersion: number;
  stateHash: string | null;
  lastOpId: string | null;
  manifestKey: string | null;
  snapshotId: string | null;
  ops: Array<{ version: number; opId: string; payloadCiphertext: string; createdAt: string }>;
  objects: Map<string, Uint8Array>;
  calls: string[];
};

const servers = new Map<string, FakeServer>();
const serverKey = (token: string) => `${process.env.SF_API_BASE_URL ?? "default"}|${token}`;
const serverFor = (token: string): FakeServer => {
  const key = serverKey(token);
  let server = servers.get(key);
  if (!server) {
    server = {
      exists: false,
      version: 0,
      snapshotVersion: 0,
      stateHash: null,
      lastOpId: null,
      manifestKey: null,
      snapshotId: null,
      ops: [],
      objects: new Map(),
      calls: [],
    };
    servers.set(key, server);
  }
  return server;
};
const dumpServer = (token: string) => {
  const server = serverFor(token);
  return {
    key: serverKey(token),
    exists: server.exists,
    version: server.version,
    snapshotVersion: server.snapshotVersion,
    lastOpId: server.lastOpId,
    opVersions: server.ops.map((op) => op.version),
    lastCalls: server.calls.slice(-12),
  };
};
const metaOf = (server: FakeServer): LibraryMeta => ({
  exists: server.exists,
  bootstrapRequired: !server.exists,
  syncUnavailable: false,
  version: server.version,
  snapshotVersion: server.snapshotVersion,
  hash: null,
  stateHash: server.stateHash,
  lastOpId: server.lastOpId,
  consistency: server.exists ? "ok" : "missing_snapshot",
  updatedAt: new Date().toISOString(),
  keyProbe: null,
  keyProbeUpdatedAt: null,
  blobEncoding: "binary",
  snapshotId: server.snapshotId,
  manifestKey: server.manifestKey,
  chunkSize: null,
  snapshotHistory: [],
  opsHistory: [],
  storageFormatVersion: 1,
  opStreamVersion: 1,
});
const conflict = (server: FakeServer) => new realApi.ApiError(409, { error: "version_conflict", version: server.version });

// mock.module is process-global in a bun test run: restore the real exports afterwards.
const originalApi = { ...realApi };
afterAll(() => {
  mock.module("../src/api", () => originalApi);
});

mock.module("../src/api", () => ({
  ...originalApi,
  getLibraryMeta: async (token: string) => {
    const server = serverFor(token);
    server.calls.push(`getLibraryMeta -> v=${server.version}`);
    return metaOf(server);
  },
  getLibraryDb: async (token: string) => {
    const server = serverFor(token);
    server.calls.push(`getLibraryDb -> snapshotVersion=${server.snapshotVersion}`);
    return {
      exists: server.exists,
      version: server.version,
      snapshotVersion: server.snapshotVersion,
      hash: null,
      manifestKey: server.manifestKey,
      updatedAt: new Date().toISOString(),
      blobEncoding: "binary" as const,
      snapshotId: server.snapshotId,
      chunkSize: null,
    };
  },
  getLibraryOps: async (token: string, since: number) => {
    const server = serverFor(token);
    const history = server.ops.filter((op) => op.version > server.snapshotVersion);
    const minVersion = history.length ? Math.min(...history.map((op) => op.version)) : server.snapshotVersion;
    const tooOld = since < Math.max(server.snapshotVersion, minVersion - 1);
    const ops = tooOld ? [] : history.filter((op) => op.version > since);
    server.calls.push(`getLibraryOps since=${since} -> ${tooOld ? "tooOld" : ops.length}`);
    return {
      version: server.version,
      snapshotVersion: server.snapshotVersion,
      tooOld,
      ops: ops.map((op) => ({ ...op, objectKey: `library/ops/${op.opId}`, size: 0 })),
      storageFormatVersion: 1,
      opStreamVersion: 1,
    };
  },
  putLibraryOp: async (
    token: string,
    baseVersion: number,
    opId: string,
    payload: Uint8Array,
    lineage?: { prevStateHash?: string | null; nextStateHash?: string | null }
  ) => {
    const server = serverFor(token);
    if (baseVersion !== server.version) {
      server.calls.push(`putLibraryOp base=${baseVersion} -> 409 current=${server.version}`);
      throw conflict(server);
    }
    server.version += 1;
    server.stateHash = lineage?.nextStateHash ?? server.stateHash;
    server.lastOpId = opId;
    server.ops.push({
      version: server.version,
      opId,
      payloadCiphertext: Buffer.from(payload).toString("base64"),
      createdAt: new Date().toISOString(),
    });
    server.calls.push(`putLibraryOp -> v=${server.version}`);
    return { version: server.version, snapshotVersion: server.snapshotVersion, stateHash: server.stateHash, lastOpId: opId };
  },
  putLibraryDb: async (
    token: string,
    expectedVersion: number,
    manifestBase64: string,
    snapshotId: string,
    _chunkSize: number,
    _keyProbe?: string | null,
    _force?: boolean,
    stateHash?: string | null,
    lastOpId?: string | null
  ) => {
    const server = serverFor(token);
    if (expectedVersion !== server.version) {
      server.calls.push(`putLibraryDb expected=${expectedVersion} -> 409 current=${server.version}`);
      throw conflict(server);
    }
    server.version += 1;
    server.snapshotVersion = server.version;
    server.exists = true;
    server.snapshotId = snapshotId;
    server.manifestKey = `library/manifests/${snapshotId}`;
    server.objects.set(server.manifestKey, new TextEncoder().encode(manifestBase64));
    server.stateHash = stateHash ?? server.stateHash ?? `snap-${snapshotId}`;
    server.lastOpId = lastOpId ?? server.lastOpId;
    server.calls.push(`putLibraryDb -> v=${server.version}`);
    return { version: server.version, stateHash: server.stateHash, lastOpId: server.lastOpId, snapshotVersion: server.version };
  },
  uploadStorageObjectViaTunnel: async (token: string, objectKey: string, payload: Uint8Array) => {
    serverFor(token).objects.set(objectKey, Uint8Array.from(payload));
    return { ok: true };
  },
  downloadStorageObjectViaTunnel: async (token: string, objectKey: string) => {
    const bytes = serverFor(token).objects.get(objectKey);
    if (!bytes) throw new realApi.ApiError(404, { error: "not_found" });
    return bytes;
  },
  listStorageObjects: async (token: string) => ({ keys: [...serverFor(token).objects.keys()] }),
  deleteStorageObjects: async (token: string, keys: string[]) => {
    for (const key of keys) serverFor(token).objects.delete(key);
    return { deleted: keys.length };
  },
}));

// Dynamic import on purpose: libraryDb must load AFTER mock.module so its `./api` bindings resolve to the fake.
const { LibraryDb } = await import("../src/libraryDb");
const { accountLibraryDir, resetLibraryOwnersForTests } = await import("../src/libraryAccount");
type Db = typeof LibraryDb.prototype;

const DEV_API = "http://127.0.0.1:3001";
const RELEASE_API = "https://api.release.test";
const ACCOUNT_A = { token: "token-account-a", key: randomBytes(32).toString("base64"), userId: "user-a" };
const ACCOUNT_B = { token: "token-account-b", key: randomBytes(32).toString("base64"), userId: "user-b" };
let root = "";

const libraryRoot = () => join(root, "library");
const listTree = (dir: string, prefix = ""): string[] => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listTree(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]
  );
};
const titlesOf = (db: Db) => db.listMedia().map((media) => media.title).sort();
const syncStateOf = (db: Db) => db as unknown as { pendingOps: unknown[]; opsFlushInFlight: boolean }; // test-only peek

// LibraryDb uploads ops on its own real debounce setTimeout inside the module under test: poll an explicit condition.
const waitFor = async (label: string, predicate: () => boolean, timeoutMs = 10_000) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      log(`waitFor:timeout ${label}`);
      throw new Error(`waitFor timeout: ${label}`);
    }
    await Bun.sleep(10);
  }
  log(`waitFor:ok ${label}`, { ms: Date.now() - started });
};

const addMovie = async (db: Db, id: number, title: string) => {
  db.setSyncEnabled(true);
  const mediaId = await db.addMediaFromTmdb({
    id,
    type: "movie",
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
  await waitFor(`ops of "${title}" uploaded`, () => {
    const internals = syncStateOf(db);
    return internals.pendingOps.length === 0 && !internals.opsFlushInFlight;
  });
  return mediaId;
};

/** Give `account` a library holding `titles` on the current server, written from a throwaway userData dir. */
const seedServerLibrary = async (account: typeof ACCOUNT_A, titles: string[]) => {
  const seedRoot = mkdtempSync(join(tmpdir(), "sf-account-isolation-seed-"));
  const previous = process.env.SF_USER_DATA_PATH;
  process.env.SF_USER_DATA_PATH = seedRoot;
  try {
    const db = await LibraryDb.open(account.token, account.key);
    for (const [index, title] of titles.entries()) await addMovie(db, 90_000 + index, title);
    db.close();
  } finally {
    process.env.SF_USER_DATA_PATH = previous;
    rmSync(seedRoot, { recursive: true, force: true });
  }
  log("seed:server", { userId: account.userId, titles, server: dumpServer(account.token) });
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-account-isolation-"));
  process.env.SF_USER_DATA_PATH = root;
  process.env.SF_API_BASE_URL = RELEASE_API;
  servers.clear();
  resetLibraryOwnersForTests();
  log("setup", { root });
});

afterEach(() => {
  log("teardown", { root, tree: listTree(libraryRoot()) });
  rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
  delete process.env.SF_API_BASE_URL;
  resetLibraryOwnersForTests();
});

describe(`[${SUITE}] one library dir per server and account`, () => {
  it("@bugfix @regression-proof account B signing in after A sees none of A's library and pushes none of it", async () => {
    await seedServerLibrary(ACCOUNT_B, ["B Movie"]);

    log("phase:account-a open + add two movies");
    const a = await LibraryDb.open(ACCOUNT_A.token, ACCOUNT_A.key, { userId: ACCOUNT_A.userId });
    await addMovie(a, 1001, "A Movie One");
    await addMovie(a, 1002, "A Movie Two");
    log("phase:account-a state", { titles: titlesOf(a), server: dumpServer(ACCOUNT_A.token), tree: listTree(libraryRoot()) });
    a.close();

    log("phase:account-b open (A's cache v3 is ahead of B's server v2)");
    const b = await LibraryDb.open(ACCOUNT_B.token, ACCOUNT_B.key, { userId: ACCOUNT_B.userId });
    const bTitles = titlesOf(b);
    log("phase:account-b state", { titles: bTitles, server: dumpServer(ACCOUNT_B.token), tree: listTree(libraryRoot()) });
    b.close();

    expect(bTitles).toEqual(["B Movie"]);
    expect(existsSync(join(accountLibraryDir({ apiOrigin: RELEASE_API, userId: ACCOUNT_A.userId }, libraryRoot()), "cache.json"))).toBe(true);
    expect(existsSync(join(accountLibraryDir({ apiOrigin: RELEASE_API, userId: ACCOUNT_B.userId }, libraryRoot()), "cache.json"))).toBe(true);
  }, 30_000);

  it("@bugfix @regression-proof a brand-new account B opens an empty library, not A's", async () => {
    log("phase:account-a open + add a movie");
    const a = await LibraryDb.open(ACCOUNT_A.token, ACCOUNT_A.key, { userId: ACCOUNT_A.userId });
    await addMovie(a, 2001, "A Only");
    a.close();

    log("phase:account-b first sign-in (server has no library for B)");
    const b = await LibraryDb.open(ACCOUNT_B.token, ACCOUNT_B.key, { userId: ACCOUNT_B.userId });
    const bTitles = titlesOf(b);
    log("phase:account-b state", { titles: bTitles, server: dumpServer(ACCOUNT_B.token), tree: listTree(libraryRoot()) });
    b.close();
    expect(bTitles).toEqual([]);
  }, 30_000);

  it("@bugfix @regression-proof sign-out removes that account's library files and leaves the other account's", async () => {
    const a = await LibraryDb.open(ACCOUNT_A.token, ACCOUNT_A.key, { userId: ACCOUNT_A.userId });
    await addMovie(a, 3001, "A Signed Out");
    a.close();
    const b = await LibraryDb.open(ACCOUNT_B.token, ACCOUNT_B.key, { userId: ACCOUNT_B.userId });
    b.close();

    log("phase:sign-out account A", { before: listTree(libraryRoot()) });
    await LibraryDb.clearLocalCache({ userId: ACCOUNT_A.userId });
    const after = listTree(libraryRoot());
    log("phase:after sign-out", { after });
    expect(existsSync(accountLibraryDir({ apiOrigin: RELEASE_API, userId: ACCOUNT_A.userId }, libraryRoot()))).toBe(false);
    expect(existsSync(join(accountLibraryDir({ apiOrigin: RELEASE_API, userId: ACCOUNT_B.userId }, libraryRoot()), "cache.json"))).toBe(true);
  }, 30_000);
});

describe(`[${SUITE}] a cache from another server is never picked`, () => {
  it("@bugfix @regression-proof a dev server's cache, ahead of the release server, is set aside and the release library opens", async () => {
    process.env.SF_API_BASE_URL = RELEASE_API;
    await seedServerLibrary(ACCOUNT_A, ["Release Movie"]);

    log("phase:dev build opens A on the dev API and adds three movies");
    process.env.SF_API_BASE_URL = DEV_API;
    const dev = await LibraryDb.open(ACCOUNT_A.token, ACCOUNT_A.key, { userId: ACCOUNT_A.userId });
    await addMovie(dev, 4001, "Dev One");
    await addMovie(dev, 4002, "Dev Two");
    await addMovie(dev, 4003, "Dev Three");
    log("phase:dev state", { titles: titlesOf(dev), dev: dumpServer(ACCOUNT_A.token) });
    dev.close();

    log("phase:release build opens A on the release API");
    process.env.SF_API_BASE_URL = RELEASE_API;
    const releaseCallsBefore = serverFor(ACCOUNT_A.token).calls.length;
    const release = await LibraryDb.open(ACCOUNT_A.token, ACCOUNT_A.key, { userId: ACCOUNT_A.userId });
    const titles = titlesOf(release);
    log("phase:release state", { titles, release: dumpServer(ACCOUNT_A.token), tree: listTree(libraryRoot()) });
    release.close();

    expect(titles).toEqual(["Release Movie"]);
    // The release server got nothing from the dev library.
    const releaseWrites = serverFor(ACCOUNT_A.token).calls.slice(releaseCallsBefore).filter((call) => call.startsWith("put"));
    log("phase:release writes after open", { releaseWrites });
    expect(releaseWrites).toEqual([]);
  }, 30_000);
});

describe(`[${SUITE}] the old flat library dir is migrated once`, () => {
  /** Write a library in the pre-LIB-STORE-06 flat `library/` dir (open without an account). */
  const writeFlatLibrary = async (titles: string[]) => {
    const flat = await LibraryDb.open(ACCOUNT_A.token, ACCOUNT_A.key);
    for (const [index, title] of titles.entries()) await addMovie(flat, 5000 + index, title);
    flat.close();
    resetLibraryOwnersForTests();
    log("seed:flat", { titles, tree: listTree(libraryRoot()), server: dumpServer(ACCOUNT_A.token) });
  };

  it("@bugfix @regression-proof adopts the flat dir when its cache matches the server head", async () => {
    await writeFlatLibrary(["Flat Kept"]);
    const serverVersion = serverFor(ACCOUNT_A.token).version;

    const db = await LibraryDb.open(ACCOUNT_A.token, ACCOUNT_A.key, { userId: ACCOUNT_A.userId });
    const titles = titlesOf(db);
    const tree = listTree(libraryRoot());
    log("phase:after adopt", { titles, tree, server: dumpServer(ACCOUNT_A.token) });
    db.close();

    const accountDir = accountLibraryDir({ apiOrigin: RELEASE_API, userId: ACCOUNT_A.userId }, libraryRoot());
    expect(titles).toEqual(["Flat Kept"]);
    expect(existsSync(join(libraryRoot(), "cache.json"))).toBe(false);
    expect(existsSync(join(accountDir, "cache.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(accountDir, "owner.json"), "utf8"))).toEqual({
      apiOrigin: RELEASE_API,
      userId: ACCOUNT_A.userId,
    });
    expect(tree.some((path) => path.startsWith("_orphaned-"))).toBe(false);
    expect(serverFor(ACCOUNT_A.token).version).toBe(serverVersion);
  }, 30_000);

  it("@bugfix @regression-proof moves the flat dir to _orphaned-<ts> when it is not this server's library", async () => {
    process.env.SF_API_BASE_URL = DEV_API;
    await writeFlatLibrary(["Dev Flat One", "Dev Flat Two"]);

    process.env.SF_API_BASE_URL = RELEASE_API;
    await seedServerLibrary(ACCOUNT_A, ["Release Only"]);

    const callsBefore = serverFor(ACCOUNT_A.token).calls.length;
    const db = await LibraryDb.open(ACCOUNT_A.token, ACCOUNT_A.key, { userId: ACCOUNT_A.userId });
    const titles = titlesOf(db);
    const tree = listTree(libraryRoot());
    log("phase:after orphan", { titles, tree, server: dumpServer(ACCOUNT_A.token) });
    db.close();

    expect(titles).toEqual(["Release Only"]);
    expect(existsSync(join(libraryRoot(), "cache.json"))).toBe(false);
    const orphaned = tree.filter((path) => path.startsWith("_orphaned-"));
    expect(orphaned.some((path) => path.endsWith("/cache.json"))).toBe(true);
    expect(orphaned.some((path) => path.endsWith("/reason.json"))).toBe(true);
    expect(serverFor(ACCOUNT_A.token).calls.slice(callsBefore).filter((call) => call.startsWith("put"))).toEqual([]);
  }, 30_000);
});
