/**
 * @test-id PARROT-CORE-ARTIST-PICTURES-001
 * @level unit (real SQLite library, fake lookup, copies, storage and publish)
 * @why PAR-META-15: every artist with an id in the metadata and no photo is asked for one on its own; a found photo is
 *   stored as two copies with its credit, an empty answer is recorded so the artist is not asked again at the next
 *   launch, a failed lookup records nothing (asked again next pass), an artist without an id gets the one of its matched
 *   album or song only when the match bears its name (never replacing an id already set), and the pass's ops follow a
 *   rename made on another device. PAR-META-20: the pass reports the artists it still has to answer for, an artist
 *   leaving that list only once its answer is kept (or its lookup failed), so a photo never looks missing while it is
 *   on its way.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { buildParrotOpStatements, createParrotOp, parrotLibraryMigrationStatements, type ParrotLibraryOp } from "@space/parrot-library-db-definition";
import type { MusicArtistImage } from "@space/shared/api";
import {
  PARROT_ARTIST_PICTURE_RETRY_MS,
  parrotArtistPictureCredit,
  rebaseParrotArtistPictureOps,
  runParrotAutoArtistPictures,
  type ParrotAutoArtistPicturesArgs,
} from "../src/artistPictures";
import type { ParrotLibraryQuery } from "../src/manage";
import { ARTISTS_SQL, type ArtistRow } from "../src/queries";

const T = "[PARROT-CORE-ARTIST-PICTURES]";
const meta = { id: "seed", createdAt: "2026-11-10T00:00:00.000Z" };
const NOW = 1_762_732_800_000;
const ID_LP = "5e1c0a2d-4b7f-4c3a-9d21-7a6b3c9e0f15";
const ID_DUSK = "056e4f3e-d505-4dad-8ec1-d04f521cbb56";

const apply = (db: Database, ops: readonly ParrotLibraryOp[]) =>
  db.transaction(() => {
    for (const op of ops)
      for (const statements of Object.values(buildParrotOpStatements(op)))
        for (const { sql, params } of statements ?? []) db.prepare(sql).run(...(params as never[]));
  })();

const queryOf =
  (db: Database): ParrotLibraryQuery =>
  <Row,>(sql: string, params: readonly (string | number | null)[] = []) =>
    db.prepare(sql).all(...(params as never[])) as Row[];

/** Linnet Park (an id, has a photo), Dusk Pike (an id, no photo anywhere) and a local band without an id. */
const seed = () => {
  const db = new Database(":memory:");
  db.transaction(() => {
    for (const sql of parrotLibraryMigrationStatements(0)) db.run(sql);
  })();
  const album = (id: string, title: string, albumArtistId: string) =>
    createParrotOp(
      "album.upsert",
      { id, title, albumArtistId, year: 2003, kind: "studio", musicId: null, musicEditionId: null, coverObjectKey: null, coverThumbObjectKey: null, createdAt: 1 },
      meta
    );
  apply(db, [
    createParrotOp("artist.upsert", { id: "ar-lp", musicId: ID_LP, name: "Linnet Park", sortName: "Linnet Park" }, meta),
    createParrotOp("artist.upsert", { id: "ar-dusk", musicId: ID_DUSK, name: "Dusk Pike", sortName: "Dusk Pike" }, meta),
    createParrotOp("artist.upsert", { id: "ar-local", musicId: null, name: "The Garage Band", sortName: "Garage Band" }, meta),
    album("al-meltway", "Meltway", "ar-lp"),
    album("al-lowlands", "Lowlands", "ar-dusk"),
    album("al-demo", "Demo", "ar-local"),
  ]);
  return db;
};

const LP_PHOTO: MusicArtistImage = {
  mime: "image/jpeg",
  base64: Buffer.from("lp-photo").toString("base64"),
  credit: { author: "Jane Doe", licence: "CC BY-SA 4.0", licenceUrl: "https://creativecommons.org/licenses/by-sa/4.0" },
};

