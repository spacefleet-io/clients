// @req OFFL-FILE-01[parrot]: an exported song is a normal file of its stored format: index first, its own tags (custom
// ones included) under the library's names, the library's cover inside, the stored sound byte for byte.
/**
 * @test-id PARROT-INGEST-EXPORT-FILE-001
 * @level unit (real ffmpeg-made files, split as the importer stores them, rebuilt, read back by ffprobe)
 */
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { ParrotCopyTags } from "@space/parrot-core";
import { concat, latin1, readOggPage, toSyncsafe, u32be, u32le } from "../src/containerBytes";
import { type ParrotExportInput, parrotExportExtension, rebuildParrotTrackFile } from "../src/exportFile";
import type { ParrotLibraryFile } from "../src/library";
import { parrotSplitPieces, splitParrotOriginal } from "../src/splitOriginal";
import { makeAudioFixture, makeCoverPicture, makeTempDir, testLog } from "./helpers";

const log = testLog("PARROT-INGEST-EXPORT-FILE-001");

/** The audio stream's codec facts and every packet's timing, size and md5: equal packets play equal samples. */
const soundOf = (file: string) =>
  execFileSync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_data_hash", "md5", "-show_entries", "stream=codec_name,sample_rate,channels:packet=pts,duration,size,data_hash", "-of", "compact", file])
    .toString()
    .trim();

/** Every tag ffmpeg reads from the file (format and stream), keys lower-cased. */
const tagsOf = (file: string): Record<string, string> => {
  const probe: { format?: { tags?: Record<string, string> }; streams?: Array<{ tags?: Record<string, string> }> } = JSON.parse(
    execFileSync("ffprobe", ["-v", "error", "-show_entries", "format_tags:stream_tags", "-of", "json", file]).toString()
  );
  const out: Record<string, string> = {};
  for (const tags of [probe.format?.tags, ...(probe.streams ?? []).map((stream) => stream.tags)])
    for (const [key, value] of Object.entries(tags ?? {})) out[key.toLowerCase()] ??= value;
  return out;
};

/** Attached pictures ffmpeg sees, as `codec width x height`. */
const picturesOf = (file: string) =>
  execFileSync("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries", "stream=codec_name,width,height", "-of", "csv=p=0", file]).toString().trim();

const errorsOf = (file: string) => execFileSync("ffmpeg", ["-v", "error", "-i", file, "-map", "0:a", "-f", "null", "-"], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

const flacPicture = (image: Uint8Array) => {
  const mime = latin1("image/jpeg");
  return concat(u32be(3), u32be(mime.length), mime, u32be(0), u32be(64), u32be(64), u32be(24), u32be(0), u32be(image.length), image);
};

/** An ID3v2.3 tag holding TXXX MOOD=calm, a TRCK of 8/12 and a front cover. */
const id3Tag = (image: Uint8Array) => {
  const frame = (id: string, body: Uint8Array) => concat(latin1(id), u32be(body.length), new Uint8Array(2), body);
  const frames = concat(
    frame("TXXX", concat(new Uint8Array([0]), latin1("MOOD\0calm"))),
    frame("TRCK", concat(new Uint8Array([0]), latin1("8/12"))),
    frame("APIC", concat(new Uint8Array([0]), latin1("image/jpeg\0"), new Uint8Array([3, 0]), image))
  );
  return concat(latin1("ID3"), new Uint8Array([3, 0, 0]), toSyncsafe(frames.length), frames);
};

/** 80 KB no encoder writes by chance: an Ogg comment that large spans several pages. */
const bigPicture = () => {
  const out = new Uint8Array(80_000);
  let seed = 11;
  for (let i = 0; i < out.length; i += 1) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    out[i] = seed >>> 24;
  }
  out.set([0xff, 0xd8, 0xff, 0xe0], 0);
  return out;
};

/** A library file record for stored `pieces` (as the importer writes it). */
const fileFor = (mime: string, codec: string, header: Uint8Array | null, pieces: Uint8Array[], tagsObjectKey: string | null): ParrotLibraryFile => {
  let offset = 0;
  return {
    id: "tf-export",
    trackId: "t-export",
    mime,
    codec,
    sizeBytes: pieces.reduce((sum, piece) => sum + piece.length, 0),
    headerBytes: header ? header.length : null,
    sourceSizeBytes: null,
    tagsObjectKey,
    chunks: pieces.map((piece, idx) => {
      const chunk = { idx, objectKey: `chunk-${idx}`, plainOffset: offset, plainSize: piece.length };
      offset += piece.length;
      return chunk;
    }),
  };
};

const collect = async (pieces: AsyncIterable<Uint8Array>) => {
  const out: Uint8Array[] = [];
  for await (const piece of pieces) out.push(piece);
  return out;
};

