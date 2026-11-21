/**
 * @level unit (real `searchParrotImportAlbums` / `importCoverOf` and the shared retry; the metadata client is a fake
 * with timed answers, so speed is measured, not assumed)
 *
 * PAR-UP-08 "Wrong album? Search": the walk timed 20–28 s per search (each album's tracklist and then its cover asked
 * one after the other, a cold cover 4–5 s) and saw one `metadata service unavailable (429)`. A search now answers
 * before any cover and asks a busy refusal again after the service's Retry-After.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MetadataUnavailableError } from "@space/metadata-client";
import type { MusicAlbum, MusicAlbumsQuery } from "@space/shared/api";
import { importCoverOf, searchParrotImportAlbums } from "../src/main/importSearch";

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

/** A metadata client answering like prod does cold: each album search 120 ms, each cover 1.5 s. */
const fakeClient = (options: { busyAlbums?: number } = {}) => {
  const calls: string[] = [];
  let busyLeft = options.busyAlbums ?? 0;
  const client = {
    musicAlbums: async (query: MusicAlbumsQuery) => {
      calls.push(`albums ${query.artist} / ${query.album}`);
      await sleep(120);
      if (busyLeft > 0) {
        busyLeft -= 1;
        console.log("[import-search test] fake service: 429 rate_limited, Retry-After 1");
        throw new MetadataUnavailableError(429, 1, "rate_limited");
      }
      return { results: ALBUMS.filter((album) => album.title === query.album || !query.album.trim()).slice(0, query.limit) };
    },
    musicCover: async (id: string, size: number) => {
      calls.push(`cover ${id} ${size}`);
      await sleep(1_500);
      return { cover: { mime: "image/jpeg", base64: "AAAA" } };
    },
  };
  return { client, calls };
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

describe("Wrong album? Search answers in a moment (PAR-UP-08)", () => {
  // @req PAR-UP-08
  it("answers seven albums without asking any cover", async () => {
    phase("cold album search, seven albums");
    const { client, calls } = fakeClient();
    const { log } = logged();
    const startedAt = Date.now();
    const found = await onFakeClock(searchParrotImportAlbums(client, { artist: "Linnet Park", album: "" }, log));
    const took = Date.now() - startedAt;
    console.log(`[import-search test] answered ${found.length} in ${took} ms; calls`, calls);
    expect(took).toBeLessThan(500);
    expect(found.map((result) => result.album.title)).toEqual(ALBUMS.map((album) => album.title));
    expect(found.every((result) => result.cover === null)).toBe(true);
    expect(calls.some((call) => call.startsWith("cover"))).toBe(false);
  });

  // @req PAR-UP-08
  it("asks a busy refusal again after the service's Retry-After instead of failing", async () => {
    phase("429 on albums");
    const { client, calls } = fakeClient({ busyAlbums: 1 });
    const { log, lines } = logged();
    const found = await onFakeClock(searchParrotImportAlbums(client, { artist: "Linnet Park", album: "Meltway" }, log));
    console.log("[import-search test] albums", found.map((result) => result.album.title), "calls", calls);
    expect(calls.filter((call) => call.startsWith("albums"))).toHaveLength(2);
    expect(found.map((result) => result.album.title)).toEqual(["Meltway"]);
    expect(lines).toContain("[import] album search: service busy (429 rate_limited), try 2 in 1s");
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
