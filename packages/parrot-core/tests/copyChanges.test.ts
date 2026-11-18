/**
 * @test-id PARROT-CORE-COPY-CHANGES-001
 * @level unit (real SQLite library and real edit planner, fake lookup, publish and device memory)
 * @why PAR-COPY-01: when our music copy changes an album's details, the user's stored copy of that album follows,
 *   unless the user edited it by hand. The app learns of it from ONE shared list per copy, asked at library sync at
 *   most once a day, and looks up only the albums it holds that are on that list: never its albums one by one, never
 *   an album the user edited, never twice a day. A first check only records where the copies stand.
 * @req PAR-COPY-01[parrot]
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { buildParrotOpStatements, createParrotOp, parrotLibraryMigrationStatements, type ParrotLibraryOp } from "@space/parrot-library-db-definition";
import type { MusicAlbum, MusicAlbumsQuery, MusicCopyChanges } from "@space/shared/api";
import {
  PARROT_COPY_CHECK_EVERY_MS,
  rebaseParrotCopyRefreshOps,
  runParrotCopyChanges,
  type ParrotCopyCheck,
  type ParrotCopyChangesArgs,
} from "../src/copyChanges";
import { planParrotEdit, type ParrotLibraryQuery } from "../src/manage";

const T = "[PARROT-CORE-COPY-CHANGES]";
const phase = (name: string) => console.info(`${T} phase: ${name}`);
const meta = { id: "seed", createdAt: "2026-11-10T00:00:00.000Z" };
const NOW = 1_763_251_200_000;
const RG_MELTWAY = "4e2f2d5b-ef0e-3c3d-8d4b-2a8f0e5c5a10";
const RG_HT = "4e2f2d5b-ef0e-3c3d-8d4b-2a8f0e5c5a20";
const RG_LIVE = "4e2f2d5b-ef0e-3c3d-8d4b-2a8f0e5c5a11";
const RG_NOT_HELD = "4e2f2d5b-ef0e-3c3d-8d4b-2a8f0e5c5a99";
const V1 = "20261104-002222";
const V2 = "20261108-002222";
const V3 = "20261111-002222";

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

const listed = (titles: string[]) => titles.map((title, i) => ({ disc: 1, number: i + 1, title, durationMs: 180_000 + i }));

const album = (id: string, title: string, musicId: string, tracks: string[]) =>
  createParrotOp(
    "album.upsert",
    {
      id,
      title,
      albumArtistId: "ar-lp",
      year: 2003,
      kind: "studio",
      musicId,
      musicEditionId: null,
      coverObjectKey: `assets/${id}`,
      coverThumbObjectKey: null,
      createdAt: 1,
      tracklist: listed(tracks),
    },
    meta
  );

const track = (id: string, albumId: string, number: number, title: string, musicId: string) =>
  createParrotOp("track.upsert", { id, albumId, disc: 1, number, title, artistId: "ar-lp", durationMs: 180_000, musicId }, meta);

/** Linnet Park: Meltway (two songs held), Hollow Signal (held), Live in Tarvo (held, not on any list). */
const seed = () => {
  const db = new Database(":memory:");
  db.transaction(() => {
    for (const sql of parrotLibraryMigrationStatements(0)) db.run(sql);
  })();
  apply(db, [
    createParrotOp("artist.upsert", { id: "ar-lp", musicId: null, name: "Linnet Park", sortName: "Linnet Park" }, meta),
    album("al-meltway", "Meltway", RG_MELTWAY, ["Forecast", "Dont Linger", "Nook"]),
    track("tr-dont-stay", "al-meltway", 2, "Dont Linger", "rec-dont-stay"),
    track("tr-nook", "al-meltway", 3, "Nook", "rec-nook"),
    album("al-ht", "Hollow Signal", RG_HT, ["Paperboat", "One Step Farther"]),
    track("tr-paperboat", "al-ht", 1, "Paperboat", "rec-paperboat"),
    album("al-live", "Live in Tarvo", RG_LIVE, ["Somewhere I Wander", "Nook"]),
  ]);
  return db;
};

/** What the new copy says about each album the lookup is asked for. */
const NEW_COPY: Record<string, MusicAlbum> = {
  [RG_MELTWAY]: {
    id: RG_MELTWAY,
    title: "Meltway (20th Anniversary)",
    year: 2003,
    kind: "Album",
    artist: { id: "5e1c0a2d-4b7f-4c3a-9d21-7a6b3c9e0f15", name: "Linnet Park" },
    tracks: [
      { disc: 1, number: 1, title: "Forecast", durationMs: 13_000, id: "rec-forecast" },
      { disc: 1, number: 2, title: "Don't Linger", durationMs: 187_000, id: "rec-dont-stay" },
      { disc: 1, number: 3, title: "Nook", durationMs: 185_000, id: "rec-nook" },
    ],
  },
  [RG_HT]: {
    id: RG_HT,
    title: "Hollow Signal (fixed)",
    year: 2000,
    kind: "Album",
    artist: { id: "5e1c0a2d-4b7f-4c3a-9d21-7a6b3c9e0f15", name: "Linnet Park" },
    tracks: [{ disc: 1, number: 1, title: "Paperboat (fixed)", durationMs: 184_000, id: "rec-paperboat" }],
  },
};

