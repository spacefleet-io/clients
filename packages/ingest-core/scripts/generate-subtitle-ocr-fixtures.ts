/**
 * Regenerates the committed picture-subtitle OCR fixtures in fixtures/subtitle-ocr/:
 *
 * - ocr-synthetic.sup: SYNTHETIC_CUES rendered by ffmpeg drawtext (DejaVu Sans
 *   Bold, white text, black outline), quantised to a 3-colour palette and
 *   written as HDMV PGS. Cue 3's object is split across several ODS fragments.
 * - ocr-synthetic-dvdsub.mkv / ocr-synthetic-dvbsub.mkv: the same cues
 *   re-encoded by ffmpeg's dvdsub / dvbsub encoders.
 * - vobsub-sample-{eng,fre}.mkv: VOBSUB_SAMPLES (invented two-line dialogue,
 *   French accents, pictures from ~47.9 s) rendered in Liberation Sans Bold the
 *   same way, then re-encoded by ffmpeg's dvdsub encoder with eng/fre tags.
 *
 * Usage: bun packages/ingest-core/scripts/generate-subtitle-ocr-fixtures.ts [--lang-data [--api-base <url>]]
 * `--lang-data` also fetches eng/fra traineddata into the OCR test cache dir, from the SpaceFleet API
 * `--api-base` (default https://api.spacefleet.io), checked against the pinned sha256 list.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ensureTesseractLangData } from "../src/subtitleOcr/langData";
import {
  SUBTITLE_OCR_FIXTURE_DIR,
  SUBTITLE_OCR_TEST_LANG_DIR,
  SYNTHETIC_CUES,
  VOBSUB_SAMPLES,
  subtitleOcrFixture,
} from "../tests/helpers/subtitleOcrFixtures";

type Font = { file: string; size: number; renderWidth: number; renderHeight: number };
type Cue = { startMs: number; endMs: number; text: string };

const SYNTHETIC_FONT: Font = { file: "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf", size: 44, renderWidth: 1000, renderHeight: 140 };
const VOBSUB_FONT: Font = { file: "/usr/share/fonts/liberation/LiberationSans-Bold.ttf", size: 52, renderWidth: 1400, renderHeight: 160 };
const CANVAS = { width: 1920, height: 1080 };
const COLOR = { transparent: 0, white: 1, black: 2 } as const;

const ffmpeg = (args: string[]): Buffer => {
  const result = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`ffmpeg ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout;
};

/** drawtext on pure blue → palette indices (blue = transparent, bright = white, rest = outline black). */
const renderCue = (text: string, font: Font): { width: number; height: number; indices: Uint8Array } => {
  const textFile = `${SUBTITLE_OCR_FIXTURE_DIR}/.cue.txt`;
  writeFileSync(textFile, text);
  const rgb = ffmpeg([
    "-f", "lavfi", "-i", `color=c=0x0000ff:s=${font.renderWidth}x${font.renderHeight}`,
    "-vf", `drawtext=fontfile=${font.file}:textfile=${textFile}:fontsize=${font.size}:line_spacing=8:fontcolor=white:borderw=3:bordercolor=black:x=(w-tw)/2:y=(h-th)/2`,
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ]);
  spawnSync("rm", ["-f", textFile]);
  const RENDER = { width: font.renderWidth, height: font.renderHeight };
  const all = new Uint8Array(RENDER.width * RENDER.height);
  let minX = RENDER.width, minY = RENDER.height, maxX = -1, maxY = -1;
  for (let i = 0; i < all.length; i++) {
    const [r, g, b] = [rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]];
    const background = b > 160 && r < 90 && g < 90;
    all[i] = background ? COLOR.transparent : 0.299 * r + 0.587 * g + 0.114 * b > 128 ? COLOR.white : COLOR.black;
    if (!background) {
      const x = i % RENDER.width, y = Math.floor(i / RENDER.width);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }
  const width = maxX - minX + 1, height = maxY - minY + 1;
  const indices = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) indices.set(all.subarray((minY + y) * RENDER.width + minX, (minY + y) * RENDER.width + maxX + 1), y * width);
  return { width, height, indices };
};

const u16 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff];

const segment = (type: number, ptsMs: number, payload: number[]): Buffer => {
  const header = Buffer.alloc(13);
  header.write("PG", 0, "latin1");
  header.writeUInt32BE(Math.round(ptsMs * 90) >>> 0, 2);
  header.writeUInt8(type, 10);
  header.writeUInt16BE(payload.length, 11);
  return Buffer.concat([header, Buffer.from(payload)]);
};

/** HDMV RLE, every line closed by 00 00. */
const encodeRle = (indices: Uint8Array, width: number, height: number): number[] => {
  const out: number[] = [];
  for (let y = 0; y < height; y++) {
    let x = 0;
    while (x < width) {
      const colour = indices[y * width + x];
      let run = 1;
      while (x + run < width && run < 0x3fff && indices[y * width + x + run] === colour) run++;
      if (colour !== 0 && run < 3) {
        for (let k = 0; k < run; k++) out.push(colour);
      } else if (colour === 0) {
        out.push(0, ...(run < 64 ? [run] : [0x40 | (run >> 8), run & 0xff]));
      } else {
        out.push(0, ...(run < 64 ? [0x80 | run] : [0xc0 | (run >> 8), run & 0xff]), colour);
      }
      x += run;
    }
    out.push(0, 0);
  }
  return out;
};

