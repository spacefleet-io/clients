/**
 * @test-id PARROT-CORE-AUTO-LYRICS-001
 * @level unit (real SQLite library, fake lookup and publish)
 * @why PAR-LYR-01: songs whose file had no words are looked up on their own, one at a time with a gap, without a
 *   button press; found words and the final "no lyrics" state are kept in the library in batches, a song is never
 *   asked twice by the automatic pass, the file's own lyrics are never asked over, a failed lookup is asked again on
 *   the next pass, and the pass stops on sign-out.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { buildParrotOpStatements, createParrotOp, parrotLibraryMigrationStatements, type ParrotLibraryOp } from "@space/parrot-library-db-definition";
import type { MusicLyrics, MusicLyricsQuery } from "@space/shared/api";
import { createParrotLyricsPending, parrotAutoLyricsOnError, queueParrotAutoLyrics, runParrotAutoLyrics, type ParrotAutoLyricsArgs } from "../src/autoLyrics";
import { parrotLyricsOrSearching, readParrotLyrics } from "../src/lyrics";
import type { ParrotLibraryQuery } from "../src/manage";

const T = "[PARROT-CORE-AUTO-LYRICS]";
const meta = { id: "seed", createdAt: "2026-11-10T00:00:00.000Z" };

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

const read = (db: Database, trackId: string) => readParrotLyrics((sql, params) => db.prepare(sql).all(...(params as never[])) as never[], trackId);

/** Meltway: Nook and Fable (no words in their files), Breaking the Tide (its file's words), and a song with no artist name. */
const seed = (extra = 0) => {
  const db = new Database(":memory:");
  db.transaction(() => {
    for (const sql of parrotLibraryMigrationStatements(0)) db.run(sql);
  })();
  const song = (id: string, number: number, title: string, artistId = "ar-lp") =>
    createParrotOp("track.upsert", { id, albumId: "al-meltway", disc: 1, number, title, artistId, durationMs: 180_000, musicId: null }, meta);
  apply(db, [
    createParrotOp("artist.upsert", { id: "ar-lp", musicId: null, name: "Linnet Park", sortName: "Linnet Park" }, meta),
    createParrotOp("artist.upsert", { id: "ar-blank", musicId: null, name: " ", sortName: " " }, meta),
    createParrotOp(
      "album.upsert",
      { id: "al-meltway", title: "Meltway", albumArtistId: "ar-lp", year: 2003, kind: "studio", musicId: null, musicEditionId: null, coverObjectKey: null, coverThumbObjectKey: null, createdAt: 1 },
      meta
    ),
    song("t-nook", 13, "Nook"),
    song("t-fable", 7, "Fable"),
    song("t-habit", 10, "Breaking the Tide"),
    song("t-anon", 1, "Untitled", "ar-blank"),
    ...Array.from({ length: extra }, (_, i) => song(`t-x${String(i).padStart(2, "0")}`, 20 + i, `Extra ${i}`)),
    createParrotOp("lyrics.set", { trackId: "t-habit", plain: "Habit words from the file", synced: null, source: "file", fetchedAt: 1 }, meta),
  ]);
  return db;
};

const answers: Record<string, MusicLyrics> = {
  Nook: { plain: null, synced: "[00:01.00]I left the porch light on for you" },
  Fable: { plain: null, synced: null },
};

let n = 0;
const harness = (db: Database, overrides: Partial<ParrotAutoLyricsArgs> = {}) => {
  const asked: MusicLyricsQuery[] = [];
  const published: ParrotLibraryOp[][] = [];
  const sleeps: number[] = [];
  const args: ParrotAutoLyricsArgs = {
    query: () => queryOf(db),
    lookup: async (question) => (asked.push(question), answers[question.title] ?? { plain: null, synced: null, source: null }),
    publish: async (ops) => (published.push(ops), apply(db, ops), true),
    onError: () => ({ kind: "skip" }),
    now: () => 1_762_732_800_000,
    newId: () => `op-${++n}`,
    sleep: async (ms) => void sleeps.push(ms),
    gapMs: 1500,
    ...overrides,
  };
  return { args, asked, published, sleeps };
};

