/**
 * @test-id LIB-DB-FK-LINT-001
 * @level unit
 * @why The library-db split runs SQLite with `PRAGMA foreign_keys=OFF` on
 *   every non-core group (libraryDb.ts:1150/1177/1204/1231 — metadata,
 *   playback, ingest, templates). That means every FK whose owning table
 *   lives outside `core` has NO database-level enforcement: SQLite never
 *   cascades, never even checks. Referential integrity falls entirely on
 *   the app layer — specifically, on `appendMediaDelete` in ops.ts fanning
 *   out one synthetic media.delete op into per-group DELETEs.
 *
 *   This lint:
 *   1. Enumerates every `FOREIGN KEY(<col>) REFERENCES <target>(<col>) ON
 *      DELETE CASCADE` in the per-group DDL.
 *   2. For every FK rooted (transitively) at `media_items`, asserts that
 *      `buildMediaDeleteStatements()` emits a DELETE that reaches the
 *      owning table — either directly (`WHERE media_id = ?`) or via the
 *      correlated subquery patterns used for chunks/events.
 *   3. Reverse lint: every `DELETE FROM <table>` emitted by media.delete
 *      references a table that still exists in the manifest. Catches
 *      stale fan-out entries pointing at dropped tables.
 *
 *   Without this guard, a schema change that adds a new FK-CASCADE
 *   table to e.g. `playback` would silently leak orphan rows on every
 *   media delete — invisible until the FS bloats or a stale chunk gets
 *   served. The lint fails the build at PR time.
 */
import { describe, expect, test } from "vitest";
import { tableGroups, ALL_LIBRARY_DB_GROUPS, type LibraryDbGroup } from "../src/manifest";
import { getGroupDdlStatements } from "../src/migrations";
import { buildMediaDeleteStatements } from "../src/ops";

const SUITE = "cross-group-cascade-lint";

// ── DDL parsing ──────────────────────────────────────────────────────

type ForeignKey = Readonly<{
  owningTable: string;
  owningColumn: string;
  targetTable: string;
  targetColumn: string;
  onDeleteCascade: boolean;
  owningGroup: LibraryDbGroup;
  targetGroup: LibraryDbGroup | "unknown";
}>;

const CREATE_TABLE_RE = /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(\w+)\s*\(([\s\S]*?)\);/g;
// Match FOREIGN KEY(col) REFERENCES target(col) [ON DELETE CASCADE]
const FK_RE =
  /FOREIGN KEY\s*\(\s*(\w+)\s*\)\s*REFERENCES\s+(\w+)\s*\(\s*(\w+)\s*\)(?:\s+ON\s+DELETE\s+CASCADE)?/gi;

const parseForeignKeys = (): ReadonlyArray<ForeignKey> => {
  const fks: ForeignKey[] = [];
  for (const group of ALL_LIBRARY_DB_GROUPS) {
    const ddlStatements = getGroupDdlStatements(group);
    const combined = ddlStatements.join("\n");
    // Pull out each CREATE TABLE body
    let tableMatch: RegExpExecArray | null;
    const ctRe = new RegExp(CREATE_TABLE_RE.source, "g");
    while ((tableMatch = ctRe.exec(combined)) !== null) {
      const owningTable = tableMatch[1]!;
      const body = tableMatch[2]!;
      const fkRe = new RegExp(FK_RE.source, "gi");
      let fkMatch: RegExpExecArray | null;
      while ((fkMatch = fkRe.exec(body)) !== null) {
        const onDelete = /ON\s+DELETE\s+CASCADE/i.test(fkMatch[0]!);
        const targetTable = fkMatch[2]!;
        const targetGroup = tableGroups[targetTable] ?? ("unknown" as const);
        fks.push({
          owningTable,
          owningColumn: fkMatch[1]!,
          targetTable,
          targetColumn: fkMatch[3]!,
          onDeleteCascade: onDelete,
          owningGroup: group,
          targetGroup,
        });
      }
    }
  }
  return fks;
};

// Build a reverse adjacency map: target → list of FK-owning tables.
const tablesDependingOn = (
  fks: ReadonlyArray<ForeignKey>,
  rootTable: string
): ReadonlySet<string> => {
  const reverseEdges = new Map<string, string[]>();
  for (const fk of fks) {
    if (!fk.onDeleteCascade) continue;
    const owners = reverseEdges.get(fk.targetTable) ?? [];
    owners.push(fk.owningTable);
    reverseEdges.set(fk.targetTable, owners);
  }

  const visited = new Set<string>();
  const stack = [rootTable];
  while (stack.length > 0) {
    const next = stack.pop()!;
    const owners = reverseEdges.get(next) ?? [];
    for (const owner of owners) {
      if (!visited.has(owner)) {
        visited.add(owner);
        stack.push(owner);
      }
    }
  }
  return visited;
};