const memoryOf = (initial: ParrotCopyCheck) => {
  const writes: ParrotCopyCheck[] = [];
  let state = initial;
  return {
    writes,
    current: () => state,
    memory: { read: () => state, write: (next: ParrotCopyCheck) => void (writes.push(next), (state = next)) },
  };
};

const harness = (db: Database, initial: ParrotCopyCheck, answer: MusicCopyChanges, overrides: Partial<ParrotCopyChangesArgs> = {}) => {
  const asked: (string | null)[] = [];
  const looked: MusicAlbumsQuery[] = [];
  const published: ParrotLibraryOp[][] = [];
  const memory = memoryOf(initial);
  let n = 0;
  const args: ParrotCopyChangesArgs = {
    query: () => queryOf(db),
    changes: async (since) => (asked.push(since), answer),
    albums: async (question) => {
      looked.push(question);
      const found = question.id ? NEW_COPY[question.id] : undefined;
      return { results: found ? [found] : [] };
    },
    publish: async (ops) => (published.push(ops), apply(db, ops), true),
    memory: memory.memory,
    onError: () => ({ kind: "skip" }),
    now: () => NOW,
    newId: () => `op-${++n}`,
    sleep: async () => undefined,
    ...overrides,
  };
  return { args, asked, looked, published, memory };
};

const albumOf = (db: Database, id: string) =>
  db.prepare("SELECT title, year, cover_object_key AS cover, tracklist FROM albums WHERE id = ?").get(id) as { title: string; year: number | null; cover: string | null; tracklist: string | null };
const trackTitle = (db: Database, id: string) => (db.prepare("SELECT title FROM tracks WHERE id = ?").get(id) as { title: string }).title;

const CHANGED: MusicCopyChanges = { version: V2, changes: [{ version: V2, albums: [RG_MELTWAY, RG_NOT_HELD, RG_HT] }] };

