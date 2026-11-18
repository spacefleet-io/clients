/**
 * @bugfix @regression-proof — #25 WAL sidecar safety for the library files.
 *
 * The per-group library files run in WAL + synchronous=NORMAL (see
 * library-open-no-fsync-per-commit.test.ts). A WAL database lives in THREE
 * files: `<path>`, `<path>-wal`, `<path>-shm`. Any code that deletes,
 * replaces or reads the bytes of `<path>` alone can lose or resurrect rows:
 *
 * 1. Remote snapshot replace (applyRemoteSnapshot) closes the group handles,
 *    deletes the files and recreates them at the same names. bun:sqlite's
 *    close() is sqlite3_close_v2: while drizzle's prepared statements live
 *    the old connection stays open with its -wal/-shm on disk, so the delete
 *    must take the sidecars too. When GC finally closes that zombie, SQLite
 *    sees its db file was unlinked and does NOT delete `<path>-wal`/`-shm` by
 *    name (they now belong to the new files). Guard test: the new files keep
 *    their sidecars and a second connection reads the post-replace write.
 * 2. openSqliteDb(bytes) rewrites library.sqlite. A `-wal` (mobile uploads
 *    WAL-header bytes) or `-journal` left next to the previous file was
 *    replayed onto the new bytes: pre-fix this test read ["fresh","stale"].
 *    clearLocalCache likewise left the sidecars behind.
 * 3. The upload/cache bytes are built by ATTACHing the group files to a
 *    scratch DB; they must carry rows that are still only in the -wal, and
 *    must not carry a WAL header themselves. A clean close() leaves no
 *    sidecar, so a byte copy of a closed group file is complete.
 */
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { LibraryDb, openSqliteDb } from "../src/libraryDb";
import {
  getCoreDbPath,
  getIngestDbPath,
  getMetadataDbPath,
  getPlaybackDbPath,
  getTemplatesDbPath,
} from "../src/libraryDbStorage";

// The staging file openSqliteDb() writes (libraryDb.ts resolveLibraryDbPath).
const resolveLibraryDbPath = () => join(root, "library", "library.sqlite");

const SUITE = "library-wal-sidecar-safety";
const KEY_BASE64 = Buffer.alloc(32, 7).toString("base64");

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-lib-wal-sidecar-"));
  process.env.SF_USER_DATA_PATH = root;
  console.info(`[${SUITE}:setup] SF_USER_DATA_PATH=${root}`);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
});

const groupPaths = () => ({
  core: getCoreDbPath(),
  metadata: getMetadataDbPath(),
  playback: getPlaybackDbPath(),
  ingest: getIngestDbPath(),
  templates: getTemplatesDbPath(),
});

const sidecarState = () => {
  const state: Record<string, { main: boolean; wal: boolean; shm: boolean }> = {};
  for (const [group, path] of Object.entries(groupPaths())) {
    state[group] = { main: existsSync(path), wal: existsSync(`${path}-wal`), shm: existsSync(`${path}-shm`) };
  }
  return state;
};

const readSettingDirect = (key: string) => {
  const probe = new Database(getCoreDbPath());
  try {
    const row = probe.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value?: string } | undefined;
    return row?.value ?? null;
  } finally {
    probe.close();
  }
};

// Finalizers of unreachable bun:sqlite handles (the deferred sqlite3_close_v2
// of the pre-replace connections) run during a full GC.
const collectGarbage = () => {
  for (let i = 0; i < 5; i += 1) Bun.gc(true);
};

// applyRemoteSnapshot is private; the sync path reaches it only after a
// network fetch, so the test drives it directly with a prepared snapshot.
type SnapshotApplier = { applyRemoteSnapshot: (prepared: unknown) => Promise<boolean> };