// @req PAR-LYR-01[parrot]
describe("[parrot] automatic lyrics lookup", () => {
  it("looks up every song without words, one at a time with a gap, and keeps words and 'no lyrics'", async () => {
    const db = seed();
    const h = harness(db);
    const report = await runParrotAutoLyrics(h.args);
    console.info(T, "report", report, "asked", h.asked.map((q) => q.title), "sleeps", h.sleeps);
    expect(report).toEqual({ asked: 2, found: 1, none: 1, failed: 0, stopped: false });
    expect(h.asked.map((q) => q.title)).toEqual(["Fable", "Nook"]);
    expect(h.sleeps).toEqual([1500]);
    expect(h.published).toHaveLength(1);
    expect(read(db, "t-nook")).toEqual({ synced: [{ ms: 1000, text: "I left the porch light on for you" }], plain: null, fetched: true });
    expect(read(db, "t-fable")).toEqual({ synced: null, plain: null, fetched: true, notFound: true });
    expect(read(db, "t-habit")).toEqual({ synced: null, plain: "Habit words from the file", fetched: false });
    expect(read(db, "t-anon")).toBeNull();
  });

  // @req UX-JOBS-02[parrot]
  it("says how far the pass is before each song, for the Jobs panel's quiet line", async () => {
    const h = harness(seed());
    const progress: Array<[number, number]> = [];
    await runParrotAutoLyrics({ ...h.args, onProgress: (done, total) => progress.push([done, total]) });
    console.info(T, "progress", progress);
    // Three songs never looked up (one has no artist to ask with, so it is settled without a lookup).
    expect(progress).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
    ]);
  });

  it("asks nothing on the next pass: every song was looked up once", async () => {
    const db = seed();
    await runParrotAutoLyrics(harness(db).args);
    const again = harness(db);
    const report = await runParrotAutoLyrics(again.args);
    console.info(T, "second pass", report);
    expect(report.asked).toBe(0);
    expect(again.published).toHaveLength(0);
  });

  it("publishes in batches", async () => {
    const db = seed(30);
    const h = harness(db, { batchSize: 10 });
    const report = await runParrotAutoLyrics(h.args);
    console.info(T, "batches", h.published.map((ops) => ops.length));
    expect(report.asked).toBe(32);
    expect(h.published.map((ops) => ops.length)).toEqual([10, 10, 10, 2]);
  });

  it("writes nothing for a failed lookup, so the next pass asks again; waits when told to", async () => {
    const db = seed();
    const h = harness(db, {
      lookup: async (question) => {
        if (question.title === "Nook") throw new Error("rate limited");
        return answers[question.title]!;
      },
      onError: () => ({ kind: "wait", ms: 60_000 }),
    });
    const report = await runParrotAutoLyrics(h.args);
    console.info(T, "failed pass", report, h.sleeps);
    expect(report).toEqual({ asked: 2, found: 0, none: 1, failed: 1, stopped: false });
    expect(h.sleeps).toContain(60_000);
    expect(read(db, "t-nook")).toBeNull();
    const retry = harness(db);
    expect((await runParrotAutoLyrics(retry.args)).found).toBe(1);
    expect(retry.asked.map((q) => q.title)).toEqual(["Nook"]);
  });

  it("stops when told to (no ticket) and on sign-out, keeping what it found", async () => {
    const db = seed(5);
    const stop = harness(db, { lookup: async () => Promise.reject(new Error("no ticket")), onError: () => ({ kind: "stop" }) });
    expect(await runParrotAutoLyrics(stop.args)).toEqual({ asked: 1, found: 0, none: 0, failed: 1, stopped: true });

    const controller = new AbortController();
    const h = harness(db);
    const lookup = h.args.lookup;
    h.args.lookup = async (question) => {
      if (h.asked.length === 1) controller.abort();
      return lookup(question);
    };
    h.args.signal = controller.signal;
    const report = await runParrotAutoLyrics(h.args);
    console.info(T, "signed out", report);
    expect(report.stopped).toBe(true);
    expect(report.asked).toBe(2);
    expect(h.published.flat()).toHaveLength(2);
  });

  it("skips a song that got words or was deleted meanwhile, and stops when a publish is refused", async () => {
    const db = seed();
    const h = harness(db);
    h.args.lookup = async (question) => {
      h.asked.push(question);
      apply(db, [createParrotOp("lyrics.set", { trackId: "t-nook", plain: "edited in", synced: null, source: "file", fetchedAt: 2 }, meta)]);
      return answers[question.title]!;
    };
    const report = await runParrotAutoLyrics(h.args);
    expect(h.asked.map((q) => q.title)).toEqual(["Fable"]);
    expect(report.asked).toBe(1);

    const refused = seed();
    const r = harness(refused, { publish: async () => false, batchSize: 1 });
    const stopped = await runParrotAutoLyrics(r.args);
    console.info(T, "refused", stopped);
    expect(stopped).toEqual({ asked: 1, found: 0, none: 1, failed: 0, stopped: true });
  });
});

