/**
 * @test-id LIBDB-TITLE-ART-CAS-001
 * @level integration (real LibraryDb over bun:sqlite, no server)
 * @req ACCT-PROF-03
 *
 * Why this exists: the title-variants pass (`reconcileTitleVariants`) moves a title's row onto the account-language
 * title, poster and backdrop in the background. A user edit made while the lookup was in flight must win, so the
 * write is compare-and-set: it lands only while the row still holds the title and pictures the pass read.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { LibraryDb } from "../src/libraryDb";

const TAG = "[replace-title-art]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

let root = "";
let originalFetch: typeof globalThis.fetch | null = null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-title-art-"));
  process.env.SF_USER_DATA_PATH = root;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 503 })) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
  rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
});

const film = () => ({
  id: 406,
  type: "movie" as const,
  title: "La Haine",
  originalTitle: "La Haine",
  originalLanguage: "fr",
  overview: null,
  year: "1995",
  rating: null,
  posterPath: "/fr-poster.jpg",
  backdropPath: "/fr-backdrop.jpg",
  genres: [],
  cast: [],
  trailers: [],
  seasons: [],
  episodes: [],
  totalEpisodes: null,
  status: null,
  nextEpisodeAirDate: null,
});

const open = async () => {
  const db = await LibraryDb.openLocal("token", "key");
  db.setSyncEnabled(false);
  return db;
};

const artOf = (db: LibraryDb, mediaId: string) => {
  const details = db.getMediaDetails(mediaId)!;
  return { title: details.title, posterPath: details.posterPath ?? null, backdropPath: details.backdropPath ?? null };
};

const english = { title: "Hate", posterPath: "/en-poster.jpg", backdropPath: "/en-backdrop.jpg" };

describe("replaceMediaTitleArt: compare-and-set of a title's title, poster and backdrop (ACCT-PROF-03)", () => {
  it("@req ACCT-PROF-03[badger-desktop] replaces the set while the row still holds what the pass read", async () => {
    const db = await open();
    const mediaId = await db.addMediaFromCatalog(film());
    const before = artOf(db, mediaId);
    log("phase: added", before);
    const replaced = await db.replaceMediaTitleArt(mediaId, before, english);
    const after = artOf(db, mediaId);
    log("phase: replaced", { replaced, after });
    expect(replaced).toBe(true);
    expect(after).toEqual(english);
  });

  it("@req ACCT-PROF-03[badger-desktop] a user edit made meanwhile wins: nothing is written", async () => {
    const db = await open();
    const mediaId = await db.addMediaFromCatalog(film());
    const read = artOf(db, mediaId);
    await db.updateMediaMetadata({ mediaId, media: { title: "My own title" } });
    const replaced = await db.replaceMediaTitleArt(mediaId, read, english);
    const after = artOf(db, mediaId);
    log("phase: raced", { replaced, after });
    expect(replaced).toBe(false);
    expect(after.title).toBe("My own title");
    expect(after.posterPath).toBe("/fr-poster.jpg");
  });

  it("@req ACCT-PROF-03[badger-desktop] a title that is gone answers false", async () => {
    const db = await open();
    const replaced = await db.replaceMediaTitleArt("missing-id", english, english);
    log("phase: missing", { replaced });
    expect(replaced).toBe(false);
  });
});
