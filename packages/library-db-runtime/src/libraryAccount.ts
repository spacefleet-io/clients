/**
 * LIB-STORE-06: the library files on this computer belong to one server and one account.
 *
 * Layout under `<userData>/library`:
 *   <sha256(apiOrigin)[:16]>/<userId>/   one account's library (owner.json, cache.json, library.*.sqlite, pending files)
 *   _orphaned-<ts>/                      files set aside because nothing proved whose they were
 *
 * Before this layout every account and every server (dev and prod builds shared the userData dir) used the one flat
 * `library/` dir: a new account opened the previous account's library and pushed it into its own, and a cache from
 * another server could look "ahead" of this server's library and win over it.
 *
 * `selectLibraryOwner` is called by `LibraryDb.open` / `openLocal` with the signed-in account. Until an owner is
 * selected for the current userData dir the flat dir is used (embedders that hold one account and tests); the desktop
 * runtime always selects one (`badger.db.open` carries the user id).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getApiBaseUrl } from "./apiHost";
import { scopeLogger } from "./logger";
import { getUserDataPath } from "./userDataPath";

const logger = scopeLogger("library-account");

/** Whose library a dir holds: the API server's origin and the account id on that server. */
export type LibraryOwner = { apiOrigin: string; userId: string };

/** The signed-in account a caller opens the library for; the server is the one this process talks to. */
export type LibraryAccount = { userId: string };

export const libraryOwnerFor = (account: LibraryAccount): LibraryOwner => ({
  apiOrigin: getApiBaseUrl(),
  userId: account.userId.trim(),
});

export const LIBRARY_OWNER_FILE = "owner.json";
const ORPHANED_DIR_PREFIX = "_orphaned-";

/** The dir holds another account's (or server's) library: opening it would mix two libraries. */
export class LibraryOwnerMismatchError extends Error {
  readonly code = "LIBRARY_OWNER_MISMATCH";
  constructor(
    readonly dir: string,
    readonly expected: LibraryOwner,
    readonly found: LibraryOwner | null,
  ) {
    super("LIBRARY_OWNER_MISMATCH");
    this.name = "LibraryOwnerMismatchError";
  }
}

const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");

/** `<userData>/library`: the root of every account dir (and the flat dir of the old layout). */
export const libraryRootDir = () => join(getUserDataPath(), "library");

/** The server part of an account dir: a short hash, so an origin (`https://host:port`) never becomes a path. */
export const serverDirName = (apiOrigin: string) => sha256Hex(apiOrigin).slice(0, 16);

const SAFE_USER_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
/** User ids are uuids; anything that could not be a plain dir name is hashed instead. */
export const userDirName = (userId: string) => (SAFE_USER_ID.test(userId) ? userId : `u-${sha256Hex(userId).slice(0, 32)}`);

export const accountLibraryDir = (owner: LibraryOwner, root = libraryRootDir()) =>
  join(root, serverDirName(owner.apiOrigin), userDirName(owner.userId));

/** The selected owner per userData dir (the e2e harness switches `SF_USER_DATA_PATH` between clients). */
const activeOwners = new Map<string, LibraryOwner>();

export const getActiveLibraryOwner = (): LibraryOwner | null => activeOwners.get(getUserDataPath()) ?? null;

/** Where the library files live now: the selected account's dir, else the flat root. */
export const libraryDir = () => {
  const owner = getActiveLibraryOwner();
  return owner ? accountLibraryDir(owner) : libraryRootDir();
};

const sameOwner = (a: LibraryOwner, b: LibraryOwner) => a.apiOrigin === b.apiOrigin && a.userId === b.userId;

export const readLibraryOwner = (dir: string): LibraryOwner | null => {
  const file = join(dir, LIBRARY_OWNER_FILE);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<LibraryOwner>;
    if (typeof parsed.apiOrigin !== "string" || typeof parsed.userId !== "string") return null;
    return { apiOrigin: parsed.apiOrigin, userId: parsed.userId };
  } catch {
    return null;
  }
};

/** Whether the selected account dir is stamped with exactly `owner` (false in the flat layout). */
export const libraryDirOwnedBy = (owner: LibraryOwner) => {
  const found = readLibraryOwner(accountLibraryDir(owner));
  return found !== null && sameOwner(found, owner);
};

