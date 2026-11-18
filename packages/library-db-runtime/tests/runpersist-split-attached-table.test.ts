/**
 * @test-id LIB-RUNPERSIST-SPLIT-ATTACH-001
 * @level integration (real-engine, bun:sqlite, full LibraryDb)
 * @bugfix runpersist-split-attached-table-missing
 * @regression-proof
 *
 * The combined-snapshot ATTACH must target the file backing the open
 * per-group SQLite handle, NOT a path freshly re-resolved at call time.
 *
 * Pre-fix:
 *   `LibraryDb.buildCombinedExportBytes()` called `getCoreDbPath()` etc. at
 *   call time, which re-reads `SF_USER_DATA_PATH` LIVE. The E2E harness
 *   wraps `LibraryDb.open()` in a `withUserDataPath` block that restores the
 *   env once the constructor returns, but writes (`setSetting`) then trigger
 *   a deferred `runPersist()` via `setTimeout(0)` AFTER the restore. At that
 *   point `getCoreDbPath()` resolves against a DIFFERENT directory than the
 *   `coreDb` handle is bound to. SQLite's `ATTACH` of a non-existent path
 *   creates an empty file, and the subsequent
 *   `INSERT OR REPLACE INTO media_items SELECT * FROM split_0.media_items`
 *   throws `no such table: split_0.media_items`. All scenarios of
 *   `tests/e2e/library-sync.e2e.ts` failed with this symptom.
 *
 * Post-fix:
 *   Per-group paths are captured at handle-open time and stored on
 *   `this.<group>DbPath`. `buildCombinedExportBytes` uses the stored paths,
 *   so the ATTACH always targets the file the open handle is backed by —
 *   regardless of any subsequent `SF_USER_DATA_PATH` mutation.
 *
 * This test reproduces the env-flip pattern: open under root-A, flip the
 * env to root-B (and even remove root-A from disk, to be doubly sure that
 * a stale-path ATTACH would not silently succeed), then write + export.
 * The pre-fix code would throw `no such table: split_0.media_items`; the
 * post-fix code stitches the snapshot via the bound paths and the row is
 * present in the export.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { LibraryDb } from "../src/libraryDb";

let rootA = "";
let rootB = "";
let previousEnv: string | undefined;

beforeEach(() => {
  rootA = mkdtempSync(join(tmpdir(), "sf-runpersist-A-"));
  rootB = mkdtempSync(join(tmpdir(), "sf-runpersist-B-"));
  previousEnv = process.env.SF_USER_DATA_PATH;
  process.env.SF_USER_DATA_PATH = rootA;
  console.info(
    `[runpersist-split-attached-table:setup] rootA=${rootA} rootB=${rootB} ` +
      `previousEnv=${JSON.stringify(previousEnv)}`,
  );
});

afterEach(() => {
  console.info(
    `[runpersist-split-attached-table:teardown] rootA-exists=${existsSync(rootA)} ` +
      `rootB-exists=${existsSync(rootB)}`,
  );
  if (existsSync(rootA)) rmSync(rootA, { recursive: true, force: true });
  if (existsSync(rootB)) rmSync(rootB, { recursive: true, force: true });
  if (previousEnv === undefined) delete process.env.SF_USER_DATA_PATH;
  else process.env.SF_USER_DATA_PATH = previousEnv;
});

const openSnapshot = (bytes: Uint8Array) => {
  const path = join(rootB, "snapshot-readback.sqlite");
  writeFileSync(path, bytes);
  console.info(`[runpersist-split-attached-table:open-snapshot] path=${path} bytes=${bytes.length}`);
  return new Database(path);
};

// Suite-id: runpersist-split-attached-table
// Captures env-flip context, per-group file existence, and snapshot byte
// length. The whole point of this regression is that SF_USER_DATA_PATH gets
// flipped mid-test — dump shows what each path resolves to right now.
const dumpRunPersistSnapshot = (
  label: string,
  ctx: {
    currentEnv?: string;
    rootAExists?: boolean;
    rootBExists?: boolean;
    coreInA?: boolean;
    coreInB?: boolean;
    bytesLength?: number;
    settingsRow?: unknown;
    capturedError?: unknown;
  },
) => {
  try {
    console.error(`=== [runpersist-split-attached-table:${label}] snapshot ===`);
    console.error(
      `env: SF_USER_DATA_PATH=${JSON.stringify(ctx.currentEnv ?? process.env.SF_USER_DATA_PATH)}`,
    );
    console.error(`rootA path=${rootA} exists=${ctx.rootAExists ?? existsSync(rootA)}`);
    console.error(`rootB path=${rootB} exists=${ctx.rootBExists ?? existsSync(rootB)}`);
    if (ctx.coreInA !== undefined) console.error(`library.core.sqlite in rootA=${ctx.coreInA}`);
    if (ctx.coreInB !== undefined) console.error(`library.core.sqlite in rootB=${ctx.coreInB}`);
    if (ctx.bytesLength !== undefined) console.error(`exportBytes length=${ctx.bytesLength}`);
    if (ctx.settingsRow !== undefined) {
      console.error(`app_settings row from snapshot=${JSON.stringify(ctx.settingsRow)}`);
    }
    if (ctx.capturedError !== undefined) {
      const e = ctx.capturedError;
      console.error(`captured error=${e instanceof Error ? e.message : String(e)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("buildCombinedExportBytes — uses bound per-group paths, not re-resolved getCoreDbPath()", () => {
  it("@bugfix @regression-proof exports a working snapshot after SF_USER_DATA_PATH is restored between open and export (split_0.media_items must resolve)", async () => {
    // Open under root-A; the per-group SQLite files end up in root-A/library/.
    console.info(`[runpersist-split-attached-table:open] LibraryDb.openLocal under rootA=${rootA}`);
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);

    // Write a row to core's app_settings (and another via setSetting) so the
    // export has something non-trivial to stitch in.
    console.info(`[runpersist-split-attached-table:set] setSetting key=e2e.runpersist.key`);
    await db.setSetting("e2e.runpersist.key", "post-env-flip");

    // Flip the env to a different root and (paranoia) tear down root-A so a
    // stale-path ATTACH cannot accidentally see the right file.
    process.env.SF_USER_DATA_PATH = rootB;
    console.info(
      `[runpersist-split-attached-table:flip] env flipped to rootB=${rootB} ` +
        `core-in-A=${existsSync(join(rootA, "library", "library.core.sqlite"))} ` +
        `core-in-B=${existsSync(join(rootB, "library", "library.core.sqlite"))}`,
    );

    try {
      // exportBytes() is the public wrapper around buildCombinedExportBytes.
      let bytes: Uint8Array | null = null;
      let row: { value?: string } | undefined;
      let captured: unknown;
      try {
        bytes = db.exportBytes();
        console.info(`[runpersist-split-attached-table:export] bytes.length=${bytes.length}`);
        const snap = openSnapshot(bytes);
        try {
          row = snap
            .prepare("SELECT value FROM app_settings WHERE key = ?;")
            .get("e2e.runpersist.key") as { value?: string } | undefined;
          console.info(
            `[runpersist-split-attached-table:read-back] row=${JSON.stringify(row)}`,
          );
        } finally {
          snap.close();
        }
      } catch (err) {
        captured = err;
        throw err;
      }

      try {
        expect(row?.value).toBe("post-env-flip");
      } catch (err) {
        console.error(`[runpersist-split-attached-table:export] read-back mismatch`);
        dumpRunPersistSnapshot("read-back-failure", {
          currentEnv: process.env.SF_USER_DATA_PATH,
          rootAExists: existsSync(rootA),
          rootBExists: existsSync(rootB),
          coreInA: existsSync(join(rootA, "library", "library.core.sqlite")),
          coreInB: existsSync(join(rootB, "library", "library.core.sqlite")),
          bytesLength: bytes?.length,
          settingsRow: row,
          capturedError: captured,
        });
        throw err;
      }
    } finally {
      db.close();
    }
  });

  it("@bugfix @regression-proof tolerates env restore AND wholesale destruction of the wrong root — ATTACH still resolves against the bound path", async () => {
    console.info(
      `[runpersist-split-attached-table:open2] LibraryDb.openLocal under rootA=${rootA}`,
    );
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);
    await db.setSetting("e2e.runpersist.deleted-root", "should-survive");

    // Restore env to point at root-B (where library.core.sqlite does NOT
    // exist). This is the exact pattern `withUserDataPath` restores create
    // in the E2E harness when SF_USER_DATA_PATH was unset before the call.
    process.env.SF_USER_DATA_PATH = rootB;
    const coreInB = existsSync(join(rootB, "library", "library.core.sqlite"));
    console.info(
      `[runpersist-split-attached-table:flip2] env flipped to rootB=${rootB} ` +
        `core-in-B=${coreInB} (expected false)`,
    );

    try {
      // Sanity check: root-B has no per-group SQLite file. A pre-fix ATTACH
      // pointed here would create one (empty), then `split_0.media_items`
      // would not exist.
      expect(existsSync(join(rootB, "library", "library.core.sqlite"))).toBe(false);

      const bytes = db.exportBytes();
      console.info(`[runpersist-split-attached-table:export2] bytes.length=${bytes.length}`);
      const snap = openSnapshot(bytes);
      let row: { value?: string } | undefined;
      try {
        row = snap
          .prepare("SELECT value FROM app_settings WHERE key = ?;")
          .get("e2e.runpersist.deleted-root") as { value?: string } | undefined;
        console.info(
          `[runpersist-split-attached-table:read-back2] row=${JSON.stringify(row)}`,
        );
        expect(row?.value).toBe("should-survive");
      } finally {
        snap.close();
      }
    } catch (err) {
      console.error(`[runpersist-split-attached-table:export2] assertion failed`);
      dumpRunPersistSnapshot("destroy-wrong-root-failure", {
        currentEnv: process.env.SF_USER_DATA_PATH,
        rootAExists: existsSync(rootA),
        rootBExists: existsSync(rootB),
        coreInA: existsSync(join(rootA, "library", "library.core.sqlite")),
        coreInB,
        capturedError: err,
      });
      throw err;
    } finally {
      db.close();
    }
  });
});
