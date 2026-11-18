/**
 * @req LIB-CREW-01
 *
 * The one-time crew backfill: a library from before crew was stored gets the director and writers of each title it
 * already holds, once, without touching anything else. Real engine (bun:sqlite, full LibraryDb); the "old library"
 * is titles added from TMDB without crew, which is what the code before LIB-CREW-01 wrote.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { pickLibraryCrew } from "@space/shared/libraryCrew";
import type { TmdbCrewMember } from "@space/shared/api";
import type { TmdbDetails } from "../src/api";
import { LibraryDb } from "../src/libraryDb";
import {
  CREW_BACKFILL_BACKOFF_MS,
  CREW_BACKFILL_COMPLETE_KEY,
  CREW_BACKFILL_IDLE_POLL_MS,
  CREW_BACKFILL_SETTING_PREFIX,
  backfillMissingCrew,
  type CrewBackfillDeps,
} from "../src/crewBackfill";

const SUITE = "crew-backfill";
let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-crew-backfill-"));
  process.env.SF_USER_DATA_PATH = root;
  console.info(`[${SUITE}:setup] root=${root}`);
});

afterEach(() => {
  console.info(`[${SUITE}:teardown] removing root=${root}`);
  rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
});

// What TMDB credits, per TMDB id.
const TMDB_CREW: Record<number, TmdbCrewMember[]> = {
  961: [
    { tmdbId: 8635, name: "Buster Keaton", job: "Director", department: "Directing", profilePath: null },
    { tmdbId: 8636, name: "Clyde Bruckman", job: "Director", department: "Directing", profilePath: null },
    { tmdbId: 8637, name: "Al Boasberg", job: "Writer", department: "Writing", profilePath: null },
  ],
  44441: [{ tmdbId: 2, name: "Richard Oswald", job: "Director", department: "Directing", profilePath: null }],
  19: [{ tmdbId: 3, name: "Fritz Lang", job: "Director", department: "Directing", profilePath: null }],
  // A title TMDB credits with nobody the library keeps.
  777: [{ tmdbId: 4, name: "Someone", job: "Editor", department: "Editing", profilePath: null }],
};

const addMovie = (db: LibraryDb, id: number, title: string) =>
  db.addMediaFromTmdb({
    id,
    type: "movie",
    title,
    originalTitle: title,
    originalLanguage: "en",
    overview: `${title} synopsis`,
    year: "1926",
    rating: 7.5,
    posterPath: `/poster-${id}.jpg`,
    backdropPath: null,
    genres: [],
    cast: [],
    trailers: [],
    seasons: [],
    episodes: [],
    totalEpisodes: 0,
  } satisfies TmdbDetails);

const openLibrary = async () => {
  const db = await LibraryDb.openLocal("token", "key");
  db.setSyncEnabled(false);
  return db;
};

const crewOf = (db: LibraryDb, mediaId: string) =>
  (db.getMediaDetails(mediaId)?.crew ?? []).map((member) => `${member.job}:${member.name}`);

/** Stands in for the metadata service's 429 answer. */
class NotNowError extends Error {
  constructor(readonly retryAfterMs: number) {
    super("metadata service unavailable (429)");
  }
}

