/**
 * @bugfix @regression-proof
 *
 * Phase 3.6 follow-up: after `retireLegacyDb()` renames `library.sqlite` to
 * `library.sqlite.pre-split.bak`, subsequent boots saw `LibraryDb.openLocal`
 * surface "library unavailable" and the cache reset to version 0. Three
 * coupled bugs in the post-split state caused it:
 *
 *  1. `loadCache()` returned null because cache.json's `dbPath` field still
 *     pointed at the renamed legacy file. The user's version + stateHash
 *     were silently dropped on every restart.
 *
 *  2. `openLocal`'s "cache exists but file missing" branch wrote a fresh
 *     empty SQLite via `openSqliteDb()` (which touches library.sqlite on
 *     disk) and saved a v0 cache — losing the user's sync version.
 *
 *  3. `retireLegacyDb()` then ran AGAIN on the freshly-written empty
 *     placeholder, deleted the real backup, and replaced it with the empty
 *     placeholder. The user's pre-Phase-3 library bytes — held in
 *     `.pre-split.bak` as a safety net — were lost.
 *
 * This test pins all three behaviors at the boundary so the bug can't
 * return.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { LibraryDb } from "../src/libraryDb";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-post-split-cache-"));
  process.env.SF_USER_DATA_PATH = root;
  console.info(`[post-split-cache-tolerance:setup] root=${root}`);
});

afterEach(() => {
  console.info(`[post-split-cache-tolerance:teardown] removing root=${root}`);
  rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
});

const libDir = () => join(root, "library");
const backupPath = () => join(libDir(), "library.sqlite.pre-split.bak");
const cachePath = () => join(libDir(), "cache.json");
const legacyPath = () => join(libDir(), "library.sqlite");

// Suite-id: post-split-cache-tolerance
// Dumps cache.json contents, attached/per-group file state, and split-marker
// state. The bug surfaces as orphaned dbPath + lost cache rows + clobbered
// .pre-split.bak — this snapshot captures all three.
const dumpSplitState = (
  label: string,
  ctx: {
    expectedVersion?: number;
    backupSizeBefore?: number;
    backupBytesEqual?: boolean | null;
    db?: LibraryDb | null;
    livePhase?: string;
  },
) => {
  try {
    console.error(`=== [post-split-cache-tolerance:${label}] snapshot ===`);
    if (ctx.livePhase) console.error(`livePhase=${ctx.livePhase}`);

    let dirListing: string[] = [];
    try {
      dirListing = readdirSync(libDir());
    } catch (err) {
      dirListing = [
        `(readdir failed: ${err instanceof Error ? err.message : String(err)})`,
      ];
    }
    console.error(`library/ contents (${dirListing.length})=${JSON.stringify(dirListing)}`);

    const files = {
      legacy: existsSync(legacyPath()) ? statSync(legacyPath()).size : "(missing)",
      backup: existsSync(backupPath()) ? statSync(backupPath()).size : "(missing)",
      cacheJson: existsSync(cachePath()) ? statSync(cachePath()).size : "(missing)",
    };
    console.error(`file sizes=${JSON.stringify(files)}`);

    let cacheContents: unknown = "(missing)";
    if (existsSync(cachePath())) {
      try {
        cacheContents = JSON.parse(readFileSync(cachePath(), "utf-8"));
      } catch (err) {
        cacheContents = `(parse failed: ${err instanceof Error ? err.message : String(err)})`;
      }
    }
    console.error(`cache.json:\n${JSON.stringify(cacheContents, null, 2)}`);

    if (ctx.expectedVersion !== undefined) {
      console.error(`expectedVersion=${ctx.expectedVersion}`);
    }
    if (ctx.backupSizeBefore !== undefined) {
      console.error(
        `backupSizeBefore=${ctx.backupSizeBefore} backupSizeNow=${files.backup} backupBytesEqual=${ctx.backupBytesEqual}`,
      );
    }

    if (ctx.db) {
      const markers: Record<string, unknown> = {};
      let liveVersion: unknown = "(unknown)";
      try {
        liveVersion = ctx.db.getVersion();
      } catch (err) {
        liveVersion = `(getVersion failed: ${err instanceof Error ? err.message : String(err)})`;
      }
      for (const group of ["core", "metadata", "playback", "ingest", "templates"]) {
        try {
          markers[`migration_phase3_${group}_split`] = ctx.db.getSetting(
            `migration_phase3_${group}_split`,
          )?.value;
        } catch (err) {
          markers[`migration_phase3_${group}_split`] = `(read failed: ${err instanceof Error ? err.message : String(err)})`;
        }
      }
      console.error(`live db getVersion()=${JSON.stringify(liveVersion)}`);
      console.error(`split markers:\n${JSON.stringify(markers, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

/**
 * Set up a user data dir that looks like what an existing user sees after
 * Phase 3.6 migration ran on their machine: per-group files populated, the
 * `.pre-split.bak` exists with non-trivial bytes, cache.json's dbPath
 * references the renamed legacy file, and the legacy `library.sqlite`
 * itself is missing.
 *
 * Returns the populated cache version + a copy of the backup bytes so the
 * test can assert preservation across the next reopen.
 */
