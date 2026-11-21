/**
 * Byte helpers for the audio containers Parrot imports (PAR-UP-01): MP4 atoms, ID3v2 tags, FLAC metadata blocks,
 * Vorbis comments, Ogg pages and RIFF chunks. Plain functions over `Uint8Array`, no Node imports.
 */

export const ascii = (bytes: Uint8Array, at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length));
export const latin1 = (text: string) => new Uint8Array([...text].map((c) => c.charCodeAt(0) & 0xff));
export const utf8 = (text: string) => new TextEncoder().encode(text);
export const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
export const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
export const u32be = (value: number) => {
  const out = new Uint8Array(4);
  view(out).setUint32(0, value);
  return out;
};
export const u32le = (value: number) => {
  const out = new Uint8Array(4);
  view(out).setUint32(0, value, true);
  return out;
};

// ---- MP4 atoms ----

/** One atom: `start` of its header, total `size`, `header` length (8, or 16 with a 64-bit size). */
export type Atom = { type: string; start: number; size: number; header: number };

/**
 * The atoms in `bytes[from, to)`, 64-bit sizes and a last atom running to the end (size 0) included; null when one is
 * unreadable or overruns.
 */
export const atomsIn = (bytes: Uint8Array, from: number, to: number): Atom[] | null => {
  const atoms: Atom[] = [];
  const data = view(bytes);
  let at = from;
  while (at + 8 <= to) {
    let size = data.getUint32(at);
    let header = 8;
    if (size === 1) {
      if (at + 16 > to) return null;
      size = Number(data.getBigUint64(at + 8));
      header = 16;
    } else if (size === 0) size = to - at;
    if (size < header || at + size > to) return null;
    atoms.push({ type: ascii(bytes, at + 4, 4), start: at, size, header });
    at += size;
  }
  return at === to ? atoms : null;
};

/** An atom of `type` around `children` (32-bit size). */
export const box = (type: string, ...children: Uint8Array[]) => {
  const body = concat(...children);
  return concat(u32be(8 + body.length), latin1(type), body);
};

// ---- ID3v2 ----

export const syncsafe = (bytes: Uint8Array, at: number) =>
  ((bytes[at] & 0x7f) << 21) | ((bytes[at + 1] & 0x7f) << 14) | ((bytes[at + 2] & 0x7f) << 7) | (bytes[at + 3] & 0x7f);
export const toSyncsafe = (value: number) => new Uint8Array([(value >> 21) & 0x7f, (value >> 14) & 0x7f, (value >> 7) & 0x7f, value & 0x7f]);

/** Length of the ID3v2 tag at `at` (header, frames, padding and footer), or 0 when none starts there. */
export const id3v2Length = (bytes: Uint8Array, at: number): number => {
  if (at + 10 > bytes.length || ascii(bytes, at, 3) !== "ID3" || bytes[at + 3] === 0xff || bytes[at + 4] === 0xff) return 0;
  if ([6, 7, 8, 9].some((i) => bytes[at + i] & 0x80)) return 0;
  return 10 + syncsafe(bytes, at + 6) + (bytes[at + 5] & 0x10 ? 10 : 0);
};

// ---- Vorbis comments (FLAC block 4, Ogg Vorbis / Opus comment headers) ----

/** A Vorbis comment body: vendor, then `KEY=value` comments; `end` = where the body ends. Null when unreadable. */
export const readVorbisComments = (body: Uint8Array): { vendor: Uint8Array; comments: Uint8Array[]; end: number } | null => {
  const data = view(body);
  if (body.length < 8) return null;
  const vendorLength = data.getUint32(0, true);
  let at = 4 + vendorLength;
  if (at + 4 > body.length) return null;
  const count = data.getUint32(at, true);
  at += 4;
  const comments: Uint8Array[] = [];
  for (let i = 0; i < count; i += 1) {
    if (at + 4 > body.length) return null;
    const length = data.getUint32(at, true);
    if (at + 4 + length > body.length) return null;
    comments.push(body.subarray(at + 4, at + 4 + length));
    at += 4 + length;
  }
  return { vendor: body.subarray(4, 4 + vendorLength), comments, end: at };
};

