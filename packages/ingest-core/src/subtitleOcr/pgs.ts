/**
 * HDMV PGS (`.sup`) decoder: display sets → composed RGBA pictures.
 *
 * Segment = "PG" + PTS(4) + DTS(4) + type(1) + size(2) + payload. A display set
 * runs PCS (0x16) … END (0x80) with optional WDS (0x17), PDS (0x14) palettes
 * and ODS (0x15) objects (split across fragments). A composition with objects
 * starts a picture at its PTS; any later composition (including one with zero
 * objects, the usual "clear") ends it.
 */
import { ycbcrToRgba } from "./colour";
import { closePictureTimeline, type DecodedPictureSubtitles, type SubtitlePicture } from "./types";

const SEGMENT = { PDS: 0x14, ODS: 0x15, PCS: 0x16, WDS: 0x17, END: 0x80 } as const;
const COMPOSITION_EPOCH_START = 0x80;

type PgsObject = { width: number; height: number; expectedLength: number; data: number[]; complete: boolean };
type CompositionObject = {
  objectId: number;
  x: number;
  y: number;
  crop: { x: number; y: number; width: number; height: number } | null;
};
type Composition = { ptsMs: number; height: number; paletteId: number; objects: CompositionObject[] };

const decodePgsRle = (data: number[], width: number, height: number): Uint8Array => {
  const indices = new Uint8Array(width * height);
  let pos = 0;
  let x = 0;
  let y = 0;
  while (pos < data.length && y < height) {
    const b = data[pos++];
    let run = 1;
    let colour = b;
    if (b === 0) {
      const flags = data[pos++] ?? 0;
      if (flags === 0) {
        x = 0;
        y += 1;
        continue;
      }
      const long = (flags & 0x40) !== 0;
      run = long ? ((flags & 0x3f) << 8) | (data[pos++] ?? 0) : flags & 0x3f;
      colour = (flags & 0x80) !== 0 ? (data[pos++] ?? 0) : 0;
    }
    const end = Math.min(width, x + run);
    if (colour !== 0) indices.fill(colour, y * width + x, y * width + end);
    x = end;
  }
  return indices;
};

