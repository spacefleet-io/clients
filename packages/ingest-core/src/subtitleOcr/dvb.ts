/**
 * DVB subtitle decoder (ETSI EN 300 743). Each Matroska packet is one PES
 * payload: [data_identifier 0x20, stream_id 0x00,] then segments
 * `0x0F type(1) page_id(2) length(2) data`, closed by 0xFF. Decoder state
 * (regions, CLUTs) survives across packets within an epoch; a page
 * composition in "mode change" or "acquisition point" state restarts it.
 *
 * A display set with visible regions starts a picture at the packet PTS; the
 * next display set ends it, else the page time-out does.
 */
import { ycbcrToRgba } from "./colour";
import type { SubtitlePicture } from "./types";

const SEGMENT = {
  PAGE: 0x10,
  REGION: 0x11,
  CLUT: 0x12,
  OBJECT: 0x13,
  DISPLAY: 0x14,
  END: 0x80,
} as const;

type Clut = { c2: Uint8Array; c4: Uint8Array; c8: Uint8Array };
type RegionObject = { id: number; x: number; y: number };
type Region = {
  width: number;
  height: number;
  depth: 2 | 4 | 8;
  clutId: number;
  pixels: Uint8Array;
  objects: RegionObject[];
};
type Page = { timeoutMs: number; regions: Array<{ id: number; x: number; y: number }> };

export type DvbPacket = { ptsMs: number; data: Uint8Array };
export type DvbPicture = Omit<SubtitlePicture, "endMs"> & { endMs: number | null };

const rgbaClut = (size: number, entry: (i: number) => [number, number, number, number]): Uint8Array => {
  const out = new Uint8Array(size * 4);
  for (let i = 0; i < size; i++) out.set(entry(i), i * 4);
  return out;
};

/** EN 300 743 §10 default CLUTs (as ffmpeg's dvbsubdec builds them). */
const defaultClut = (): Clut => ({
  c2: rgbaClut(4, (i) => [[0, 0, 0, 0], [255, 255, 255, 255], [0, 0, 0, 255], [127, 127, 127, 255]][i] as [number, number, number, number]),
  c4: rgbaClut(16, (i) => {
    if (i === 0) return [0, 0, 0, 0];
    const level = i < 8 ? 255 : 127;
    return [i & 1 ? level : 0, i & 2 ? level : 0, i & 4 ? level : 0, 255];
  }),
  c8: rgbaClut(256, (i) => {
    if (i === 0) return [0, 0, 0, 0];
    if (i < 8) return [i & 1 ? 255 : 0, i & 2 ? 255 : 0, i & 4 ? 255 : 0, 63];
    const lo = (bit: number, hi: number, a: number, b: number) => (i & bit ? a : 0) + (i & hi ? b : 0);
    switch (i & 0x88) {
      case 0x00:
        return [lo(1, 0x10, 85, 170), lo(2, 0x20, 85, 170), lo(4, 0x40, 85, 170), 255];
      case 0x08:
        return [lo(1, 0x10, 85, 170), lo(2, 0x20, 85, 170), lo(4, 0x40, 85, 170), 127];
      case 0x80:
        return [127 + lo(1, 0x10, 43, 85), 127 + lo(2, 0x20, 43, 85), 127 + lo(4, 0x40, 43, 85), 255];
      default:
        return [lo(1, 0x10, 43, 85), lo(2, 0x20, 43, 85), lo(4, 0x40, 43, 85), 255];
    }
  }),
});

const DEFAULT_MAP_2TO4 = [0x0, 0x7, 0x8, 0xf];
const DEFAULT_MAP_2TO8 = [0x00, 0x77, 0x88, 0xff];
const DEFAULT_MAP_4TO8 = Array.from({ length: 16 }, (_, i) => i * 0x11);

class BitReader {
  private bit = 0;
  constructor(
    private readonly buf: Uint8Array,
    private pos: number,
    private readonly end: number
  ) {}
  read(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.pos < this.end ? this.buf[this.pos] : 0;
      v = (v << 1) | ((byte >> (7 - this.bit)) & 1);
      this.bit += 1;
      if (this.bit === 8) {
        this.bit = 0;
        this.pos += 1;
      }
    }
    return v;
  }
  /** Byte offset after aligning to the next byte boundary. */
  align(): number {
    if (this.bit !== 0) {
      this.bit = 0;
      this.pos += 1;
    }
    return this.pos;
  }
  get exhausted(): boolean {
    return this.pos >= this.end;
  }
}