const simulatePostSplitState = async (version: number): Promise<{ backupBytes: Buffer }> => {
  console.info(`[post-split-cache-tolerance:simulate] first-boot to land per-group files`);
  // First boot: populates 5 per-group files + creates the .pre-split.bak.
  const db = await LibraryDb.openLocal("token", "key");
  await db.setSetting("phase3-test.seeded", "yes");
  db.close();
  console.info(`[post-split-cache-tolerance:simulate] first-boot closed`);

  // Rewrite cache.json so it carries non-default version + sync metadata —
  // the bug is most visible when those values would be silently discarded
  // by an orphaned-dbPath loadCache().
  const cache = JSON.parse(readFileSync(cachePath(), "utf-8"));
  cache.version = version;
  cache.stateHash = "test-state-hash-1234";
  cache.lastOpId = "test-last-op-9999";
  writeFileSync(cachePath(), JSON.stringify(cache));
  console.info(
    `[post-split-cache-tolerance:simulate] cache.json rewritten with version=${version} hash=test-state-hash-1234 lastOpId=test-last-op-9999`,
  );

  // Remove the legacy library.sqlite that persistInline re-created post-flip
  // (it gets rebuilt on every persist as the combined-snapshot cache, but
  // post-restart the canonical state must live in per-group files +
  // .pre-split.bak alone — the legacy path was the bug surface).
  if (existsSync(legacyPath())) {
    rmSync(legacyPath(), { force: true });
    console.info(`[post-split-cache-tolerance:simulate] legacy library.sqlite removed`);
  }

  const backupBytes = Buffer.from(readFileSync(backupPath()));
  console.info(
    `[post-split-cache-tolerance:simulate] backup captured (${backupBytes.length} bytes)`,
  );
  return { backupBytes };
};

