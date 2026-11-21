// @req PAR-FMT-01[parrot] @req PAR-META-04[parrot]: a song's file is stored as a header with no picture and no user
// tag, the sound byte for byte in pieces, and its own tags in a small object; header then sound plays the same samples.
/**
 * @test-id PARROT-INGEST-SPLIT-ORIGINAL-001
 * @level unit (real ffmpeg-made files from tests/fixtures/media, ffprobe reads them back)
 */
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { concat, latin1, toSyncsafe, u32be, u32le } from "../src/containerBytes";
import { PARROT_FIRST_PAYLOAD_PIECE_BYTES, PARROT_PAYLOAD_PIECE_BYTES, parrotSplitPieces, splitParrotOriginal } from "../src/splitOriginal";
import { makeAudioFixture, makeCoverPicture, makeTempDir, testLog } from "./helpers";

const log = testLog("PARROT-INGEST-SPLIT-ORIGINAL-001");

/**
 * The sound as ffmpeg reads it: the audio stream's codec facts, then every audio packet's timing, size and md5. Equal
 * packets decode to equal samples. Packets, not decoded samples: the ffmpeg CI runs has no PCM or md5 writer.
 */
const soundOf = (file: string) =>
  execFileSync("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "a:0",
    "-show_data_hash",
    "md5",
    "-show_entries",
    "stream=codec_name,sample_rate,channels:packet=pts,duration,size,data_hash",
    "-of",
    "compact",
    file,
  ])
    .toString()
    .trim();

/** md5 of the decoded samples, where this ffmpeg has the md5 writer (a full build); null elsewhere. */
const samplesOf = (file: string) => {
  try {
    return execFileSync("ffmpeg", ["-v", "error", "-i", file, "-map", "0:a", "-f", "md5", "-"]).toString().trim();
  } catch {
    return null;
  }
};

const videoStreams = (file: string) =>
  execFileSync("ffprobe", ["-v", "error", "-select_streams", "v", "-show_entries", "stream=index", "-of", "csv=p=0", file]).toString().trim();

/** A FLAC picture block body (as METADATA_BLOCK_PICTURE carries it, base64) around `image`. */
const flacPicture = (image: Uint8Array) => {
  const mime = latin1("image/jpeg");
  return concat(u32be(3), u32be(mime.length), mime, u32be(0), u32be(64), u32be(64), u32be(24), u32be(0), u32be(image.length), image);
};

/** An ID3v2.3 tag holding a TXXX MOOD=calm frame and an APIC front cover of `image`. */
const id3WithPicture = (image: Uint8Array) => {
  const frame = (id: string, body: Uint8Array) => concat(latin1(id), u32be(body.length), new Uint8Array(2), body);
  const frames = concat(
    frame("TXXX", concat(new Uint8Array([0]), latin1("MOOD\0calm"))),
    frame("APIC", concat(new Uint8Array([0]), latin1("image/jpeg\0"), new Uint8Array([3, 0]), image))
  );
  return concat(latin1("ID3"), new Uint8Array([3, 0, 0]), toSyncsafe(frames.length), frames);
};

/** A deterministic stand-in for a large cover: 80 KB that no encoder would ever write by chance. */
const bigPicture = () => {
  const out = new Uint8Array(80_000);
  let seed = 7;
  for (let i = 0; i < out.length; i += 1) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    out[i] = seed >>> 24;
  }
  out.set([0xff, 0xd8, 0xff, 0xe0], 0);
  return out;
};