type Run = { run: number; colour: number } | null;

/** Reads one run of a 2/4/8-bit pixel code string; null = end of string. */
const readRun = (r: BitReader, bits: 2 | 4 | 8): Run => {
  if (bits === 2) {
    const code = r.read(2);
    if (code !== 0) return { run: 1, colour: code };
    if (r.read(1) === 1) return { run: 3 + r.read(3), colour: r.read(2) };
    if (r.read(1) === 1) return { run: 1, colour: 0 };
    switch (r.read(2)) {
      case 0:
        return null;
      case 1:
        return { run: 2, colour: 0 };
      case 2:
        return { run: 12 + r.read(4), colour: r.read(2) };
      default:
        return { run: 29 + r.read(8), colour: r.read(2) };
    }
  }
  if (bits === 4) {
    const code = r.read(4);
    if (code !== 0) return { run: 1, colour: code };
    if (r.read(1) === 0) {
      const run = r.read(3);
      return run === 0 ? null : { run: run + 2, colour: 0 };
    }
    if (r.read(1) === 0) return { run: 4 + r.read(2), colour: r.read(4) };
    switch (r.read(2)) {
      case 0:
        return { run: 1, colour: 0 };
      case 1:
        return { run: 2, colour: 0 };
      case 2:
        return { run: 9 + r.read(4), colour: r.read(4) };
      default:
        return { run: 25 + r.read(8), colour: r.read(4) };
    }
  }
  const code = r.read(8);
  if (code !== 0) return { run: 1, colour: code };
  if (r.read(1) === 0) {
    const run = r.read(7);
    return run === 0 ? null : { run, colour: 0 };
  }
  const run = r.read(7);
  return { run, colour: r.read(8) };
};

/** Maps a pixel code of `codeBits` depth into a region of `depth` bits. */
const mapCode = (
  colour: number,
  codeBits: 2 | 4 | 8,
  depth: 2 | 4 | 8,
  maps: { m2to4: number[]; m2to8: number[]; m4to8: number[] }
): number => {
  if (codeBits === depth) return colour;
  if (codeBits === 2) return depth === 4 ? maps.m2to4[colour] : maps.m2to8[colour];
  if (codeBits === 4) return depth === 8 ? maps.m4to8[colour] : colour >> 2;
  return depth === 4 ? colour >> 4 : colour >> 6;
};

/** Decodes one field of pixel-data sub-blocks into `region` at (x, y0), every second line. */
const decodeField = (
  buf: Uint8Array,
  start: number,
  end: number,
  region: Region,
  x0: number,
  y0: number,
  nonModifying: boolean
): void => {
  const maps = { m2to4: [...DEFAULT_MAP_2TO4], m2to8: [...DEFAULT_MAP_2TO8], m4to8: [...DEFAULT_MAP_4TO8] };
  let pos = start;
  let x = x0;
  let y = y0;
  while (pos < end) {
    const type = buf[pos++];
    if (type === 0x10 || type === 0x11 || type === 0x12) {
      const bits = type === 0x10 ? 2 : type === 0x11 ? 4 : 8;
      const r = new BitReader(buf, pos, end);
      for (;;) {
        const run = readRun(r, bits);
        if (run === null || r.exhausted) {
          pos = r.align();
          break;
        }
        const colour = mapCode(run.colour, bits, region.depth, maps);
        const skip = nonModifying && run.colour === 1 && bits !== 8;
        if (y < region.height && !skip) {
          const from = y * region.width + Math.min(x, region.width);
          const to = y * region.width + Math.min(x + run.run, region.width);
          region.pixels.fill(colour, from, to);
        }
        x += run.run;
      }
    } else if (type === 0x20) {
      maps.m2to4 = [buf[pos] >> 4, buf[pos] & 15, buf[pos + 1] >> 4, buf[pos + 1] & 15];
      pos += 2;
    } else if (type === 0x21) {
      maps.m2to8 = [buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]];
      pos += 4;
    } else if (type === 0x22) {
      maps.m4to8 = Array.from(buf.subarray(pos, pos + 16));
      pos += 16;
    } else if (type === 0xf0) {
      x = x0;
      y += 2;
    } else {
      throw new Error(`unknown DVB pixel-data sub-block 0x${type.toString(16)}`);
    }
  }
};

