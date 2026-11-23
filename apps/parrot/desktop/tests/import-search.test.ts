/**
 * @level unit (real `searchParrotImportSongs` / `searchParrotImportAlbums` / `importCoverOf` and the shared retry; the
 * metadata client is a fake with timed answers, so overlap and speed are measured, not assumed)
 *
 * PAR-UP-05 "Identify": the walk timed 20–28 s per search (each album's tracklist and then its cover asked one after the
 * other, a cold cover 4–5 s) and saw one `metadata service unavailable (429)`. A search now answers before any cover,
 * asks its albums a few at a time, and asks a busy refusal again after the service's Retry-After.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MetadataUnavailableError } from "@space/metadata-client";
import type { MusicAlbum, MusicAlbumsQuery, MusicRecording, MusicRecordingsQuery } from "@space/shared/api";
import { IMPORT_SEARCH_ALBUMS_AT_ONCE, importCoverOf, searchParrotImportAlbums, searchParrotImportSongs } from "../src/main/importSearch";

const phase = (name: string) => console.log(`[import-search test] phase: ${name}`);
// The fake service's latencies and the retry's Retry-After wait run on vitest's fake clock: the test measures the
// search's own time (fake Date.now) without waiting it for real.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Runs `work` while the fake clock moves through every wait it schedules. */
const onFakeClock = async <T>(work: Promise<T>): Promise<T> => {
  await vi.runAllTimersAsync();
  return work;
};
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});
const LP = { id: "5e1c0a2d-4b7f-4c3a-9d21-7a6b3c9e0f15", name: "Linnet Park" };
const catalogId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Linnet Park albums "Fable" is on (the studio album, live sets, compilations): seven of them. */
const ALBUMS: MusicAlbum[] = ["Meltway", "Live in Tarvo", "Road to Rivermouth", "Meltway 20th Anniversary", "Paperboats", "Hollow Signal/Meltway", "Live at Harrowfield"].map(
  (title, index) => ({
    id: catalogId(index + 1),
    title,
    year: 2003 + index,
    kind: "album",
    artist: LP,
    tracks: [
      { disc: 1, number: 1, title: "Forecast", durationMs: 13_000, id: catalogId(100 + index) },
      { disc: 1, number: 7, title: "Fable", durationMs: 162_000, id: catalogId(200 + index) },
    ],
  })
);
const RECORDINGS: MusicRecording[] = ALBUMS.map((album, index) => ({
  id: catalogId(200 + index),
  title: "Fable",
  durationMs: 162_000,
  artist: LP,
  album: { id: album.id, title: album.title, year: album.year, trackNumber: 7, disc: 1 },
}));

/** A metadata client answering like prod does cold: recordings fast, each album 120 ms, each cover 1.5 s. */
const fakeClient = (options: { busyRecordings?: number } = {}) => {
  const calls: string[] = [];
  let busyLeft = options.busyRecordings ?? 0;
  let albumsInFlight = 0;
  let mostAlbumsAtOnce = 0;
  const client = {
    musicRecordings: async (query: MusicRecordingsQuery) => {
      calls.push(`recordings ${query.artist} / ${query.title}`);
      await sleep(30);
      if (busyLeft > 0) {
        busyLeft -= 1;
        console.log("[import-search test] fake service: 429 rate_limited, Retry-After 1");
        throw new MetadataUnavailableError(429, 1, "rate_limited");
      }
      return { results: RECORDINGS.slice(0, query.limit) };
    },
    musicAlbums: async (query: MusicAlbumsQuery) => {
      calls.push(`albums ${query.artist} / ${query.album}`);
      albumsInFlight += 1;
      mostAlbumsAtOnce = Math.max(mostAlbumsAtOnce, albumsInFlight);
      await sleep(120);
      albumsInFlight -= 1;
      return { results: ALBUMS.filter((album) => album.title === query.album || !query.album.trim()).slice(0, query.limit) };
    },
    musicCover: async (id: string, size: number) => {
      calls.push(`cover ${id} ${size}`);
      await sleep(1_500);
      return { cover: { mime: "image/jpeg", base64: "AAAA" } };
    },
  };
  return { client, calls, mostAlbumsAtOnce: () => mostAlbumsAtOnce };
};

const logged = () => {
  const lines: string[] = [];
  return {
    lines,
    log: (line: string) => {
      console.log(line);
      lines.push(line);
    },
  };
};