describe("a song's file split into header, sound and tags", () => {
  let root: string;
  let cover: string;
  let coverBytes: Uint8Array;
  const big = bigPicture();
  const tags = { title: "At the Gate", artist: "Linnet Park", album: "Hollow Signal", track: "8" };
  const mood = ["-metadata", "MOOD=calm"];

  beforeAll(async () => {
    root = await makeTempDir("split-original");
    cover = makeCoverPicture(path.join(root, "cover.jpg"), "red", 64);
    coverBytes = new Uint8Array(await fs.readFile(cover));
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  /** Each fixture as a file on disk, with the picture bytes that must not survive. */
  const fixtures: Array<{ name: string; container: string; make: (file: string) => Promise<Uint8Array> }> = [
    {
      name: "id3.mp3",
      container: "mp3",
      make: async (file) => {
        makeAudioFixture(file, { ...tags, picture: cover }, 2, log, ["-c:a", "libmp3lame", "-b:a", "64k", "-id3v2_version", "3", "-write_id3v1", "1", ...mood]);
        return coverBytes;
      },
    },
    {
      name: "pictured.flac",
      container: "flac",
      make: async (file) => {
        makeAudioFixture(file, { ...tags, picture: cover }, 2, log, ["-c:a", "flac", ...mood]);
        return coverBytes;
      },
    },
    {
      name: "end-moov.m4a",
      container: "mp4",
      make: async (file) => {
        makeAudioFixture(file, { ...tags, picture: cover }, 2, log, ["-c:a", "aac", "-metadata", "comment=calm"]);
        return coverBytes;
      },
    },
    {
      name: "faststart.m4a",
      container: "mp4",
      make: async (file) => {
        makeAudioFixture(file, { ...tags, picture: cover }, 2, log, ["-c:a", "aac", "-movflags", "+faststart", "-metadata", "comment=calm"]);
        return coverBytes;
      },
    },
    {
      name: "alac.m4a",
      container: "mp4",
      make: async (file) => {
        makeAudioFixture(file, { ...tags, picture: cover }, 2, log, ["-c:a", "alac", "-metadata", "comment=calm"]);
        return coverBytes;
      },
    },
    {
      name: "adts.aac",
      container: "adts",
      make: async (file) => {
        const bare = path.join(root, "bare-adts.aac");
        makeAudioFixture(bare, {}, 2, log, ["-c:a", "aac", "-f", "adts"]);
        const v1 = concat(latin1("TAG"), new Uint8Array(125));
        await fs.writeFile(file, concat(id3WithPicture(big), new Uint8Array(await fs.readFile(bare)), v1));
        return big;
      },
    },
    {
      name: "vorbis.ogg",
      container: "ogg",
      make: async (file) => {
        const picture = Buffer.from(flacPicture(big)).toString("base64");
        makeAudioFixture(file, tags, 2, log, ["-c:a", "libvorbis", "-metadata", `METADATA_BLOCK_PICTURE=${picture}`, ...mood]);
        return latin1(picture);
      },
    },
    {
      name: "opus.opus",
      container: "ogg",
      make: async (file) => {
        const picture = Buffer.from(flacPicture(big)).toString("base64");
        makeAudioFixture(file, tags, 2, log, ["-c:a", "libopus", "-ar", "48000", "-metadata", `METADATA_BLOCK_PICTURE=${picture}`, ...mood]);
        return latin1(picture);
      },
    },
    {
      name: "tagged.wav",
      container: "wav",
      make: async (file) => {
        const bare = path.join(root, "bare.wav");
        makeAudioFixture(bare, tags, 2, log);
        const wav = new Uint8Array(await fs.readFile(bare));
        const tag = id3WithPicture(big);
        const chunk = concat(latin1("id3 "), u32le(tag.length), tag, tag.length & 1 ? new Uint8Array(1) : new Uint8Array(0));
        const out = concat(wav, chunk);
        new DataView(out.buffer).setUint32(4, out.length - 8, true);
        await fs.writeFile(file, out);
        return big;
      },
    },
  ];

  for (const fixture of fixtures) {
    it(`${fixture.name}: header and sound play the same, with no picture and the file's tags kept aside`, async () => {
      const file = path.join(root, fixture.name);
      const picture = await fixture.make(file);
      const source = new Uint8Array(await fs.readFile(file));
      // Its first bytes: an Ogg comment runs across pages, whose headers cut the picture's text.
      expect(Buffer.from(source).indexOf(picture.subarray(0, 64))).toBeGreaterThanOrEqual(0);
      const split = splitParrotOriginal(source, fixture.container);
      log(`${fixture.name} split`, split.kind === "split" ? { header: split.header.length, payload: split.payload.length, source: source.length, pictures: split.picturesDropped, tags: split.tags.groups.map((g) => g.format) } : split);
      expect(split.kind).toBe("split");
      if (split.kind !== "split") return;
      const stored = path.join(root, `stored-${fixture.name}`);
      const storedBytes = concat(split.header, split.payload);
      await fs.writeFile(stored, storedBytes);
      // Same packets, and (where this ffmpeg can say) the same decoded samples.
      expect(soundOf(stored)).toEqual(soundOf(file));
      const samples = samplesOf(file);
      log(`${fixture.name} samples`, { source: samples, stored: samplesOf(stored) });
      if (samples) expect(samplesOf(stored)).toBe(samples);
      // No picture anywhere in what is stored.
      expect(split.picturesDropped).toBeGreaterThanOrEqual(1);
      expect(Buffer.from(storedBytes).indexOf(picture.subarray(0, 64))).toBe(-1);
      expect(videoStreams(stored)).toBe("");
      // Nor in any stored piece (the header, then each sound piece), each looked at on its own.
      const pieces = parrotSplitPieces(split.header, split.payload);
      log(`${fixture.name} pieces`, pieces.map((piece) => piece.length));
      for (const piece of pieces) expect(Buffer.from(piece).indexOf(picture.subarray(0, 64))).toBe(-1);
      // The file's own tags, the custom one included, are in the tags object.
      const tagText = split.tags.groups
        .flatMap((group) => ("frames" in group ? group.frames : "comments" in group ? group.comments : "items" in group ? group.items : group.chunks))
        .map((entry) => Buffer.from(entry, "base64").toString("latin1"))
        .join("\n");
      if (fixture.container !== "wav" && fixture.container !== "adts") expect(tagText).toContain("Linnet Park");
      if (fixture.container !== "wav") expect(tagText).toContain("calm");
      else expect(tagText).toContain("At the Gate");
      // The header carries no user tag.
      expect(Buffer.from(split.header).indexOf("Linnet Park")).toBe(-1);
      // The sound is the file's own bytes (Ogg: same packets, renumbered pages).
      if (fixture.container !== "ogg") expect(Buffer.from(source).indexOf(split.payload)).toBeGreaterThanOrEqual(0);
    });
  }

  it("an MP4 index ends up before the sound, whatever its place in the file", async () => {
    const file = path.join(root, "end-moov.m4a");
    const source = new Uint8Array(await fs.readFile(file));
    expect(Buffer.from(source).indexOf("moov")).toBeGreaterThan(Buffer.from(source).indexOf("mdat"));
    const split = splitParrotOriginal(source, "mp4");
    if (split.kind !== "split") throw new Error(split.reason);
    const header = Buffer.from(split.header);
    expect(header.subarray(4, 8).toString("latin1")).toBe("ftyp");
    expect(header.indexOf("moov")).toBeLessThan(header.indexOf("mdat"));
    expect(header.subarray(header.length - 4).toString("latin1")).toBe("mdat");
  });

  it("files it cannot read are named, not guessed", () => {
    expect(splitParrotOriginal(latin1("not audio at all"), "flac")).toEqual({ kind: "unsupported", reason: "no fLaC marker" });
    expect(splitParrotOriginal(latin1("RIFF\0\0\0\0WAVE"), "wav").kind).toBe("unsupported");
    expect(splitParrotOriginal(new Uint8Array(10), "mkv")).toEqual({ kind: "unsupported", reason: "container mkv" });
  });

  it("pieces: the header, then 256 KiB of sound, then 1 MiB pieces", () => {
    const payload = new Uint8Array(PARROT_FIRST_PAYLOAD_PIECE_BYTES + 2 * PARROT_PAYLOAD_PIECE_BYTES + 5);
    const sizes = parrotSplitPieces(new Uint8Array(900), payload).map((piece) => piece.length);
    expect(sizes).toEqual([900, 256 * 1024, 1024 * 1024, 1024 * 1024, 5]);
    expect(parrotSplitPieces(new Uint8Array(0), new Uint8Array(10)).map((piece) => piece.length)).toEqual([10]);
  });
});
