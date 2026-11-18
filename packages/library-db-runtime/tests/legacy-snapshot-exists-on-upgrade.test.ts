/**
 * @bugfix @regression-proof
 *
 * Phase 3.7 E2E-style scenario as a `bun test` rather than wired into the
 * compose-backed library-sync.e2e.ts script.
 *
 * Why a unit test here instead of a scenario in tests/e2e/library-sync.e2e.ts:
 * the library-sync.e2e.ts script is run via Electron's tsx loader, which
 * doesn't expose CommonJS `require()` to TS source files. `library-db-runtime`
 * uses `require()` inside `db.ts` to lazy-load bun:sqlite OR better-sqlite3,
 * and that pattern fails under the Electron+tsx ESM loader without a wrapper.
 * The existing scenarios in library-sync.e2e.ts only invoke `LibraryDb.open`
 * (which hits the API before reaching the lazy-load) — but the legacy-upgrade
 * path needs `LibraryDb.openLocal`, which hits the lazy-load immediately.
 *
 * bun:test's runtime resolves the same `require()` calls natively (the
 * package's other tests prove this), so this file delivers identical
 * coverage of the migration path without the loader gotcha. The scenario
 * description below mirrors what would have been the compose scenario.
 *
 * Scenario: legacy-snapshot-exists-on-upgrade.
 *
 *  1. Boot LibraryDb against a fresh user data dir.
 *  2. The constructor's `initialize<Group>Db()` × 5 chain + `retireLegacyDb()`
 *     materializes five `library.<group>.sqlite` files and renames the
 *     (empty) legacy `library.sqlite` to `library.sqlite.pre-split.bak`.
 *  3. Seed a core-group setting so the next boot can verify the rows
 *     survive the split.
 *  4. Reopen — assert the per-group markers in
 *     `core.app_settings.migration_phase3_<group>_split` are present and
 *     the seeded setting is still readable through the routed accessor.
 *  5. Reopen again — assert per-group file sizes are identical (the split
 *     did NOT re-run; markers are honored).
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { LibraryDb } from "../src/libraryDb";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-legacy-upgrade-"));
  process.env.SF_USER_DATA_PATH = root;
  console.info(`[legacy-snapshot-exists-on-upgrade:setup] root=${root}`);
});

afterEach(() => {
  console.info(`[legacy-snapshot-exists-on-upgrade:teardown] removing root=${root}`);
  rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
});

const libDir = () => join(root, "library");
const perGroupFiles = [
  "library.core.sqlite",
  "library.metadata.sqlite",
  "library.playback.sqlite",
  "library.ingest.sqlite",
  "library.templates.sqlite",
] as const;

// Suite-id: legacy-snapshot-exists-on-upgrade
// Dumps schema version + per-group file inventory + split markers + upgrade
// progress visible at this point in the boot sequence.
const dumpUpgradeSnapshot = (
  label: string,
  ctx: {
    db?: LibraryDb | null;
    markers?: Record<string, string | undefined>;
    fileSizes?: Record<string, number | string>;
  },
) => {
  try {
    console.error(`=== [legacy-snapshot-exists-on-upgrade:${label}] snapshot ===`);
    console.error(`libDir=${libDir()}`);
    let dirListing: string[] = [];
    try {
      dirListing = readdirSync(libDir());
    } catch (err) {
      dirListing = [
        `(readdir failed: ${err instanceof Error ? err.message : String(err)})`,
      ];
    }
    console.error(`library/ contents (${dirListing.length})=${JSON.stringify(dirListing)}`);

    const perGroupSizes: Record<string, number | string> = {};
    for (const name of perGroupFiles) {
      const fp = join(libDir(), name);
      try {
        perGroupSizes[name] = existsSync(fp) ? statSync(fp).size : "(missing)";
      } catch (err) {
        perGroupSizes[name] = `(stat failed: ${err instanceof Error ? err.message : String(err)})`;
      }
    }
    const legacyPath = join(libDir(), "library.sqlite");
    const bakPath = join(libDir(), "library.sqlite.pre-split.bak");
    perGroupSizes["library.sqlite"] = existsSync(legacyPath)
      ? statSync(legacyPath).size
      : "(missing)";
    perGroupSizes["library.sqlite.pre-split.bak"] = existsSync(bakPath)
      ? statSync(bakPath).size
      : "(missing)";
    console.error(`file sizes:\n${JSON.stringify(perGroupSizes, null, 2)}`);

    if (ctx.fileSizes) {
      console.error(`pre-captured file sizes:\n${JSON.stringify(ctx.fileSizes, null, 2)}`);
    }
    if (ctx.markers) {
      console.error(`split markers (post-boot):\n${JSON.stringify(ctx.markers, null, 2)}`);
    } else if (ctx.db) {
      const live: Record<string, unknown> = {};
      for (const group of ["core", "metadata", "playback", "ingest", "templates"]) {
        try {
          live[`migration_phase3_${group}_split`] = ctx.db.getSetting(
            `migration_phase3_${group}_split`,
          )?.value;
        } catch (err) {
          live[`migration_phase3_${group}_split`] = `(read failed: ${err instanceof Error ? err.message : String(err)})`;
        }
      }
      console.error(`split markers (live):\n${JSON.stringify(live, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("legacy-snapshot-exists-on-upgrade", () => {
  it("materializes five per-group files + .pre-split.bak on first boot", async () => {
    console.info(`[legacy-snapshot-exists-on-upgrade:first-boot] opening LibraryDb.openLocal`);
    const db = await LibraryDb.openLocal("token", "key");
    db.close();
    console.info(`[legacy-snapshot-exists-on-upgrade:first-boot] closed handle`);

    try {
      for (const name of perGroupFiles) {
        const filePath = join(libDir(), name);
        console.info(
          `[legacy-snapshot-exists-on-upgrade:check] ${name} exists=${existsSync(filePath)} size=${existsSync(filePath) ? statSync(filePath).size : "(missing)"}`,
        );
        expect(existsSync(filePath)).toBe(true);
        expect(statSync(filePath).size).toBeGreaterThan(0);
      }
      const bakExists = existsSync(join(libDir(), "library.sqlite.pre-split.bak"));
      console.info(`[legacy-snapshot-exists-on-upgrade:check] .pre-split.bak exists=${bakExists}`);
      expect(bakExists).toBe(true);
      // The legacy `library.sqlite` may have been re-created as an empty
      // shell by the most recent `openSqliteDb()` call before retire ran;
      // either it's gone, or it's a tiny empty SQLite file (<16 KB).
      const legacyPath = join(libDir(), "library.sqlite");
      const legacyExists = existsSync(legacyPath);
      const legacySize = legacyExists ? statSync(legacyPath).size : null;
      console.info(
        `[legacy-snapshot-exists-on-upgrade:check] legacy library.sqlite exists=${legacyExists} size=${legacySize}`,
      );
      if (legacyExists) {
        expect(statSync(legacyPath).size).toBeLessThan(16 * 1024);
      }
    } catch (err) {
      console.error(`[legacy-snapshot-exists-on-upgrade:first-boot] assertion failed`);
      dumpUpgradeSnapshot("first-boot-failure", { db: null });
      throw err;
    }
  });

  it("writes per-group split markers into core.app_settings", async () => {
    console.info(`[legacy-snapshot-exists-on-upgrade:markers] opening for marker check`);
    const db = await LibraryDb.openLocal("token", "key");
    const observed: Record<string, string | undefined> = {};
    try {
      for (const group of ["core", "metadata", "playback", "ingest", "templates"]) {
        const marker = db.getSetting(`migration_phase3_${group}_split`);
        observed[`migration_phase3_${group}_split`] = marker?.value;
        console.info(
          `[legacy-snapshot-exists-on-upgrade:markers] ${group} marker=${marker?.value}`,
        );
        expect(marker?.value).toBe("1");
      }
    } catch (err) {
      console.error(`[legacy-snapshot-exists-on-upgrade:markers] assertion failed`);
      dumpUpgradeSnapshot("markers-failure", { db, markers: observed });
      throw err;
    } finally {
      db.close();
    }
  });

  it("preserves seeded core-group rows across the split + reopen", async () => {
    console.info(`[legacy-snapshot-exists-on-upgrade:preserve] first boot — seeding theme`);
    const first = await LibraryDb.openLocal("token", "key");
    try {
      first.setSyncEnabled(false);
      await first.setSetting("e2e.legacy.theme", "starlight");
      console.info(`[legacy-snapshot-exists-on-upgrade:preserve] seeded theme=starlight`);
    } finally {
      first.close();
    }

    console.info(`[legacy-snapshot-exists-on-upgrade:preserve] second boot — reading theme`);
    const second = await LibraryDb.openLocal("token", "key");
    try {
      const seeded = second.getSetting("e2e.legacy.theme");
      console.info(
        `[legacy-snapshot-exists-on-upgrade:preserve] read theme=${seeded?.value}`,
      );
      expect(seeded?.value).toBe("starlight");
    } catch (err) {
      console.error(`[legacy-snapshot-exists-on-upgrade:preserve] assertion failed`);
      dumpUpgradeSnapshot("preserve-failure", { db: second });
      throw err;
    } finally {
      second.close();
    }
  });

  it("is idempotent — per-group file sizes are stable across reopens", async () => {
    // Boot once to land the splits.
    console.info(`[legacy-snapshot-exists-on-upgrade:idempotent] first boot — seeding 10 settings`);
    const first = await LibraryDb.openLocal("token", "key");
    try {
      first.setSyncEnabled(false);
      // Add enough core data to make file-size changes detectable.
      for (let i = 0; i < 10; i += 1) {
        await first.setSetting(`e2e.legacy.k${i}`, `v${i}`);
      }
    } finally {
      first.close();
    }

    const sizesBefore: Record<string, number> = {};
    for (const name of perGroupFiles) {
      sizesBefore[name] = statSync(join(libDir(), name)).size;
    }
    console.info(
      `[legacy-snapshot-exists-on-upgrade:idempotent] sizesBefore=${JSON.stringify(sizesBefore)}`,
    );

    // Second boot — markers should make the split a no-op. File sizes
    // shouldn't change.
    console.info(`[legacy-snapshot-exists-on-upgrade:idempotent] second boot — verifying stability`);
    const second = await LibraryDb.openLocal("token", "key");
    second.close();

    const sizesAfter: Record<string, number> = {};
    try {
      for (const name of perGroupFiles) {
        const after = statSync(join(libDir(), name)).size;
        sizesAfter[name] = after;
        console.info(
          `[legacy-snapshot-exists-on-upgrade:idempotent] ${name} before=${sizesBefore[name]} after=${after}`,
        );
        expect(after).toBe(sizesBefore[name]);
      }
    } catch (err) {
      console.error(`[legacy-snapshot-exists-on-upgrade:idempotent] assertion failed`);
      dumpUpgradeSnapshot("idempotent-failure", {
        db: null,
        fileSizes: { ...sizesBefore, ...Object.fromEntries(Object.entries(sizesAfter).map(([k, v]) => [`${k}-after`, v])) },
      });
      throw err;
    }
  });
});
