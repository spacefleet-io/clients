/**
 * @test-id PARROT-INGEST-LYRICS-001
 * @level unit
 * @why PAR-LYR-01: a song's own lyrics are read at import, a same-name `.lrc` next to the file first, then the file's
 *      tags (timed lines as synced lyrics, else plain text, LRC text in the plain field read as synced); the import
 *      writes them into the library with a `lyrics.set` op, and the apps read them back synced, line by line.
 *      Deleting the song takes its lyrics with it.
 * @covers packages/parrot-ingest/src/readTrack.ts: readOwnLyrics, packages/parrot-ingest/src/importer.ts: buildParrotTrackOps,
 *         packages/parrot-ingest/src/library.ts: getParrotLyrics
 * @req PAR-LYR-01[parrot]
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createParrotOp } from "@space/parrot-library-db-definition";
import type { ILyricsTag } from "music-metadata";
import { parrotAudioFormatFor } from "../src/formats";
import { parrotTrackIds, sha256Hex } from "../src/ids";
import { buildParrotTrackOps } from "../src/importer";
import { applyParrotOps, getParrotLyrics, openParrotLibrary } from "../src/library";
import { readOwnLyrics, type ParrotTrackInfo } from "../src/readTrack";
import { testLog } from "./helpers";

const log = testLog("PARROT-INGEST-LYRICS-001");
const dir = mkdtempSync(path.join(tmpdir(), "parrot-lyrics-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const tag = (patch: Partial<ILyricsTag>): ILyricsTag => ({ contentType: 1, timeStampFormat: 2, syncText: [], ...patch }) as ILyricsTag;

describe("a song's own lyrics (PAR-LYR-01)", () => {
  it("takes the same-name .lrc next to the file first, over the tags", async () => {
    const file = path.join(dir, "01 - Song.flac");
    writeFileSync(path.join(dir, "01 - Song.lrc"), "[ar:Test]\n[00:01.50] First line\n[00:04.00] Second line\n");
    const lyrics = await readOwnLyrics(file, [tag({ text: "Plain words from the tag" })]);
    log("from .lrc", lyrics);
    expect(lyrics).toEqual({ synced: "[00:01.50] First line\n[00:04.00] Second line", plain: "Plain words from the tag" });
  });

  it("reads timed tag lines as synced lyrics and plain tag text as plain lyrics", async () => {
    const file = path.join(dir, "02 - Other.mp3");
    const synced = await readOwnLyrics(file, [tag({ syncText: [{ text: "Hello", timestamp: 1000 }, { text: "World", timestamp: 2500 }] })]);
    const plain = await readOwnLyrics(file, [tag({ text: "Just words\nno times" })]);
    const lrcInPlain = await readOwnLyrics(file, [tag({ text: "[00:02.00] Timed in the plain field" })]);
    const none = await readOwnLyrics(file, undefined);
    log("from tags", { synced, plain, lrcInPlain, none });
    expect(synced).toEqual({ synced: "[00:01.00] Hello\n[00:02.50] World", plain: null });
    expect(plain).toEqual({ synced: null, plain: "Just words\nno times" });
    expect(lrcInPlain).toEqual({ synced: "[00:02.00] Timed in the plain field", plain: null });
    expect(none).toBeNull();
  });

  it("stores them with the song at import, reads them back synced, and drops them with the song", () => {
    const db = openParrotLibrary(null);
    const info: ParrotTrackInfo = {
      file: "/music/Song.flac",
      artist: "Artist",
      albumArtist: "Artist",
      album: "Album",
      title: "Song",
      disc: 1,
      number: 1,
      year: 2020,
      durationMs: 200_000,
      bitrateKbps: 900,
      sampleRate: 44100,
      format: parrotAudioFormatFor("x.flac")!,
      lyrics: { synced: "[00:01.00] Hello\n[00:02.50] World", plain: null },
    };
    const fileHash = sha256Hex("bytes");
    const ids = parrotTrackIds({ ...info, fileHash });
    const ops = buildParrotTrackOps({ info, fileHash, sizeBytes: 10, chunks: [{ idx: 0, objectKey: "k", plainOffset: 0, plainSize: 10 }], now: 1 });
    expect(ops.map((op) => op.type)).toContain("lyrics.set");
    applyParrotOps(db, ops);
    const read = getParrotLyrics(db, ids.trackId);
    log("read back", read);
    expect(read).toEqual({ synced: [{ ms: 1000, text: "Hello" }, { ms: 2500, text: "World" }], plain: null, fetched: false });
    applyParrotOps(db, [createParrotOp("track.delete", { id: ids.trackId }, { id: "d", createdAt: new Date(2).toISOString() })]);
    expect(getParrotLyrics(db, ids.trackId)).toBeNull();
    db.close();
  });
});