describe("Identify answers in a few seconds (PAR-UP-05)", () => {
  // @req PAR-UP-05
  it("answers seven albums without asking any cover, a few albums at a time", async () => {
    phase("cold song search, seven albums");
    const { client, calls, mostAlbumsAtOnce } = fakeClient();
    const { log, lines } = logged();
    const startedAt = Date.now();
    const found = await onFakeClock(searchParrotImportSongs(client, { artist: "Linnet Park", title: "Fable", album: "" }, log));
    const took = Date.now() - startedAt;
    console.log(`[import-search test] answered ${found.length} in ${took} ms; most albums at once ${mostAlbumsAtOnce()}; calls`, calls);
    // The old flow asked 7 × (album 120 ms + cover 1.5 s) one after the other: over 11 s here. One album at a time
    // without covers is still 870 ms; three at a time is 30 + 3 × 120 = 390 ms.
    expect(took).toBeLessThan(500);
    expect(calls.filter((call) => call.startsWith("cover"))).toEqual([]);
    expect(calls.filter((call) => call.startsWith("albums"))).toHaveLength(7);
    expect(mostAlbumsAtOnce()).toBeGreaterThan(1);
    expect(mostAlbumsAtOnce()).toBeLessThanOrEqual(IMPORT_SEARCH_ALBUMS_AT_ONCE);
    expect(found.map((result) => `${result.album.title} #${result.track.number} ${result.track.title}`)).toEqual(ALBUMS.map((album) => `${album.title} #7 Fable`));
    expect(found.every((result) => result.cover === null)).toBe(true);
    expect(lines.some((line) => /song search: 7 recording\(s\), 7 album\(s\) asked, 7 on a known album/u.test(line))).toBe(true);
  });

  // @req PAR-UP-05
  it("asks a busy refusal again after the service's Retry-After instead of failing", async () => {
    phase("429 on recordings");
    const { client, calls } = fakeClient({ busyRecordings: 1 });
    const { log, lines } = logged();
    const found = await onFakeClock(searchParrotImportSongs(client, { artist: "Linnet Park", title: "Fable", album: "Meltway" }, log));
    console.log(`[import-search test] answered ${found.length}; calls`, calls);
    expect(calls.filter((call) => call.startsWith("recordings"))).toHaveLength(2);
    expect(found.length).toBeGreaterThan(0);
    expect(lines).toContain("[import] song search: service busy (429 rate_limited), try 2 in 1s");
  });

  it("album search answers without covers too", async () => {
    phase("album search");
    const { client, calls } = fakeClient();
    const { log } = logged();
    const found = await onFakeClock(searchParrotImportAlbums(client, { artist: "Linnet Park", album: "Meltway" }, log));
    console.log("[import-search test] albums", found.map((result) => result.album.title), "calls", calls);
    expect(found.map((result) => result.album.title)).toEqual(["Meltway"]);
    expect(found[0]!.cover).toBeNull();
    expect(calls.some((call) => call.startsWith("cover"))).toBe(false);
  });
});

describe("covers follow the answer, each asked once per scan (PAR-UP-05)", () => {
  it("asks each album's cover once and hands it as a data: URL", async () => {
    phase("cover memo");
    const { client, calls } = fakeClient();
    const asked = new Map<string, Promise<string | null>>();
    const { log } = logged();
    const [first, again] = await onFakeClock(Promise.all([importCoverOf(async () => client, asked, catalogId(1), log), importCoverOf(async () => client, asked, catalogId(1), log)]));
    console.log("[import-search test] covers", first?.slice(0, 30), again?.slice(0, 30), "calls", calls);
    expect(first).toBe("data:image/jpeg;base64,AAAA");
    expect(again).toBe(first);
    expect(calls).toEqual([`cover ${catalogId(1)} 500`]);
  });

  it("refuses an id that is no album id, without asking", async () => {
    phase("bad id");
    const { client, calls } = fakeClient();
    const { log } = logged();
    expect(await importCoverOf(async () => client, new Map(), "../../etc/passwd", log)).toBeNull();
    expect(await importCoverOf(async () => client, new Map(), 42, log)).toBeNull();
    console.log("[import-search test] calls", calls);
    expect(calls).toEqual([]);
  });

  it("forgets a failed cover so the next search asks it again", async () => {
    phase("cover failure");
    const asked = new Map<string, Promise<string | null>>();
    let tries = 0;
    const failing = async () => ({
      musicCover: async () => {
        tries += 1;
        throw new Error("network down");
      },
    });
    const { log, lines } = logged();
    expect(await importCoverOf(failing, asked, "album-meltway", log)).toBeNull();
    expect(await importCoverOf(failing, asked, "album-meltway", log)).toBeNull();
    console.log("[import-search test] tries", tries, "lines", lines);
    expect(tries).toBe(2);
    expect(asked.size).toBe(0);
  });
});
