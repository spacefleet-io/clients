/**
 * @req PAR-COPY-01[parrot]
 * @test-id PARROT-INGEST-RELEASE-GROUP-001
 * @level unit
 * @covers packages/parrot-ingest/src/scan.ts: applyParrotImportEdit, packages/parrot-ingest/src/importer.ts: buildParrotTrackOps
 *
 * Why: the copy-changes refresh (and the album-cover pass) find the user's albums by their catalog id. Found on the
 * dev lane 2026-11-16: the importer stored every album with no catalog id, so a changed album the user held was
 * never refreshed. The matched album's catalog id must reach the library, and a later song of the same album
 * imported without a match must not wipe it.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { buildParrotOpStatements, parrotLibraryMigrationStatements, type ParrotLibraryOp } from "@space/parrot-library-db-definition";
import { buildParrotTrackOps } from "../src/importer";
import type { ParrotTrackInfo } from "../src/readTrack";
import { applyParrotImportEdit } from "../src/scan";
import { testLog } from "./helpers";

const log = testLog("PARROT-INGEST-RELEASE-GROUP-001");
const GROUP = "0a7e3c1e-0000-4000-8000-0000000000a5";

const song = (title: string, number: number): ParrotTrackInfo => ({
  file: `/music/${title}.mp3`,
  artist: "Linnet Park",
  albumArtist: "Linnet Park",
  album: "Live in Tarvo",
  title,
  disc: 1,
  number,
  year: 2003,
  durationMs: 185_000,
  bitrateKbps: 320,
  sampleRate: 44_100,
  format: { codec: "mp3", container: "mp3", mime: "audio/mpeg", lossless: false },
});

const apply = (db: Database, ops: readonly ParrotLibraryOp[]) =>
  db.transaction(() => {
    for (const op of ops)
      for (const statements of Object.values(buildParrotOpStatements(op)))
        for (const { sql, params } of statements ?? []) db.prepare(sql).run(...(params as never[]));
  })();

const importOps = (info: ParrotTrackInfo, fileHash: string) =>
  buildParrotTrackOps({ info, fileHash, sizeBytes: 10, chunks: [{ idx: 0, objectKey: `${fileHash}/chunk-0`, plainOffset: 0, plainSize: 10 }], now: 1 });

describe("the matched album's catalog id", () => {
  it("is stored on the album at import and kept when a later song brings none", () => {
    log("phase: setup — empty library");
    const db = new Database(":memory:");
    for (const sql of parrotLibraryMigrationStatements(0)) db.run(sql);

    log("phase: act — import a song confirmed on a matched album");
    const matched = applyParrotImportEdit(song("Nook (Live)", 13), { artist: "", album: "", title: "", albumMusicId: GROUP });
    log("edited info", { albumMusicId: matched.albumMusicId });
    apply(db, importOps(matched, "a"));
    const groups = () => db.query("SELECT music_id AS g FROM albums").all() as Array<{ g: string | null }>;
    log("albums after the matched song", groups());
    expect(groups()).toEqual([{ g: GROUP }]);

    log("phase: act — import a second song of the same album, kept as is (no match)");
    apply(db, importOps(song("Fable (Live)", 6), "b"));
    log("albums after the unmatched song", groups());
    expect(groups()).toEqual([{ g: GROUP }]);
    log("phase: done");
  });
});