/**
 * Decodes the Matroska packets of one DVB subtitle track. `onFailure` counts
 * display sets that could not be decoded (they are skipped).
 */
export const decodeDvbPackets = (packets: DvbPacket[], onFailure: (error: unknown) => void): DvbPicture[] => {
  const pictures: DvbPicture[] = [];
  let cluts = new Map<number, Clut>();
  let regions = new Map<number, Region>();
  let page: Page | null = null;
  let open: DvbPicture | null = null;
  let pageId: number | null = null;

  for (const packet of packets) {
    const buf = packet.data;
    try {
      let pos = buf[0] === 0x20 && buf[1] === 0x00 ? 2 : 0;
      let displaySetSeen = false;
      while (pos + 6 <= buf.length && buf[pos] === 0x0f) {
        const type = buf[pos + 1];
        const segmentPage = (buf[pos + 2] << 8) | buf[pos + 3];
        const length = (buf[pos + 4] << 8) | buf[pos + 5];
        const start = pos + 6;
        const end = Math.min(buf.length, start + length);
        pos = start + length;
        // Composition page and ancillary page both apply; ignore foreign pages once one is chosen.
        if (type === SEGMENT.PAGE) pageId ??= segmentPage;
        switch (type) {
          case SEGMENT.PAGE: {
            if (segmentPage !== pageId) break;
            const state = (buf[start + 1] >> 2) & 3;
            if (state === 1 || state === 2) {
              regions = new Map();
              cluts = new Map();
            }
            const pageRegions: Page["regions"] = [];
            for (let p = start + 2; p + 6 <= end; p += 6) {
              pageRegions.push({
                id: buf[p],
                x: (buf[p + 2] << 8) | buf[p + 3],
                y: (buf[p + 4] << 8) | buf[p + 5],
              });
            }
            page = { timeoutMs: buf[start] * 1000, regions: pageRegions };
            displaySetSeen = true;
            break;
          }
          case SEGMENT.REGION: {
            const id = buf[start];
            const fill = (buf[start + 1] & 0x08) !== 0;
            const width = (buf[start + 2] << 8) | buf[start + 3];
            const height = (buf[start + 4] << 8) | buf[start + 5];
            const depthCode = (buf[start + 6] >> 2) & 7;
            const depth: 2 | 4 | 8 = depthCode === 1 ? 2 : depthCode === 2 ? 4 : 8;
            const clutId = buf[start + 7];
            const fillCode = depth === 8 ? buf[start + 8] : depth === 4 ? buf[start + 9] >> 4 : (buf[start + 9] >> 2) & 3;
            const previous = regions.get(id);
            const reuse = previous && previous.width === width && previous.height === height && previous.depth === depth;
            const pixels = reuse ? previous.pixels : new Uint8Array(width * height);
            if (fill || !reuse) pixels.fill(fill ? fillCode : 0);
            const objects: RegionObject[] = [];
            for (let p = start + 10; p + 6 <= end; ) {
              const objectType = buf[p + 2] >> 6;
              objects.push({
                id: (buf[p] << 8) | buf[p + 1],
                x: ((buf[p + 2] & 0x0f) << 8) | buf[p + 3],
                y: ((buf[p + 4] & 0x0f) << 8) | buf[p + 5],
              });
              p += objectType === 1 || objectType === 2 ? 8 : 6;
            }
            regions.set(id, { width, height, depth, clutId, pixels, objects });
            break;
          }
          case SEGMENT.CLUT: {
            const id = buf[start];
            const clut = cluts.get(id) ?? defaultClut();
            for (let p = start + 2; p + 2 <= end; ) {
              const entry = buf[p];
              const flags = buf[p + 1];
              let y: number;
              let cr: number;
              let cb: number;
              let t: number;
              if (flags & 1) {
                [y, cr, cb, t] = [buf[p + 2], buf[p + 3], buf[p + 4], buf[p + 5]];
                p += 6;
              } else {
                y = buf[p + 2] & 0xfc;
                cr = (((buf[p + 2] & 3) << 2) | (buf[p + 3] >> 6)) << 4;
                cb = (buf[p + 3] << 2) & 0xf0;
                t = (buf[p + 3] << 6) & 0xc0;
                p += 4;
              }
              const colour = y === 0 ? [0, 0, 0, 0] : ycbcrToRgba(y, cb, cr, 255 - t, false);
              if (flags & 0x80 && entry < 4) clut.c2.set(colour, entry * 4);
              if (flags & 0x40 && entry < 16) clut.c4.set(colour, entry * 4);
              if (flags & 0x20) clut.c8.set(colour, entry * 4);
            }
            cluts.set(id, clut);
            break;
          }
          case SEGMENT.OBJECT: {
            const id = (buf[start] << 8) | buf[start + 1];
            const method = (buf[start + 2] >> 2) & 3;
            const nonModifying = (buf[start + 2] & 0x02) !== 0;
            if (method !== 0) throw new Error(`DVB object coding method ${method} (character strings) unsupported`);
            const topLength = (buf[start + 3] << 8) | buf[start + 4];
            const bottomLength = (buf[start + 5] << 8) | buf[start + 6];
            const topStart = start + 7;
            const bottomStart = topStart + topLength;
            for (const region of regions.values()) {
              for (const ref of region.objects) {
                if (ref.id !== id) continue;
                decodeField(buf, topStart, Math.min(end, bottomStart), region, ref.x, ref.y, nonModifying);
                if (bottomLength > 0) {
                  decodeField(buf, bottomStart, Math.min(end, bottomStart + bottomLength), region, ref.x, ref.y + 1, nonModifying);
                } else {
                  decodeField(buf, topStart, Math.min(end, bottomStart), region, ref.x, ref.y + 1, nonModifying);
                }
              }
            }
            break;
          }
          default: // display definition, disparity, end of display set: nothing to keep
            if (type === SEGMENT.END) displaySetSeen = true;
            break;
        }
      }
      if (!displaySetSeen || !page) continue;
      if (open) {
        open.endMs = packet.ptsMs;
        open = null;
      }
      const visible = page.regions.filter((r) => regions.has(r.id));
      if (visible.length === 0) continue;
      const left = Math.min(...visible.map((r) => r.x));
      const top = Math.min(...visible.map((r) => r.y));
      const right = Math.max(...visible.map((r) => r.x + (regions.get(r.id)?.width ?? 0)));
      const bottom = Math.max(...visible.map((r) => r.y + (regions.get(r.id)?.height ?? 0)));
      const width = right - left;
      const height = bottom - top;
      if (width <= 0 || height <= 0) continue;
      const rgba = new Uint8Array(width * height * 4);
      let opaque = false;
      for (const placement of visible) {
        const region = regions.get(placement.id);
        if (!region) continue;
        const clut = cluts.get(region.clutId) ?? defaultClut();
        const table = region.depth === 2 ? clut.c2 : region.depth === 4 ? clut.c4 : clut.c8;
        for (let ry = 0; ry < region.height; ry++) {
          for (let rx = 0; rx < region.width; rx++) {
            const c = region.pixels[ry * region.width + rx] * 4;
            if (table[c + 3] === 0) continue;
            const d = ((placement.y - top + ry) * width + (placement.x - left + rx)) * 4;
            rgba[d] = table[c];
            rgba[d + 1] = table[c + 1];
            rgba[d + 2] = table[c + 2];
            rgba[d + 3] = table[c + 3];
            opaque = true;
          }
        }
      }
      if (!opaque) continue;
      open = {
        startMs: packet.ptsMs,
        endMs: page.timeoutMs > 0 ? packet.ptsMs + page.timeoutMs : null,
        width,
        height,
        rgba,
      };
      pictures.push(open);
    } catch (error) {
      onFailure(error);
    }
  }
  return pictures;
};
