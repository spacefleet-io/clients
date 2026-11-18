/**
 * @req META-SRC-09[badger-desktop,badger-mobile,badger-tv,badger-web-player]
 *
 * Libraries written by older apps still replay and read: a `media.upsert` of op stream v2 (catalog ids under the old
 * keys, other sites' ids beside them) lands as the neutral rows, and the source migration turns an older library's
 * external-id rows into catalog rows only. The old names appear in this file and `src/legacyFormat.ts` only.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import type { LibraryOp } from "@space/shared/libraryOps";
import type { MediaDetails } from "@space/shared/libraryTypes";
import { CATALOG_ID_SOURCE } from "../src/catalogId";
import { catalogSourceMigrationStatements, LEGACY_CATALOG_ID_SOURCE, neutralMediaDetails } from "../src/legacyFormat";
import { assembleMediaDetails, mediaDetailsQueries, type MediaDetailsRows } from "../src/mediaDetails";
import { getGroupDdlStatements } from "../src/migrations";
import { buildOpStatements } from "../src/ops";

const log = (phase: string, data?: unknown) =>
  console.info(`[legacy-format] ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const T = "2026-11-01T00:00:00.000Z";

/** A `media.upsert` exactly as an app of op stream v2 wrote it. */
const v2Upsert = (): LibraryOp =>
  ({
    id: "op-v2",
    createdAt: T,
    type: "media.upsert",
    payload: {
      details: {
        id: "media-old",
        type: "tv",
        tmdbId: 1399,
        externalIds: { imdb: "tt0944947", tvdb: 121361 },
        title: "Old Show",
        originalTitle: null,
        originalLanguage: "en",
        overview: null,
        year: "2011",
        rating: null,
        posterPath: null,
        backdropPath: null,
        genres: [],
        addedAt: T,
        updatedAt: T,
        hasFiles: false,
        progressPct: 0,
        lastWatchedAt: null,
        totalEpisodes: null,
        episodeCount: 0,
        cast: [{ id: "role-1", personId: "p-1", tmdbId: 22970, name: "Actor", role: "Lead", profilePath: null }],
        crew: [{ id: "crew-1", personId: "p-2", tmdbId: 9813, name: "Writer", job: "Writer", profilePath: null }],
        playlistIds: [],
        seasons: [],
        episodes: [],
        trailers: [],
        files: [],
      },
    },
  }) as unknown as LibraryOp;

const db = () => {
  const handle = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  for (const sql of [...getGroupDdlStatements("core"), ...getGroupDdlStatements("metadata")]) handle.exec(sql);
  return handle;
};

const apply = (handle: DatabaseSync, op: LibraryOp) => {
  let n = 0;
  const built = buildOpStatements(op, () => `gen-${++n}`);
  for (const group of ["core", "metadata"] as const) {
    for (const statement of built[group] ?? []) handle.prepare(statement.sql).run(...(statement.params as never[]));
  }
};

const read = (handle: DatabaseSync, mediaId: string): MediaDetails | null => {
  const rows: MediaDetailsRows = {};
  for (const query of mediaDetailsQueries(mediaId)) {
    if (query.group !== "core" && query.group !== "metadata") continue;
    rows[query.name] = handle.prepare(query.sql).all(...(query.params as never[])) as Record<string, unknown>[];
  }
  return assembleMediaDetails(mediaId, rows);
};

