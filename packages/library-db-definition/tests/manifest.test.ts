/**
 * @test-id LIB-DB-MANIFEST-001
 * @level unit
 * @why The manifest in src/manifest.ts is the single source of truth for which
 *   logical SQLite database each table lives in. Both clients derive their
 *   per-DB DDL from it. If a table exists in schema.ts but isn't grouped,
 *   neither client will create it — silent data loss. This test fails the
 *   build at PR time if any Drizzle table is missing from the manifest.
 */
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import * as schema from "../src/schema";
import {
  ALL_LIBRARY_DB_GROUPS,
  desktopGroups,
  mobileGroups,
  tableGroups,
  tablesInGroup,
  type LibraryDbGroup,
} from "../src/manifest";

const SUITE = "manifest";

const collectDrizzleTableNames = (): Set<string> => {
  const names = new Set<string>();
  for (const value of Object.values(schema)) {
    if (!value || typeof value !== "object") continue;
    try {
      const config = getTableConfig(value as Parameters<typeof getTableConfig>[0]);
      names.add(config.name);
    } catch {
      // Not a Drizzle table — skip
    }
  }
  return names;
};

const dumpManifestSnapshot = (
  label: string,
  ctx: {
    drizzleTables?: ReadonlySet<string>;
    tableGroupsSnapshot?: Record<string, string>;
    perGroupCounts?: Record<string, number>;
    diff?: { missing?: ReadonlyArray<unknown>; orphans?: ReadonlyArray<unknown>; unknown?: ReadonlyArray<unknown> };
  },
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    if (ctx.drizzleTables) {
      console.error(`drizzle table count: ${ctx.drizzleTables.size}`);
      console.error(`drizzle tables: ${JSON.stringify([...ctx.drizzleTables].sort())}`);
    }
    if (ctx.tableGroupsSnapshot) {
      console.error(`manifest tableGroups entries: ${Object.keys(ctx.tableGroupsSnapshot).length}`);
      console.error(`tableGroups:\n${JSON.stringify(ctx.tableGroupsSnapshot, null, 2)}`);
    }
    if (ctx.perGroupCounts) {
      console.error(`tables per group:\n${JSON.stringify(ctx.perGroupCounts, null, 2)}`);
    }
    if (ctx.diff) {
      console.error(`diff:\n${JSON.stringify(ctx.diff, null, 2)}`);
    }
    console.error(`ALL_LIBRARY_DB_GROUPS: ${JSON.stringify(ALL_LIBRARY_DB_GROUPS)}`);
    console.error(`desktopGroups: ${JSON.stringify(desktopGroups)}`);
    console.error(`mobileGroups: ${JSON.stringify(mobileGroups)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const perGroupCounts = (): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const group of ALL_LIBRARY_DB_GROUPS) counts[group] = tablesInGroup(group).length;
  return counts;
};

describe("library-db manifest coverage", () => {
  console.info(`[${SUITE}:setup] collecting Drizzle table names from src/schema`);
  const drizzleTables = collectDrizzleTableNames();
  console.info(`[${SUITE}:setup] drizzleTables.size=${drizzleTables.size} manifestEntries=${Object.keys(tableGroups).length} groups=${ALL_LIBRARY_DB_GROUPS.length}`);

  it("every Drizzle table appears in tableGroups", () => {
    const missing: string[] = [];
    for (const tableName of drizzleTables) {
      if (!(tableName in tableGroups)) missing.push(tableName);
    }
    console.info(`[${SUITE}:check] missing-from-manifest count=${missing.length}`);
    try {
      expect(
        missing,
        "tables in schema.ts not classified in manifest.ts — add them to tableGroups"
      ).toEqual([]);
    } catch (err) {
      dumpManifestSnapshot("missing-from-manifest", {
        drizzleTables,
        tableGroupsSnapshot: tableGroups as unknown as Record<string, string>,
        diff: { missing },
      });
      throw err;
    }
  });

  it("every manifest entry corresponds to a real Drizzle table", () => {
    const orphans: string[] = [];
    for (const tableName of Object.keys(tableGroups)) {
      if (!drizzleTables.has(tableName)) orphans.push(tableName);
    }
    console.info(`[${SUITE}:check] orphan-manifest-entries count=${orphans.length}`);
    try {
      expect(
        orphans,
        "manifest entries with no matching Drizzle table — typo or stale entry"
      ).toEqual([]);
    } catch (err) {
      dumpManifestSnapshot("orphan-manifest-entries", {
        drizzleTables,
        tableGroupsSnapshot: tableGroups as unknown as Record<string, string>,
        diff: { orphans },
      });
      throw err;
    }
  });

  it("every manifest group is in ALL_LIBRARY_DB_GROUPS", () => {
    const knownGroups = new Set<LibraryDbGroup>(ALL_LIBRARY_DB_GROUPS);
    const unknown: Array<[string, string]> = [];
    for (const [table, group] of Object.entries(tableGroups)) {
      if (!knownGroups.has(group)) unknown.push([table, group]);
    }
    console.info(`[${SUITE}:check] unknown-group-assignments count=${unknown.length}`);
    try {
      expect(unknown, "manifest uses a group not in ALL_LIBRARY_DB_GROUPS").toEqual([]);
    } catch (err) {
      dumpManifestSnapshot("unknown-group-assignments", {
        tableGroupsSnapshot: tableGroups as unknown as Record<string, string>,
        diff: { unknown },
      });
      throw err;
    }
  });

  it("mobileGroups is a subset of ALL_LIBRARY_DB_GROUPS", () => {
    const all = new Set<LibraryDbGroup>(ALL_LIBRARY_DB_GROUPS);
    const stray = mobileGroups.filter((g) => !all.has(g));
    console.info(`[${SUITE}:check] mobileGroups-stray count=${stray.length} stray=${JSON.stringify(stray)}`);
    try {
      expect(stray, "mobileGroups contains unknown group").toEqual([]);
    } catch (err) {
      dumpManifestSnapshot("mobile-groups-stray", { diff: { unknown: stray } });
      throw err;
    }
  });

  it("desktopGroups covers every group in ALL_LIBRARY_DB_GROUPS", () => {
    const desktop = new Set<LibraryDbGroup>(desktopGroups);
    const missing = ALL_LIBRARY_DB_GROUPS.filter((g) => !desktop.has(g));
    console.info(`[${SUITE}:check] desktopGroups-missing count=${missing.length} missing=${JSON.stringify(missing)}`);
    try {
      expect(missing, "desktopGroups must cover every defined group").toEqual([]);
    } catch (err) {
      dumpManifestSnapshot("desktop-groups-missing", { diff: { missing } });
      throw err;
    }
  });

  it("templates group is desktop-only (excluded from mobileGroups)", () => {
    const present = mobileGroups.includes("templates");
    console.info(`[${SUITE}:check] templates-in-mobileGroups=${present}`);
    try {
      expect(
        present,
        "templates group is desktop-only per Decision #4 in the plan"
      ).toBe(false);
    } catch (err) {
      dumpManifestSnapshot("templates-leak-into-mobile", {});
      throw err;
    }
  });

  it("every group has at least one table", () => {
    const empty: LibraryDbGroup[] = [];
    for (const group of ALL_LIBRARY_DB_GROUPS) {
      if (tablesInGroup(group).length === 0) empty.push(group);
    }
    const counts = perGroupCounts();
    console.info(`[${SUITE}:check] empty-groups count=${empty.length} per-group-counts=${JSON.stringify(counts)}`);
    try {
      expect(empty, "groups defined in manifest with zero tables — remove or populate").toEqual([]);
    } catch (err) {
      dumpManifestSnapshot("empty-group", { perGroupCounts: counts, diff: { missing: empty } });
      throw err;
    }
  });
});