/** `fragmentCue`: index of the cue whose object is split across several ODS fragments. */
const buildSup = (cues: readonly Cue[], font: Font, fragmentCue?: number): Buffer => {
  const parts: Buffer[] = [];
  let composition = 0;
  // PDS: id, Y, Cr, Cb, alpha.
  const palette = [0, 0, COLOR.transparent, 16, 128, 128, 0, COLOR.white, 235, 128, 128, 255, COLOR.black, 16, 128, 128, 255];
  cues.forEach((cue, i) => {
    const bitmap = renderCue(cue.text, font);
    const x = Math.round((CANVAS.width - bitmap.width) / 2);
    const y = CANVAS.height - 80 - bitmap.height;
    const window = [1, 0, ...u16(x), ...u16(y), ...u16(bitmap.width), ...u16(bitmap.height)];
    const pcs = (objects: number[], state: number) => [
      ...u16(CANVAS.width), ...u16(CANVAS.height), 0x10, ...u16(composition++), state, 0, 0, objects.length > 0 ? 1 : 0, ...objects,
    ];
    parts.push(
      segment(0x16, cue.startMs, pcs([...u16(0), 0, 0, ...u16(x), ...u16(y)], 0x80)),
      segment(0x17, cue.startMs, window),
      segment(0x14, cue.startMs, palette)
    );
    const rle = encodeRle(bitmap.indices, bitmap.width, bitmap.height);
    const objectData = [...u16(bitmap.width), ...u16(bitmap.height), ...rle];
    // Multi-fragment objects: first fragment carries the u24 length, the rest only data.
    const fragmentSize = i === fragmentCue ? 1500 : 0xffe0;
    for (let offset = 0, first = true; offset < objectData.length; offset += fragmentSize, first = false) {
      const chunk = objectData.slice(offset, offset + fragmentSize);
      const last = offset + fragmentSize >= objectData.length;
      const flags = (first ? 0x80 : 0) | (last ? 0x40 : 0);
      const length = objectData.length;
      parts.push(
        segment(0x15, cue.startMs, [...u16(0), 0, flags, ...(first ? [(length >> 16) & 0xff, ...u16(length & 0xffff)] : []), ...chunk])
      );
    }
    parts.push(
      segment(0x80, cue.startMs, []),
      segment(0x16, cue.endMs, pcs([], 0x00)),
      segment(0x17, cue.endMs, window),
      segment(0x80, cue.endMs, [])
    );
  });
  return Buffer.concat(parts);
};

const { values } = parseArgs({
  options: { "lang-data": { type: "boolean" }, "api-base": { type: "string", default: "https://api.spacefleet.io" } },
});
mkdirSync(SUBTITLE_OCR_FIXTURE_DIR, { recursive: true });

const sup = subtitleOcrFixture("ocr-synthetic.sup");
writeFileSync(sup, buildSup(SYNTHETIC_CUES, SYNTHETIC_FONT, 2));
console.info(`[subtitle-ocr:fixtures] wrote ${sup}`);
for (const [codec, name] of [["dvdsub", "ocr-synthetic-dvdsub.mkv"], ["dvbsub", "ocr-synthetic-dvbsub.mkv"]] as const) {
  ffmpeg(["-copyts", "-fix_sub_duration", "-i", sup, "-map", "0:s:0", "-c:s", codec, "-metadata:s:s:0", "language=eng", "-f", "matroska", subtitleOcrFixture(name)]);
  console.info(`[subtitle-ocr:fixtures] wrote ${name}`);
}
ffmpeg(["-copyts", "-i", sup, "-map", "0:s:0", "-c:s", "copy", "-f", "matroska", subtitleOcrFixture("ocr-synthetic-pgs.mkv")]);
console.info("[subtitle-ocr:fixtures] wrote ocr-synthetic-pgs.mkv");
for (const sample of Object.values(VOBSUB_SAMPLES)) {
  const sampleSup = subtitleOcrFixture(`.${sample.language}.sup`);
  writeFileSync(sampleSup, buildSup(sample.cues, VOBSUB_FONT));
  ffmpeg(["-copyts", "-fix_sub_duration", "-i", sampleSup, "-map", "0:s:0", "-c:s", "dvdsub", "-metadata:s:s:0", `language=${sample.language}`, "-fflags", "+bitexact", "-f", "matroska", subtitleOcrFixture(sample.file)]);
  rmSync(sampleSup);
  console.info(`[subtitle-ocr:fixtures] wrote ${sample.file}`);
}
if (values["lang-data"]) {
  for (const tesseractLang of ["eng", "fra"]) {
    await ensureTesseractLangData({
      tesseractLang,
      langDir: SUBTITLE_OCR_TEST_LANG_DIR,
      apiBaseUrl: values["api-base"],
      log: (event, payload) => console.info(event, payload),
    });
  }
}