describe("op stream v2 media.upsert", () => {
  test("replays into catalog rows only and reads back with its catalog ids", () => {
    const handle = db();
    apply(handle, v2Upsert());
    const media = handle.prepare("SELECT source, external_id FROM media_external_ids ORDER BY source;").all();
    const people = handle.prepare("SELECT person_id, source, external_id FROM people_external_ids ORDER BY person_id;").all();
    log("v2.replayed", { media, people });
    expect(media).toEqual([{ source: CATALOG_ID_SOURCE, external_id: "1399" }]);
    expect(people).toEqual([
      { person_id: "p-1", source: CATALOG_ID_SOURCE, external_id: "22970" },
      { person_id: "p-2", source: CATALOG_ID_SOURCE, external_id: "9813" },
    ]);
    const details = read(handle, "media-old");
    log("v2.read", { catalogId: details?.catalogId, cast: details?.cast, crew: details?.crew });
    expect(details?.catalogId).toBe(1399);
    expect(details?.cast.map((member) => member.catalogId)).toEqual([22970]);
    expect(details?.crew?.map((member) => member.catalogId)).toEqual([9813]);
    expect(details).not.toHaveProperty("tmdbId");
    expect(details).not.toHaveProperty("externalIds");
  });

  test("a v2 payload that only carried the id among its other sites' ids still finds it", () => {
    const op = v2Upsert() as unknown as { payload: { details: Record<string, unknown> } };
    delete op.payload.details.tmdbId;
    op.payload.details.externalIds = { [LEGACY_CATALOG_ID_SOURCE]: 1399, imdb: "tt0944947" };
    expect(neutralMediaDetails(op.payload.details as unknown as MediaDetails).catalogId).toBe(1399);
  });

  test("current details pass through unchanged", () => {
    const current = { ...(v2Upsert() as unknown as { payload: { details: MediaDetails } }).payload.details };
    const { tmdbId: _id, externalIds: _ids, ...rest } = current as MediaDetails & { tmdbId?: unknown; externalIds?: unknown };
    const neutral = { ...rest, catalogId: 1399, cast: [], crew: [] } as MediaDetails;
    expect(neutralMediaDetails(neutral)).toBe(neutral);
  });
});

describe("source migration of an older library", () => {
  test("keeps the catalog ids under the catalog source and drops the other sites' rows", () => {
    const handle = db();
    const insertMedia = handle.prepare("INSERT INTO media_external_ids (id, media_id, media_type, source, external_id) VALUES (?, ?, ?, ?, ?);");
    insertMedia.run("e1", "media-old", "tv", LEGACY_CATALOG_ID_SOURCE, "1399");
    insertMedia.run("e2", "media-old", "tv", "imdb", "tt0944947");
    insertMedia.run("e3", "media-old", "tv", "tvdb", "121361");
    // A row the rename would duplicate: already written under the new source by a newer op.
    insertMedia.run("e4", "media-new", "movie", LEGACY_CATALOG_ID_SOURCE, "603");
    insertMedia.run("e5", "media-new", "movie", CATALOG_ID_SOURCE, "603");
    const insertPerson = handle.prepare("INSERT INTO people_external_ids (id, person_id, source, external_id) VALUES (?, ?, ?, ?);");
    insertPerson.run("x1", "p-1", LEGACY_CATALOG_ID_SOURCE, "22970");
    insertPerson.run("x2", "p-1", "imdb", "nm0227759");

    for (const sql of [...catalogSourceMigrationStatements("core"), ...catalogSourceMigrationStatements("metadata")]) handle.exec(sql);
    const media = handle.prepare("SELECT id, source, external_id FROM media_external_ids ORDER BY id;").all();
    const people = handle.prepare("SELECT id, source, external_id FROM people_external_ids ORDER BY id;").all();
    log("migrated", { media, people });
    expect(media).toEqual([
      { id: "e1", source: CATALOG_ID_SOURCE, external_id: "1399" },
      { id: "e5", source: CATALOG_ID_SOURCE, external_id: "603" },
    ]);
    expect(people).toEqual([{ id: "x1", source: CATALOG_ID_SOURCE, external_id: "22970" }]);
  });

  test("a restored snapshot that has not run the migration yet still reads its catalog ids", () => {
    const handle = db();
    handle.prepare("INSERT INTO media_items (id, type, title, added_at, updated_at) VALUES ('media-old', 'tv', 'Old Show', ?, ?);").run(T, T);
    handle
      .prepare("INSERT INTO media_external_ids (id, media_id, media_type, source, external_id) VALUES ('e1', 'media-old', 'tv', ?, '1399');")
      .run(LEGACY_CATALOG_ID_SOURCE);
    expect(read(handle, "media-old")?.catalogId).toBe(1399);
  });
});
