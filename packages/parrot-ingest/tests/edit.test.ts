import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import jpeg from "jpeg-js";
import { PARROT_COVER_MAX_BYTES, parrotAlbumId, parrotArtistId, saveParrotEdit, type ParrotLibraryQuery } from "@space/parrot-core";
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

  const framedSave = async (crop: unknown) => {
    const db = seed();
    const stored: Uint8Array[] = [];
    const seen: unknown[] = [];
    const width = 1600;
    const height = 900;
    const wide = new Uint8Array(jpeg.encode({ data: Buffer.alloc(width * height * 4, 128), width, height }, 60).data);
    const result = await saveParrotEdit({
      target: edit,
      cover: { kind: "file", bytes: wide, mime: "image/jpeg", crop },
      db,
      query,
      makeCoverCopies: (bytes, given) => {
        seen.push(given);
        return makeParrotCoverCopies(bytes, log, { square: true, crop: given });
      },
      storeCover: async (bytes) => {
        stored.push(bytes);
        return `cover/new-${stored.length}`;
      },
      publish: async (ops) => {
        apply(db, ops);
        return { ok: true as const };
      },
      deleteObjects: async (keys) => ({ deleted: keys.length }),
      newId: () => crypto.randomUUID(),
      log,
      fail: log,
    });
    return { result, seen, stored };
  };

  it("@req PAR-META-22 a cover framed in Edit details is cut to the framed square", async () => {
    const { result, seen, stored } = await framedSave({ left: 0, top: 0, size: 0.5 });
    expect(result).toEqual({ ok: true });
    expect(seen).toEqual([{ left: 0, top: 0, size: 0.5 }]);
    const large = jpeg.decode(Buffer.from(stored[0]!));
    log("framed large", { width: large.width, height: large.height });
    expect([large.width, large.height]).toEqual([450, 450]);
  });

  it("@req PAR-META-22 a cover with no framing goes in as its centre square", async () => {
    const { seen, stored } = await framedSave(undefined);
    expect(seen).toEqual([null]);
    const large = jpeg.decode(Buffer.from(stored[0]!));
    expect([large.width, large.height]).toEqual([900, 900]);
  });

  it("@req PAR-META-22 a cover sent with a broken framing is not taken", async () => {
    const { seen, stored } = await framedSave({ left: 2, top: 0, size: 0.5 });
    expect(seen).toEqual([]);
    expect(stored).toEqual([]);
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

describe("saveParrotEdit for an artist", () => {
  const seedWithPhoto = () => {
    const db = seed();
    apply(db, [
      createParrotOp(
        "artist.upsert",
        { id: ARTIST, musicId: null, name: "Linnet Park", sortName: "Linnet Park", pictureObjectKey: "pic/old", pictureThumbObjectKey: "pic/old-thumb", pictureTriedAt: 5 },
        meta
      ),
    ]);
    return db;
  };
  const artistRow = (db: Database) =>
    db.prepare("SELECT id, name, picture_object_key AS k, picture_thumb_object_key AS t, picture_tried_at AS tried FROM artists WHERE id = ?").get(ARTIST);
  const errorOf = (result: { ok: boolean } | "unchanged") => (typeof result === "object" && "error" in result ? String(result.error) : "");

  const save = (db: Database, steps: string[], overrides: Partial<Parameters<typeof saveParrotEdit<Database, { ok: boolean }>>[0]> = {}) =>
    saveParrotEdit<Database, { ok: boolean }>({
      target: { kind: "artist", id: ARTIST, edit: { name: "Linnet Park" } },
      cover: { kind: "file", bytes: picture(), mime: "image/jpeg" },
      db,
      query,
      makeCoverCopies: (bytes, crop) => makeParrotCoverCopies(bytes, log, { square: true, crop }),
      storeCover: async (bytes) => {
        steps.push(`store ${bytes.length}`);
        return `pic/new-${steps.length}`;
      },
      publish: async (ops) => {
        steps.push(`publish ${ops.length}`);
        apply(db, ops);
        return { ok: true };
      },
      deleteObjects: async (keys) => {
        steps.push(`delete ${keys.join(",")}`);
        return { deleted: keys.length };
      },
      newId: () => crypto.randomUUID(),
      log,
      fail: log,
      ...overrides,
    });

  it("@req PAR-META-31 stores the new photo in two sizes, renames the artist in place and deletes the old photo after the publish", async () => {
    const db = seedWithPhoto();
    const steps: string[] = [];
    const result = await save(db, steps, { target: { kind: "artist", id: ARTIST, edit: { name: "Linnet Park Band" } } });
    log("steps", steps);
    log("row", artistRow(db));
    expect(result).toEqual({ ok: true });
    expect(steps.slice(0, 2).every((step) => step.startsWith("store "))).toBe(true);
    expect(steps[2]).toStartWith("publish ");
    expect(steps[3]).toBe("delete pic/old,pic/old-thumb");
    expect(artistRow(db)).toMatchObject({ id: ARTIST, name: "Linnet Park Band", k: "pic/new-1", t: "pic/new-2" });
    expect(db.prepare("SELECT album_artist_id AS a FROM albums WHERE id = ?").get(ALBUM)).toEqual({ a: ARTIST });
  });

  it("@req PAR-META-31 puts the automatic photo back by clearing the user's and deleting it after the publish", async () => {
    const db = seedWithPhoto();
    const steps: string[] = [];
    const result = await save(db, steps, { target: { kind: "artist", id: ARTIST, edit: { name: "Linnet Park", picture: "automatic" } }, cover: null });
    log("steps", steps);
    log("row", artistRow(db));
    expect(result).toEqual({ ok: true });
    expect(steps.filter((step) => step.startsWith("store"))).toEqual([]);
    expect(steps.at(-1)).toBe("delete pic/old,pic/old-thumb");
    expect(artistRow(db)).toMatchObject({ k: null, t: null, tried: null });
  });

  it("@req PAR-META-31 refuses a rename onto another artist and deletes the copies it had stored", async () => {
    const db = seedWithPhoto();
    apply(db, [createParrotOp("artist.upsert", { id: parrotArtistId("Guest"), musicId: null, name: "Guest", sortName: "Guest" }, meta)]);
    const steps: string[] = [];
    const result = await save(db, steps, { target: { kind: "artist", id: ARTIST, edit: { name: "guest" } } });
    log("steps", steps);
    expect(result).toMatchObject({ ok: false });
    expect(errorOf(result)).toContain("already in your library");
    expect(steps.some((step) => step.startsWith("publish"))).toBe(false);
    expect(steps.at(-1)).toBe("delete pic/new-1,pic/new-2");
    expect(artistRow(db)).toMatchObject({ name: "Linnet Park", k: "pic/old" });
  });

  it("@req PAR-META-31 keeps the old photo when an artist of the new name arrived before the publish", async () => {
    const db = seedWithPhoto();
    const steps: string[] = [];
    const result = await save(db, steps, {
      target: { kind: "artist", id: ARTIST, edit: { name: "Guest" } },
      publish: async (_ops, build) => {
        apply(db, [createParrotOp("artist.upsert", { id: parrotArtistId("Guest"), musicId: null, name: "Guest", sortName: "Guest" }, meta)]);
        const again = await build(db);
        steps.push(`publish ${again.length}`);
        apply(db, again);
        return { ok: true };
      },
    });
    log("steps", steps);
    expect(result).toMatchObject({ ok: false });
    expect(steps).toContain("publish 0");
    expect(steps.at(-1)).toBe("delete pic/new-1,pic/new-2");
    expect(steps.some((step) => step.includes("pic/old"))).toBe(false);
    expect(artistRow(db)).toMatchObject({ name: "Linnet Park", k: "pic/old" });
  });

  it("@req PAR-META-31 refuses a file or a link over the size cap before decoding or storing it", async () => {
    const steps: string[] = [];
    const huge = new Uint8Array(PARROT_COVER_MAX_BYTES + 1);
    const fromFile = await save(seedWithPhoto(), steps, { cover: { kind: "file", bytes: huge, mime: "image/jpeg" } });
    log("file over the cap", fromFile);
    expect(errorOf(fromFile)).toContain("too large");
    const declared = await save(seedWithPhoto(), steps, {
      cover: { kind: "url", url: "https://example.test/huge.jpg" },
      fetchPicture: async () => new Response("x", { headers: { "content-length": String(PARROT_COVER_MAX_BYTES + 1) } }),
    });
    log("declared link over the cap", declared);
    expect(errorOf(declared)).toContain("too large");
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const streamed = await save(seedWithPhoto(), steps, {
      cover: { kind: "url", url: "https://example.test/endless.jpg" },
      fetchPicture: async () =>
        new Response(
          new ReadableStream({
            pull: (controller) => {
              sent += chunk.length;
              controller.enqueue(chunk);
            },
          })
        ),
    });
    log("streamed link over the cap", { streamed, sent });
    expect(errorOf(streamed)).toContain("too large");
    expect(sent).toBeLessThanOrEqual(PARROT_COVER_MAX_BYTES + 2 * chunk.length);
    expect(steps).toEqual([]);
  });
});
