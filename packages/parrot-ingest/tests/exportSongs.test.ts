/**
 * @test-id PARROT-INGEST-EXPORT-001
 * @level integration
 * @why "Download everything" (OFFL-FILE-01, ACCT-EXPORT-01) must give back the user's own file: the
 *   decrypted chunks of the original, byte for byte (a split-stored one rebuilt into one standard file with the
 *   library's names and album cover), never the light copy (OFFL-QUAL-01), under
 *   `Artist/Album/01 Title.ext` (OFFL-FILE-02). A failed, cancelled or full-disk run must leave nothing half-written
 *   under a song's name (OFFL-SAFE-01, OFFL-SAFE-02), and a second export never overwrites the first, even when the
 *   only difference is letter case.
 * @covers packages/parrot-ingest/src/exportSongs.ts
 * @covers packages/parrot-ingest/src/exportFile.ts
 * @req OFFL-FILE-01[parrot]
 * @req OFFL-FILE-02[parrot]
 * @req OFFL-SAFE-01[parrot]
 * @req OFFL-SAFE-02[parrot]
 * @req ACCT-EXPORT-01[parrot]
 * @req PAR-LYR-11[parrot]
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { sealMediaObjectWithPadding } from "@space/media-crypto";
import { PARROT_LIBRARY_SCHEMA_VERSION, parrotLibraryMigrationStatements } from "@space/parrot-library-db-definition";
import { encryptBytesToBytes } from "@space/library-db-runtime/crypto";
import {
  ParrotExportNoSpaceError,
  PARROT_EXPORT_PARTIAL_DIR,
  clearParrotExportPartials,
  exportParrotSongs,
  listParrotExportSongs,
} from "../src/exportSongs";
import { parrotExportExtension } from "../src/exportFile";
import { openParrotLibrary, type ParrotLibraryDb } from "../src/library";
import { parrotSplitPieces, splitParrotOriginal } from "../src/splitOriginal";
import { makeAudioFixture, makeCoverPicture, makeTempDir, testLog } from "./helpers";

const log = testLog("PARROT-INGEST-EXPORT-001");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const MIME_BY_CONTAINER: Record<string, string> = { flac: "audio/flac", ogg: "audio/ogg", mp4: "audio/mp4", mp3: "audio/mpeg" };

type Stored = { db: ParrotLibraryDb; key: string; objects: Map<string, Uint8Array>; plain: Map<string, Uint8Array> };

/** A library with one album by "Nina Simone" (2 songs, the first with a light copy) and one compilation song. */
const makeLibrary = (): Stored => {
  const db = openParrotLibrary(null);
  const keyBytes = randomBytes(32);
  const objects = new Map<string, Uint8Array>();
  const plain = new Map<string, Uint8Array>();
  const run = (sql: string, ...params: Array<string | number | null>) => db.prepare(sql).run(...params);
  run("INSERT INTO artists (id, name, sort_name) VALUES ('ar-nina', 'Nina Simone', 'Simone, Nina')");
  run("INSERT INTO artists (id, name, sort_name) VALUES ('ar-va', 'Various Artists', 'Various Artists')");
  run("INSERT INTO artists (id, name, sort_name) VALUES ('ar-guest', 'Guest: Singer', 'Guest Singer')");
  run("INSERT INTO albums (id, title, album_artist_id, created_at, year) VALUES ('al-pastel', 'Pastel Blues', 'ar-nina', 1, 1965)");
  run("INSERT INTO albums (id, title, album_artist_id, created_at) VALUES ('al-hits', 'Jazz Hits?', 'ar-va', 2)");
  const store = (fileId: string, trackId: string, size: number, opts: { light?: boolean; container?: string; codec?: string } = {}) => {
    const bytes = new Uint8Array(randomBytes(size));
    const chunkSize = 1000;
    for (let offset = 0, idx = 0; offset < size; offset += chunkSize, idx += 1) {
      const part = bytes.subarray(offset, offset + chunkSize);
      const objectKey = `media/parrot-test/${fileId}/chunk-${idx}`;
      objects.set(objectKey, new Uint8Array(sealMediaObjectWithPadding(part, keyBytes)));
      run("INSERT INTO track_file_chunks (track_file_id, idx, object_key, plain_offset, plain_size) VALUES (?, ?, ?, ?, ?)", fileId, idx, objectKey, offset, part.length);
    }
    run(
      "INSERT INTO track_files (id, track_id, codec, container, mime, lossless, size_bytes, light_copy, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      fileId,
      trackId,
      opts.codec ?? "flac",
      opts.container ?? "flac",
      MIME_BY_CONTAINER[opts.container ?? "flac"]!,
      opts.light ? 0 : 1,
      size,
      opts.light ? 1 : 0,
      opts.light ? 0 : 5
    );
    plain.set(fileId, bytes);
  };
  run("INSERT INTO tracks (id, album_id, disc, number, title, artist_id) VALUES ('t-sinner', 'al-pastel', 1, 9, 'Sinnerman', 'ar-nina')");
  run("INSERT INTO tracks (id, album_id, disc, number, title, artist_id) VALUES ('t-tell', 'al-pastel', 1, 1, 'Be My Husband', 'ar-nina')");
  run("INSERT INTO tracks (id, album_id, disc, number, title, artist_id) VALUES ('t-guest', 'al-hits', 1, 3, 'Song/One', 'ar-guest')");
  store("f-sinner", "t-sinner", 2500);
  // The light copy was made earlier than nothing else: it must still lose to the original.
  store("f-sinner-light", "t-sinner", 700, { light: true, container: "ogg", codec: "opus" });
  store("f-tell", "t-tell", 1200, { container: "mp4", codec: "aac" });
  store("f-guest", "t-guest", 900, { container: "mp3", codec: "mp3" });
  return { db, key: keyBytes.toString("base64"), objects, plain };
};

