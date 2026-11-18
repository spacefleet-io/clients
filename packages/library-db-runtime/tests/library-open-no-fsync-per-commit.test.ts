/**
 * @bugfix @regression-proof — #25 desktop e2e onboarding stalls on "Creating…".
 *
 * CI run 7783 (desktop-e2e on the CI host) timed a fresh account's first library
 * open in the runtime: `bootstrap open timings` pickBlobMs=54, schema=8234 ms,
 * encrypt/upload/put ≈ 135 ms, construct=56 815 ms → the `open` gate op held
 * 65 s and every e2e setup that signs a user up timed out on /onboarding/key.
 * The network was never the cost: it was SQLite. The legacy `library.sqlite`
 * and the five per-group files opened in the default rollback-journal mode
 * with synchronous=FULL, so every autocommit (each schema statement, each
 * split copy/drop, each migration) fsynced the journal and the DB file. On a
 * busy disk one fsync takes up to seconds.
 *
 * Fix, same policy as the jobs DB:
 * - per-group files (the durable store) open in WAL + synchronous=NORMAL:
 *   fsync only at checkpoints, consistent after a crash or power loss;
 * - the legacy `library.sqlite` is a transient staging file (rebuilt from the
 *   cache bytes / remote snapshot / empty schema on every open and retired
 *   right after the split), so it keeps its rollback journal (no WAL sidecar
 *   that could be replayed onto the next rewrite) but skips fsync.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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

const SUITE = "library-open-no-fsync-per-commit";
const KEY_BASE64 = Buffer.alloc(32, 7).toString("base64");

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-lib-open-wal-"));
  process.env.SF_USER_DATA_PATH = root;
  console.info(`[${SUITE}:setup] SF_USER_DATA_PATH=${root}`);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
});

const journalModeOf = (path: string) => {
  const probe = new Database(path, { readonly: true });
  try {
    const row = probe.prepare("PRAGMA journal_mode;").get() as { journal_mode?: string } | undefined;
    return String(row?.journal_mode ?? "<missing>").toLowerCase();
  } finally {
    probe.close();
  }
};

describe("@bugfix @regression-proof library SQLite files do not fsync on every commit (#25)", () => {
  it("opens the five per-group library files in WAL mode", async () => {
    const startedAt = performance.now();
    const db = await LibraryDb.openLocal("token-test", KEY_BASE64);
    console.info(`[${SUITE}:wal] openLocal took ${(performance.now() - startedAt).toFixed(1)}ms`);
    try {
      const files = {
        core: getCoreDbPath(),
        metadata: getMetadataDbPath(),
        playback: getPlaybackDbPath(),
        ingest: getIngestDbPath(),
        templates: getTemplatesDbPath(),
      };
      const modes: Record<string, string> = {};
      for (const [group, path] of Object.entries(files)) {
        modes[group] = existsSync(path) ? journalModeOf(path) : "<no file>";
      }
      console.info(`[${SUITE}:wal] journal modes=${JSON.stringify(modes)}`);
      expect(modes).toEqual({ core: "wal", metadata: "wal", playback: "wal", ingest: "wal", templates: "wal" });
    } finally {
      db.close();
    }
  });

  it("opens the transient legacy library.sqlite with a rollback journal and synchronous=OFF", () => {
    const db = openSqliteDb();
    try {
      const journal = db.prepare("PRAGMA journal_mode;").get() as { journal_mode?: string };
      const sync = db.prepare("PRAGMA synchronous;").get() as { synchronous?: number };
      console.info(`[${SUITE}:legacy] journal=${JSON.stringify(journal)} synchronous=${JSON.stringify(sync)}`);
      expect(String(journal.journal_mode).toLowerCase()).toBe("delete");
      expect(sync.synchronous).toBe(0);
    } finally {
      db.close();
    }
  });
});