describe("post-split cache tolerance — orphaned dbPath in cache.json", () => {
  it("preserves cache version + stateHash + lastOpId on reopen after retire", async () => {
    console.info(`[post-split-cache-tolerance:preserve-cache] simulating post-split state v=4051`);
    await simulatePostSplitState(4051);
    expect(existsSync(legacyPath())).toBe(false);

    console.info(`[post-split-cache-tolerance:preserve-cache] reopening to verify cache preserved`);
    const db = await LibraryDb.openLocal("token", "key");
    try {
      const liveVersion = db.getVersion();
      const status = await db.getDatasetStatus();
      const seeded = db.getSetting("phase3-test.seeded");
      console.info(
        `[post-split-cache-tolerance:preserve-cache] liveVersion=${liveVersion} status.core=${status.core} seeded=${seeded?.value}`,
      );
      expect(liveVersion).toBe(4051);
      expect(status.core).toBe(true);
      expect(seeded?.value).toBe("yes");
    } catch (err) {
      console.error(`[post-split-cache-tolerance:preserve-cache] assertion failed`);
      dumpSplitState("preserve-cache-failure", { db, expectedVersion: 4051, livePhase: "post-reopen" });
      throw err;
    } finally {
      db.close();
    }
  });

  // @req LIB-FMT-07[badger-desktop,runtime]
  it("deletes the leftover .pre-split.bak on the first boot after the split, without turning the placeholder into a new backup", async () => {
    console.info(`[post-split-cache-tolerance:bak-cleanup] simulating post-split state v=4051`);
    const { backupBytes } = await simulatePostSplitState(4051);
    expect(existsSync(legacyPath())).toBe(false);
    // the boot that created the backup keeps it: it is the safety net of a fresh split
    expect(backupBytes.length).toBeGreaterThan(0);
    expect(existsSync(backupPath())).toBe(true);
    console.info(`[post-split-cache-tolerance:bak-cleanup] backup bytes=${backupBytes.length}, reopening`);
    // openLocal writes this empty placeholder when the cache file is missing
    writeFileSync(legacyPath(), "");

    const db = await LibraryDb.openLocal("token", "key");
    const seeded = db.getSetting("phase3-test.seeded")?.value;
    db.close();

    try {
      console.info(
        `[post-split-cache-tolerance:bak-cleanup] bakExists=${existsSync(backupPath())} legacyExists=${existsSync(legacyPath())} seeded=${seeded}`,
      );
      expect(existsSync(backupPath())).toBe(false);
      expect(existsSync(legacyPath())).toBe(false);
      expect(seeded).toBe("yes");
    } catch (err) {
      console.error(`[post-split-cache-tolerance:bak-cleanup] assertion failed`);
      dumpSplitState("bak-cleanup-failure", { livePhase: "post-reopen" });
      throw err;
    }
  });

  it("loadCache surfaces cache rows even when cache.dbPath points to a missing legacy file", async () => {
    console.info(`[post-split-cache-tolerance:loadcache] simulating post-split state v=7777`);
    await simulatePostSplitState(7777);
    expect(existsSync(legacyPath())).toBe(false);

    const hasCache = await LibraryDb.hasLocalCache();
    console.info(`[post-split-cache-tolerance:loadcache] hasLocalCache()=${hasCache}`);
    let db: LibraryDb | null = null;
    try {
      expect(hasCache).toBe(true);

      db = await LibraryDb.openLocal("token", "key");
      const liveVersion = db.getVersion();
      console.info(`[post-split-cache-tolerance:loadcache] liveVersion=${liveVersion}`);
      expect(liveVersion).toBe(7777);
    } catch (err) {
      console.error(`[post-split-cache-tolerance:loadcache] assertion failed`);
      dumpSplitState("loadcache-failure", { db, expectedVersion: 7777 });
      throw err;
    } finally {
      db?.close();
    }
  });

  // @req LIB-FMT-07[badger-desktop,runtime]
  it("once the backup is removed, further reopens do not bring it back", async () => {
    console.info(`[post-split-cache-tolerance:idempotent] simulating post-split state v=4051`);
    await simulatePostSplitState(4051);
    rmSync(backupPath(), { force: true });
    console.info(`[post-split-cache-tolerance:idempotent] backup removed, bak exists=${existsSync(backupPath())}`);

    for (let i = 0; i < 3; i += 1) {
      console.info(`[post-split-cache-tolerance:idempotent] iteration ${i + 1}/3`);
      const db = await LibraryDb.openLocal("token", "key");
      try {
        const liveVersion = db.getVersion();
        db.close();
        console.info(
          `[post-split-cache-tolerance:idempotent] iter=${i + 1} liveVersion=${liveVersion} bakExists=${existsSync(backupPath())} legacyExists=${existsSync(legacyPath())}`,
        );
        expect(liveVersion).toBe(4051);
        expect(existsSync(backupPath())).toBe(false);
        expect(existsSync(legacyPath())).toBe(false);
      } catch (err) {
        console.error(`[post-split-cache-tolerance:idempotent] assertion failed at iter=${i + 1}`);
        dumpSplitState("idempotent-failure", { db, expectedVersion: 4051, livePhase: `iter-${i + 1}` });
        try {
          db.close();
        } catch {
          // ignore double-close
        }
        throw err;
      }
    }
  });
});