let n = 0;
const harness = (db: Database, overrides: Partial<ParrotAutoArtistPicturesArgs> = {}) => {
  const asked: string[] = [];
  const stored: string[] = [];
  const published: ParrotLibraryOp[][] = [];
  const args: ParrotAutoArtistPicturesArgs = {
    query: () => queryOf(db),
    lookup: async (artistId) => (asked.push(artistId), { image: artistId === ID_LP ? LP_PHOTO : null }),
    albums: async () => ({ results: [] }),
    recordings: async () => ({ results: [] }),
    fromBase64: (s) => new Uint8Array(Buffer.from(s, "base64")),
    makeCopies: (bytes) => ({ large: bytes, thumb: new Uint8Array([...bytes, 0]) }),
    store: async (bytes) => {
      const key = `assets/obj-${stored.length + 1}`;
      stored.push(`${key}:${bytes.length}`);
      return key;
    },
    publish: async (ops) => (published.push(ops), apply(db, ops), true),
    onError: () => ({ kind: "skip" }),
    now: () => NOW,
    newId: () => `op-${++n}`,
    sleep: async () => undefined,
    gapMs: 0,
    ...overrides,
  };
  return { args, asked, stored, published };
};

const artists = (db: Database) => queryOf(db)<ArtistRow>(ARTISTS_SQL) as ArtistRow[];
const triedAt = (db: Database, id: string) => db.prepare("SELECT picture_tried_at AS t FROM artists WHERE id = ?").get(id) as { t: number | null };
const musicIdOf = (db: Database, id: string) => (db.prepare("SELECT music_id FROM artists WHERE id = ?").get(id) as { music_id: string | null }).music_id;

