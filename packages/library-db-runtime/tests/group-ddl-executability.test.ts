/**
 * @test-id LIB-GROUP-DDL-EXECUTABILITY-001
 * @level integration (real-engine, bun:sqlite)
 *
 * `getGroupDdlStatements(group)` from @space/library-db-definition is the
 * canonical source for both clients' per-group CREATE TABLE + CREATE INDEX
 * statements. Today the unit test in async-migrations.test.ts only checks
 * that each statement begins with `CREATE TABLE` / `CREATE INDEX` — a
 * malformed body inside a statement (typo, trailing comma, unknown
 * function) would still slip through and only surface in production.
 *
 * This integration test pipes the DDL into a real bun:sqlite database
 * and confirms every CREATE actually executes without error.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { getGroupDdlStatements } from "@space/library-db-definition/migrations";
import { ALL_LIBRARY_DB_GROUPS, tablesInGroup } from "@space/library-db-definition";

// Suite-id: group-ddl-executability
// Dump the DDL list, the current statement that failed, present tables, and
// PRAGMA index_list output. Helps when a CREATE has a typo or PRAGMA isn't
// returning what the test expects.
const dumpGroupDdlSnapshot = (
  label: string,
  ctx: {
    group?: string;
    statements?: readonly string[];
    failingStmt?: string;
    presentTables?: string[];
    indexList?: unknown;
    table?: string;
    indexName?: string;
  },
) => {
  try {
    console.error(`=== [group-ddl-executability:${label}] snapshot ===`);
    if (ctx.group) console.error(`group=${ctx.group}`);
    if (ctx.statements) {
      console.error(`ddl statement count=${ctx.statements.length}`);
      console.error(`first 3 statements:`);
      for (const stmt of ctx.statements.slice(0, 3)) {
        console.error(`  - ${stmt.replace(/\s+/g, " ").trim().slice(0, 160)}`);
      }
    }
    if (ctx.failingStmt) {
      console.error(`failing statement (truncated 400)=${ctx.failingStmt.slice(0, 400)}`);
    }
    if (ctx.presentTables) {
      console.error(
        `tables present (${ctx.presentTables.length})=${JSON.stringify(ctx.presentTables)}`,
      );
    }
    if (ctx.indexList) {
      console.error(`PRAGMA index_list result:\n${JSON.stringify(ctx.indexList, null, 2)}`);
    }
    if (ctx.table) console.error(`target table=${ctx.table}`);
    if (ctx.indexName) console.error(`expected index name=${ctx.indexName}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("getGroupDdlStatements — real-engine executability", () => {
  for (const group of ALL_LIBRARY_DB_GROUPS) {
    it(`bun:sqlite executes every "${group}" DDL statement without error`, () => {
      const db = new Database(":memory:");
      const statements = getGroupDdlStatements(group);
      console.info(
        `[group-ddl-executability:exec] group=${group} statement-count=${statements.length}`,
      );
      try {
        for (const stmt of statements) {
          expect(() => db.exec(stmt)).not.toThrow();
        }
        console.info(`[group-ddl-executability:exec] group=${group} all ${statements.length} OK`);
      } catch (err) {
        // Identify which one failed by re-running them sequentially.
        let failing: string | undefined;
        const probe = new Database(":memory:");
        try {
          for (const stmt of statements) {
            try {
              probe.exec(stmt);
            } catch {
              failing = stmt;
              break;
            }
          }
        } finally {
          probe.close();
        }
        console.error(`[group-ddl-executability:exec] group=${group} failure detected`);
        dumpGroupDdlSnapshot("exec-failure", {
          group,
          statements,
          failingStmt: failing,
        });
        throw err;
      } finally {
        db.close();
      }
    });

    it(`every manifest table in "${group}" exists after running the group's DDL`, () => {
      const db = new Database(":memory:");
      try {
        const statements = getGroupDdlStatements(group);
        console.info(
          `[group-ddl-executability:tables] group=${group} executing ${statements.length} stmts`,
        );
        for (const stmt of statements) {
          db.exec(stmt);
        }
        const present = new Set(
          (db
            .prepare("SELECT name FROM sqlite_master WHERE type='table';")
            .all() as Array<{ name?: string }>).map((row) => String(row.name ?? ""))
        );
        const expectedTables = tablesInGroup(group);
        console.info(
          `[group-ddl-executability:tables] group=${group} expected=${expectedTables.length} ` +
            `present=${present.size}`,
        );
        for (const table of expectedTables) {
          try {
            expect(present.has(table), `missing ${table} in ${group} group`).toBe(true);
          } catch (err) {
            console.error(`[group-ddl-executability:tables] missing table ${table} in ${group}`);
            dumpGroupDdlSnapshot("table-missing", {
              group,
              presentTables: Array.from(present),
              table,
            });
            throw err;
          }
        }
      } finally {
        db.close();
      }
    });

    it(`every indexed column in "${group}" is reachable via PRAGMA index_list`, () => {
      const db = new Database(":memory:");
      try {
        const statements = getGroupDdlStatements(group);
        for (const stmt of statements) {
          db.exec(stmt);
        }
        // Pull every CREATE INDEX statement out of the DDL and confirm its
        // index lands on the named table.
        let indexProbeCount = 0;
        for (const stmt of statements) {
          const match = stmt.match(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+(\S+)\s+ON\s+(\w+)/i);
          if (!match) continue;
          indexProbeCount++;
          const [, indexName, table] = match;
          const rows = db
            .prepare(`PRAGMA index_list(${table});`)
            .all() as Array<{ name?: string }>;
          const names = rows.map((row) => String(row.name ?? ""));
          try {
            expect(names.includes(indexName!), `${indexName} missing on ${table}`).toBe(true);
          } catch (err) {
            console.error(
              `[group-ddl-executability:index] group=${group} index ${indexName} missing on ${table}`,
            );
            dumpGroupDdlSnapshot("index-missing", {
              group,
              indexList: rows,
              table,
              indexName,
            });
            throw err;
          }
        }
        console.info(
          `[group-ddl-executability:index] group=${group} probed ${indexProbeCount} indexes`,
        );
      } finally {
        db.close();
      }
    });
  }

  it("the same DDL re-executed in the same DB is idempotent (CREATE IF NOT EXISTS)", () => {
    const db = new Database(":memory:");
    console.info(`[group-ddl-executability:idempotent] executing all groups twice`);
    try {
      for (const group of ALL_LIBRARY_DB_GROUPS) {
        const statements = getGroupDdlStatements(group);
        for (const stmt of statements) {
          db.exec(stmt);
        }
        for (const stmt of statements) {
          try {
            expect(() => db.exec(stmt)).not.toThrow();
          } catch (err) {
            console.error(
              `[group-ddl-executability:idempotent] group=${group} non-idempotent stmt detected`,
            );
            dumpGroupDdlSnapshot("idempotent-failure", {
              group,
              failingStmt: stmt,
            });
            throw err;
          }
        }
      }
      console.info(`[group-ddl-executability:idempotent] OK across all groups`);
    } finally {
      db.close();
    }
  });
});
