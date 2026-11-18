/**
 * DVD (VobSub) SPU decoder. Matroska stores each SPU unwrapped from MPEG-PS,
 * so one packet = one SPU: size(2) + control-sequence offset(2) + interlaced
 * 2-bit RLE fields + DCSQ chain (start/stop delays, colour/alpha nibbles,
 * display area, field offsets). The palette comes from the track's
 * CodecPrivate, which is the `.idx` header text (`size:` / `palette:` lines).
 */
import type { SubtitlePicture } from "./types";

export type VobSubIdx = { width: number; height: number; palette: Array<[number, number, number]> };

/** Grey ramp used when a track carries no `palette:` line. */
const FALLBACK_PALETTE: Array<[number, number, number]> = Array.from({ length: 16 }, (_, i) => {
  const v = Math.round((i / 15) * 255);
  return [v, v, v];
});

export const parseVobSubIdx = (text: string): VobSubIdx => {
  let width = 720;
  let height = 480;
  let palette: Array<[number, number, number]> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("size:")) {
      const match = /(\d+)\s*x\s*(\d+)/.exec(line);
      if (match) {
        width = Number(match[1]);
        height = Number(match[2]);
      }
    } else if (line.startsWith("palette:")) {
      palette = line
        .slice("palette:".length)
        .split(",")
        .map((c) => Number.parseInt(c.trim(), 16))
        .filter((v) => Number.isFinite(v))
        .map((v): [number, number, number] => [(v >> 16) & 255, (v >> 8) & 255, v & 255]);
    }
  }
  return { width, height, palette: palette.length > 0 ? palette : FALLBACK_PALETTE };
};

/** One SPU field: 2-bit RLE (nibble-coded), every second line starting at `firstLine`. */
const decodeSpuField = (
  spu: Uint8Array,
  offset: number,
  end: number,
  width: number,
  height: number,
  out: Uint8Array,
  firstLine: number
): void => {
  let nib = offset * 2;
  const nibEnd = Math.min(end, spu.length) * 2;
  const next = (): number => {
    if (nib >= nibEnd) return 0;
    const b = spu[nib >> 1];
    const v = (nib & 1) === 0 ? b >> 4 : b & 15;
    nib += 1;
    return v;
  };
  for (let y = firstLine; y < height; y += 2) {
    let x = 0;
    while (x < width) {
      let v = next();
      if (v < 0x4) {
        v = (v << 4) | next();
        if (v < 0x10) {
          v = (v << 4) | next();
          if (v < 0x40) v = (v << 4) | next();
        }
      }
      const colour = v & 3;
      const run = v >> 2 === 0 ? width - x : v >> 2;
      out.fill(colour, y * width + x, y * width + Math.min(width, x + run));
      x += run;
    }
    if (nib & 1) nib += 1;
    if (nib >= nibEnd) break;
  }
};

/**
 * Decodes one SPU. `ptsMs` is the packet timestamp; the picture starts at
 * pts + start delay and ends at pts + stop delay (null when the SPU has no
 * stop command — the caller closes it at the next picture).
 */
export const decodeVobSubPacket = (
  spu: Uint8Array,
  ptsMs: number,
  idx: VobSubIdx
): (Omit<SubtitlePicture, "endMs"> & { endMs: number | null }) | null => {
  if (spu.length < 4) throw new Error("SPU shorter than its header");
  const dcsq = (spu[2] << 8) | spu[3];
  let colours = [0, 1, 2, 3];
  let alphas = [0, 15, 15, 15];
  let x1 = 0;
  let x2 = -1;
  let y1 = 0;
  let y2 = -1;
  let top = 0;
  let bottom = 0;
  let startDelayMs = 0;
  let stopDelayMs: number | null = null;
  const seen = new Set<number>();
  let pos = dcsq;
  while (pos + 4 <= spu.length && !seen.has(pos)) {
    seen.add(pos);
    const delayMs = (((spu[pos] << 8) | spu[pos + 1]) * 1024) / 90;
    const nextPos = (spu[pos + 2] << 8) | spu[pos + 3];
    let p = pos + 4;
    commands: while (p < spu.length) {
      const cmd = spu[p++];
      switch (cmd) {
        case 0x00: // forced start display
        case 0x01: // start display
          startDelayMs = delayMs;
          break;
        case 0x02: // stop display
          stopDelayMs = delayMs;
          break;
        case 0x03: {
          const v = (spu[p] << 8) | spu[p + 1];
          colours = [v & 15, (v >> 4) & 15, (v >> 8) & 15, (v >> 12) & 15];
          p += 2;
          break;
        }
        case 0x04: {
          const v = (spu[p] << 8) | spu[p + 1];
          alphas = [v & 15, (v >> 4) & 15, (v >> 8) & 15, (v >> 12) & 15];
          p += 2;
          break;
        }
        case 0x05:
          x1 = (spu[p] << 4) | (spu[p + 1] >> 4);
          x2 = ((spu[p + 1] & 15) << 8) | spu[p + 2];
          y1 = (spu[p + 3] << 4) | (spu[p + 4] >> 4);
          y2 = ((spu[p + 4] & 15) << 8) | spu[p + 5];
          p += 6;
          break;
        case 0x06:
          top = (spu[p] << 8) | spu[p + 1];
          bottom = (spu[p + 2] << 8) | spu[p + 3];
          p += 4;
          break;
        default: // 0xff end of command list, or an unsupported command
          break commands;
      }
    }
    if (nextPos === pos) break;
    pos = nextPos;
  }
  const width = x2 - x1 + 1;
  const height = y2 - y1 + 1;
  if (width <= 0 || height <= 0 || top === 0) return null;
  const indices = new Uint8Array(width * height);
  decodeSpuField(spu, top, bottom, width, height, indices, 0);
  decodeSpuField(spu, bottom, dcsq, width, height, indices, 1);
  const lut = colours.map((c, i) => {
    const [r, g, b] = idx.palette[c] ?? [0, 0, 0];
    return [r, g, b, alphas[i] * 17];
  });
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < indices.length; i++) rgba.set(lut[indices[i]], i * 4);
  return {
    startMs: ptsMs + startDelayMs,
    endMs: stopDelayMs !== null && stopDelayMs > startDelayMs ? ptsMs + stopDelayMs : null,
    width,
    height,
    rgba,
  };
};
