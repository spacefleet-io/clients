/**
 * @test-id PARROT-CORE-ALBUM-COVERS-001
 * @level unit (real SQLite library, fake lookup, copies, storage and publish)
 * @why PAR-META-20: every album with no cover and a known identity is asked for one on its own, so a cover an import
 *   could not fetch arrives later; a found cover is stored as two copies, an empty answer is remembered on the device
 *   so the album is asked again only after the retry delay, a failed lookup remembers nothing, the albums still to ask
 *   are reported (their covers shimmer) and a found one stays "on its way" until its batch is published, and the
 *   pass's ops follow an edit made on another device.
 * @req PAR-META-20[parrot]
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { buildParrotOpStatements, createParrotOp, parrotLibraryMigrationStatements, type ParrotLibraryOp } from "@space/parrot-library-db-definition";
import type { MusicImage } from "@space/shared/api";
import {
  PARROT_ALBUM_COVER_RETRY_MS,
  rebaseParrotAlbumCoverOps,
  runParrotAutoAlbumCovers,
  type ParrotAlbumCoversAsked,
  type ParrotAutoAlbumCoversArgs,
} from "../src/albumCovers";
import type { ParrotLibraryQuery } from "../src/manage";

const T = "[PARROT-CORE-ALBUM-COVERS]";
const meta = { id: "seed", createdAt: "2026-11-10T00:00:00.000Z" };
const NOW = 1_762_732_800_000;
const RG_MELTWAY = "4e2a6e6b-meltway-rg";
const RG_HT = "hollow-signal-rg";

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

const album = (id: string, title: string, musicId: string | null, coverObjectKey: string | null = null) =>
  createParrotOp(
    "album.upsert",
    { id, title, albumArtistId: "ar-lp", year: 2003, kind: "studio", musicId, musicEditionId: null, coverObjectKey, coverThumbObjectKey: null, createdAt: 1 },
    meta
  );

/** Linnet Park: Meltway (known, no cover), Hollow Signal (known, no cover anywhere), a demo (unknown), Live (has one). */
const seed = () => {
  const db = new Database(":memory:");
  db.transaction(() => {
    for (const sql of parrotLibraryMigrationStatements(0)) db.run(sql);
  })();
  apply(db, [
    createParrotOp("artist.upsert", { id: "ar-lp", musicId: null, name: "Linnet Park", sortName: "Linnet Park" }, meta),
    album("al-meltway", "Meltway", RG_MELTWAY),
    album("al-ht", "Hollow Signal", RG_HT),
    album("al-demo", "Demo", null),
    album("al-live", "Live", "live-rg", "assets/live"),
  ]);
  return db;
};

const MELTWAY_COVER: MusicImage = { mime: "image/jpeg", base64: Buffer.from("meltway-cover").toString("base64") };

const memoryAsked = (initial: Record<string, number> = {}): ParrotAlbumCoversAsked & { all: Map<string, number> } => {
  const all = new Map(Object.entries(initial));
  return { all, at: (id) => all.get(id) ?? null, mark: (id, at) => void all.set(id, at) };
};

const coverOf = (db: Database, id: string) =>
  db.prepare("SELECT cover_object_key AS large, cover_thumb_object_key AS thumb, title FROM albums WHERE id = ?").get(id) as { large: string | null; thumb: string | null; title: string };

const harness = (db: Database, overrides: Partial<ParrotAutoAlbumCoversArgs> = {}) => {
  const looked: string[] = [];
  const stored: string[] = [];
  const published: ParrotLibraryOp[][] = [];
  const waiting: string[][] = [];
  const asked = memoryAsked();
  let n = 0;
  const args: ParrotAutoAlbumCoversArgs = {
    query: () => queryOf(db),
    lookup: async (rg) => (looked.push(rg), { cover: rg === RG_MELTWAY ? MELTWAY_COVER : null }),
    fromBase64: (s) => new Uint8Array(Buffer.from(s, "base64")),
    makeCopies: (bytes) => ({ large: bytes, thumb: new Uint8Array([...bytes, 0]) }),
    store: async (bytes) => {
      const key = `assets/obj-${stored.length + 1}`;
      stored.push(`${key}:${bytes.length}`);
      return key;
    },
    publish: async (ops) => (published.push(ops), apply(db, ops), true),
    asked,
    onError: () => ({ kind: "skip" }),
    onWaiting: (ids) => void waiting.push([...ids]),
    now: () => NOW,
    newId: () => `op-${++n}`,
    sleep: async () => undefined,
    ...overrides,
  };
  return { args, looked, stored, published, waiting, asked };
};