/** The app's fetch: the details lookup, then only the crew written (what the desktop's `fetchCrew` does). */
const makeDeps = (db: LibraryDb, overrides: Partial<CrewBackfillDeps> = {}) => {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const deps: CrewBackfillDeps = {
    fetchCrew: async (mediaId) => {
      calls.push(mediaId);
      const details = db.getMediaDetails(mediaId)!;
      if (details.crew?.length) return details.crew.length;
      const crew = pickLibraryCrew(TMDB_CREW[details.tmdbId!] ?? []);
      if (crew.length) db.updateMediaMetadata({ mediaId, crew });
      return crew.length;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    isOffline: () => false,
    isPlaying: () => false,
    retryAfterMs: (error) => (error instanceof NotNowError ? error.retryAfterMs : null),
    log: (message, details) => console.info(`[${SUITE}] ${message} ${JSON.stringify(details)}`),
    ...overrides,
  };
  return { deps, calls, sleeps };
};

describe("LIB-CREW-01 one-time crew backfill", () => {
  it("fills every title missing crew, keeps crew the user edited and the other fields, then never runs again", async () => {
    const db = await openLibrary();
    const general = await addMovie(db, 961, "The General");
    const anders = await addMovie(db, 44441, "Anders als die Andern");
    const edited = await addMovie(db, 19, "Metropolis");
    db.updateMediaMetadata({
      mediaId: edited,
      crew: [{ tmdbId: null, name: "Thea von Harbou", job: "Director", profilePath: null }],
    });
    const before = db.getMediaDetails(general)!;

    expect(db.listMediaMissingCrew().sort()).toEqual([general, anders].sort());

    const { deps, calls } = makeDeps(db);
    const first = await backfillMissingCrew(db, deps);
    console.info(`[${SUITE}:fill] result=${JSON.stringify(first)} calls=${JSON.stringify(calls)}`);
    expect(first).toMatchObject({ found: 2, filled: 2, empty: 0, failed: 0, complete: true });
    expect(calls.sort()).toEqual([general, anders].sort());
    expect(crewOf(db, general)).toEqual(["Director:Buster Keaton", "Director:Clyde Bruckman", "Writer:Al Boasberg"]);
    expect(crewOf(db, anders)).toEqual(["Director:Richard Oswald"]);
    // The user's edit stays: never listed, never fetched, never replaced.
    expect(crewOf(db, edited)).toEqual(["Director:Thea von Harbou"]);
    const after = db.getMediaDetails(general)!;
    expect([after.title, after.overview, after.year, after.rating, after.posterPath]).toEqual([
      before.title,
      before.overview,
      before.year,
      before.rating,
      before.posterPath,
    ]);
    expect(db.getSetting(CREW_BACKFILL_COMPLETE_KEY)?.value).toBe("done");

    // A later start, even with a new title missing crew, returns at once: the backfill runs once per library.
    await addMovie(db, 777, "Untitled");
    const second = await backfillMissingCrew(db, deps);
    console.info(`[${SUITE}:again] result=${JSON.stringify(second)} calls=${calls.length}`);
    expect(second).toMatchObject({ found: 0, complete: true });
    expect(calls).toHaveLength(2);
  });

  it("resumes after an interruption without asking a filled title again", async () => {
    const db = await openLibrary();
    const ids = [await addMovie(db, 961, "The General"), await addMovie(db, 44441, "Anders"), await addMovie(db, 19, "Metropolis")];
    const order = db.listMediaMissingCrew();
    expect(order.sort()).toEqual([...ids].sort());

    // The app quits (or crashes) right after the first title is written.
    let stop = false;
    const interrupted = makeDeps(db, { shouldStop: () => stop });
    const wrapped = interrupted.deps.fetchCrew;
    interrupted.deps.fetchCrew = async (mediaId) => {
      const count = await wrapped(mediaId);
      stop = true;
      return count;
    };
    const cut = await backfillMissingCrew(db, interrupted.deps);
    console.info(`[${SUITE}:cut] result=${JSON.stringify(cut)} calls=${JSON.stringify(interrupted.calls)}`);
    expect(cut).toMatchObject({ found: 3, filled: 1, complete: false });
    expect(db.getSetting(CREW_BACKFILL_COMPLETE_KEY)).toBeNull();
    expect(db.listMediaMissingCrew()).toHaveLength(2);

    // Next start: only the two left are asked.
    const resumed = makeDeps(db);
    const rest = await backfillMissingCrew(db, resumed.deps);
    console.info(`[${SUITE}:resume] result=${JSON.stringify(rest)} calls=${JSON.stringify(resumed.calls)}`);
    expect(rest).toMatchObject({ found: 2, filled: 2, complete: true });
    expect(resumed.calls).not.toContain(interrupted.calls[0]);
    expect(db.listMediaMissingCrew()).toEqual([]);
  });

  it("waits out a rate limit, an offline spell and a playing video without counting a failure", async () => {
    const db = await openLibrary();
    const general = await addMovie(db, 961, "The General");
    let notNowLeft = 2;
    let offlineChecks = 2;
    let playingChecks = 1;
    const { deps, calls, sleeps } = makeDeps(db);
    const fetch = deps.fetchCrew;
    deps.isOffline = () => offlineChecks-- > 0;
    deps.isPlaying = () => playingChecks-- > 0;
    deps.fetchCrew = async (mediaId) => {
      if (notNowLeft-- > 0) {
        calls.push(`${mediaId}:429`);
        throw new NotNowError(5_000);
      }
      return fetch(mediaId);
    };
    const result = await backfillMissingCrew(db, deps);
    console.info(`[${SUITE}:wait] result=${JSON.stringify(result)} calls=${JSON.stringify(calls)} sleeps=${JSON.stringify(sleeps)}`);
    expect(result).toMatchObject({ found: 1, filled: 1, failed: 0, complete: true });
    expect(crewOf(db, general)[0]).toBe("Director:Buster Keaton");
    expect(db.getSetting(`${CREW_BACKFILL_SETTING_PREFIX}${general}`)).toBeNull();
    // Offline twice, then a video: three idle polls before the first lookup; then two rate-limit waits, the second longer.
    expect(sleeps.slice(0, 3)).toEqual([CREW_BACKFILL_IDLE_POLL_MS, CREW_BACKFILL_IDLE_POLL_MS, CREW_BACKFILL_IDLE_POLL_MS]);
    expect(sleeps.slice(3)).toEqual([CREW_BACKFILL_BACKOFF_MS, CREW_BACKFILL_BACKOFF_MS * 2]);
  });

  it("marks a title TMDB credits with no director or writer so it is not asked again, and retries a failed one on the next start", async () => {
    const db = await openLibrary();
    const untitled = await addMovie(db, 777, "Untitled");
    const general = await addMovie(db, 961, "The General");
    let failGeneral = true;
    const { deps, calls } = makeDeps(db);
    const fetch = deps.fetchCrew;
    deps.fetchCrew = async (mediaId) => {
      if (mediaId === general && failGeneral) {
        calls.push(`${mediaId}:500`);
        throw new Error("metadata request failed (500)");
      }
      return fetch(mediaId);
    };
    const first = await backfillMissingCrew(db, deps);
    console.info(`[${SUITE}:empty] result=${JSON.stringify(first)} calls=${JSON.stringify(calls)}`);
    expect(first).toMatchObject({ found: 2, filled: 0, empty: 1, failed: 1, complete: false });
    expect(db.getSetting(`${CREW_BACKFILL_SETTING_PREFIX}${untitled}`)?.value).toBe("done");
    expect(db.getSetting(`${CREW_BACKFILL_SETTING_PREFIX}${general}`)?.value).toBe("failed:1");

    failGeneral = false;
    calls.length = 0;
    const second = await backfillMissingCrew(db, deps);
    console.info(`[${SUITE}:retry] result=${JSON.stringify(second)} calls=${JSON.stringify(calls)}`);
    expect(second).toMatchObject({ found: 2, filled: 1, skipped: 1, complete: true });
    expect(calls).toEqual([general]);
  });
});
