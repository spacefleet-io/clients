/**
 * @test-id PARROT-INGEST-WAL-SNAPSHOT-001
 * @level unit
 * @bugfix
 * @regression-proof
 * @why LIB-FMT-10: Parrot iOS published its library as the phone's own SQLite file, in WAL mode (header bytes
 *   18/19 = 2), and Parrot desktop could not open it: node:sqlite's `deserialize` (in-memory SQLite) refused it with
 *   "unable to open database file", so the desktop never showed that library. The snapshots already stored that way
 *   stay on the server, so the desktop must open them; a snapshot it then saves is a rollback-journal file again.
 *   The WAL library here is made the way the phone makes it: a real Parrot library file switched to WAL, written
 *   to, folded with a TRUNCATE checkpoint and read as bytes.
 * @req LIB-FMT-10[parrot]
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { parrotOpStatements } from "@space/parrot-core";
import { parrotAudioFormatFor } from "../src/formats";
import { parrotTrackIds, sha256Hex } from "../src/ids";
import { buildParrotTrackOps } from "../src/importer";
import { listParrotTracks, openParrotLibrary, serializeParrotLibrary, type ParrotLibraryDb } from "../src/library";
import { testLog } from "./helpers";

const log = testLog("PARROT-INGEST-WAL-SNAPSHOT-001");

const trackOps = (title: string, number: number) => {
  const info = {
    file: `/music/${title}.mp3`,
    artist: "Linnet Park",
    albumArtist: "Linnet Park",
    album: "Meltway",
    disc: 1,
    year: 2003,
    durationMs: 187_000,
    bitrateKbps: 320,
    sampleRate: 44100,
    format: parrotAudioFormatFor("x.mp3")!,
    title,
    number,
  };
  const fileHash = sha256Hex(`bytes of ${title}`);
  const ids = parrotTrackIds({ ...info, fileHash });
  const chunks = [{ idx: 0, objectKey: `media/p/${ids.fileId}/chunk-0`, plainOffset: 0, plainSize: 500 }];
  return buildParrotTrackOps({ info, fileHash, sizeBytes: 500, chunks, now: 1_700_000_000_000 });
};

/** The phone's library file: a Parrot library in WAL mode with a song written after the switch, folded and read. */
const phoneWalSnapshot = () => {
  const dir = mkdtempSync(join(tmpdir(), "parrot-wal-"));
  try {
    const path = join(dir, "parrot.sqlite");
    const start = openParrotLibrary(null);
    const ops = trackOps("Nook", 13);
    for (const { sql, params } of parrotOpStatements(ops)) start.prepare(sql).run(...(params as SQLInputValue[]));
    writeFileSync(path, serializeParrotLibrary(start));
    start.close();
    const phone = new DatabaseSync(path);
    phone.exec("PRAGMA journal_mode=WAL");
    for (const { sql, params } of parrotOpStatements(trackOps("Fable", 7))) phone.prepare(sql).run(...(params as SQLInputValue[]));
    phone.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const bytes = new Uint8Array(readFileSync(path));
    phone.close();
    return bytes;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe("a library snapshot stored in WAL mode", () => {
  it("opens on the desktop with every song, and saves back as a rollback-journal file @req LIB-FMT-10[parrot]", () => {
    const wal = phoneWalSnapshot();
    log("phone snapshot", { bytes: wal.length, header: [wal[18], wal[19]] });
    expect([wal[18], wal[19]], "the phone's file says WAL").toEqual([2, 2]);

    let opened: ParrotLibraryDb | null = null;
    let failure: string | null = null;
    try {
      opened = openParrotLibrary(wal);
    } catch (error) {
      failure = String(error);
    }
    log("opened", { failure });
    expect(failure, "the desktop opens the WAL snapshot").toBeNull();
    const titles = listParrotTracks(opened!).map((track) => track.title);
    log("tracks", titles);
    expect(titles.sort()).toEqual(["Fable", "Nook"]);

    const saved = serializeParrotLibrary(opened!);
    log("saved", { header: [saved[18], saved[19]] });
    expect([saved[18], saved[19]], "what the desktop saves is a rollback-journal file").toEqual([1, 1]);
    expect([wal[18], wal[19]], "the downloaded bytes are not changed in place").toEqual([2, 2]);
    opened!.close();
  });
});
