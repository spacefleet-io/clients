/**
 * @req LIB-CAST-01
 * @bugfix cast-list-repeats-one-actor
 * @regression-proof
 *
 * Details served by the metadata service carried cast members without a TMDB person id. `ensurePerson`
 * read the id with `Number(member.tmdbId)`, and `Number(null)` is `0`, a finite number: every member of the cast
 * became TMDB person `0`. The first one created the person and its `people_external_ids` row (`tmdb`, `"0"`); every
 * later one matched that row, renamed the same person and pointed its role at it. The desktop and phone detail
 * pages then showed one actor's name and face for every role (LIB-CAST-01).
 *
 * Pre-fix: the three roles below share one `personId` and one name.
 * Post-fix: each role has its own person, name and photo, and no person carries TMDB id 0.
 *
 * Real engine (bun:sqlite, full LibraryDb), driven through `addMediaFromTmdb`, the call every ingest path makes.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { TmdbCastMember, TmdbDetails } from "../src/api";
import { LibraryDb } from "../src/libraryDb";

const SUITE = "cast-without-tmdb-id";
let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-cast-no-tmdb-"));
  process.env.SF_USER_DATA_PATH = root;
  console.info(`[${SUITE}:setup] root=${root}`);
});

afterEach(() => {
  console.info(`[${SUITE}:teardown] removing root=${root}`);
  rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
});


const addMovie = (db: LibraryDb, id: number, title: string, cast: TmdbCastMember[]) =>
  db.addMediaFromTmdb({
    id,
    type: "movie",
    title,
    originalTitle: title,
    originalLanguage: "de",
    overview: null,
    year: "1919",
    rating: null,
    posterPath: null,
    backdropPath: null,
    genres: [],
    cast,
    trailers: [],
    seasons: [],
    episodes: [],
    totalEpisodes: 0,
  } satisfies TmdbDetails);

// The cast of "Anders als die Andern" (1919) as the metadata service answered it: names, roles and photos, no ids.
const IDLESS_CAST: TmdbCastMember[] = [
  { tmdbId: null, name: "Conrad Veidt", role: "Paul Körner", profilePath: "/veidt.jpg", order: null },
  { tmdbId: null, name: "Reinhold Schünzel", role: "Franz Bollek", profilePath: "/schuenzel.jpg", order: null },
  { tmdbId: null, name: "Anita Berber", role: "Else", profilePath: "/berber.jpg", order: null },
];

const dump = (db: LibraryDb, label: string, mediaId: string) => {
  try {
    const details = db.getMediaDetails(mediaId);
    console.error(`=== [${SUITE}:${label}] cast snapshot ===`);
    console.error(JSON.stringify(details?.cast ?? null, null, 2));
    console.error(`=== [${SUITE}:${label}] end snapshot ===`);
  } catch (error) {
    console.error(`(snapshot failed: ${error instanceof Error ? error.message : String(error)})`);
  }
};

describe("@bugfix @regression-proof cast members without a TMDB person id", () => {
  it("keeps one person per role when the cast carries no TMDB ids", async () => {
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);
    console.info(`[${SUITE}:exec] adding movie with ${IDLESS_CAST.length} id-less cast members`);
    const mediaId = await addMovie(db, 28055, "Anders als die Andern", IDLESS_CAST);

    try {
      const roles = db.getMediaDetails(mediaId)?.cast ?? [];
      console.info(`[${SUITE}:check] roles=${JSON.stringify(roles.map((r) => [r.personId, r.name, r.role, r.profilePath, r.tmdbId]))}`);
      expect(roles.map((r) => [r.name, r.role, r.profilePath])).toEqual(
        IDLESS_CAST.map((member) => [member.name, member.role, member.profilePath])
      );
      expect(new Set(roles.map((r) => r.personId)).size).toBe(IDLESS_CAST.length);
      expect(roles.every((r) => r.tmdbId === null)).toBe(true);
    } catch (error) {
      dump(db, "distinct-people", mediaId);
      throw error;
    }
  });

  it("does not merge the id-less cast of one title into another title's people", async () => {
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);
    const first = await addMovie(db, 28055, "Anders als die Andern", IDLESS_CAST);
    const second = await addMovie(db, 9101, "Another Film", [
      { tmdbId: null, name: "Someone Else", role: "Lead", profilePath: "/else.jpg", order: null },
    ]);
    console.info(`[${SUITE}:exec] first=${first} second=${second}`);

    try {
      const firstRoles = db.getMediaDetails(first)?.cast ?? [];
      const secondRoles = db.getMediaDetails(second)?.cast ?? [];
      console.info(`[${SUITE}:check] first=${JSON.stringify(firstRoles.map((r) => r.name))} second=${JSON.stringify(secondRoles.map((r) => r.name))}`);
      // Pre-fix the second title renamed the shared "TMDB 0" person, so the first title's roles all read "Someone Else".
      expect(firstRoles.map((r) => r.name)).toEqual(IDLESS_CAST.map((m) => m.name));
      expect(secondRoles.map((r) => r.name)).toEqual(["Someone Else"]);
    } catch (error) {
      dump(db, "cross-title-first", first);
      dump(db, "cross-title-second", second);
      throw error;
    }
  });

  it("still links a cast member with a real TMDB id to the same person across titles", async () => {
    const db = await LibraryDb.openLocal("token", "key");
    db.setSyncEnabled(false);
    const veidt: TmdbCastMember = { tmdbId: 3007, name: "Conrad Veidt", role: "Paul Körner", profilePath: "/veidt.jpg", order: 0 };
    const first = await addMovie(db, 28055, "Anders als die Andern", [veidt]);
    const second = await addMovie(db, 234, "Das Cabinet des Dr. Caligari", [{ ...veidt, role: "Cesare" }]);
    const a = db.getMediaDetails(first)?.cast ?? [];
    const b = db.getMediaDetails(second)?.cast ?? [];
    console.info(`[${SUITE}:check] a=${JSON.stringify(a)} b=${JSON.stringify(b)}`);
    expect(a[0]?.personId).toBe(b[0]?.personId);
    expect(a[0]?.tmdbId).toBe(3007);
  });
});