// Extract every "DELETE FROM <table>" target out of the SQL strings in
// buildMediaDeleteStatements' output (across all groups).
const tablesDeletedByMediaDelete = (): ReadonlySet<string> => {
  const out = buildMediaDeleteStatements("synthetic-media-id");
  const targets = new Set<string>();
  for (const stmts of Object.values(out)) {
    for (const stmt of stmts ?? []) {
      // Top-level DELETE target
      const top = stmt.sql.match(/DELETE\s+FROM\s+(\w+)/i);
      if (top) targets.add(top[1]!);
      // Correlated subquery targets — e.g. "...WHERE format_id IN (SELECT id FROM media_formats WHERE ...)"
      // These don't *delete* from the subquery table, only scope the outer
      // delete, so the outer table name is what matters for cascade
      // coverage. The subquery is a scoping helper, not a separate effect.
    }
  }
  return targets;
};

const dumpCascadeSnapshot = (
  label: string,
  ctx: {
    allForeignKeys: ReadonlyArray<ForeignKey>;
    mediaItemsDependents: ReadonlySet<string>;
    mediaDeleteTargets: ReadonlySet<string>;
    violations?: ReadonlyArray<string>;
    note?: string;
  },
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    if (ctx.note) console.error(`note: ${ctx.note}`);
    const fksByGroup: Record<string, Array<Omit<ForeignKey, "owningGroup" | "targetGroup"> & { owningGroup: string; targetGroup: string }>> = {};
    for (const fk of ctx.allForeignKeys) {
      const g = fk.owningGroup;
      fksByGroup[g] = fksByGroup[g] ?? [];
      fksByGroup[g]!.push({ ...fk, owningGroup: g, targetGroup: fk.targetGroup });
    }
    console.error(
      `FK counts per group: ${JSON.stringify(
        Object.fromEntries(Object.entries(fksByGroup).map(([g, l]) => [g, l.length])),
      )}`,
    );
    console.error(`total FKs: ${ctx.allForeignKeys.length}`);
    console.error(`fks-by-group:\n${JSON.stringify(fksByGroup, null, 2)}`);
    console.error(
      `media_items transitive dependents (${ctx.mediaItemsDependents.size}):\n${JSON.stringify([...ctx.mediaItemsDependents].sort(), null, 2)}`,
    );
    console.error(
      `appendMediaDelete DELETE targets (${ctx.mediaDeleteTargets.size}):\n${JSON.stringify([...ctx.mediaDeleteTargets].sort(), null, 2)}`,
    );
    if (ctx.violations) {
      console.error(`lint findings:\n${JSON.stringify(ctx.violations, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

// ── Tests ────────────────────────────────────────────────────────────

const allForeignKeys = parseForeignKeys();
const mediaItemsDependents = tablesDependingOn(allForeignKeys, "media_items");
const mediaDeleteTargets = tablesDeletedByMediaDelete();

console.info(
  `[${SUITE}:setup] totalFKs=${allForeignKeys.length} media_items-dependents=${mediaItemsDependents.size} mediaDelete-targets=${mediaDeleteTargets.size}`,
);

describe("FK parsing sanity", () => {
  test("DDL contains the expected number of FK declarations across all groups", () => {
    console.info(`[${SUITE}:parser-sanity] parsed FK count=${allForeignKeys.length}`);
    try {
      // Sanity check that the regex actually pulled something out. If migrations.ts
      // is ever refactored to a different format, this will catch the parser
      // breaking before the lint silently passes with zero data.
      expect(allForeignKeys.length).toBeGreaterThanOrEqual(20);
    } catch (err) {
      dumpCascadeSnapshot("fk-parser-undercount", {
        allForeignKeys,
        mediaItemsDependents,
        mediaDeleteTargets,
        note: "FK parser found <20 FKs — DDL refactor likely broke the regex",
      });
      throw err;
    }
  });

  test("every FK target table is present in the manifest", () => {
    // Catches FKs pointing at tables that were dropped without updating their
    // referrers.
    const unknownTargets = allForeignKeys
      .filter((fk) => fk.targetGroup === "unknown")
      .map((fk) => `${fk.owningTable}.${fk.owningColumn} → ${fk.targetTable}`);
    console.info(`[${SUITE}:fk-target-in-manifest] unknownTargets=${unknownTargets.length}`);
    try {
      expect(
        unknownTargets,
        "FK targets a table not in the manifest — stale FK or missing manifest entry",
      ).toEqual([]);
    } catch (err) {
      dumpCascadeSnapshot("fk-unknown-target", {
        allForeignKeys,
        mediaItemsDependents,
        mediaDeleteTargets,
        violations: unknownTargets,
        note: "Stale FK or missing manifest entry",
      });
      throw err;
    }
  });

  test("every FK has ON DELETE CASCADE", () => {
    // Decision: app-layer fan-out only works if we can rely on every cross-
    // group FK being CASCADE. A non-cascade FK would mean the DDL is
    // semantically inconsistent with the appendMediaDelete strategy.
    const nonCascade = allForeignKeys
      .filter((fk) => !fk.onDeleteCascade)
      .map((fk) => `${fk.owningTable}.${fk.owningColumn} → ${fk.targetTable}`);
    console.info(`[${SUITE}:fk-all-cascade] nonCascade=${nonCascade.length}`);
    try {
      expect(
        nonCascade,
        "FK without ON DELETE CASCADE — appendMediaDelete relies on cascade semantics",
      ).toEqual([]);
    } catch (err) {
      dumpCascadeSnapshot("fk-missing-cascade", {
        allForeignKeys,
        mediaItemsDependents,
        mediaDeleteTargets,
        violations: nonCascade,
        note: "appendMediaDelete relies on CASCADE — every FK must declare it",
      });
      throw err;
    }
  });
});

describe("cross-group cascade fan-out", () => {
  test("every cross-group FK is enforced by app-layer fan-out (foreign_keys=OFF makes DB cascade a no-op)", () => {
    // For every FK whose owning group differs from `core` (i.e. cannot rely
    // on SQLite's cascade because foreign_keys is OFF on that DB), the
    // app-layer media.delete output must include a DELETE FROM the owning
    // table — directly via WHERE media_id = ? or transitively via a
    // correlated subquery.
    const crossGroup = allForeignKeys.filter((fk) => fk.owningGroup !== "core");
    const missing: string[] = [];
    for (const fk of crossGroup) {
      // Walk back up the FK chain to see if the *root* dependency is on
      // media_items. If not (e.g. ingest_job_events → ingest_jobs, where
      // the FK is intra-group), the parent's deletion already cascades
      // within its own group via the correlated-subquery pattern.
      if (!mediaItemsDependents.has(fk.owningTable)) continue;
      // The owning table is transitively dependent on media_items. Either
      // mediaDelete targets it directly, OR another DELETE in the same
      // output deletes the parent which transitively wipes it via a
      // correlated subquery emitted in ops.ts.
      const directlyDeleted = mediaDeleteTargets.has(fk.owningTable);
      if (!directlyDeleted) {
        missing.push(
          `${fk.owningGroup}.${fk.owningTable} (FK on .${fk.owningColumn} → ${fk.targetGroup}.${fk.targetTable}) — no DELETE FROM ${fk.owningTable} in appendMediaDelete output`,
        );
      }
    }
    console.info(`[${SUITE}:cross-group-fanout] crossGroupFKs=${crossGroup.length} missing=${missing.length}`);
    try {
      expect(
        missing,
        "Cross-group FK with no app-layer fan-out — orphan rows will accumulate on media.delete because foreign_keys=OFF on the owning group",
      ).toEqual([]);
    } catch (err) {
      dumpCascadeSnapshot("cross-group-fk-fanout-missing", {
        allForeignKeys,
        mediaItemsDependents,
        mediaDeleteTargets,
        violations: missing,
        note: "appendMediaDelete is missing a DELETE for a cross-group cascade",
      });
      throw err;
    }
  });

  test("every table that transitively depends on media_items via CASCADE FKs is covered by appendMediaDelete", () => {
    // Stricter form of the test above — doesn't care about same-group vs
    // cross-group, just requires the full transitive closure to be wiped.
    const missing = Array.from(mediaItemsDependents).filter(
      (table) => !mediaDeleteTargets.has(table),
    );
    console.info(`[${SUITE}:transitive-closure] missing=${missing.length}`);
    try {
      expect(
        missing,
        "Tables transitively depending on media_items via CASCADE FKs but not deleted by appendMediaDelete",
      ).toEqual([]);
    } catch (err) {
      dumpCascadeSnapshot("transitive-closure-not-covered", {
        allForeignKeys,
        mediaItemsDependents,
        mediaDeleteTargets,
        violations: missing,
        note: "Some media_items transitive dependents are not deleted by appendMediaDelete",
      });
      throw err;
    }
  });

  test("every DELETE FROM target in appendMediaDelete points at a table still in the manifest", () => {
    // Reverse lint: catches stale entries in appendMediaDelete that target
    // tables which have been dropped from the schema. Bonus over the FK
    // lint because it also covers tables with NO FK to media_items (e.g.
    // media_skip_analysis is desktop-only templates with its own ML
    // lifecycle).
    const orphans = Array.from(mediaDeleteTargets).filter(
      (table) => !(table in tableGroups),
    );
    console.info(`[${SUITE}:reverse-lint] orphan-delete-targets=${orphans.length}`);
    try {
      expect(
        orphans,
        "appendMediaDelete deletes from a table not in the manifest — stale cascade entry, dropped table, or typo",
      ).toEqual([]);
    } catch (err) {
      dumpCascadeSnapshot("reverse-lint-orphans", {
        allForeignKeys,
        mediaItemsDependents,
        mediaDeleteTargets,
        violations: orphans,
        note: "appendMediaDelete references a table that no longer exists in the manifest",
      });
      throw err;
    }
  });
});

describe("intra-group cascade fan-out (the cases SQLite *could* enforce but the app duplicates)", () => {
  test("playback's intra-group chunk cascades are explicit in appendMediaDelete", () => {
    // media_format_chunks (playback) → media_formats (playback): same group,
    // PRAGMA foreign_keys=OFF, so the cascade IS app-driven. Mirror for
    // media_audio_chunks → media_audio_tracks.
    const targets = mediaDeleteTargets;
    console.info(
      `[${SUITE}:intra-group-chunks] format_chunks=${targets.has("media_format_chunks")} audio_chunks=${targets.has("media_audio_chunks")} chapters=${targets.has("media_chapters")}`,
    );
    try {
      expect(targets.has("media_format_chunks")).toBe(true);
      expect(targets.has("media_audio_chunks")).toBe(true);
      expect(targets.has("media_chapters")).toBe(true);
    } catch (err) {
      dumpCascadeSnapshot("intra-group-chunks-missing", {
        allForeignKeys,
        mediaItemsDependents,
        mediaDeleteTargets,
        violations: [
          targets.has("media_format_chunks") ? "" : "missing media_format_chunks",
          targets.has("media_audio_chunks") ? "" : "missing media_audio_chunks",
          targets.has("media_chapters") ? "" : "missing media_chapters",
        ].filter(Boolean),
        note: "intra-group cascade tables (chunks, chapters) must be explicit in appendMediaDelete",
      });
      throw err;
    }
  });

  test("ingest_job_events is wiped before ingest_jobs (correlated subquery would otherwise return nothing)", () => {
    const out = buildMediaDeleteStatements("m-x");
    const ingest = out.ingest ?? [];
    const eventsIdx = ingest.findIndex((s) => s.sql.includes("ingest_job_events"));
    const jobsIdx = ingest.findIndex(
      (s) => s.sql.includes("ingest_jobs") && !s.sql.includes("ingest_job_events"),
    );
    console.info(
      `[${SUITE}:ingest-order] ingest-stmts=${ingest.length} eventsIdx=${eventsIdx} jobsIdx=${jobsIdx}`,
    );
    try {
      expect(eventsIdx).toBeGreaterThanOrEqual(0);
      expect(jobsIdx).toBeGreaterThan(eventsIdx);
    } catch (err) {
      console.error(`=== [${SUITE}:ingest-order-violation] snapshot ===`);
      console.error(`ingest DELETE statements (${ingest.length}):`);
      ingest.forEach((s, i) =>
        console.error(`  [${i}] ${s.sql.slice(0, 120)}${s.sql.length > 120 ? "…" : ""}`),
      );
      console.error(`eventsIdx=${eventsIdx} jobsIdx=${jobsIdx} — events must precede jobs`);
      throw err;
    }
  });

  test("core's media_items DELETE is last (so other core deletes can still reference it if needed)", () => {
    const out = buildMediaDeleteStatements("m-x");
    const core = out.core ?? [];
    const itemsIdx = core.findIndex((s) =>
      s.sql.trim().startsWith("DELETE FROM media_items WHERE id ="),
    );
    console.info(`[${SUITE}:core-order] core-stmts=${core.length} itemsIdx=${itemsIdx}`);
    try {
      expect(itemsIdx).toBe(core.length - 1);
    } catch (err) {
      console.error(`=== [${SUITE}:core-order-violation] snapshot ===`);
      console.error(`core DELETE statements (${core.length}):`);
      core.forEach((s, i) =>
        console.error(`  [${i}] ${s.sql.slice(0, 120)}${s.sql.length > 120 ? "…" : ""}`),
      );
      console.error(`itemsIdx=${itemsIdx} expected=${core.length - 1}`);
      throw err;
    }
  });
});
