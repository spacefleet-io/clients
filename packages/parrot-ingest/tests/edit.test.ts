import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import jpeg from "jpeg-js";
import { parrotAlbumId, parrotArtistId, saveParrotEdit, type ParrotLibraryQuery } from "@space/parrot-core";
import { buildParrotOpStatements, createParrotOp, parrotLibraryMigrationStatements, type ParrotLibraryOp } from "@space/parrot-library-db-definition";
import { makeParrotCoverCopies } from "../src/covers";
import { testLog } from "./helpers";

const log = testLog("PARROT-INGEST-EDIT-001");
const meta = { id: "seed", createdAt: "2026-11-09T00:00:00.000Z" };

const apply = (db: Database, ops: readonly ParrotLibraryOp[]) =>
  db.transaction(() => {
    for (const op of ops)
      for (const statements of Object.values(buildParrotOpStatements(op)))
        for (const { sql, params } of statements ?? []) db.prepare(sql).run(...(params as never[]));
  })();

const query =
  (db: Database): ParrotLibraryQuery =>
  <Row,>(sql: string, params: readonly (string | number | null)[] = []) =>
    db.prepare(sql).all(...(params as never[])) as Row[];

const ARTIST = parrotArtistId("Linnet Park");
const ALBUM = parrotAlbumId(ARTIST, "Meltway");

const seed = () => {
  const db = new Database(":memory:");
  db.transaction(() => {
    for (const sql of parrotLibraryMigrationStatements(0)) db.run(sql);
  })();
  apply(db, [
    createParrotOp("artist.upsert", { id: ARTIST, musicId: null, name: "Linnet Park", sortName: "Linnet Park" }, meta),
    createParrotOp(
      "album.upsert",
      { id: ALBUM, title: "Meltway", albumArtistId: ARTIST, year: 2004, kind: "studio", musicId: null, musicEditionId: null, coverObjectKey: "cover/old", coverThumbObjectKey: "cover/old-thumb", createdAt: 1 },
      meta
    ),
  ]);
  return db;
};

const picture = () => {
  const width = 1600;
  const height = 1600;
  return new Uint8Array(jpeg.encode({ data: Buffer.alloc(width * height * 4, 128), width, height }, 60).data);
};

const edit = { kind: "album", id: ALBUM, edit: { title: "Meltway", albumArtist: "Linnet Park", year: 2003, genre: "Nu metal" } };

const run = (db: Database, publishOk: boolean, steps: string[]) =>
  saveParrotEdit({
    target: edit,
    cover: { kind: "file", bytes: picture(), mime: "image/jpeg" },
    db,
    query,
    makeCoverCopies: (bytes) => makeParrotCoverCopies(bytes, log),
    storeCover: async (bytes) => {
      steps.push(`store ${bytes.length > 0 ? "copy" : "empty"}`);
      return `cover/new-${steps.length}`;
    },
    publish: async (ops) => {
      steps.push(`publish ${ops.length}`);
      if (publishOk) apply(db, ops);
      return publishOk ? { ok: true as const } : { ok: false as const };
    },
    deleteObjects: async (keys) => {
      steps.push(`delete ${keys.join(",")}`);
      return { deleted: keys.length };
    },
    newId: () => crypto.randomUUID(),
    log,
    fail: log,
  });

describe("saveParrotEdit", () => {
  it("@req PAR-META-16 stores the new cover in two sizes before the publish and deletes the old copies only after it", async () => {
    const db = seed();
    const steps: string[] = [];
    const result = await run(db, true, steps);
    log("steps", steps);
    expect(result).toEqual({ ok: true });
    expect(steps.slice(0, 2)).toEqual(["store copy", "store copy"]);
    expect(steps[2]).toStartWith("publish ");
    expect(steps[3]).toBe("delete cover/old,cover/old-thumb");
    expect(db.prepare("SELECT id, year, cover_object_key AS c FROM albums").all()).toEqual([{ id: ALBUM, year: 2003, c: "cover/new-1" }]);
  });

  it("@req PAR-META-16 keeps the old cover in storage when the publish fails", async () => {
    const steps: string[] = [];
    const result = await run(seed(), false, steps);
    log("steps", steps);
    expect(result).toEqual({ ok: false });
    expect(steps.some((step) => step.startsWith("delete"))).toBe(false);
  });

  it("@req PAR-META-16 refuses a malformed edit without storing anything", async () => {
    const steps: string[] = [];
    const result = await saveParrotEdit({
      target: { kind: "album", id: ALBUM, edit: { title: " " } },
      cover: null,
      db: seed(),
      query,
      makeCoverCopies: () => null,
      storeCover: async () => {
        steps.push("store");
        return "x";
      },
      publish: async () => ({ ok: true }),
      deleteObjects: async () => ({}),
      newId: () => "id",
      log,
      fail: log,
    });
    expect(result).toEqual({ ok: false, error: "invalid edit" });
    expect(steps).toEqual([]);
  });
});
