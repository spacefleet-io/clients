import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { requireMediaBinary } from "@space/media-deps";
import { decodePictureSubtitleFile } from "../src/subtitleOcr/decode";
import { parseFfprobeHexDump } from "../src/subtitleOcr/ffprobePackets";
import { decodePgsSup } from "../src/subtitleOcr/pgs";
import { closePictureTimeline, DEFAULT_PICTURE_DURATION_MS, type SubtitlePicture } from "../src/subtitleOcr/types";
import { parseVobSubIdx } from "../src/subtitleOcr/vobsub";
import { formatSrtTimestamp } from "../src/subtitleOcr/srt";
import { SYNTHETIC_CUES, subtitleOcrFixture, VOBSUB_SAMPLES } from "./helpers/subtitleOcrFixtures";

const SUITE = "subtitle-ocr-decoders";

const ffprobeAvailable = requireMediaBinary("ffprobe", spawnSync("ffprobe", ["-version"]).status === 0);
if (!ffprobeAvailable) console.warn(`[${SUITE}:SKIPPED] ffprobe unavailable: Matroska decoder tests did not run`);

const opaquePixels = (picture: SubtitlePicture): number => {
  let n = 0;
  for (let i = 3; i < picture.rgba.length; i += 4) if (picture.rgba[i] > 0) n++;
  return n;
};

const summarise = (pictures: SubtitlePicture[]) =>
  pictures.map((p) => ({ startMs: p.startMs, endMs: Math.round(p.endMs), width: p.width, height: p.height, opaque: opaquePixels(p) }));

describe("PGS .sup decoder", () => {
  it("decodes every synthetic display set with its exact timing and inked pixels", async () => {
    console.info(`[${SUITE}:phase] decode ocr-synthetic.sup`);
    const decoded = decodePgsSup(await readFile(subtitleOcrFixture("ocr-synthetic.sup")));
    const summary = summarise(decoded.pictures);
    console.info(`[${SUITE}:state] pgs`, JSON.stringify({ codec: decoded.codec, failures: decoded.failures, summary }));
    expect(decoded.codec).toBe("hdmv_pgs_subtitle");
    expect(decoded.failures).toBe(0);
    expect(summary.map(({ startMs, endMs }) => ({ startMs, endMs }))).toEqual(
      SYNTHETIC_CUES.map(({ startMs, endMs }) => ({ startMs, endMs }))
    );
    for (const p of summary) expect(p.opaque).toBeGreaterThan(1000);
    // Two-line cue is roughly twice as tall as the one-line cues.
    expect(summary[1].height).toBeGreaterThan(summary[0].height * 1.8);
  });

  it("composes white text and black outline from the YCbCr palette", async () => {
    const decoded = decodePgsSup(await readFile(subtitleOcrFixture("ocr-synthetic.sup")));
    const colours = new Set<string>();
    const { rgba } = decoded.pictures[0];
    for (let i = 0; i < rgba.length; i += 4) if (rgba[i + 3] > 0) colours.add(`${rgba[i]},${rgba[i + 1]},${rgba[i + 2]},${rgba[i + 3]}`);
    console.info(`[${SUITE}:state] palette colours`, [...colours]);
    expect([...colours].sort()).toEqual(["0,0,0,255", "255,255,255,255"]);
  });

  it("skips a corrupt display set, counts it, and keeps decoding the rest", async () => {
    const sup = Buffer.from(await readFile(subtitleOcrFixture("ocr-synthetic.sup")));
    // Point the first composition at an object id that is never defined.
    const firstPcs = sup.indexOf(Buffer.from([0x16]), 10);
    expect(sup[firstPcs - 10]).toBe(0x50);
    sup.writeUInt16BE(0x0007, firstPcs + 3 + 11);
    const decoded = decodePgsSup(sup);
    console.info(`[${SUITE}:state] corrupt`, JSON.stringify({ failures: decoded.failures, summary: summarise(decoded.pictures) }));
    expect(decoded.failures).toBe(1);
    expect(decoded.pictures.map((p) => p.startMs)).toEqual([4000, 8000]);
  });

  it("rejects input without the PG magic", () => {
    expect(() => decodePgsSup(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]))).toThrow(/PG/);
  });
});

