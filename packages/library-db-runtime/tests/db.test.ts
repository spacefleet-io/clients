import { describe, expect, it } from "bun:test";
import { openDatabase, createOrm } from "../src/db";

// Suite-id: db — kebab-case match for filename.
// Lightweight dump helper: list tables and PRAGMA user_version of the open
// handle. Wrapped in try/catch so a dump-failure cannot mask the assertion.
const dumpDbSnapshot = (label: string, db: ReturnType<typeof openDatabase> | null) => {
  try {
    console.error(`=== [db:${label}] snapshot ===`);
    if (!db) {
      console.error(`db handle: null`);
      return;
    }
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table';")
      .all() as Array<{ name?: string }>;
    const userVersion = db.prepare("PRAGMA user_version;").get() as { user_version?: number } | undefined;
    console.error(`tables (${tables.length})=${JSON.stringify(tables.map((t) => t.name))}`);
    console.error(`user_version=${userVersion?.user_version ?? "(null)"}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("bun:sqlite database", () => {
  it("opens an in-memory database", () => {
    console.info(`[db:open] opening :memory: database`);
    const db = openDatabase(":memory:");
    try {
      expect(db).toBeTruthy();
      console.info(`[db:open] open succeeded, handle=${db ? "non-null" : "null"}`);
    } catch (err) {
      console.error(`[db:open] assertion failed`);
      dumpDbSnapshot("open-failure", db);
      throw err;
    }
    db.close();
    console.info(`[db:open] closed handle`);
  });

  it("creates a drizzle ORM from an open database", () => {
    console.info(`[db:orm] opening :memory: database for ORM`);
    const db = openDatabase(":memory:");
    try {
      const orm = createOrm(db);
      console.info(`[db:orm] createOrm returned, orm=${orm ? "non-null" : "null"}`);
      expect(orm).toBeTruthy();
    } catch (err) {
      console.error(`[db:orm] assertion failed`);
      dumpDbSnapshot("orm-failure", db);
      throw err;
    }
    db.close();
    console.info(`[db:orm] closed handle`);
  });
});