// @req PAR-LYR-01[parrot]
describe("[parrot] automatic lyrics lookup, failures", () => {
  const named = (name: string, extra: Record<string, unknown> = {}) => Object.assign(Object.assign(new Error(name), { name }), extra);
  it("stops on no ticket and after five failures in a row, backs off longer on a busy lookup, skips other failures", () => {
    expect(parrotAutoLyricsOnError(named("NoTicketError"), 1)).toEqual({ kind: "stop" });
    expect(parrotAutoLyricsOnError(named("MetadataUnavailableError", { status: 429 }), 1)).toEqual({ kind: "wait", ms: 30_000 });
    expect(parrotAutoLyricsOnError(named("MetadataUnavailableError", { status: 503 }), 2)).toEqual({ kind: "wait", ms: 60_000 });
    expect(parrotAutoLyricsOnError(named("MetadataUnavailableError", { retryAfterSeconds: 120 }), 1)).toEqual({ kind: "wait", ms: 120_000 });
    expect(parrotAutoLyricsOnError(named("MetadataUnavailableError", { retryAfterSeconds: 99_999 }), 4)).toEqual({ kind: "wait", ms: 600_000 });
    expect(parrotAutoLyricsOnError(named("MetadataRequestError", { status: 500 }), 1)).toEqual({ kind: "skip" });
    expect(parrotAutoLyricsOnError(new Error("offline"), 5)).toEqual({ kind: "stop" });
  });

  it("a lookup that keeps failing stops the pass after five songs, not the whole library", async () => {
    const db = seed(20);
    const h = harness(db, { lookup: async () => Promise.reject(new Error("upstream 500")), onError: parrotAutoLyricsOnError });
    const report = await runParrotAutoLyrics(h.args);
    console.info(T, "down", report);
    expect(report).toEqual({ asked: 5, found: 0, none: 0, failed: 5, stopped: true });
  });
});