describe("@bugfix @regression-proof library WAL sidecars are never lost, stale or replayed (#25)", () => {
  it("remote snapshot replace keeps the new files' -wal alive: writes after the replace survive GC of the old handles", async () => {
    const db = await LibraryDb.openLocal("token-test", KEY_BASE64);
    try {
      db.setSetting("before_replace", "1");
      for (let i = 0; i < 20; i += 1) db.setSetting(`warm_${i}`, String(i));
      console.info(`[${SUITE}:replace] after warm writes sidecars=${JSON.stringify(sidecarState())}`);
      const bytes = db.exportBytes();
      // Private access, see SnapshotApplier.
      const applier = db as unknown as SnapshotApplier;
      await applier.applyRemoteSnapshot({
        kind: "snapshot",
        meta: { stateHash: null, lastOpId: null },
        fromVersion: 0,
        snapshotVersion: 1,
        updatedAt: new Date().toISOString(),
        bytes,
      });
      db.setSetting("after_replace", "2");
      console.info(`[${SUITE}:replace] after replace + write sidecars=${JSON.stringify(sidecarState())}`);
      collectGarbage();
      const state = sidecarState();
      console.info(`[${SUITE}:replace] after GC sidecars=${JSON.stringify(state)}`);
      // While the live handle is open, the core file's WAL sidecars must
      // still be on disk: a zombie close must not have unlinked them.
      expect(state.core).toEqual({ main: true, wal: true, shm: true });
      const viaSecondConnection = readSettingDirect("after_replace");
      console.info(`[${SUITE}:replace] second connection reads after_replace=${viaSecondConnection}`);
      expect(viaSecondConnection).toBe("2");
      expect(db.getSetting("before_replace")?.value).toBe("1");
    } finally {
      db.close();
    }
  });

  it("close() checkpoints and leaves no -wal/-shm next to any group file", async () => {
    const db = await LibraryDb.openLocal("token-test", KEY_BASE64);
    db.setSetting("closed_row", "yes");
    db.close();
    collectGarbage();
    const state = sidecarState();
    console.info(`[${SUITE}:close] sidecars after close=${JSON.stringify(state)}`);
    for (const [group, files] of Object.entries(state)) {
      expect({ group, ...files }).toEqual({ group, main: true, wal: false, shm: false });
    }
    // The row is in the main file itself (a byte copy of it is complete).
    // Read-write: the copy is still a WAL-format file without its -wal/-shm, which some
    // SQLite builds (Apple's system SQLite) refuse to open read-only.
    const copy = join(root, "core-copy.sqlite");
    copyFileSync(getCoreDbPath(), copy);
    const probe = new Database(copy, { readwrite: true });
    try {
      const row = probe.prepare("SELECT value FROM app_settings WHERE key = 'closed_row'").get() as { value?: string } | undefined;
      expect(row?.value).toBe("yes");
    } finally {
      probe.close();
    }
  });

  it("exportBytes after writes (no close) carries the newest rows and a rollback-journal header", async () => {
    const db = await LibraryDb.openLocal("token-test", KEY_BASE64);
    try {
      db.setSetting("export_row", "fresh");
      const bytes = db.exportBytes();
      console.info(`[${SUITE}:export] bytes=${bytes.length} header[18..19]=${bytes[18]},${bytes[19]}`);
      expect([bytes[18], bytes[19]]).toEqual([1, 1]);
      const image = Database.deserialize(bytes);
      try {
        const row = image.prepare("SELECT value FROM app_settings WHERE key = 'export_row'").get() as { value?: string } | undefined;
        expect(row?.value).toBe("fresh");
      } finally {
        image.close();
      }
    } finally {
      db.close();
    }
  });

  it("openSqliteDb(bytes) never replays a stale -wal onto the rewritten library.sqlite and forces a rollback journal", () => {
    // A WAL-mode image (what mobile uploads) holding the FRESH row.
    const freshPath = join(root, "fresh.sqlite");
    const fresh = new Database(freshPath);
    fresh.exec("PRAGMA journal_mode = WAL");
    fresh.exec("CREATE TABLE marker (v TEXT)");
    fresh.exec("INSERT INTO marker VALUES ('fresh')");
    fresh.close();
    const freshBytes = new Uint8Array(readFileSync(freshPath));
    console.info(`[${SUITE}:legacy] fresh header[18..19]=${freshBytes[18]},${freshBytes[19]}`);
    expect([freshBytes[18], freshBytes[19]]).toEqual([2, 2]);

    // A previous library.sqlite whose un-checkpointed -wal holds a STALE row.
    const legacyPath = resolveLibraryDbPath();
    openSqliteDb(freshBytes).close();
    const stale = new Database(legacyPath);
    stale.exec("PRAGMA journal_mode = WAL");
    stale.exec("PRAGMA wal_autocheckpoint = 0");
    stale.exec("INSERT INTO marker VALUES ('stale')");
    const staleWal = readFileSync(`${legacyPath}-wal`);
    stale.close();
    writeFileSync(`${legacyPath}-wal`, staleWal);
    console.info(`[${SUITE}:legacy] planted stale -wal bytes=${staleWal.length}`);

    const db = openSqliteDb(freshBytes);
    try {
      const rows = (db.prepare("SELECT v FROM marker ORDER BY v").all() as Array<{ v: string }>).map((r) => r.v);
      const journal = db.prepare("PRAGMA journal_mode;").get() as { journal_mode?: string };
      console.info(`[${SUITE}:legacy] rows=${JSON.stringify(rows)} journal=${JSON.stringify(journal)}`);
      expect(rows).toEqual(["fresh"]);
      expect(String(journal.journal_mode).toLowerCase()).toBe("delete");
    } finally {
      db.close();
    }
    expect(existsSync(`${legacyPath}-wal`)).toBe(false);
  });

  it("clearLocalCache removes library.sqlite together with its sidecars", async () => {
    const legacyPath = resolveLibraryDbPath();
    openSqliteDb().close();
    for (const suffix of ["-wal", "-shm", "-journal"]) writeFileSync(`${legacyPath}${suffix}`, "stale");
    await LibraryDb.clearLocalCache();
    const left = ["", "-wal", "-shm", "-journal"].filter((suffix) => existsSync(`${legacyPath}${suffix}`));
    console.info(`[${SUITE}:clear] left=${JSON.stringify(left)}`);
    expect(left).toEqual([]);
  });
});