/**
 * Make `owner`'s dir the library dir of this userData dir. Creates the dir and its `owner.json`; throws
 * {@link LibraryOwnerMismatchError} (and selects nothing) when the dir is stamped with another owner or its
 * `owner.json` is unreadable while library files are present.
 */
export const selectLibraryOwner = (owner: LibraryOwner): LibraryOwner => {
  if (!owner.userId.trim()) throw new Error("LIBRARY_OWNER_USER_ID_MISSING");
  const dir = accountLibraryDir(owner);
  mkdirSync(dir, { recursive: true });
  const found = readLibraryOwner(dir);
  if (found && !sameOwner(found, owner)) {
    logger.error({ event: "library_owner_mismatch", dir, expected: owner, found });
    throw new LibraryOwnerMismatchError(dir, owner, found);
  }
  if (!found) {
    const strayFiles = listFiles(dir);
    if (strayFiles.length > 0) {
      logger.error({ event: "library_owner_missing", dir, expected: owner, files: strayFiles });
      throw new LibraryOwnerMismatchError(dir, owner, null);
    }
    writeFileSync(join(dir, LIBRARY_OWNER_FILE), JSON.stringify(owner));
  }
  const previous = getActiveLibraryOwner();
  activeOwners.set(getUserDataPath(), owner);
  logger.info({ event: "library_owner_selected", dir, owner, previous });
  return owner;
};

/** Files (not dirs) directly in `dir`. */
const listFiles = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => {
    try {
      return statSync(join(dir, name)).isFile();
    } catch {
      return false;
    }
  });
};

/** Move `names` from `fromDir` into a fresh `<root>/_orphaned-<ts>/` and return that dir. */
const moveAside = (fromDir: string, names: string[], reason: string): string => {
  const root = libraryRootDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let target = join(root, `${ORPHANED_DIR_PREFIX}${stamp}`);
  for (let n = 1; existsSync(target); n += 1) target = join(root, `${ORPHANED_DIR_PREFIX}${stamp}-${n}`);
  mkdirSync(target, { recursive: true });
  for (const name of names) renameSync(join(fromDir, name), join(target, name));
  writeFileSync(join(target, "reason.json"), JSON.stringify({ reason, from: fromDir, movedAt: new Date().toISOString() }));
  return target;
};

/**
 * Set the current library dir's files aside (`owner.json` stays): the cache in it cannot be this server's library,
 * so the remote library must open on an empty dir instead of under the old per-group files (whose split marker would
 * keep them in place). Returns the dir they went to, or null when there was nothing to move.
 */
export const setAsideLibraryFiles = (reason: string): string | null => {
  const dir = libraryDir();
  const names = listFiles(dir).filter((name) => name !== LIBRARY_OWNER_FILE);
  if (names.length === 0) return null;
  const target = moveAside(dir, names, reason);
  logger.warn({ event: "library_files_set_aside", reason, from: dir, to: target, files: names });
  return target;
};

/** Remove `owner`'s whole library dir (sign-out). */
export const removeAccountLibrary = (owner: LibraryOwner) => {
  const dir = accountLibraryDir(owner);
  const existed = existsSync(dir);
  rmSync(dir, { recursive: true, force: true });
  const active = getActiveLibraryOwner();
  if (active && sameOwner(active, owner)) activeOwners.delete(getUserDataPath());
  logger.info({ event: "library_account_removed", dir, existed, owner });
};

/** Remove every file of the flat dir (no account selected); account dirs and set-aside dirs are left alone. */
export const removeFlatLibraryFiles = () => {
  const root = libraryRootDir();
  const names = listFiles(root);
  for (const name of names) rmSync(join(root, name), { force: true });
  logger.info({ event: "flat_library_removed", root, files: names });
};

/** The server's view of a library, as far as the migration needs it (`GET /library/db/meta`). */
export type LibraryMetaHead = {
  exists: boolean;
  bootstrapRequired: boolean;
  version: number;
  lastOpId: string | null;
  stateHash: string | null;
};

export type FlatLibraryMigration =
  | { outcome: "none" }
  | { outcome: "deferred"; files: string[] }
  | { outcome: "adopted"; to: string; files: string[] }
  | { outcome: "orphaned"; to: string; files: string[]; reason: string };

