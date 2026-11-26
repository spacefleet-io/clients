/**
 * @req LIB-CAST-01
 * @bugfix cast-list-repeats-one-actor
 *
 * Libraries written before the LIB-CAST-01 fix still hold casts merged into one person: every role points at one
 * `people` row, which carries catalog person id 0. `listMediaWithCollapsedCast` finds those titles and
 * `refetchCollapsedCasts` fetches each one's cast once: a synced `cast_refetch_v1:<mediaId>` setting marks it, so a
 * later pass (or another device) never fetches it again, and a title whose fetch keeps failing stops after
 * `CAST_REFETCH_MAX_ATTEMPTS` passes.
 *
 * Real engine (bun:sqlite, full LibraryDb); the collapsed state is rebuilt the way the old code left it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { peopleExternalIds } from "@space/library-db-definition/schema";
import { LEGACY_CATALOG_ID_SOURCE } from "@space/library-db-definition/legacyFormat";
import type { CastMember, TitleDetails } from "../src/api";
import { LibraryDb } from "../src/libraryDb";
import {
  CAST_REFETCH_MAX_ATTEMPTS,
  CAST_REFETCH_SETTING_PREFIX,
  refetchCollapsedCasts,
} from "../src/castRefetch";

const SUITE = "cast-refetch";
let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-cast-refetch-"));
  process.env.SF_USER_DATA_PATH = root;
  console.info(`[${SUITE}:setup] root=${root}`);
});

afterEach(() => {
  console.info(`[${SUITE}:teardown] removing root=${root}`);
  rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
});

// "Anders als die Andern" (1919) as the catalog credits it.
const CATALOG_CAST: CastMember[] = [
  { personId: 11, name: "Conrad Veidt", role: "Paul Körner", profilePath: "/veidt.jpg", order: 0 },
  { personId: 12, name: "Reinhold Schünzel", role: "Franz Bollek", profilePath: "/schuenzel.jpg", order: 1 },
  { personId: 13, name: "Anita Berber", role: "Else", profilePath: "/berber.jpg", order: 2 },
];

const addMovie = (db: LibraryDb, id: number, title: string, cast: CastMember[]) =>
  db.addMediaFromCatalog({
    id,
    type: "movie",
    title,
    originalTitle: title,
    originalLanguage: "de",
    overview: null,
    year: "1919",
    posterPath: null,
    backdropPath: null,
    genres: [],
    cast,
    trailers: [],
    seasons: [],
    episodes: [],
    totalEpisodes: 0,
  } satisfies TitleDetails);

/** What the old code left: every role on the first person, which carries catalog person id 0. */
const collapse = (db: LibraryDb, mediaId: string) => {
  const roles = db.getMediaDetails(mediaId)?.cast ?? [];
  const personId = roles[0]!.personId;
  db.updateMediaMetadata({
    mediaId,
    cast: roles.map((role) => ({ personId, name: "Helga Molander", role: role.role, profilePath: "/molander.jpg" })),
  });
  // The fixed code refuses catalog person id 0, so the old row is written straight into the private metadata ORM.
  const legacyWriter = db as unknown as { metadata: { insert: (table: unknown) => any } };
  legacyWriter.metadata.insert(peopleExternalIds).values({ id: `zero-${personId}`, personId, source: LEGACY_CATALOG_ID_SOURCE, externalId: "0" }).run();
};

const castOf = (db: LibraryDb, mediaId: string) =>
  (db.getMediaDetails(mediaId)?.cast ?? []).map((role) => [role.personId, role.name, role.role, role.catalogId]);

const openLibrary = async () => {
  const db = await LibraryDb.openLocal("token", "key");
  db.setSyncEnabled(false);
  return db;
};