describe("a stored song rebuilt into a normal file", () => {
  let root: string;
  let cover: Uint8Array;
  const big = bigPicture();
  const tags = { title: "At the Gate", artist: "Linnet Park", album: "Hollow Signal", track: "8" };
  const mood = ["-metadata", "MOOD=calm"];
  /** The library renamed the song; the rest agrees with the file. */
  const names: ParrotCopyTags = { title: "At the Gate (edit)", artist: "Linnet Park", album: "Hollow Signal", albumArtist: "Linnet Park", number: 8, year: 2024, genre: "Ambient" };

  beforeAll(async () => {
    root = await makeTempDir("export-file");
    cover = new Uint8Array(await fs.readFile(makeCoverPicture(path.join(root, "library-cover.jpg"), "blue", 120)));
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const fixtures: Array<{ name: string; container: string; mime: string; codec: string; make: (file: string) => Promise<void> }> = [
    { name: "id3.mp3", container: "mp3", mime: "audio/mpeg", codec: "mp3", make: async (file) => void makeAudioFixture(file, tags, 2, log, ["-c:a", "libmp3lame", "-b:a", "64k", "-id3v2_version", "3", ...mood]) },
    { name: "tagged.flac", container: "flac", mime: "audio/flac", codec: "flac", make: async (file) => void makeAudioFixture(file, tags, 2, log, ["-c:a", "flac", ...mood]) },
    { name: "end-moov.m4a", container: "mp4", mime: "audio/mp4", codec: "aac", make: async (file) => void makeAudioFixture(file, tags, 2, log, ["-c:a", "aac", "-metadata", "comment=calm"]) },
    { name: "faststart.m4a", container: "mp4", mime: "audio/mp4", codec: "aac", make: async (file) => void makeAudioFixture(file, tags, 2, log, ["-c:a", "aac", "-movflags", "+faststart", "-metadata", "comment=calm"]) },
    { name: "alac.m4a", container: "mp4", mime: "audio/mp4; codecs=alac", codec: "alac", make: async (file) => void makeAudioFixture(file, tags, 2, log, ["-c:a", "alac", "-metadata", "comment=calm"]) },
    {
      name: "adts.aac",
      container: "adts",
      mime: "audio/aac",
      codec: "aac",
      make: async (file) => {
        const bare = path.join(root, "bare-adts.aac");
        makeAudioFixture(bare, {}, 2, log, ["-c:a", "aac", "-f", "adts"]);
        await fs.writeFile(file, concat(id3Tag(big), new Uint8Array(await fs.readFile(bare))));
      },
    },
    {
      name: "vorbis.ogg",
      container: "ogg",
      mime: "audio/ogg",
      codec: "vorbis",
      make: async (file) => void makeAudioFixture(file, tags, 2, log, ["-c:a", "libvorbis", "-metadata", `METADATA_BLOCK_PICTURE=${Buffer.from(flacPicture(big)).toString("base64")}`, ...mood]),
    },
    { name: "opus.opus", container: "ogg", mime: "audio/ogg", codec: "opus", make: async (file) => void makeAudioFixture(file, tags, 2, log, ["-c:a", "libopus", "-ar", "48000", ...mood]) },
    {
      name: "tagged.wav",
      container: "wav",
      mime: "audio/wav",
      codec: "pcm_s16le",
      make: async (file) => {
        const bare = path.join(root, "bare.wav");
        makeAudioFixture(bare, tags, 2, log);
        const tag = id3Tag(big);
        const out = concat(new Uint8Array(await fs.readFile(bare)), latin1("id3 "), u32le(tag.length), tag, new Uint8Array(tag.length & 1));
        new DataView(out.buffer).setUint32(4, out.length - 8, true);
        await fs.writeFile(file, out);
      },
    },
  ];

  for (const fixture of fixtures) {
    it(`${fixture.name}: index first, own tags under the library's names, the library's cover, the stored sound`, async () => {
      const source = path.join(root, fixture.name);
      await fixture.make(source);
      const split = splitParrotOriginal(new Uint8Array(await fs.readFile(source)), fixture.container);
      if (split.kind !== "split") throw new Error(split.reason);
      const stored = path.join(root, `stored-${fixture.name}`);
      await fs.writeFile(stored, concat(split.header, split.payload));
      const pieces = parrotSplitPieces(split.header, split.payload);
      const file = fileFor(fixture.mime, fixture.codec, split.header, pieces, "tags");
      const read: number[] = [];
      const input: ParrotExportInput = {
        file,
        tags: split.tags,
        names,
        cover: { bytes: cover, mime: "image/jpeg" },
        readChunk: async (index) => {
          read.push(index);
          return pieces[index]!;
        },
      };
      const out = await collect(rebuildParrotTrackFile(input));
      const exported = path.join(root, `exported-${fixture.name.replace(/\.[^.]+$/, "")}${parrotExportExtension(file)}`);
      await fs.writeFile(exported, concat(...out));
      const found = tagsOf(exported);
      log(`${fixture.name} exported`, { bytes: out.reduce((sum, piece) => sum + piece.length, 0), stored: split.header.length + split.payload.length, tags: found, pictures: picturesOf(exported) });
      // Every stored piece read once, in order; the sound pieces passed on as stored (Ogg: renumbered pages).
      expect(read).toEqual(pieces.map((_, index) => index));
      if (fixture.container !== "ogg") for (const [i, piece] of pieces.slice(split.header.length > 0 ? 1 : 0).entries()) expect(out[i + 1]).toBe(piece);
      // The same packets as what is stored, read without an error.
      expect(soundOf(exported)).toEqual(soundOf(stored));
      expect(errorsOf(exported)).toBe("");
      // The library's names over the file's, its custom tag kept.
      expect(found.title).toBe("At the Gate (edit)");
      expect(found.artist).toBe("Linnet Park");
      expect(found.genre).toBe("Ambient");
      expect(Object.values(found).join("\n")).toContain("calm");
      // The library's cover, and only it.
      expect(picturesOf(exported)).toBe("mjpeg,120,120");
      // The index ahead of the sound.
      if (fixture.container === "mp4") {
        const bytes = Buffer.from(out[0]!);
        expect(bytes.indexOf("moov")).toBeLessThan(bytes.indexOf("mdat"));
      }
    });
  }

  it("a track number the library agrees with keeps the file's total", async () => {
    const source = path.join(root, "adts.aac");
    const split = splitParrotOriginal(new Uint8Array(await fs.readFile(source)), "adts");
    if (split.kind !== "split") throw new Error(split.reason);
    const pieces = parrotSplitPieces(split.header, split.payload);
    const out = await collect(rebuildParrotTrackFile({ file: fileFor("audio/aac", "aac", split.header, pieces, "tags"), tags: split.tags, names, cover: null, readChunk: async (i) => pieces[i]! }));
    const exported = path.join(root, "track-total.aac");
    await fs.writeFile(exported, concat(...out));
    expect(tagsOf(exported).track).toBe("8/12");
    expect(picturesOf(exported)).toBe("");
  });

  it("an Ogg comment that needs more pages moves every sound page's number", async () => {
    const source = path.join(root, "opus.opus");
    const split = splitParrotOriginal(new Uint8Array(await fs.readFile(source)), "ogg");
    if (split.kind !== "split") throw new Error(split.reason);
    const pieces = parrotSplitPieces(split.header, split.payload);
    const out = concat(...(await collect(rebuildParrotTrackFile({ file: fileFor("audio/ogg", "opus", split.header, pieces, "tags"), tags: split.tags, names, cover: { bytes: big, mime: "image/jpeg" }, readChunk: async (i) => pieces[i]! }))));
    const sequences: number[] = [];
    for (let at = 0, page = readOggPage(out, 0); page; page = readOggPage(out, at)) {
      sequences.push(page.sequence);
      at = page.end;
    }
    log("opus pages", { stored: split.header.length, pages: sequences.length });
    // The 107 KB comment takes two pages where the stored header had one: every later page is one further on, unbroken.
    expect(sequences).toEqual(sequences.map((_, i) => i));
    expect(Buffer.from(out).indexOf("OpusHead")).toBe(28);
  });

  it("a file stored whole comes back as stored", async () => {
    const pieces = [latin1("ID3 whole file "), latin1("as the user picked it")];
    const out = await collect(rebuildParrotTrackFile({ file: fileFor("audio/mpeg", "mp3", null, pieces, null), tags: null, names, cover: { bytes: cover, mime: "image/jpeg" }, readChunk: async (i) => pieces[i]! }));
    expect(out).toEqual(pieces);
  });

  it("stops between pieces once aborted", async () => {
    const pieces = [latin1("one"), latin1("two")];
    const controller = new AbortController();
    const reading = rebuildParrotTrackFile({ file: fileFor("audio/mpeg", "mp3", null, pieces, null), tags: null, names, cover: null, signal: controller.signal, readChunk: async (i) => pieces[i]! });
    const iterator = reading[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual(pieces[0]);
    controller.abort();
    await expect(iterator.next()).rejects.toThrow();
  });

  it("extensions follow the stored format", () => {
    expect(parrotExportExtension({ mime: "audio/mp4; codecs=alac", codec: "alac" })).toBe(".m4a");
    expect(parrotExportExtension({ mime: "audio/ogg", codec: "opus" })).toBe(".opus");
    expect(parrotExportExtension({ mime: "audio/ogg", codec: "vorbis" })).toBe(".ogg");
    expect(parrotExportExtension({ mime: "audio/aac", codec: "aac" })).toBe(".aac");
    expect(parrotExportExtension({ mime: "audio/flac", codec: "flac" })).toBe(".flac");
  });
});