const tree = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  const walk = async (at: string) => {
    for (const entry of await fs.readdir(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(path.relative(dir, full).split(path.sep).join("/"));
    }
  };
  await walk(dir);
  return out.sort();
};

const run = (stored: Stored, dest: string, over: Partial<Parameters<typeof exportParrotSongs>[0]> = {}) =>
  exportParrotSongs({
    db: stored.db,
    songs: listParrotExportSongs(stored.db),
    dest,
    libraryKeyBase64: () => stored.key,
    readSealed: async (objectKey) => stored.objects.get(objectKey)!,
    signal: new AbortController().signal,
    freeBytes: async () => 10 * 1024 * 1024 * 1024,
    log: (line) => log(line),
    ...over,
  });

describe("exporting songs as plain files", () => {
  it("lists every song with its original, never the light copy", () => {
    const stored = makeLibrary();
    const songs = listParrotExportSongs(stored.db);
    log("songs", songs);
    expect(songs.map((song) => [song.trackId, song.fileId])).toEqual([
      ["t-tell", "f-tell"],
      ["t-sinner", "f-sinner"],
      ["t-guest", "f-guest"],
    ]);
  });

  it("writes Artist/Album/NN Title.ext with the decrypted bytes of the upload", async () => {
    const stored = makeLibrary();
    const dest = await makeTempDir("export");
    const progress: string[] = [];
    const done: string[] = [];
    const result = await run(stored, dest, { onProgress: (p) => progress.push(`${p.doneSongs}/${p.totalSongs} ${p.doneBytes}/${p.totalBytes}`), onSongDone: (id) => done.push(id) });
    const files = await tree(dest);
    log("tree", files);
    log("progress", progress.slice(-3));
    expect(files).toEqual(["Nina Simone/Pastel Blues/01 Be My Husband.m4a", "Nina Simone/Pastel Blues/09 Sinnerman.flac", "Various Artists/Jazz Hits/03 SongOne.mp3"]);
    for (const [file, fileId] of [
      ["Nina Simone/Pastel Blues/09 Sinnerman.flac", "f-sinner"],
      ["Nina Simone/Pastel Blues/01 Be My Husband.m4a", "f-tell"],
      ["Various Artists/Jazz Hits/03 SongOne.mp3", "f-guest"],
    ] as const) {
      const written = new Uint8Array(await fs.readFile(path.join(dest, file)));
      log("sha256", { file, written: sha(written), original: sha(stored.plain.get(fileId)!) });
      expect(sha(written)).toBe(sha(stored.plain.get(fileId)!));
    }
    expect(result.failed).toEqual([]);
    expect(result.stopped).toBeNull();
    expect(done).toEqual(["t-tell", "t-sinner", "t-guest"]);
    expect(progress.at(-1)).toBe("3/3 4600/4600");
  });

  it("never overwrites: a second export, and a name differing only in case, get (2)", async () => {
    const stored = makeLibrary();
    const dest = await makeTempDir("export-again");
    await fs.mkdir(path.join(dest, "nina simone", "PASTEL BLUES"), { recursive: true });
    await fs.writeFile(path.join(dest, "nina simone", "PASTEL BLUES", "09 SINNERMAN.FLAC"), "the user's own file");
    const pastel = listParrotExportSongs(stored.db).filter((song) => song.albumId === "al-pastel");
    await run(stored, dest, { songs: pastel });
    await run(stored, dest, { songs: pastel });
    const files = await tree(dest);
    log("tree", files);
    expect(files).toEqual([
      "nina simone/PASTEL BLUES/01 Be My Husband (2).m4a",
      "nina simone/PASTEL BLUES/01 Be My Husband.m4a",
      "nina simone/PASTEL BLUES/09 SINNERMAN.FLAC",
      "nina simone/PASTEL BLUES/09 Sinnerman (2).flac",
      "nina simone/PASTEL BLUES/09 Sinnerman (3).flac",
    ]);
    expect(await fs.readFile(path.join(dest, "nina simone", "PASTEL BLUES", "09 SINNERMAN.FLAC"), "utf8")).toBe("the user's own file");
  });

  it("gives two songs finishing together two names", async () => {
    const stored = makeLibrary();
    const dest = await makeTempDir("export-race");
    const songs = listParrotExportSongs(stored.db).filter((song) => song.trackId === "t-sinner");
    await Promise.all([run(stored, dest, { songs }), run(stored, dest, { songs }), run(stored, dest, { songs })]);
    const files = await tree(dest);
    log("tree", files);
    expect(files).toEqual(["Nina Simone/Pastel Blues/09 Sinnerman (2).flac", "Nina Simone/Pastel Blues/09 Sinnerman (3).flac", "Nina Simone/Pastel Blues/09 Sinnerman.flac"]);
  });

  it("leaves nothing under a song's name when a chunk fails, and goes on with the next song", async () => {
    const stored = makeLibrary();
    const dest = await makeTempDir("export-fail");
    const result = await run(stored, dest, {
      readSealed: async (objectKey) => {
        if (objectKey.endsWith("f-sinner/chunk-2")) throw new Error("storage unreachable");
        return stored.objects.get(objectKey)!;
      },
    });
    const files = await tree(dest);
    log("tree", files);
    log("failed", result.failed);
    expect(files).toEqual(["Nina Simone/Pastel Blues/01 Be My Husband.m4a", "Various Artists/Jazz Hits/03 SongOne.mp3"]);
    expect(result.failed).toEqual([{ trackId: "t-sinner", title: "Sinnerman", reason: "storage unreachable" }]);
    expect(await fs.readdir(dest)).not.toContain(PARROT_EXPORT_PARTIAL_DIR);
  });

  it("stops on cancel with no half-written file", async () => {
    const stored = makeLibrary();
    const dest = await makeTempDir("export-cancel");
    const abort = new AbortController();
    const result = await run(stored, dest, {
      signal: abort.signal,
      readSealed: async (objectKey) => {
        if (objectKey.endsWith("f-sinner/chunk-1")) abort.abort();
        return stored.objects.get(objectKey)!;
      },
    });
    const files = await tree(dest);
    log("tree", files, result);
    expect(result.stopped).toBe("cancelled");
    expect(files).toEqual(["Nina Simone/Pastel Blues/01 Be My Husband.m4a"]);
  });

  it("refuses to start without room for every song, and stops when the disk fills", async () => {
    const stored = makeLibrary();
    const dest = await makeTempDir("export-space");
    const refused = await run(stored, dest, { freeBytes: async () => 1000 }).catch((error: unknown) => error);
    log("refused", String(refused));
    expect(refused).toBeInstanceOf(ParrotExportNoSpaceError);
    expect((refused as ParrotExportNoSpaceError).freeBytes).toBe(1000);
    expect(await tree(dest)).toEqual([]);

    let checks = 0;
    const result = await run(stored, dest, { freeBytes: async () => (++checks > 2 ? 10 : 10 * 1024 * 1024 * 1024) });
    log("filled", result);
    expect(result.stopped).toBe("no-space");
    expect(await tree(dest)).toEqual(["Nina Simone/Pastel Blues/01 Be My Husband.m4a"]);
  });

  it("rebuilds a split-stored song into one standard file: library names and album cover inside, sound unchanged", async () => {
    const stored = makeLibrary();
    // A library holding a split song is at schema 11 (API-VER-01); a new one starts at the whole-files schema.
    for (const sql of parrotLibraryMigrationStatements(Number((stored.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version), PARROT_LIBRARY_SCHEMA_VERSION)) stored.db.exec(sql);
    log("schema", stored.db.prepare("PRAGMA user_version").get());
    // A real FLAC upload, stored split as the importer does it: header piece, sound pieces, tags object.
    const work = await makeTempDir("export-split-src");
    const upload = makeAudioFixture(path.join(work, "upload.flac"), { title: "Old Title", artist: "Old Artist", album: "Old Album" }, 2, log, ["-c:a", "flac", "-metadata", "MOOD=calm"]);
    const split = splitParrotOriginal(new Uint8Array(await fs.readFile(upload)), "flac");
    if (split.kind !== "split") throw new Error(`fixture not splittable: ${split.reason}`);
    const pieces = parrotSplitPieces(split.header, split.payload);
    log("split", { header: split.header.length, payload: split.payload.length, pieces: pieces.length, groups: split.tags.groups.length });
    const keyBytes = Buffer.from(stored.key, "base64");
    const size = pieces.reduce((sum, piece) => sum + piece.length, 0);
    stored.db.prepare("DELETE FROM track_file_chunks WHERE track_file_id = 'f-guest'").run();
    for (let idx = 0, offset = 0; idx < pieces.length; offset += pieces[idx]!.length, idx += 1) {
      const objectKey = `media/parrot-test/f-guest/chunk-${idx}`;
      stored.objects.set(objectKey, new Uint8Array(sealMediaObjectWithPadding(pieces[idx]!, keyBytes)));
      stored.db.prepare("INSERT INTO track_file_chunks (track_file_id, idx, object_key, plain_offset, plain_size) VALUES ('f-guest', ?, ?, ?, ?)").run(idx, objectKey, offset, pieces[idx]!.length);
    }
    const tagsKey = "media/parrot-test/f-guest/tags";
    stored.db
      .prepare("UPDATE track_files SET codec = 'flac', container = 'flac', mime = 'audio/flac', size_bytes = ?, header_bytes = ?, tags_object_key = ? WHERE id = 'f-guest'")
      .run(size, split.header.length, tagsKey);
    stored.objects.set(tagsKey, new Uint8Array(sealMediaObjectWithPadding(new TextEncoder().encode(JSON.stringify(split.tags)), keyBytes)));
    // Both albums have a cover; only the split song's album cover is fetched (a whole file keeps its own).
    const jpeg = new Uint8Array(await fs.readFile(makeCoverPicture(path.join(work, "cover.jpg"), "blue", 120)));
    for (const [albumId, coverKey] of [["al-hits", "assets/cover-hits"], ["al-pastel", "assets/cover-pastel"]] as const) {
      stored.db.prepare("UPDATE albums SET cover_object_key = ? WHERE id = ?").run(coverKey, albumId);
      stored.objects.set(coverKey, await encryptBytesToBytes(stored.key, jpeg));
    }
    // The user's own lyrics (PAR-LYR-08) go into the exported file like any lyrics the library holds (PAR-LYR-11).
    stored.db
      .prepare("INSERT INTO lyrics (track_id, plain, synced, source, fetched_at) VALUES ('t-guest', NULL, ?, 'user', 1)")
      .run("[00:01.00]Own first line\n[00:04.50]Own second line");
    const asked: string[] = [];
    const dest = await makeTempDir("export-split");
    const result = await run(stored, dest, {
      readSealed: async (objectKey) => {
        asked.push(objectKey);
        return stored.objects.get(objectKey)!;
      },
    });
    const files = await tree(dest);
    log("asked", asked.filter((key) => !key.includes("/chunk-")));
    log("result", { failed: result.failed, stopped: result.stopped, files });
    expect(asked.filter((key) => !key.includes("/chunk-"))).toEqual([tagsKey, "assets/cover-hits"]);
    expect(result.failed).toEqual([]);
    expect(files).toEqual(["Nina Simone/Pastel Blues/01 Be My Husband.m4a", "Nina Simone/Pastel Blues/09 Sinnerman.flac", "Various Artists/Jazz Hits/03 SongOne.flac"]);
    const out = path.join(dest, "Various Artists/Jazz Hits/03 SongOne.flac");
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format_tags:stream=codec_type,codec_name,width,height", "-of", "json", out]).toString()) as {
      format: { tags: Record<string, string> };
      streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number }>;
    };
    const tags = Object.fromEntries(Object.entries(probe.format.tags).map(([key, value]) => [key.toLowerCase(), value]));
    log("ffprobe", { tags, streams: probe.streams });
    expect(tags.title).toBe("Song/One");
    expect(tags.artist).toBe("Guest: Singer");
    expect(tags.album).toBe("Jazz Hits?");
    expect(tags.album_artist).toBe("Various Artists");
    expect(tags.track).toBe("3");
    expect(tags.mood).toBe("calm");
    expect(tags.lyrics).toContain("Own first line");
    expect(probe.streams.find((stream) => stream.codec_type === "video")).toMatchObject({ codec_name: "mjpeg", width: 120, height: 120 });
    // Same sound: every audio packet's md5 is the upload's.
    const sound = (file: string) => execFileSync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_data_hash", "md5", "-show_entries", "packet=pts,size,data_hash", "-of", "compact", file]).toString().trim();
    expect(sound(out)).toBe(sound(upload));
  });

  it("clears what a stopped run left in the partial folder", async () => {
    const dest = await makeTempDir("export-leftover");
    await fs.mkdir(path.join(dest, PARROT_EXPORT_PARTIAL_DIR), { recursive: true });
    await fs.writeFile(path.join(dest, PARROT_EXPORT_PARTIAL_DIR, "x.part"), "half");
    await clearParrotExportPartials(dest);
    expect(await fs.readdir(dest)).toEqual([]);
  });

  it("names the extension from the stored type", () => {
    const ext = (mime: string, codec: string) => parrotExportExtension({ mime, codec });
    expect([ext("audio/mp4", "aac"), ext("audio/ogg", "opus"), ext("audio/ogg", "vorbis"), ext("audio/aac", "aac"), ext("audio/flac", "flac"), ext("audio/mpeg", "mp3")]).toEqual([
      ".m4a",
      ".opus",
      ".ogg",
      ".aac",
      ".flac",
      ".mp3",
    ]);
  });
});