type FlatCache = { version?: unknown; lastOpId?: unknown; stateHash?: unknown; apiOrigin?: unknown };

const readFlatCache = (root: string): FlatCache | null => {
  try {
    const parsed = JSON.parse(readFileSync(join(root, "cache.json"), "utf8")) as FlatCache;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
};

const textOrNull = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

/**
 * Why the flat library cannot be proved to be `owner`'s library on this server (null: it can). The old layout
 * recorded no owner, so the only proof is the lineage: no other server stamped on the cache, and its last
 * server-confirmed op is the server's head op. cache.json's version also counts this device's unsent changes, so it
 * may be ahead of the server, never behind; the state hash is compared when the versions are equal.
 */
const flatLibraryMismatch = (cache: FlatCache | null, meta: LibraryMetaHead, owner: LibraryOwner): string | null => {
  if (!meta.exists) return "server_has_no_library";
  if (!cache) return "no_cache";
  const cacheOrigin = textOrNull(cache.apiOrigin);
  if (cacheOrigin && cacheOrigin !== owner.apiOrigin) return "other_server";
  const cacheVersion = Number(cache.version);
  if (!(cacheVersion >= meta.version)) return `version_${String(cache.version)}_behind_${meta.version}`;
  if (textOrNull(cache.lastOpId) !== textOrNull(meta.lastOpId)) return "last_op_differs";
  const cacheHash = textOrNull(cache.stateHash);
  const metaHash = textOrNull(meta.stateHash);
  if (cacheVersion === meta.version && cacheHash && metaHash && cacheHash.toLowerCase() !== metaHash.toLowerCase()) {
    return "state_hash_differs";
  }
  return null;
};

/**
 * One-time move of the old flat `library/` files (LIB-STORE-06). Adopted into `owner`'s dir only when the flat
 * cache stands on this server's library head (see `flatLibraryMismatch`) and the account dir holds no library yet;
 * otherwise set aside under `_orphaned-<ts>/` (kept, never deleted) so the account opens from the server. Without a
 * server head (offline open, snapshot unavailable) nothing is decided: the flat files stay until an online open can
 * check them, and the account dir starts empty.
 */
export const migrateFlatLibrary = (owner: LibraryOwner, meta: LibraryMetaHead | null): FlatLibraryMigration => {
  const root = libraryRootDir();
  const files = listFiles(root);
  if (files.length === 0) return { outcome: "none" };
  // Offline, or the server holds this account's library but cannot serve it now (missing snapshot): no head to
  // compare, so nothing is decided yet.
  if (!meta || (!meta.exists && !meta.bootstrapRequired)) {
    logger.info({ event: "flat_library_migration_deferred", root, files, metaExists: meta?.exists ?? null });
    return { outcome: "deferred", files };
  }
  const target = accountLibraryDir(owner, root);
  const cache = readFlatCache(root);
  const occupied = existsSync(join(target, "library.core.sqlite")) || existsSync(join(target, "cache.json"));
  const reason = occupied ? "account_dir_has_library" : flatLibraryMismatch(cache, meta, owner);
  const context = {
    root,
    owner,
    cacheVersion: cache?.version ?? null,
    cacheLastOpId: cache?.lastOpId ?? null,
    metaExists: meta.exists,
    metaVersion: meta.version,
    metaLastOpId: meta.lastOpId,
    files,
  };
  if (reason) {
    const to = moveAside(root, files, reason);
    logger.warn({ event: "flat_library_orphaned", reason, to, ...context });
    return { outcome: "orphaned", to, files, reason };
  }
  mkdirSync(target, { recursive: true });
  for (const name of files) renameSync(join(root, name), join(target, name));
  // The adopted files are proved to be this owner's: stamp them, or `selectLibraryOwner` refuses an unstamped dir.
  if (!existsSync(join(target, LIBRARY_OWNER_FILE))) writeFileSync(join(target, LIBRARY_OWNER_FILE), JSON.stringify(owner));
  logger.info({ event: "flat_library_adopted", to: target, ...context });
  return { outcome: "adopted", to: target, files };
};

/** Test seam: forget every selected owner (each test starts with the flat layout, like a fresh process). */
export const resetLibraryOwnersForTests = () => {
  activeOwners.clear();
};
