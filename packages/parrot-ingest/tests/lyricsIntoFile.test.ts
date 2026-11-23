// @req PAR-LYR-01[parrot] @req PAR-META-04[parrot]: found lyrics go into the user's own file when it has none; a
// file's own lyrics and light copies are never changed, and the sound is left bit for bit.
/**
 * @test-id PARROT-INGEST-LYRICS-INTO-FILE-001
 * @level unit (real ffmpeg-made files from tests/fixtures/media, ffprobe reads them back; in-memory storage and library)
 */
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { decryptMediaObject } from "@space/media-crypto";
import { createParrotOp } from "@space/parrot-library-db-definition";
import { importParrotFiles, type ParrotImportTransport } from "../src/importer";
import { applyParrotOps, getParrotFile, openParrotLibrary } from "../src/library";
import { listParrotLyricsFilesPending, parrotLyricsFileStillCurrent, PARROT_LYRICS_FILE_MARK, writeParrotLyricsIntoFile } from "../src/lyricsIntoFile";
import { writeParrotLyricsTag } from "../src/lyricsTags";
import { readParrotTrackInfo } from "../src/readTrack";
import { ffmpegFixture, makeAudioFixture, makeTempDir, testLog } from "./helpers";

const log = testLog("PARROT-INGEST-LYRICS-INTO-FILE-001");
const LRC = "[00:00.50]Cresting the morning tide\n[00:01.20]The kettle hums a little tune ✓";

/** Every format/stream tag ffprobe reads, keys lower-cased. */
const probeTags = (file: string): Record<string, string> => {
  const out = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_entries", "format_tags:stream_tags", file]).toString()) as {
    format?: { tags?: Record<string, string> };
    streams?: Array<{ tags?: Record<string, string> }>;
  };
  const tags: Record<string, string> = {};
  for (const source of [out.format?.tags, ...(out.streams ?? []).map((stream) => stream.tags)]) {
    for (const [key, value] of Object.entries(source ?? {})) tags[key.toLowerCase()] = value;
  }
  return tags;
};
const lyricsOf = (file: string) => Object.entries(probeTags(file)).find(([key]) => key.startsWith("lyrics"))?.[1];
/**
 * The sound as ffmpeg reads it: the audio stream's codec facts, then every audio packet's timing, size and md5. Equal
 * packets decode to equal samples, so this proves the sound is left bit for bit. Packets, not decoded samples: the
 * ffmpeg CI runs (the one the apps ship) has no PCM or md5 writer.
 */
const SOUND_ENTRIES = "stream=codec_name,sample_rate,channels:packet=pts,duration,size,data_hash";
const soundOf = (file: string) =>
  execFileSync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_data_hash", "md5", "-show_entries", SOUND_ENTRIES, "-of", "compact", file])
    .toString()
    .trim();