describe("runParrotCopyChanges", () => {
  it("records where the copies stand on a first check, and looks nothing up", async () => {
    phase("first check: no version remembered on this device");
    const db = seed();
    const h = harness(db, { checkedAt: null, version: null }, { version: V1, changes: [] });
    const report = await runParrotCopyChanges(h.args);
    console.info(T, "report", JSON.stringify(report), "asked", h.asked, "memory", JSON.stringify(h.memory.current()));
    expect(h.asked).toEqual([null]);
    expect(h.looked).toEqual([]);
    expect(h.memory.current()).toEqual({ checkedAt: NOW, version: V1 });
    expect(report).toMatchObject({ checked: true, version: V1, refreshed: 0 });
  });

  it("refreshes only the held, unedited albums the new copy's list names, once, and remembers the copy", async () => {
    const db = seed();
    phase("the user edits Hollow Signal by hand (its title)");
    const edit = await planParrotEdit(
      queryOf(db),
      { kind: "album", id: "al-ht", edit: { title: "Hollow Signal (my copy)", albumArtist: "Linnet Park", year: 2000, genre: null } },
      { now: NOW, newId: () => "edit-1", ids: { artistId: () => "ar-lp", albumId: () => "al-ht" } }
    );
    apply(db, edit.ops);

    phase("sync: a new copy came out since this device's last check, a day ago");
    const h = harness(db, { checkedAt: NOW - PARROT_COPY_CHECK_EVERY_MS - 1, version: V1 }, CHANGED);
    const report = await runParrotCopyChanges(h.args);
    console.info(T, "report", JSON.stringify(report), "asked", h.asked, "looked", JSON.stringify(h.looked));

    phase("one list asked, since the remembered copy; one album looked up, by its id and the new copy");
    expect(h.asked).toEqual([V1]);
    expect(h.looked).toEqual([{ artist: "Linnet Park", album: "Meltway", id: RG_MELTWAY, copyVersion: V2, limit: 1 }]);
    expect(report).toEqual({ checked: true, version: V2, listed: 3, held: 2, refreshed: 1, unchanged: 0, edited: 1, failed: 0, stopped: false });

    phase("Meltway follows the new copy; its cover and the songs it does not list stay");
    const meltway = albumOf(db, "al-meltway");
    expect(meltway.title).toBe("Meltway (20th Anniversary)");
    expect(meltway.cover).toBe("assets/al-meltway");
    expect(JSON.parse(meltway.tracklist ?? "[]")).toEqual([
      { disc: 1, number: 1, title: "Forecast", durationMs: 13_000 },
      { disc: 1, number: 2, title: "Don't Linger", durationMs: 187_000 },
      { disc: 1, number: 3, title: "Nook", durationMs: 185_000 },
    ]);
    // A song whose title followed the old track list follows the new one.
    expect(trackTitle(db, "tr-dont-stay")).toBe("Don't Linger");
    expect(trackTitle(db, "tr-nook")).toBe("Nook");

    phase("the hand-edited album keeps the user's edit; the album not on the list is untouched");
    expect(albumOf(db, "al-ht").title).toBe("Hollow Signal (my copy)");
    expect(trackTitle(db, "tr-paperboat")).toBe("Paperboat");
    expect(albumOf(db, "al-live").title).toBe("Live in Tarvo");
    expect(h.memory.current()).toEqual({ checkedAt: NOW, version: V2 });
  });

  it("checks at most once a day", async () => {
    const db = seed();
    const h = harness(db, { checkedAt: NOW - 60 * 60_000, version: V1 }, CHANGED);
    const report = await runParrotCopyChanges(h.args);
    console.info(T, "within a day:", JSON.stringify(report));
    expect(report.checked).toBe(false);
    expect(h.asked).toEqual([]);
    expect(h.looked).toEqual([]);
    expect(h.memory.writes).toEqual([]);
  });

  it("downloads each list it missed, and keeps a song the user renamed", async () => {
    const db = seed();
    phase("the user renames one Meltway song by hand");
    const edit = await planParrotEdit(
      queryOf(db),
      { kind: "track", id: "tr-dont-stay", edit: { title: "Dont Linger (demo)", artist: "Linnet Park", album: "Meltway", number: 2, disc: 1, year: 2003, genre: null } },
      { now: NOW, newId: () => "edit-2", ids: { artistId: () => "ar-lp", albumId: () => "al-meltway" } }
    );
    apply(db, edit.ops);
    const answer: MusicCopyChanges = { version: V3, changes: [{ version: V2, albums: [RG_HT] }, { version: V3, albums: [RG_MELTWAY] }] };
    const h = harness(db, { checkedAt: NOW - 3 * PARROT_COPY_CHECK_EVERY_MS, version: V1 }, answer);
    const report = await runParrotCopyChanges(h.args);
    console.info(T, "report", JSON.stringify(report), "looked", h.looked.map((q) => q.id));
    expect(h.looked.map((q) => q.id).sort()).toEqual([RG_HT, RG_MELTWAY].sort());
    expect(albumOf(db, "al-ht").title).toBe("Hollow Signal (fixed)");
    expect(trackTitle(db, "tr-paperboat")).toBe("Paperboat (fixed)");
    expect(albumOf(db, "al-meltway").title).toBe("Meltway (20th Anniversary)");
    expect(trackTitle(db, "tr-dont-stay")).toBe("Dont Linger (demo)");
    expect(h.memory.current()).toEqual({ checkedAt: NOW, version: V3 });
  });

  it("keeps the old copy's mark when a lookup failed, and spends nothing below the ticket floor", async () => {
    const db = seed();
    phase("a lookup fails: checked today, the copy is asked again tomorrow");
    const failing = harness(db, { checkedAt: null, version: V1 }, CHANGED, {
      albums: async () => {
        throw new Error("lookup down");
      },
    });
    const report = await runParrotCopyChanges(failing.args);
    console.info(T, "failed", JSON.stringify(report));
    expect(report).toMatchObject({ failed: 2, refreshed: 0 });
    expect(failing.memory.current()).toEqual({ checkedAt: NOW, version: V1 });
    expect(albumOf(db, "al-meltway").title).toBe("Meltway");

    phase("below the ticket floor: not even the list is asked, nothing remembered");
    const poor = harness(db, { checkedAt: null, version: V1 }, CHANGED, { canSpend: () => false });
    const stopped = await runParrotCopyChanges(poor.args);
    console.info(T, "below floor", JSON.stringify(stopped));
    expect(poor.asked).toEqual([]);
    expect(poor.memory.writes).toEqual([]);
    expect(stopped.stopped).toBe(true);
  });
});

describe("rebaseParrotCopyRefreshOps", () => {
  it("drops a refresh of an album edited by hand on another device meanwhile", async () => {
    const db = seed();
    phase("this device plans Meltway's refresh, but its publish is refused (the library moved on)");
    const refused: ParrotLibraryOp[][] = [];
    const answer: MusicCopyChanges = { version: V2, changes: [{ version: V2, albums: [RG_MELTWAY] }] };
    const h = harness(db, { checkedAt: null, version: V1 }, answer, { publish: async (planned) => (refused.push(planned), false) });
    const report = await runParrotCopyChanges(h.args);
    console.info(T, "refused publish", JSON.stringify(report));
    expect(report.stopped).toBe(true);
    expect(h.memory.writes).toEqual([]);
    const ops = refused[0] ?? [];
    expect(ops.length).toBeGreaterThan(0);
    phase("another device edits Meltway before this one publishes");
    const edit = await planParrotEdit(
      queryOf(db),
      { kind: "album", id: "al-meltway", edit: { title: "Meltway (mine)", albumArtist: "Linnet Park", year: 2003, genre: null } },
      { now: NOW, newId: () => "edit-3", ids: { artistId: () => "ar-lp", albumId: () => "al-meltway" } }
    );
    apply(db, edit.ops);
    const rebased = await rebaseParrotCopyRefreshOps(queryOf(db), ops);
    console.info(T, "rebased", rebased.map((op) => op.type));
    expect(rebased).toEqual([]);
  });
});