describe("runParrotAutoAlbumCovers", () => {
  it("asks every known album with no cover, keeps the found one as two copies and remembers both answers", async () => {
    const db = seed();
    const h = harness(db);
    const report = await runParrotAutoAlbumCovers(h.args);
    console.info(T, "report", JSON.stringify(report), "looked", h.looked, "stored", h.stored, "waiting", JSON.stringify(h.waiting));
    expect(report).toEqual({ asked: 2, found: 1, none: 1, failed: 0, stopped: false });
    expect(h.looked.sort()).toEqual([RG_HT, RG_MELTWAY].sort());
    expect(coverOf(db, "al-meltway")).toEqual({ large: "assets/obj-1", thumb: "assets/obj-2", title: "Meltway" });
    expect(coverOf(db, "al-ht").large).toBeNull();
    expect(coverOf(db, "al-live").large).toBe("assets/live");
    expect([...h.asked.all.keys()].sort()).toEqual(["al-ht", "al-meltway"]);
  });

  it("reports the albums still to ask, and a found one stays on its way until its batch is published", async () => {
    const db = seed();
    const h = harness(db);
    await runParrotAutoAlbumCovers(h.args);
    console.info(T, "waiting steps", JSON.stringify(h.waiting));
    expect(h.waiting[0]?.sort()).toEqual(["al-ht", "al-meltway"]);
    // Title order: Hollow Signal settles as none first; found Meltway stays waiting until its batch is published.
    const beforePublish = h.waiting.findIndex((ids) => !ids.includes("al-ht"));
    expect(h.waiting[beforePublish]).toEqual(["al-meltway"]);
    expect(h.waiting.at(-1)).toEqual([]);
  });

  it("asks an album with no cover anywhere again only after the retry delay", async () => {
    const db = seed();
    const recent = harness(db, { asked: memoryAsked({ "al-ht": NOW - 1000, "al-meltway": NOW - 1000 }) });
    expect((await runParrotAutoAlbumCovers(recent.args)).asked).toBe(0);
    const old = harness(db, { asked: memoryAsked({ "al-ht": NOW - PARROT_ALBUM_COVER_RETRY_MS - 1 }) });
    const report = await runParrotAutoAlbumCovers(old.args);
    console.info(T, "after retry delay", JSON.stringify(report), old.looked);
    expect(old.looked.sort()).toEqual([RG_HT, RG_MELTWAY].sort());
  });

  it("remembers nothing when the lookup fails, so the next pass asks again", async () => {
    const db = seed();
    const h = harness(db, {
      lookup: async () => {
        throw new Error("lookup down");
      },
    });
    const report = await runParrotAutoAlbumCovers(h.args);
    console.info(T, "failed", JSON.stringify(report));
    expect(report.failed).toBe(2);
    expect(h.asked.all.size).toBe(0);
    expect(h.waiting.at(-1)).toEqual([]);
  });
});

describe("rebaseParrotAlbumCoverOps", () => {
  it("keeps an edit made on another device and drops an album given a cover meanwhile", async () => {
    const db = seed();
    const h = harness(db, { publish: async (ops) => (h.published.push(ops), true) });
    await runParrotAutoAlbumCovers(h.args);
    const ops = h.published.flat();
    apply(db, [album("al-meltway", "Meltway (Bonus Edition)", RG_MELTWAY)]);
    const rebased = await rebaseParrotAlbumCoverOps(queryOf(db), ops);
    console.info(T, "rebased", JSON.stringify(rebased.map((op) => op.payload)));
    expect(rebased).toHaveLength(1);
    expect(rebased[0]?.payload).toMatchObject({ id: "al-meltway", title: "Meltway (Bonus Edition)", coverObjectKey: "assets/obj-1" });
    apply(db, [album("al-meltway", "Meltway", RG_MELTWAY, "assets/elsewhere")]);
    expect(await rebaseParrotAlbumCoverOps(queryOf(db), ops)).toEqual([]);
  });
});