describe("@bugfix one-time refetch of casts merged into one person", () => {
  it("lists only the collapsed title, refetches it once and marks it done", async () => {
    const db = await openLibrary();
    const broken = await addMovie(db, 44441, "Anders als die Andern", CATALOG_CAST);
    const healthy = await addMovie(db, 961, "The General", [
      { personId: 21, name: "Buster Keaton", role: "Johnnie Gray", profilePath: "/keaton.jpg", order: 0 },
      { personId: 22, name: "Marion Mack", role: "Annabelle Lee", profilePath: "/mack.jpg", order: 1 },
    ]);
    collapse(db, broken);
    console.info(`[${SUITE}:setup] broken cast=${JSON.stringify(castOf(db, broken))}`);

    const listed = db.listMediaWithCollapsedCast();
    console.info(`[${SUITE}:check] listed=${JSON.stringify(listed)} broken=${broken} healthy=${healthy}`);
    expect(listed).toEqual([broken]);

    const calls: string[] = [];
    const refetch = async (mediaId: string) => {
      calls.push(mediaId);
      db.updateMediaMetadata({
        mediaId,
        cast: CATALOG_CAST.map(({ personId, name, role, profilePath }) => ({ catalogId: personId, name, role, profilePath })),
      });
    };
    const first = await refetchCollapsedCasts(db, refetch);
    console.info(`[${SUITE}:pass1] result=${JSON.stringify(first)} calls=${JSON.stringify(calls)}`);
    console.info(`[${SUITE}:pass1] cast=${JSON.stringify(castOf(db, broken))}`);
    expect(first).toEqual({ found: 1, refetched: 1, failed: 0, skipped: 0 });
    expect(calls).toEqual([broken]);
    expect(db.getSetting(`${CAST_REFETCH_SETTING_PREFIX}${broken}`)?.value).toBe("done");

    const roles = db.getMediaDetails(broken)?.cast ?? [];
    expect(roles.map((role) => [role.name, role.role, role.catalogId])).toEqual(
      CATALOG_CAST.map((member) => [member.name, member.role, member.personId])
    );
    expect(new Set(roles.map((role) => role.personId)).size).toBe(CATALOG_CAST.length);
    expect(db.listMediaWithCollapsedCast()).toEqual([]);

    const second = await refetchCollapsedCasts(db, refetch);
    console.info(`[${SUITE}:pass2] result=${JSON.stringify(second)} calls=${JSON.stringify(calls)}`);
    expect(second.refetched).toBe(0);
    expect(calls).toEqual([broken]);
  });

  it("never fetches a marked title again, even when it still lists (an actor credited twice)", async () => {
    const db = await openLibrary();
    const mediaId = await addMovie(db, 44441, "Anders als die Andern", CATALOG_CAST);
    collapse(db, mediaId);
    db.setSetting(`${CAST_REFETCH_SETTING_PREFIX}${mediaId}`, "done");

    let calls = 0;
    const result = await refetchCollapsedCasts(db, async () => {
      calls += 1;
    });
    console.info(`[${SUITE}:marked] result=${JSON.stringify(result)} calls=${calls}`);
    expect(result).toEqual({ found: 1, refetched: 0, failed: 0, skipped: 1 });
    expect(calls).toBe(0);
  });

  it(`stops trying a title after ${CAST_REFETCH_MAX_ATTEMPTS} failed passes`, async () => {
    const db = await openLibrary();
    const mediaId = await addMovie(db, 44441, "Anders als die Andern", CATALOG_CAST);
    collapse(db, mediaId);

    let calls = 0;
    const errors: string[] = [];
    const failing = async () => {
      calls += 1;
      throw new Error("offline");
    };
    for (let pass = 1; pass <= CAST_REFETCH_MAX_ATTEMPTS + 2; pass += 1) {
      const result = await refetchCollapsedCasts(db, failing, { onError: (id, error) => errors.push(`${id}:${error}`) });
      const marker = db.getSetting(`${CAST_REFETCH_SETTING_PREFIX}${mediaId}`)?.value;
      console.info(`[${SUITE}:failing] pass=${pass} result=${JSON.stringify(result)} marker=${marker} calls=${calls}`);
    }
    expect(calls).toBe(CAST_REFETCH_MAX_ATTEMPTS);
    expect(errors).toHaveLength(CAST_REFETCH_MAX_ATTEMPTS);
    expect(db.getSetting(`${CAST_REFETCH_SETTING_PREFIX}${mediaId}`)?.value).toBe(`failed:${CAST_REFETCH_MAX_ATTEMPTS}`);
  });
});