// @req PAR-LYR-06[parrot]
// @req PAR-LYR-06[parrot-web-player]
describe("[parrot] automatic lyrics lookup, songs still pending", () => {
  const songs = ["t-fable", "t-nook", "t-habit", "t-anon"];
  it("holds every song the pass will ask until its answer is kept, so the Lyrics tab says 'Looking for lyrics…' meanwhile", async () => {
    const db = seed();
    const pending = createParrotLyricsPending();
    const changes: string[][] = [];
    pending.onChange(() => changes.push(songs.filter((id) => pending.has(id))));
    const atLookup: Record<string, string[]> = {};
    const atPublish: string[][] = [];
    const shownAtPublish: Record<string, unknown> = {};
    const h = harness(db, { pending });
    const lookup = h.args.lookup;
    h.args.lookup = async (question) => {
      atLookup[question.title] = songs.filter((id) => pending.has(id));
      return lookup(question);
    };
    const publish = h.args.publish;
    h.args.publish = async (ops) => {
      atPublish.push(songs.filter((id) => pending.has(id)));
      // What the Lyrics tab is handed for Fable while its answer waits to be kept: searching, never null or "No lyrics".
      shownAtPublish.fable = parrotLyricsOrSearching(read(db, "t-fable"), pending.has("t-fable"));
      return publish(ops);
    };
    const report = await runParrotAutoLyrics(h.args);
    console.info(T, "pending", { report, atLookup, atPublish, shownAtPublish, changes });
    expect(atLookup).toEqual({ Fable: ["t-fable", "t-nook"], Nook: ["t-fable", "t-nook"] });
    expect(atPublish).toEqual([["t-fable", "t-nook"]]);
    expect(shownAtPublish.fable).toEqual({ synced: null, plain: null, fetched: false, searching: true });
    expect(songs.filter((id) => pending.has(id))).toEqual([]);
    // Afterwards the tab shows the kept answer: the final "No lyrics" for Fable.
    expect(parrotLyricsOrSearching(read(db, "t-fable"), pending.has("t-fable"))).toEqual({ synced: null, plain: null, fetched: true, notFound: true });
    expect(changes.at(-1)).toEqual([]);
  });

  it("lets go of a song whose lookup failed, and of every song when the pass stops", async () => {
    const db = seed(3);
    const pending = createParrotLyricsPending();
    const seen: string[] = [];
    const h = harness(db, {
      pending,
      lookup: async (question) => {
        seen.push(`${question.title}:${pending.has("t-nook") ? "nook-pending" : "nook-settled"}`);
        throw new Error("upstream 500");
      },
      onError: (_error, inARow) => (inARow >= 2 ? { kind: "stop" } : { kind: "skip" }),
    });
    const report = await runParrotAutoLyrics(h.args);
    console.info(T, "pending after failures", { report, seen });
    expect(report.stopped).toBe(true);
    expect(seen).toEqual(["Fable:nook-pending", "Nook:nook-pending"]);
    expect([...songs, "t-x00", "t-x01", "t-x02"].filter((id) => pending.has(id))).toEqual([]);
  });

  it("a library loaded during a pass makes its songs pending until the next pass takes them over; sign-out empties the set", async () => {
    const db = seed();
    const pending = createParrotLyricsPending();
    await queueParrotAutoLyrics(queryOf(db), pending);
    console.info(T, "queued", songs.filter((id) => pending.has(id)));
    expect(songs.filter((id) => pending.has(id))).toEqual(["t-fable", "t-nook", "t-anon"]);
    await runParrotAutoLyrics(harness(db, { pending }).args);
    console.info(T, "after the next pass", songs.filter((id) => pending.has(id)));
    expect(songs.filter((id) => pending.has(id))).toEqual([]);
    await queueParrotAutoLyrics(queryOf(seed()), pending);
    pending.clear();
    expect(songs.filter((id) => pending.has(id))).toEqual([]);
  });

  it("an old pass ending after sign-out and sign-in never clears a song the new pass is still asking", async () => {
    const pending = createParrotLyricsPending();
    const none = { plain: null, synced: null, source: null } as MusicLyrics;
    const oldAnswer = Promise.withResolvers<MusicLyrics>();
    const newAnswer = Promise.withResolvers<MusicLyrics>();
    const oldAsked = Promise.withResolvers<void>();
    const newAsked = Promise.withResolvers<void>();
    const signedOut = new AbortController();
    const oldPass = runParrotAutoLyrics(
      harness(seed(), { pending, signal: signedOut.signal, lookup: async () => (oldAsked.resolve(), oldAnswer.promise) }).args
    );
    await oldAsked.promise;
    signedOut.abort();
    pending.clear();
    const newPass = runParrotAutoLyrics(harness(seed(), { pending, lookup: async () => (newAsked.resolve(), newAnswer.promise) }).args);
    await newAsked.promise;
    oldAnswer.resolve(none);
    const oldReport = await oldPass;
    console.info(T, "old pass ended", { oldReport, fablePending: pending.has("t-fable") });
    expect(oldReport.stopped).toBe(true);
    expect(pending.has("t-fable")).toBe(true);
    newAnswer.resolve(none);
    await newPass;
    expect(songs.filter((id) => pending.has(id))).toEqual([]);
  });

  it("a pass ending never clears a song a 'Fetch lyrics' still holds, and the reverse", async () => {
    const pending = createParrotLyricsPending();
    const fetch = pending.hold(["t-nook"]);
    await runParrotAutoLyrics(harness(seed(), { pending }).args);
    console.info(T, "after the pass, Fetch still holding Nook", songs.filter((id) => pending.has(id)));
    expect(songs.filter((id) => pending.has(id))).toEqual(["t-nook"]);
    fetch.release();
    expect(pending.has("t-nook")).toBe(false);

    const answer = Promise.withResolvers<MusicLyrics>();
    const asked = Promise.withResolvers<void>();
    const pass = runParrotAutoLyrics(harness(seed(), { pending, lookup: async () => (asked.resolve(), answer.promise) }).args);
    await asked.promise;
    const quick = pending.hold(["t-fable"]);
    quick.release();
    console.info(T, "Fetch on Fable ended while the pass asks it", pending.has("t-fable"));
    expect(pending.has("t-fable")).toBe(true);
    answer.resolve({ plain: null, synced: null, source: null } as MusicLyrics);
    await pass;
    expect(songs.filter((id) => pending.has(id))).toEqual([]);
  });

  it("a queue whose song list arrives after the next pass started is dropped, never left 'searching' forever", async () => {
    const db = seed();
    const pending = createParrotLyricsPending();
    const slowRead = Promise.withResolvers<void>();
    const fast = queryOf(db);
    const slow: ParrotLibraryQuery = async <Row,>(sql: string, params?: readonly (string | number | null)[]) => {
      await slowRead.promise;
      return fast<Row>(sql, params);
    };
    const late = queueParrotAutoLyrics(slow, pending);
    const report = await runParrotAutoLyrics(harness(seed(), { pending }).args);
    console.info(T, "next pass done before the queue's read", report);
    slowRead.resolve();
    await late;
    console.info(T, "after the late queue", songs.filter((id) => pending.has(id)));
    expect(songs.filter((id) => pending.has(id))).toEqual([]);
  });

  it("a next pass that cannot read its songs still lets go of the queued ones", async () => {
    const db = seed();
    const pending = createParrotLyricsPending();
    await queueParrotAutoLyrics(queryOf(db), pending);
    expect(songs.filter((id) => pending.has(id))).toEqual(["t-fable", "t-nook", "t-anon"]);
    const broken: ParrotLibraryQuery = async () => {
      throw new Error("library closed");
    };
    await expect(runParrotAutoLyrics(harness(db, { pending, query: () => broken }).args)).rejects.toThrow("library closed");
    console.info(T, "after the failed pass", songs.filter((id) => pending.has(id)));
    expect(songs.filter((id) => pending.has(id))).toEqual([]);
  });
});