describe("runParrotAutoArtistPictures", () => {
  it("stores a found photo as two copies with its credit and records the empty answer", async () => {
    const db = seed();
    const h = harness(db);
    const report = await runParrotAutoArtistPictures(h.args);
    console.info(`${T} first pass report=${JSON.stringify(report)} asked=${JSON.stringify(h.asked)} stored=${JSON.stringify(h.stored)}`);
    expect(report).toEqual({ asked: 2, found: 1, none: 1, failed: 0, identified: 0, unidentified: 1, stopped: false });
    expect(h.asked.sort()).toEqual([ID_DUSK, ID_LP].sort());
    expect(h.stored).toHaveLength(2);
    const byId = Object.fromEntries(artists(db).map((row) => [row.id, row]));
    expect(byId["ar-lp"]).toMatchObject({ name: "Linnet Park", pictureObjectKey: expect.stringMatching(/^assets\/obj-/), pictureThumbObjectKey: expect.stringMatching(/^assets\/obj-/) });
    expect(parrotArtistPictureCredit(byId["ar-lp"]!)).toEqual(LP_PHOTO.credit);
    expect(byId["ar-dusk"]).toMatchObject({ pictureObjectKey: null, pictureThumbObjectKey: null });
    expect(parrotArtistPictureCredit(byId["ar-dusk"]!)).toBeNull();
    expect(byId["ar-local"]).toMatchObject({ pictureObjectKey: null });
    expect(triedAt(db, "ar-lp").t).toBe(NOW);
    expect(triedAt(db, "ar-dusk").t).toBe(NOW);
    expect(triedAt(db, "ar-local").t).toBe(NOW);
    expect(musicIdOf(db, "ar-local")).toBeNull();
  });

  it("@req PAR-META-20 reports the artists still to answer for until each answer is kept", async () => {
    const db = seed();
    const waiting: string[][] = [];
    const published: string[][] = [];
    const h = harness(db, {
      batchSize: 2,
      onWaiting: (ids) => void waiting.push([...ids].sort()),
      publish: async (ops) => {
        published.push(ops.map((op) => (op.payload as { id: string }).id));
        waiting.push(["<publish>"]);
        apply(db, ops);
        return true;
      },
    });
    await runParrotAutoArtistPictures(h.args);
    console.info(`${T} waiting steps=${JSON.stringify(waiting)} published=${JSON.stringify(published)}`);
    expect(waiting[0]).toEqual(["ar-dusk", "ar-local", "ar-lp"]);
    // Nothing leaves the list before the publish that keeps its answer.
    const firstPublish = waiting.findIndex((ids) => ids[0] === "<publish>");
    expect(waiting.slice(1, firstPublish)).toEqual([]);
    expect(waiting.at(-1)).toEqual([]);
  });

  it("@req PAR-META-20 takes an artist whose lookup failed off the waiting list at once", async () => {
    const db = seed();
    const waiting: string[][] = [];
    const h = harness(db, {
      lookup: async () => {
        throw new Error("offline");
      },
      onWaiting: (ids) => void waiting.push([...ids].sort()),
    });
    await runParrotAutoArtistPictures(h.args);
    console.info(`${T} failing waiting steps=${JSON.stringify(waiting)}`);
    expect(waiting).toContainEqual(["ar-local", "ar-lp"]);
    expect(waiting.at(-1)).toEqual([]);
  });

  // @req UX-JOBS-02[parrot]
  it("says how far the pass is before each artist, for the Jobs panel's quiet line", async () => {
    const h = harness(seed());
    const progress: Array<[number, number]> = [];
    await runParrotAutoArtistPictures({ ...h.args, onProgress: (done, total) => progress.push([done, total]) });
    console.info(`${T} progress=${JSON.stringify(progress)}`);
    expect(progress.length).toBeGreaterThan(0);
    const total = progress[0]![1];
    expect(progress).toEqual(Array.from({ length: total }, (_, index) => [index, total]));
  });

  it("does not ask again before the retry delay, then asks the artist with no photo again", async () => {
    const db = seed();
    await runParrotAutoArtistPictures(harness(db).args);
    const soon = harness(db, { now: () => NOW + 60_000 });
    const second = await runParrotAutoArtistPictures(soon.args);
    console.info(`${T} next launch report=${JSON.stringify(second)} asked=${JSON.stringify(soon.asked)}`);
    expect(second.asked).toBe(0);
    expect(soon.published).toEqual([]);
    const later = harness(db, { now: () => NOW + PARROT_ARTIST_PICTURE_RETRY_MS + 1 });
    const third = await runParrotAutoArtistPictures(later.args);
    console.info(`${T} after retry delay report=${JSON.stringify(third)} asked=${JSON.stringify(later.asked)}`);
    expect(later.asked).toEqual([ID_DUSK]);
  });

  it("records nothing for a failed lookup, so the next pass asks again", async () => {
    const db = seed();
    const failing = harness(db, {
      lookup: async () => {
        throw new Error("503 busy");
      },
      albums: async () => {
        throw new Error("503 busy");
      },
    });
    const report = await runParrotAutoArtistPictures(failing.args);
    console.info(`${T} failing report=${JSON.stringify(report)} published=${failing.published.length}`);
    expect(report).toEqual({ asked: 2, found: 0, none: 0, failed: 3, identified: 0, unidentified: 0, stopped: false });
    expect(failing.published).toEqual([]);
    expect(triedAt(db, "ar-lp").t).toBeNull();
    const retry = harness(db);
    await runParrotAutoArtistPictures(retry.args);
    expect(retry.asked).toHaveLength(2);
  });

  it("follows a rename made elsewhere and drops artists deleted meanwhile when its ops are planned again", async () => {
    const db = seed();
    const h = harness(db, { publish: async (ops) => (h.published.push(ops), true) });
    await runParrotAutoArtistPictures(h.args);
    const ops = h.published.flat();
    apply(db, [
      createParrotOp("artist.upsert", { id: "ar-lp", musicId: ID_LP, name: "LINNET PARK", sortName: "LINNET PARK" }, meta),
      createParrotOp("album.delete", { id: "al-lowlands" }, meta),
      createParrotOp("artist.delete", { id: "ar-dusk" }, meta),
    ]);
    const rebased = await rebaseParrotArtistPictureOps(queryOf(db), ops);
    console.info(`${T} rebased=${JSON.stringify(rebased.map((op) => op.payload))}`);
    // The local band's "no id found" answer is kept too.
    const payloads = rebased.flatMap((op) => (op.type === "artist.upsert" ? [op.payload] : []));
    expect(payloads.map((payload) => payload.id).sort()).toEqual(["ar-local", "ar-lp"]);
    expect(payloads.find((payload) => payload.id === "ar-lp")).toMatchObject({ name: "LINNET PARK", pictureCredit: LP_PHOTO.credit });
  });

  // @req PAR-META-15: an existing artist without an id (none of the importer's ever had one) gets it from its matched album.
  it("gives an artist without an id the id of its matched album's artist, then its photo", async () => {
    const db = seed();
    db.run("UPDATE artists SET music_id = NULL WHERE id = 'ar-lp'");
    const questions: unknown[] = [];
    const h = harness(db, {
      albums: async (question) => (
        questions.push(question),
        {
          results:
            question.album === "Meltway"
              ? [{ id: "album-meltway", title: "Meltway", artist: { id: ID_LP, name: "Linnet Park" }, year: 2003, tracks: [] } as never]
              : // A match credited to another artist gives nothing: never an id from the name alone.
                [{ id: "album-other", title: "Demo", artist: { id: ID_DUSK, name: "Garage Band Tribute" }, year: 2001, tracks: [] } as never],
        }
      ),
    });
    const report = await runParrotAutoArtistPictures(h.args);
    console.info(`${T} backfill report=${JSON.stringify(report)} questions=${JSON.stringify(questions)} asked=${JSON.stringify(h.asked)}`);
    expect(report).toMatchObject({ identified: 1, unidentified: 1, found: 1 });
    const byId = Object.fromEntries(artists(db).map((row) => [row.id, row]));
    expect(byId["ar-lp"]).toMatchObject({ pictureObjectKey: expect.stringMatching(/^assets\/obj-/) });
    expect(musicIdOf(db, "ar-lp")).toBe(ID_LP);
    expect(parrotArtistPictureCredit(byId["ar-lp"]!)).toEqual(LP_PHOTO.credit);
    expect(musicIdOf(db, "ar-local")).toBeNull();
    expect(h.asked).not.toContain(undefined);
  });

  // @req PAR-META-15: an artist with songs but no album of its own is identified by one of its matched songs.
  it("identifies an artist with only songs from its matched recording", async () => {
    const db = seed();
    apply(db, [
      createParrotOp("artist.upsert", { id: "ar-feat", musicId: null, name: "Jun-O", sortName: "Jun-O" }, meta),
      createParrotOp(
        "track.upsert",
        { id: "t-nook", albumId: "al-meltway", disc: 1, number: 13, title: "Nook/Reprise", artistId: "ar-feat", durationMs: 205_000, musicId: null },
        meta
      ),
    ]);
    const JAY = "f82bcf78-5b69-4622-a5ef-73800768d9ac";
    const h = harness(db, {
      recordings: async (question) => ({
        results: question.title === "Nook/Reprise" ? [{ id: "rec", title: "Nook/Reprise", artist: { id: JAY, name: "JUN-O" }, album: null, durationMs: 205_000 } as never] : [],
      }),
    });
    await runParrotAutoArtistPictures(h.args);
    console.info(`${T} song-only artist id=${musicIdOf(db, "ar-feat")}`);
    expect(musicIdOf(db, "ar-feat")).toBe(JAY);
  });

  // @req PAR-META-15: an id once set is never replaced by a later import or edit.
  it("keeps an artist's id when a later upsert brings none or another", () => {
    const db = seed();
    apply(db, [
      createParrotOp("artist.upsert", { id: "ar-lp", musicId: null, name: "Linnet Park", sortName: "Linnet Park" }, meta),
      createParrotOp("artist.upsert", { id: "ar-lp", musicId: ID_DUSK, name: "Linnet Park", sortName: "Linnet Park" }, meta),
    ]);
    expect(musicIdOf(db, "ar-lp")).toBe(ID_LP);
  });
});