/** Parses a whole `.sup` buffer. Throws only when the buffer is not PGS at all. */
export const decodePgsSup = (buf: Uint8Array): DecodedPictureSubtitles => {
  if (buf.length < 13 || buf[0] !== 0x50 || buf[1] !== 0x47) {
    throw new Error("not a PGS stream (missing \"PG\" magic)");
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const palettes = new Map<number, Uint8Array>();
  const objects = new Map<number, PgsObject>();
  const open: Array<Omit<SubtitlePicture, "endMs"> & { endMs: number | null }> = [];
  let current: Composition | null = null;
  let openIndex: number | null = null;
  let failures = 0;
  let pos = 0;

  const closeOpen = (ptsMs: number) => {
    if (openIndex !== null) {
      open[openIndex].endMs = ptsMs;
      openIndex = null;
    }
  };

  const composeDisplaySet = (composition: Composition) => {
    const previousIndex = openIndex;
    closeOpen(composition.ptsMs);
    if (composition.objects.length === 0) return;
    const palette = palettes.get(composition.paletteId);
    if (!palette) throw new Error(`palette ${composition.paletteId} missing`);
    const placed = composition.objects.map((ref) => {
      const object = objects.get(ref.objectId);
      if (!object || !object.complete) throw new Error(`object ${ref.objectId} missing or incomplete`);
      const crop = ref.crop ?? { x: 0, y: 0, width: object.width, height: object.height };
      return { ref, object, crop };
    });
    const left = Math.min(...placed.map((p) => p.ref.x));
    const top = Math.min(...placed.map((p) => p.ref.y));
    const right = Math.max(...placed.map((p) => p.ref.x + p.crop.width));
    const bottom = Math.max(...placed.map((p) => p.ref.y + p.crop.height));
    const width = right - left;
    const height = bottom - top;
    if (width <= 0 || height <= 0) throw new Error("empty composition bounds");
    const rgba = new Uint8Array(width * height * 4);
    for (const { ref, object, crop } of placed) {
      const indices = decodePgsRle(object.data, object.width, object.height);
      for (let row = 0; row < crop.height; row++) {
        const srcY = crop.y + row;
        if (srcY >= object.height) break;
        for (let col = 0; col < crop.width; col++) {
          const srcX = crop.x + col;
          if (srcX >= object.width) break;
          const p = indices[srcY * object.width + srcX] * 4;
          if (palette[p + 3] === 0) continue;
          const d = ((ref.y - top + row) * width + (ref.x - left + col)) * 4;
          rgba[d] = palette[p];
          rgba[d + 1] = palette[p + 1];
          rgba[d + 2] = palette[p + 2];
          rgba[d + 3] = palette[p + 3];
        }
      }
    }
    const previous = previousIndex !== null ? open[previousIndex] : null;
    if (
      previous &&
      previous.width === width &&
      previous.height === height &&
      Buffer.from(previous.rgba.buffer, previous.rgba.byteOffset, previous.rgba.byteLength).equals(
        Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength)
      )
    ) {
      // Acquisition point / palette-less refresh repeating the same picture: keep one cue.
      previous.endMs = null;
      openIndex = previousIndex;
      return;
    }
    openIndex = open.length;
    open.push({ startMs: composition.ptsMs, endMs: null, width, height, rgba });
  };

  while (pos + 13 <= buf.length) {
    if (buf[pos] !== 0x50 || buf[pos + 1] !== 0x47) {
      // Resync on the next "PG" after garbage.
      const next = buf.indexOf(0x50, pos + 1);
      if (next < 0) break;
      pos = next;
      continue;
    }
    const ptsMs = view.getUint32(pos + 2) / 90;
    const type = buf[pos + 10];
    const size = view.getUint16(pos + 11);
    const start = pos + 13;
    const end = start + size;
    pos = end;
    if (end > buf.length) break;
    try {
      switch (type) {
        case SEGMENT.PCS: {
          const height = view.getUint16(start + 2);
          const state = buf[start + 7];
          const paletteId = buf[start + 9];
          const count = buf[start + 10];
          if (state & COMPOSITION_EPOCH_START) {
            palettes.clear();
            objects.clear();
          }
          const refs: CompositionObject[] = [];
          let p = start + 11;
          for (let i = 0; i < count; i++) {
            const cropped = (buf[p + 3] & 0x80) !== 0;
            refs.push({
              objectId: view.getUint16(p),
              x: view.getUint16(p + 4),
              y: view.getUint16(p + 6),
              crop: cropped
                ? {
                    x: view.getUint16(p + 8),
                    y: view.getUint16(p + 10),
                    width: view.getUint16(p + 12),
                    height: view.getUint16(p + 14),
                  }
                : null,
            });
            p += cropped ? 16 : 8;
          }
          current = { ptsMs, height, paletteId, objects: refs };
          break;
        }
        case SEGMENT.PDS: {
          const id = buf[start];
          const bt709 = (current?.height ?? 1080) > 576;
          const palette = palettes.get(id) ?? new Uint8Array(256 * 4);
          for (let p = start + 2; p + 5 <= end; p += 5) {
            const [r, g, b, a] = ycbcrToRgba(buf[p + 1], buf[p + 3], buf[p + 2], buf[p + 4], bt709);
            palette.set([r, g, b, a], buf[p] * 4);
          }
          palettes.set(id, palette);
          break;
        }
        case SEGMENT.ODS: {
          const id = view.getUint16(start);
          const sequence = buf[start + 3];
          if (sequence & 0x80) {
            const dataLength = (buf[start + 4] << 16) | (buf[start + 5] << 8) | buf[start + 6];
            const object: PgsObject = {
              width: view.getUint16(start + 7),
              height: view.getUint16(start + 9),
              expectedLength: dataLength - 4,
              data: Array.from(buf.subarray(start + 11, end)),
              complete: false,
            };
            objects.set(id, object);
          } else {
            const object = objects.get(id);
            if (!object) throw new Error(`continuation for unknown object ${id}`);
            for (const b of buf.subarray(start + 4, end)) object.data.push(b);
          }
          const object = objects.get(id);
          if (object && ((sequence & 0x40) !== 0 || object.data.length >= object.expectedLength)) {
            object.complete = true;
          }
          break;
        }
        case SEGMENT.END: {
          if (current) {
            const composition = current;
            current = null;
            composeDisplaySet(composition);
          }
          break;
        }
        default:
          break;
      }
    } catch {
      // One broken display set: drop it, keep decoding the rest.
      failures += 1;
      if (type === SEGMENT.END || type === SEGMENT.PCS) current = null;
    }
  }
  return { codec: "hdmv_pgs_subtitle", pictures: closePictureTimeline(open), failures };
};
