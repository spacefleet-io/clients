import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { ALL_LIBRARY_DB_GROUPS } from "@space/library-db-definition/manifest";
import { getGroupDdlStatements } from "@space/library-db-definition/migrations";
import { rewriteLibraryBytesForReseal } from "../src/resealSnapshot";

// Suite-id: reseal-snapshot — the library bytes a key change publishes name the re-sealed copies.

const P = "0f0e0d0c-0b0a-4908-8706-050403020100";
const media = (n: number) => `media/${P}/00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const fileBytes = (build: (db: Database) => void): Uint8Array => {
  const db = new Database(":memory:");
  build(db);
  const bytes = db.serialize();
  db.close();
  return new Uint8Array(bytes);
};

const read = <T>(bytes: Uint8Array, query: (db: Database) => T): T => {
  const db = Database.deserialize(bytes);
  try {
    return query(db);
  } finally {
    db.close();
  }
};

describe("rewriteLibraryBytesForReseal (STOR-RESEAL-01)", () => {
  // @req STOR-RESEAL-01
  it("returns Badger library bytes whose references name the copies, leaving the input untouched", async () => {
    const input = fileBytes((db) => {
      db.exec("PRAGMA foreign_keys = OFF");
      for (const group of ALL_LIBRARY_DB_GROUPS) for (const sql of getGroupDdlStatements(group)) db.exec(sql);
      const columns = db.prepare("PRAGMA table_info(media_subtitles)").all() as Array<{ name: string; notnull: number; dflt_value: unknown; type: string }>;
      const row: Record<string, string | number> = { id: "s1", object_key: media(1) };
      for (const info of columns) {
        if (info.name in row || info.notnull !== 1 || info.dflt_value !== null) continue;
        row[info.name] = /INT|REAL/i.test(info.type) ? 0 : `x-${info.name}`;
      }
      const names = Object.keys(row);
      db.prepare(`INSERT INTO media_subtitles (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(...names.map((n) => row[n]!));
    });
    const before = new Uint8Array(input);

    const out = await rewriteLibraryBytesForReseal(input, "badger", new Map([[media(1), media(101)]]));

    expect(out.rewrite.references).toBe(1);
    expect(read(out.bytes, (db) => db.prepare("SELECT object_key FROM media_subtitles").get())).toEqual({ object_key: media(101) });
    expect(input).toEqual(before);
  });

  // @req STOR-RESEAL-01
  it("rewrites a Parrot library with Parrot's columns", async () => {
    const input = fileBytes((db) => {
      db.exec("CREATE TABLE albums (id TEXT PRIMARY KEY, cover_object_key TEXT, cover_thumb_object_key TEXT)");
      db.prepare("INSERT INTO albums VALUES ('a1', ?, ?)").run(media(1), media(2));
    });

    const out = await rewriteLibraryBytesForReseal(input, "parrot", new Map([[media(2), media(102)]]));

    expect(read(out.bytes, (db) => db.prepare("SELECT cover_object_key, cover_thumb_object_key FROM albums").get())).toEqual({
      cover_object_key: media(1),
      cover_thumb_object_key: media(102),
    });
  });

  it("returns the same bytes when nothing was re-sealed", async () => {
    const input = fileBytes((db) => db.exec("CREATE TABLE t (id TEXT)"));
    const out = await rewriteLibraryBytesForReseal(input, "badger", new Map());
    expect(out.bytes).toBe(input);
    expect(out.rewrite.references).toBe(0);
  });
});