export const vorbisCommentBody = (vendor: Uint8Array, comments: Uint8Array[]) =>
  concat(u32le(vendor.length), vendor, u32le(comments.length), ...comments.flatMap((comment) => [u32le(comment.length), comment]));

/** The upper-cased key of a `KEY=value` comment. */
export const vorbisCommentKey = (comment: Uint8Array) => {
  const eq = comment.indexOf(0x3d);
  return ascii(comment, 0, eq < 0 ? comment.length : eq).toUpperCase();
};

// ---- Ogg pages ----

const OGG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let crc = i << 24;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
    table[i] = crc >>> 0;
  }
  return table;
})();

/** An Ogg page's checksum: CRC-32 (polynomial 0x04c11db7, no reflection) over the page with its CRC field zeroed. */
export const oggCrc = (page: Uint8Array) => {
  let crc = 0;
  for (let i = 0; i < page.length; i += 1) crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) ^ (i >= 22 && i < 26 ? 0 : page[i])) & 0xff]) >>> 0;
  return crc;
};

export type OggPage = { start: number; end: number; flags: number; serial: number; sequence: number; segments: Uint8Array; body: Uint8Array };

export const readOggPage = (bytes: Uint8Array, at: number): OggPage | null => {
  if (at + 27 > bytes.length || ascii(bytes, at, 4) !== "OggS" || bytes[at + 4] !== 0) return null;
  const count = bytes[at + 26];
  if (at + 27 + count > bytes.length) return null;
  const segments = bytes.subarray(at + 27, at + 27 + count);
  const bodyLength = segments.reduce((sum, value) => sum + value, 0);
  const bodyStart = at + 27 + count;
  if (bodyStart + bodyLength > bytes.length) return null;
  const data = view(bytes);
  return {
    start: at,
    end: bodyStart + bodyLength,
    flags: bytes[at + 5],
    serial: data.getUint32(at + 14, true),
    sequence: data.getUint32(at + 18, true),
    segments,
    body: bytes.subarray(bodyStart, bodyStart + bodyLength),
  };
};

/** A page with granule 0 (header pages carry no sound), its sequence number and CRC filled in. */
const oggHeaderPage = (template: Uint8Array, flags: number, sequence: number, segments: number[], body: Uint8Array) => {
  const page = concat(template.subarray(0, 27), new Uint8Array(segments), body);
  page[5] = flags;
  page.fill(0, 6, 14);
  const data = view(page);
  data.setUint32(18, sequence, true);
  data.setUint32(22, 0, true);
  page[26] = segments.length;
  data.setUint32(22, oggCrc(page), true);
  return page;
};

/**
 * Header packets laid out in pages of at most 255 lacing values, each packet ending where Ogg says it ends; the last
 * packet closes its page, so the sound starts on a fresh one (Vorbis I and RFC 7845 both ask it).
 */
export const paginateOggHeaders = (template: Uint8Array, firstSequence: number, packets: Uint8Array[]) => {
  const pages: Uint8Array[] = [];
  let segments: number[] = [];
  let parts: Uint8Array[] = [];
  let continued = false;
  let nextContinued = false;
  const flush = () => {
    pages.push(oggHeaderPage(template, continued ? 1 : 0, firstSequence + pages.length, segments, concat(...parts)));
    continued = nextContinued;
    segments = [];
    parts = [];
  };
  for (const [index, packet] of packets.entries()) {
    let left = packet.length;
    let at = 0;
    for (;;) {
      const piece = Math.min(255, left);
      segments.push(piece);
      parts.push(packet.subarray(at, at + piece));
      at += piece;
      left -= piece;
      const ended = piece < 255;
      nextContinued = !ended;
      if (segments.length === 255) flush();
      if (ended) break;
    }
    if (index === packets.length - 1 && segments.length > 0) flush();
  }
  return pages;
};

/** A copy of the page at `page` with its sequence number set to `sequence` and its CRC recomputed. */
export const renumberOggPage = (bytes: Uint8Array, page: OggPage, sequence: number) => {
  const copy = bytes.slice(page.start, page.end);
  const data = view(copy);
  data.setUint32(18, sequence, true);
  data.setUint32(22, 0, true);
  data.setUint32(22, oggCrc(copy), true);
  return copy;
};
