import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  oggCrc,
  opusHead,
  opusTags,
  parrotOpusComments,
  readOggPackets,
  readOggPages,
  readOpusHeadPreSkip,
  writeOggOpus,
} from "../src/oggOpus";

const FLAG_CONTINUED = 1;
const FLAG_BOS = 2;
const FLAG_EOS = 4;

const fakePackets = (count: number, size: (index: number) => number) =>
  Array.from({ length: count }, (_, index) => ({ bytes: new Uint8Array(size(index)).fill(index & 0xff), samples: 960 }));

describe("oggCrc", () => {
  test("matches Ogg's CRC-32 (poly 0x04c11db7, no reflection)", () => {
    expect(oggCrc(new TextEncoder().encode("123456789"))).toBe(0x89a1897f);
  });
});

describe("writeOggOpus", () => {
  const head = opusHead({ channels: 2, preSkip: 312, inputSampleRate: 44_100 });
  const tags = opusTags("parrot-test", ["TITLE=Song"]);

  test("headers on their own pages, the last granule is pre-skip plus the real samples, EOS on the last page only", () => {
    const packets = fakePackets(60, (index) => 100 + index * 7);
    const samples = 60 * 960 - 312 - 500;
    const pages = readOggPages(writeOggOpus({ head, tags, packets, preSkip: 312, samples }));
    expect(pages.every((page) => page.crcOk)).toBe(true);
    expect(pages.map((page) => page.sequence)).toEqual(pages.map((_, index) => index));
    expect(pages[0]!.flags).toBe(FLAG_BOS);
    expect(pages[0]!.granule).toBe(0n);
    expect(pages[1]!.granule).toBe(0n);
    expect(pages.at(-1)!.flags & FLAG_EOS).toBe(FLAG_EOS);
    expect(pages.slice(0, -1).some((page) => page.flags & FLAG_EOS)).toBe(false);
    expect(pages.at(-1)!.granule).toBe(BigInt(312 + samples));
    const granules = pages.slice(2).map((page) => page.granule);
    expect([...granules].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(granules);
    expect(readOggPackets(pages)).toEqual([head, tags, ...packets.map((packet) => packet.bytes)]);
  });

  test("packets longer than a page continue on the next one, with granule -1 on pages no packet ends on", () => {
    const packets = fakePackets(3, (index) => (index === 1 ? 255 * 600 : 510));
    const pages = readOggPages(writeOggOpus({ head, tags, packets, preSkip: 312, samples: 3 * 960 - 312 }));
    expect(pages.some((page) => page.flags & FLAG_CONTINUED)).toBe(true);
    expect(pages.some((page) => page.granule === -1n)).toBe(true);
    expect(readOggPackets(pages).slice(2)).toEqual(packets.map((packet) => packet.bytes));
  });

  test("refuses a stream shorter than its pre-skip plus samples", () => {
    expect(() => writeOggOpus({ head, tags, packets: fakePackets(2, () => 10), preSkip: 312, samples: 1920 })).toThrow("OGG_OPUS_SHORT");
  });
});

describe("tags", () => {
  test("names, numbers and lyrics, and no picture", () => {
    const comments = parrotOpusComments({
      title: "Paperboat",
      artist: "Linnet Park",
      album: "Hollow Signal",
      albumArtist: "Linnet Park",
      number: 1,
      disc: 1,
      year: 2000,
      genre: "Rock",
      lyrics: { synced: "[00:01.00]Where does it go", plain: "Where does it go" },
    });
    expect(comments).toContain("TITLE=Paperboat");
    expect(comments).toContain("ALBUMARTIST=Linnet Park");
    expect(comments).toContain("TRACKNUMBER=1");
    expect(comments).toContain("DATE=2000");
    expect(comments).toContain("LYRICS=[00:01.00]Where does it go");
    expect(comments.some((comment) => comment.startsWith("METADATA_BLOCK_PICTURE="))).toBe(false);
  });

  test("reads the pre-skip back from an OpusHead", () => {
    expect(readOpusHeadPreSkip(opusHead({ channels: 1, preSkip: 3840, inputSampleRate: 48_000 }))).toBe(3840);
    expect(readOpusHeadPreSkip(new Uint8Array(19))).toBeNull();
  });
});

// The real check: libopus packets rewritten by writeOggOpus decode in FFmpeg to exactly the samples we declared.
const FFMPEG = "/usr/bin/ffmpeg";
describe.skipIf(!existsSync(FFMPEG))("with FFmpeg", () => {
  test("FFmpeg decodes the written stream to exactly the declared length, with its tags and no picture stream", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "parrot-ogg-"));
    try {
      const run = (args: string[]) => {
        const out = spawnSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "buffer" });
        if (out.status !== 0) throw new Error(out.stderr.toString());
        return out.stdout;
      };
      // 1.234567 s of a tone at 48 kHz: not a multiple of the 20 ms Opus frame.
      const samples = 59_259;
      const source = path.join(dir, "source.ogg");
      run(["-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000,aformat=channel_layouts=stereo`, "-af", `atrim=end_sample=${samples}`, "-c:a", "libopus", "-b:a", "64k", "-frame_duration", "20", source]);
      const pages = readOggPages(new Uint8Array(readFileSync(source)));
      const [sourceHead, , ...packets] = readOggPackets(pages);
      const preSkip = readOpusHeadPreSkip(sourceHead)!;
      const written = writeOggOpus({
        head: opusHead({ channels: 2, preSkip, inputSampleRate: 48_000 }),
        tags: opusTags("parrot-test", parrotOpusComments({ title: "Tone", artist: "Parrot", lyrics: { synced: null, plain: "la la" } })),
        packets: packets.map((bytes) => ({ bytes, samples: 960 })),
        preSkip,
        samples,
      });
      const target = path.join(dir, "written.ogg");
      writeFileSync(target, written);
      const pcm = run(["-i", target, "-f", "s16le", "-ac", "2", "-ar", "48000", "-"]);
      expect(pcm.length / 4).toBe(samples);
      const probe = spawnSync("/usr/bin/ffprobe", ["-v", "error", "-show_entries", "stream_tags:stream=codec_name", "-of", "json", target], {
        encoding: "utf8",
      });
      const info = JSON.parse(probe.stdout) as { streams: Array<{ codec_name: string; tags?: Record<string, string> }> };
      const audio = info.streams.find((stream) => stream.codec_name === "opus")!;
      expect(audio.tags?.title ?? audio.tags?.TITLE).toBe("Tone");
      expect(audio.tags?.LYRICS ?? audio.tags?.lyrics).toBe("la la");
      // The light copy carries no picture (PAR-FMT-02): the only stream is the sound.
      expect(info.streams.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