describe("lyrics into a file's tags", () => {
  let root: string;
  const fixtures: Array<{ name: string; container: string; encoder?: string[] }> = [
    { name: "plain.mp3", container: "mp3" },
    { name: "plain.flac", container: "flac" },
    { name: "aac.m4a", container: "mp4" },
    { name: "aac-faststart.m4a", container: "mp4", encoder: ["-c:a", "aac", "-movflags", "+faststart"] },
    { name: "alac.m4a", container: "mp4", encoder: ["-c:a", "alac"] },
    { name: "alac-faststart.m4a", container: "mp4", encoder: ["-c:a", "alac", "-movflags", "+faststart"] },
    { name: "adts.aac", container: "adts", encoder: ["-c:a", "aac", "-f", "adts"] },
    { name: "vorbis.ogg", container: "ogg" },
    { name: "opus.opus", container: "ogg", encoder: ["-c:a", "libopus", "-ar", "48000"] },
    { name: "song.wav", container: "wav" },
  ];

  beforeAll(async () => {
    root = await makeTempDir("lyrics-tags");
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  for (const fixture of fixtures) {
    it(`${fixture.name}: gets the lyrics, keeps its sound and other tags, and is never written twice`, async () => {
      const file = makeAudioFixture(path.join(root, fixture.name), { title: "At the Gate", artist: "Linnet Park", album: "Hollow Signal", track: "8" }, 2, log, fixture.encoder);
      const before = soundOf(file);
      expect(before).toContain("data_hash=MD5:");
      expect(lyricsOf(file)).toBeUndefined();
      const written = writeParrotLyricsTag(new Uint8Array(await fs.readFile(file)), fixture.container, LRC);
      expect(written.kind).toBe("written");
      if (written.kind !== "written") return;
      const out = path.join(root, `with-lyrics-${fixture.name}`);
      await fs.writeFile(out, written.bytes);
      const tags = probeTags(out);
      log(`${fixture.name} tags`, tags);
      expect(lyricsOf(out)).toBe(LRC);
      // ADTS carries no tags of its own, so the fixture's title and artist only exist where ffmpeg wrote them.
      if (fixture.container !== "adts") {
        expect(tags.title).toBe("At the Gate");
        expect(tags.artist).toBe("Linnet Park");
      }
      // Parrot's own reader takes the lyrics back as timed lines.
      const info = await readParrotTrackInfo(out);
      log(`${fixture.name} read back`, info.lyrics);
      expect(info.lyrics?.synced).toContain("Cresting the morning tide");
      const after = soundOf(out);
      log(`${fixture.name} sound`, { before, after });
      expect(after).toEqual(before);
      // A file with lyrics (ours now) is never changed again.
      expect(writeParrotLyricsTag(written.bytes, fixture.container, "other words").kind).toBe("has-lyrics");
    });
  }

  it("an MP3 without any ID3 tag gets one", async () => {
    const file = path.join(root, "bare.mp3");
    ffmpegFixture(file, ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=1", "-c:a", "libmp3lame", "-id3v2_version", "0", "-write_xing", "0"], log);
    const bytes = new Uint8Array(await fs.readFile(file));
    expect(new TextDecoder().decode(bytes.subarray(0, 3))).not.toBe("ID3");
    const written = writeParrotLyricsTag(bytes, "mp3", "plain words");
    expect(written.kind).toBe("written");
    if (written.kind !== "written") return;
    const out = path.join(root, "bare-with-lyrics.mp3");
    await fs.writeFile(out, written.bytes);
    expect(lyricsOf(out)).toBe("plain words");
    expect(soundOf(out)).toEqual(soundOf(file));
  });

  it("a file with its own lyrics is never changed", async () => {
    const flac = path.join(root, "own.flac");
    ffmpegFixture(flac, ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=duration=1", "-c:a", "flac", "-metadata", "LYRICS=their own words"], log);
    expect(writeParrotLyricsTag(new Uint8Array(await fs.readFile(flac)), "flac", LRC).kind).toBe("has-lyrics");
    const m4a = path.join(root, "own.m4a");
    ffmpegFixture(m4a, ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=duration=1", "-c:a", "alac", "-metadata", "lyrics=their own words"], log);
    expect(lyricsOf(m4a)).toBe("their own words");
    expect(writeParrotLyricsTag(new Uint8Array(await fs.readFile(m4a)), "mp4", LRC).kind).toBe("has-lyrics");
  });

  it("unusual layouts are left as they are", async () => {
    // An Ogg stream whose comment header is damaged.
    const ogg = new Uint8Array(await fs.readFile(makeAudioFixture(path.join(root, "fable.ogg"), { title: "Fable" }, 1, log)));
    const comment = Buffer.from(ogg).indexOf("\x03vorbis");
    const broken = ogg.slice();
    broken.fill(0xff, comment + 7, comment + 11); // vendor length far past the page
    expect(writeParrotLyricsTag(broken, "ogg", LRC).kind).toBe("unsupported");
    // A WAV whose `id3 ` chunk holds no ID3v2 tag.
    const wav = new Uint8Array(await fs.readFile(makeAudioFixture(path.join(root, "fable.wav"), { title: "Fable" }, 1, log)));
    const junk = new Uint8Array([0x69, 0x64, 0x33, 0x20, 4, 0, 0, 0, 1, 2, 3, 4]);
    const odd = new Uint8Array(wav.length + junk.length);
    odd.set(wav);
    odd.set(junk, wav.length);
    new DataView(odd.buffer).setUint32(4, odd.length - 8, true);
    expect(writeParrotLyricsTag(odd, "wav", LRC).kind).toBe("unsupported");
    // A container Parrot does not know.
    expect(writeParrotLyricsTag(wav, "aiff", LRC).kind).toBe("unsupported");
  });
});

describe("lyrics into the user's stored file", () => {
  const keyBase64 = randomBytes(32).toString("base64");
  let root: string;
  let song: string;

  beforeAll(async () => {
    root = await makeTempDir("lyrics-file");
    song = makeAudioFixture(path.join(root, "08 - At the Gate.flac"), { title: "At the Gate", artist: "Linnet Park", album: "Hollow Signal", track: "8" }, 3, log);
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("rewrites the original under the same file id with marked chunks, once; light copies and the file's own lyrics are left", async () => {
    const objects = new Map<string, Uint8Array>();
    const state = { version: 0, dbBytes: null as Uint8Array | null };
    const upload = async (_token: string, objectKey: string, payload: Uint8Array, options: Record<string, unknown> = {}) => {
      const placed = options.placementId ? `media/${String(options.placementId)}/${objectKey}` : objectKey;
      objects.set(placed, payload);
      return placed;
    };
    const transport = {
      upload,
      fetchSnapshot: async () => (state.dbBytes ? { snapshotVersion: state.version, dbBytes: state.dbBytes } : null),
      publishSnapshot: async (input: { dbBytes: Uint8Array; baseVersion: number }) => {
        state.version += 1;
        state.dbBytes = new Uint8Array(input.dbBytes);
        return { version: state.version };
      },
    } as unknown as ParrotImportTransport;
    // The import also stores a light copy (a stand-in), which must never be rewritten.
    await importParrotFiles([song], {
      token: "t",
      userId: "user-chris",
      libraryKeyBase64: keyBase64,
      clientType: "parrot-desktop",
      transport,
      makeLightCopy: async ({ read }) => new Uint8Array([...new TextEncoder().encode("OggS"), ...(await read(0, 15))]),
    });
    const db = openParrotLibrary(state.dbBytes);
    const original = db.prepare("SELECT id, track_id AS trackId FROM track_files WHERE light_copy = 0").get() as { id: string; trackId: string };
    expect(db.prepare("SELECT COUNT(*) AS n FROM track_files WHERE light_copy = 1").get()).toEqual({ n: 1 });
    // Nothing looked up yet: nothing to write.
    expect(listParrotLyricsFilesPending(db)).toEqual([]);
    const setLyrics = (source: string, synced: string | null) =>
      applyParrotOps(db, [createParrotOp("lyrics.set", { trackId: original.trackId, plain: null, synced, source, fetchedAt: 1 }, { id: randomUUID(), createdAt: new Date().toISOString() })]);
    // "No lyrics" and the file's own lyrics never lead to a write.
    setLyrics("none", null);
    expect(listParrotLyricsFilesPending(db)).toEqual([]);
    setLyrics("file", LRC);
    expect(listParrotLyricsFilesPending(db)).toEqual([]);
    setLyrics("fetched", LRC);
    expect(listParrotLyricsFilesPending(db)).toEqual([original.id]);

    const load = async (chunk: { objectKey: string }) => new Uint8Array(decryptMediaObject(objects.get(chunk.objectKey)!, keyBase64));
    const oldFile = getParrotFile(db, original.id)!;
    const written = await writeParrotLyricsIntoFile(db, original.id, {
      token: "t",
      userId: "user-chris",
      libraryKeyBase64: keyBase64,
      clientType: "parrot-desktop",
      load,
      upload: transport.upload,
      now: Date.now(),
      newId: randomUUID,
      log: (line) => log(line),
    });
    log("written", written.kind === "written" ? { ...written, op: written.op.type } : written);
    expect(written.kind).toBe("written");
    if (written.kind !== "written") return;
    expect(written.oldObjectKeys).toEqual(oldFile.chunks.map((chunk) => chunk.objectKey));
    expect(written.newObjectKeys.every((key) => key.includes(`${original.id}${PARROT_LYRICS_FILE_MARK}`))).toBe(true);
    expect(parrotLyricsFileStillCurrent(db, original.id, written.oldObjectKeys)).toBe(true);
    applyParrotOps(db, [written.op]);
    expect(parrotLyricsFileStillCurrent(db, original.id, written.newObjectKeys)).toBe(true);
    expect(parrotLyricsFileStillCurrent(db, original.id, written.oldObjectKeys)).toBe(false);
    const newFile = getParrotFile(db, original.id)!;
    expect(newFile.sizeBytes).toBe(written.sizeBytes);
    expect(newFile.trackId).toBe(original.trackId);
    // The stored file, read back as a player would, carries the lyrics and the same sound.
    const bytes = Buffer.concat(await Promise.all(newFile.chunks.map(load)));
    expect(bytes.length).toBe(newFile.sizeBytes);
    const out = path.join(root, "stored.flac");
    await fs.writeFile(out, bytes);
    expect(lyricsOf(out)).toBe(LRC);
    expect(soundOf(out)).toEqual(soundOf(song));
    // Done: not pending again, and asking again changes nothing.
    expect(listParrotLyricsFilesPending(db)).toEqual([]);
    expect(await writeParrotLyricsIntoFile(db, original.id, { token: "t", userId: "u", libraryKeyBase64: keyBase64, clientType: "x", load, upload: transport.upload, now: 0, newId: randomUUID })).toEqual({
      kind: "skipped",
      reason: "already written",
    });
    const light = db.prepare("SELECT id FROM track_files WHERE light_copy = 1").get() as { id: string };
    expect(await writeParrotLyricsIntoFile(db, light.id, { token: "t", userId: "u", libraryKeyBase64: keyBase64, clientType: "x", load, upload: transport.upload, now: 0, newId: randomUUID })).toEqual({
      kind: "skipped",
      reason: "a light copy",
    });
    db.close();
  });
});