describe.skipIf(!ffprobeAvailable)("Matroska picture subtitles via ffprobe", () => {
  const synthetic = [
    ["ocr-synthetic-dvdsub.mkv", "dvd_subtitle"],
    ["ocr-synthetic-dvbsub.mkv", "dvb_subtitle"],
    ["ocr-synthetic-pgs.mkv", "hdmv_pgs_subtitle"],
  ] as const;

  it.each(synthetic)("%s decodes to the same pictures as the source .sup", async (file, codec) => {
    console.info(`[${SUITE}:phase] decode ${file}`);
    const reference = summarise(decodePgsSup(await readFile(subtitleOcrFixture("ocr-synthetic.sup"))).pictures);
    const decoded = await decodePictureSubtitleFile(subtitleOcrFixture(file), { ffprobePath: "ffprobe" });
    const summary = summarise(decoded.pictures);
    console.info(`[${SUITE}:state] ${file}`, JSON.stringify({ codec: decoded.codec, failures: decoded.failures, summary }));
    expect(decoded.codec).toBe(codec);
    expect(decoded.failures).toBe(0);
    expect(summary).toHaveLength(SYNTHETIC_CUES.length);
    summary.forEach((p, i) => {
      expect(p.startMs).toBe(SYNTHETIC_CUES[i].startMs);
      // dvdsub stop delays tick in 1024/90 ms units.
      expect(Math.abs(p.endMs - SYNTHETIC_CUES[i].endMs)).toBeLessThanOrEqual(12);
      expect({ width: p.width, height: p.height, opaque: p.opaque }).toEqual({
        width: reference[i].width,
        height: reference[i].height,
        opaque: reference[i].opaque,
      });
    });
  });

  it.each(Object.entries(VOBSUB_SAMPLES))(
    "DVD-style %s VobSub sample matches the generated cue starts and dvdsub stop delays",
    async (_lang, sample) => {
      console.info(`[${SUITE}:phase] decode ${sample.file}`);
      const decoded = await decodePictureSubtitleFile(subtitleOcrFixture(sample.file), { ffprobePath: "ffprobe" });
      const timings = decoded.pictures.map((p) => ({ start: formatSrtTimestamp(p.startMs), end: formatSrtTimestamp(p.endMs) }));
      console.info(`[${SUITE}:state] ${sample.file}`, JSON.stringify({ failures: decoded.failures, timings, summary: summarise(decoded.pictures) }));
      expect(decoded.codec).toBe("dvd_subtitle");
      expect(decoded.failures).toBe(0);
      expect(timings).toEqual(sample.cues.map(({ start, end }) => ({ start, end })));
      for (const p of decoded.pictures) expect(opaquePixels(p)).toBeGreaterThan(5000);
    }
  );

  it("fails clearly on a file without a subtitle stream", async () => {
    await expect(
      decodePictureSubtitleFile(subtitleOcrFixture("../ingest/fixture_expectations.json"), { ffprobePath: "ffprobe" })
    ).rejects.toThrow(/ffprobe exited|no subtitle stream/);
  });
});

describe("decoder helpers", () => {
  it("parses ffprobe hex dumps including a short last line", () => {
    const dump = "\n00000000: 7369 7a65 3a20 3139 3230 7831 3038 300a  size: 1920x1080.\n00000010: 6f72 67                                org";
    expect(Buffer.from(parseFfprobeHexDump(dump)).toString("latin1")).toBe("size: 1920x1080\norg");
    expect(parseFfprobeHexDump(undefined)).toHaveLength(0);
  });

  it("reads size and palette from VobSub CodecPrivate text", () => {
    const idx = parseVobSubIdx("size: 1920x1080\norg: 0, 0\npalette: 000000, f0f0f0, cccccc, 3333fa\n");
    expect(idx).toEqual({
      width: 1920,
      height: 1080,
      palette: [
        [0, 0, 0],
        [240, 240, 240],
        [204, 204, 204],
        [51, 51, 250],
      ],
    });
    expect(parseVobSubIdx("").palette).toHaveLength(16);
  });

  it("closes open-ended pictures at the next start, else after the default duration", () => {
    const base = { width: 1, height: 1, rgba: new Uint8Array(4) };
    const closed = closePictureTimeline([
      { ...base, startMs: 5000, endMs: null },
      { ...base, startMs: 1000, endMs: 2000 },
      { ...base, startMs: 2500, endMs: null },
    ]);
    expect(closed.map((p) => [p.startMs, p.endMs])).toEqual([
      [1000, 2000],
      [2500, 5000],
      [5000, 5000 + DEFAULT_PICTURE_DURATION_MS],
    ]);
  });
});