/**
 * @test-id PARROT-CORE-AUTO-LYRICS-WANT-001
 * @level unit (real SQLite library, fake lookup and publish)
 * @why PAR-COPY-01: a screen never asks the metadata service for lyrics; a song played or shown that was never looked up
 *   is handed to the paced automatic pass (`pending.want`), which asks it first, keeps it "Looking for lyrics…" until its
 *   answer is kept, never asks it twice, and stops at the ticket floor (`canSpend`).
 */
// @req PAR-COPY-01[parrot]
describe("[parrot] automatic lyrics lookup, songs a screen wants (PAR-COPY-01)", () => {
  const W = "[PARROT-CORE-AUTO-LYRICS-WANT-001]";
  it("asks a wanted song first, holds it pending until kept, and asks it once", async () => {
    const db = seed();
    const pending = createParrotLyricsPending();
    console.info(W, "phase=arrange", "want t-nook before the pass");
    pending.want("t-nook");
    pending.want("t-nook");
    expect(pending.has("t-nook")).toBe(true);
    const seenPendingAtLookup: boolean[] = [];
    const h = harness(db, { pending });
    const lookup = h.args.lookup;
    h.args.lookup = async (question) => (seenPendingAtLookup.push(pending.has("t-nook")), lookup(question));
    console.info(W, "phase=act", "run the pass");
    const report = await runParrotAutoLyrics(h.args);
    console.info(W, "phase=assert", { report, asked: h.asked.map((q) => q.title), seenPendingAtLookup });
    expect(h.asked.map((q) => q.title)).toEqual(["Nook", "Fable"]);
    expect(seenPendingAtLookup[0]).toBe(true);
    expect(pending.has("t-nook")).toBe(false);
    expect(pending.takeWanted()).toBeNull();
    expect(read(db, "t-nook")?.synced?.length).toBeGreaterThan(0);
  });

  it("a song wanted while the pass runs is asked next, in the same pass", async () => {
    const db = seed(3);
    const pending = createParrotLyricsPending();
    const h = harness(db, { pending });
    const lookup = h.args.lookup;
    h.args.lookup = async (question) => {
      if (h.asked.length === 0) {
        console.info(W, "phase=act", "want t-x02 while the first song is asked");
        pending.want("t-x02");
      }
      return lookup(question);
    };
    await runParrotAutoLyrics(h.args);
    const titles = h.asked.map((q) => q.title);
    console.info(W, "phase=assert", { titles });
    expect(titles[1]).toBe("Extra 2");
    expect(titles.filter((title) => title === "Extra 2")).toHaveLength(1);
    expect(pending.has("t-x02")).toBe(false);
  });

  it("stops at the ticket floor and lets the wanted song go; dropWanted lets go when no pass can start", async () => {
    const db = seed();
    const pending = createParrotLyricsPending();
    pending.want("t-fable");
    const h = harness(db, { pending, canSpend: () => h.asked.length < 1 });
    const report = await runParrotAutoLyrics(h.args);
    console.info(W, "phase=assert", "floor", { report, asked: h.asked.map((q) => q.title) });
    expect(report.stopped).toBe(true);
    expect(h.asked.map((q) => q.title)).toEqual(["Fable"]);
    expect(pending.has("t-fable")).toBe(false);
    pending.want("t-nook");
    expect(pending.has("t-nook")).toBe(true);
    pending.dropWanted();
    console.info(W, "phase=assert", "dropWanted", { nookPending: pending.has("t-nook") });
    expect(pending.has("t-nook")).toBe(false);
    expect(pending.takeWanted()).toBeNull();
  });
});
