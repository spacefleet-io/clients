/**
 * @test-id PARROT-DESKTOP-KEY-CHANGE-SQLITE-001
 * @level unit (the library rewrite main runs at the switch, on `node:sqlite`; no network)
 * @req STOR-RESEAL-01[parrot]
 * @why Parrot desktop's main has `node:sqlite` and no better-sqlite3. The key change renames the media references of
 *   the libraries it publishes through library-db-runtime's SQLite loader, which fell back to better-sqlite3 and threw
 *   "Cannot find module" at Finish (seen on the built app, 2026-11-23). Main registers `node:sqlite` first.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { registerNodeSqlite } from "@space/library-db-runtime/nodeSqlite";
import { rewriteLibraryBytesForReseal } from "@space/library-db-runtime/resealSnapshot";

const SUITE = "[PARROT-DESKTOP-KEY-CHANGE-SQLITE-001]";

const P = "0f0e0d0c-0b0a-4908-8706-050403020100";
const media = (n: number) => `media/${P}/00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempFile = () => {
  const dir = mkdtempSync(join(tmpdir(), "parrot-key-change-sqlite-"));
  dirs.push(dir);
  return join(dir, "library.sqlite");
};

/** A library file with one album whose cover and thumbnail are `media(1)` and `media(2)`. */
const libraryWithCover = (): Uint8Array => {
  const path = tempFile();
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE albums (id TEXT PRIMARY KEY, cover_object_key TEXT, cover_thumb_object_key TEXT)");
  db.prepare("INSERT INTO albums VALUES ('a1', ?, ?)").run(media(1), media(2));
  db.close();
  return new Uint8Array(readFileSync(path));
};

const albumCovers = (bytes: Uint8Array) => {
  const path = tempFile();
  writeFileSync(path, bytes);
  const db = new DatabaseSync(path);
  try {
    return { ...db.prepare("SELECT cover_object_key, cover_thumb_object_key FROM albums WHERE id = 'a1'").get() };
  } finally {
    db.close();
  }
};

describe(`${SUITE} the key change's library rewrite in Parrot main`, () => {
  it("renames a Parrot library's references to the copies once node:sqlite is registered", async () => {
    registerNodeSqlite();

    const out = await rewriteLibraryBytesForReseal(libraryWithCover(), "parrot", new Map([[media(2), media(102)]]));

    expect(out.rewrite.references).toBe(1);
    expect(albumCovers(out.bytes)).toEqual({ cover_object_key: media(1), cover_thumb_object_key: media(102) });
  });
});
