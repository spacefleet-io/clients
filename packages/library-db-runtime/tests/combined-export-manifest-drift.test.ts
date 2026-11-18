/**
 * @test-id LIB-COMBINED-EXPORT-DRIFT-001
 * @level integration (real-engine, bun:sqlite)
 *
 * Drift guard for the per-group table-name constants in `libraryDb.ts`
 * (`CORE_TABLES` / `METADATA_TABLES` / `PLAYBACK_TABLES` / `INGEST_TABLES` /
 * `TEMPLATES_TABLES`). Those arrays are a hand-maintained mirror of
 * `tableGroups` in `@space/library-db-definition/manifest`. If they fall
 * out of sync — e.g. someone adds a new manifest table without touching
 * libraryDb's constants — the combined-export loop in
 * `buildCombinedSnapshotBytes` will silently drop that table from the
 * snapshot. The whole-library upload + local-cache snapshot then loses
 * data without raising any error.
 *
 * Behavior-level guard: open a fresh LibraryDb, call exportBytes(), open
 * the resulting bytes as a SQLite file, and assert EVERY table in the
 * manifest appears in the combined snapshot. This catches drift without
 * needing the constants themselves to be exported.
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { LibraryDb } from "../src/libraryDb";
import { tableGroups } from "@space/library-db-definition";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-combined-export-drift-"));
  process.env.SF_USER_DATA_PATH = root;
  console.info(`[combined-export-manifest-drift:setup] root=${root}`);
});

afterEach(() => {
  console.info(`[combined-export-manifest-drift:teardown] removing root=${root}`);
  rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
});

// Suite-id: combined-export-manifest-drift
// Dump manifest-vs-snapshot drift: total tables in manifest, total present in
// snapshot, the drift entries themselves, and a peek at the first 20 tables
// in the snapshot for context.
const dumpManifestDriftSnapshot = (
  label: string,
  ctx: {
    manifestTables?: string[];
    snapshotTables?: string[];
    missing?: string[];
    bytesLength?: number;
  },
) => {
  try {
    console.error(`=== [combined-export-manifest-drift:${label}] snapshot ===`);
    if (ctx.bytesLength !== undefined) console.error(`exportBytes length=${ctx.bytesLength}`);
    if (ctx.manifestTables) {
      console.error(
        `manifest tables (${ctx.manifestTables.length})=${JSON.stringify(ctx.manifestTables)}`,
      );
    }
    if (ctx.snapshotTables) {
      console.error(
        `snapshot tables (${ctx.snapshotTables.length}, first 20)=${JSON.stringify(ctx.snapshotTables.slice(0, 20))}`,
      );
    }
    if (ctx.missing) {
      console.error(`drift count=${ctx.missing.length}`);
      console.error(`drift entries=${JSON.stringify(ctx.missing)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("buildCombinedExportBytes — manifest drift guard", () => {
  it("the combined snapshot contains every table the manifest classifies", async () => {
    console.info(`[combined-export-manifest-drift:open] opening LibraryDb.openLocal`);
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);
    console.info(`[combined-export-manifest-drift:export] calling exportBytes()`);
    const bytes = db.exportBytes();
    console.info(`[combined-export-manifest-drift:export] bytes.length=${bytes.length}`);
    db.close();

    const snapshotPath = join(root, "snapshot.sqlite");
    writeFileSync(snapshotPath, bytes);
    console.info(`[combined-export-manifest-drift:open-snapshot] wrote+opening ${snapshotPath}`);
    const snapshot = new Database(snapshotPath);
    try {
      const present = new Set(
        (snapshot
          .prepare("SELECT name FROM sqlite_master WHERE type='table';")
          .all() as Array<{ name?: string }>).map((row) => String(row.name ?? ""))
      );
      const manifestTables = Object.keys(tableGroups);
      console.info(
        `[combined-export-manifest-drift:compare] manifest=${manifestTables.length} snapshot=${present.size}`,
      );

      const missing: string[] = [];
      for (const table of manifestTables) {
        if (!present.has(table)) missing.push(table);
      }
      if (missing.length > 0) {
        console.error(
          `[combined-export-manifest-drift:compare] drift detected: missing=${JSON.stringify(missing)}`,
        );
      }
      try {
        expect(
          missing,
          "tables in @space/library-db-definition manifest absent from the combined snapshot — " +
            "CORE_TABLES/METADATA_TABLES/PLAYBACK_TABLES/INGEST_TABLES/TEMPLATES_TABLES in libraryDb.ts " +
            "have drifted from the manifest. Derive them from `tablesInGroup(g)` or add the missing entries."
        ).toEqual([]);
      } catch (err) {
        console.error(`[combined-export-manifest-drift:compare] assertion failed`);
        dumpManifestDriftSnapshot("drift-failure", {
          manifestTables,
          snapshotTables: Array.from(present),
          missing,
          bytesLength: bytes.length,
        });
        throw err;
      }
    } finally {
      snapshot.close();
    }
  });
});
