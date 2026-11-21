/**
 * PAR-FMT-01: how a song's file is stored. The file is cut, never re-encoded, into
 * - a **header**: what a player reads before the first sound (the container's index and stream facts), every picture
 *   and every user tag taken out;
 * - the **payload**: the audio itself, byte for byte (Ogg pages get new sequence numbers and checksums when the
 *   header's page count changed; their packets are unchanged);
 * - the file's own **tags**, pictures excepted, kept raw in a small object of their own.
 * Header then payload is a normal file of the same container that plays the same samples. The pictures are not kept:
 * the album's cover copies come from them (PAR-META-04).
 */
import {
  ascii,
  type Atom,
  atomsIn,
  box,
  concat,
  id3v2Length,
  latin1,
  type OggPage,
  paginateOggHeaders,
  readOggPage,
  readVorbisComments,
  renumberOggPage,
  syncsafe,
  u32be,
  u32le,
  view,
  vorbisCommentBody,
  vorbisCommentKey,
} from "./containerBytes";

/** One kind of tags the file carried, each entry its raw bytes in base64, as the container wrote it. */
export type ParrotOriginalTagGroup =
  /** ID3v2 frames (whole frames with their headers), in the tag's own `major` version; v2.3 unsynchronisation undone. */
  | { format: "id3v2"; major: number; frames: string[] }
  /** Vorbis comments (`KEY=value`), FLAC or Ogg. */
  | { format: "vorbis"; comments: string[] }
  /** MP4 `ilst` items, whole atoms. */
  | { format: "mp4-ilst"; items: string[] }
  /** RIFF `LIST`/`INFO` sub-chunks, whole with their headers. */
  | { format: "riff-info"; chunks: string[] };

/** The tags object stored next to a split file (sealed JSON). */
export type ParrotOriginalTags = { v: 1; groups: ParrotOriginalTagGroup[] };

export type ParrotSplitOriginal =
  | {
      kind: "split";
      /** Container index and stream facts; empty for MP3 and ADTS, whose frames carry everything. */
      header: Uint8Array;
      payload: Uint8Array;
      tags: ParrotOriginalTags;
      /** Pictures left out of header and payload. */
      picturesDropped: number;
    }
  | { kind: "unsupported"; reason: string };

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const unsupported = (reason: string): ParrotSplitOriginal => ({ kind: "unsupported", reason });

/** Comment keys that hold a picture (FLAC-style picture block, or the legacy base64 image). */
const PICTURE_COMMENTS: Record<string, true> = { METADATA_BLOCK_PICTURE: true, COVERART: true, COVERARTMIME: true };

/** Vorbis comments split into the tags to keep and the count of pictures to drop (COVERARTMIME is the type of one). */
const sortComments = (comments: Uint8Array[]) => {
  const kept = comments.filter((comment) => !PICTURE_COMMENTS[vorbisCommentKey(comment)]);
  const pictures = comments.filter((comment) => vorbisCommentKey(comment) !== "COVERARTMIME" && PICTURE_COMMENTS[vorbisCommentKey(comment)]).length;
  return { kept, pictures };
};

// ---- ID3v2 (MP3, ADTS, FLAC and WAV may carry one) ----

/** Undoes ID3v2 unsynchronisation: every `FF 00` becomes `FF`. */
const resync = (bytes: Uint8Array) => {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i += 1) {
    out.push(bytes[i]);
    if (bytes[i] === 0xff && bytes[i + 1] === 0x00) i += 1;
  }
  return new Uint8Array(out);
};

/** The frames of the ID3v2 tag at `at` (its length already checked): pictures counted, every other frame kept raw. */
const readId3Frames = (bytes: Uint8Array, at: number, length: number): { group: ParrotOriginalTagGroup | null; pictures: number } => {
  const major = bytes[at + 3];
  const flags = bytes[at + 5];
  let body = bytes.subarray(at + 10, at + 10 + syncsafe(bytes, at + 6));
  if (major < 2 || major > 4 || body.length + 10 > length) return { group: null, pictures: 0 };
  if (major <= 3 && flags & 0x80) body = resync(body);
  let pos = 0;
  if (major >= 3 && flags & 0x40) {
    if (body.length < 4) return { group: null, pictures: 0 };
    pos = major === 3 ? 4 + view(body).getUint32(0) : syncsafe(body, 0);
  }
  const idLength = major === 2 ? 3 : 4;
  const headerLength = major === 2 ? 6 : 10;
  const frames: string[] = [];
  let pictures = 0;
  while (pos + headerLength <= body.length && body[pos] !== 0) {
    const size =
      major === 2 ? (body[pos + 3] << 16) | (body[pos + 4] << 8) | body[pos + 5] : major === 3 ? view(body).getUint32(pos + 4) : syncsafe(body, pos + 4);
    const end = pos + headerLength + size;
    if (end > body.length) break;
    const id = ascii(body, pos, idLength);
    if (id === "APIC" || id === "PIC") pictures += 1;
    else frames.push(b64(body.subarray(pos, end)));
    pos = end;
  }
  return { group: frames.length > 0 ? { format: "id3v2", major, frames } : null, pictures };
};

/** The ID3v2 tags at the start of `bytes`: where the rest starts, their frames and pictures. */
const leadingId3 = (bytes: Uint8Array) => {
  const groups: ParrotOriginalTagGroup[] = [];
  let pictures = 0;
  let at = 0;
  for (let length = id3v2Length(bytes, at); length > 0 && at + length <= bytes.length; length = id3v2Length(bytes, at)) {
    const read = readId3Frames(bytes, at, length);
    if (read.group) groups.push(read.group);
    pictures += read.pictures;
    at += length;
  }
  return { start: at, groups, pictures };
};

/** Where the trailing ID3v1 and APEv2 tags start (`bytes.length` when there are none). */
const trailingTagsStart = (bytes: Uint8Array, from: number) => {
  let end = bytes.length;
  if (end - 128 >= from && ascii(bytes, end - 128, 3) === "TAG") end -= 128;
  if (end - 32 >= from && ascii(bytes, end - 32, 8) === "APETAGEX") {
    const size = view(bytes).getUint32(end - 32 + 12, true);
    const hasHeader = (view(bytes).getUint32(end - 32 + 20, true) & 0x80000000) !== 0;
    const start = end - size - (hasHeader ? 32 : 0);
    if (start >= from) end = start;
  }
  return end;
};

/** MP3 and ADTS: frames only; the tags around them are taken out. */
const splitFrames = (bytes: Uint8Array): ParrotSplitOriginal => {
  const lead = leadingId3(bytes);
  const end = trailingTagsStart(bytes, lead.start);
  if (end <= lead.start) return unsupported("no audio frames");
  return { kind: "split", header: new Uint8Array(0), payload: bytes.subarray(lead.start, end), tags: { v: 1, groups: lead.groups }, picturesDropped: lead.pictures };
};

// ---- FLAC ----

/** Metadata blocks a player needs: STREAMINFO, APPLICATION, SEEKTABLE, CUESHEET. */
const FLAC_KEPT_BLOCKS = new Set([0, 2, 3, 5]);

const splitFlac = (bytes: Uint8Array): ParrotSplitOriginal => {
  const lead = leadingId3(bytes);
  if (ascii(bytes, lead.start, 4) !== "fLaC") return unsupported("no fLaC marker");
  const groups = [...lead.groups];
  let pictures = lead.pictures;
  const kept: Uint8Array[] = [];
  let at = lead.start + 4;
  for (let last = false; !last; ) {
    if (at + 4 > bytes.length) return unsupported("FLAC metadata runs past the file");
    last = (bytes[at] & 0x80) !== 0;
    const type = bytes[at] & 0x7f;
    const length = (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3];
    const end = at + 4 + length;
    if (end > bytes.length) return unsupported("FLAC metadata runs past the file");
    if (FLAC_KEPT_BLOCKS.has(type)) kept.push(bytes.slice(at, end));
    else if (type === 6) pictures += 1;
    else if (type === 4) {
      const comments = readVorbisComments(bytes.subarray(at + 4, end));
      if (!comments) return unsupported("unreadable FLAC comments");
      const sorted = sortComments(comments.comments);
      pictures += sorted.pictures;
      if (sorted.kept.length > 0) groups.push({ format: "vorbis", comments: sorted.kept.map(b64) });
    }
    at = end;
  }
  if (kept[0]?.[0] !== 0) return unsupported("FLAC without STREAMINFO first");
  for (const block of kept) block[0] &= 0x7f;
  kept[kept.length - 1][0] |= 0x80;
  return { kind: "split", header: concat(latin1("fLaC"), ...kept), payload: bytes.subarray(at), tags: { v: 1, groups }, picturesDropped: pictures };
};

// ---- Ogg (Vorbis, Opus) ----

const splitOgg = (bytes: Uint8Array): ParrotSplitOriginal => {
  const first = readOggPage(bytes, 0);
  if (!first) return unsupported("no Ogg page at the start");
  const codec = ascii(first.body, 0, 7) === "\x01vorbis" ? "vorbis" : ascii(first.body, 0, 8) === "OpusHead" ? "opus" : null;
  if (!codec) return unsupported("Ogg stream that is neither Vorbis nor Opus");
  const headerPackets = codec === "vorbis" ? 3 : 2;
  // The header packets, page by page, until the last one ends; it must end its page.
  const packets: Uint8Array[] = [];
  let parts: Uint8Array[] = [];
  const headerPages: OggPage[] = [];
  let at = 0;
  while (packets.length < headerPackets) {
    const page = readOggPage(bytes, at);
    if (!page) return unsupported("unreadable Ogg header page");
    if (page.serial !== first.serial) return unsupported("Ogg file with several streams");
    headerPages.push(page);
    let offset = 0;
    for (const [i, lacing] of page.segments.entries()) {
      parts.push(page.body.subarray(offset, offset + lacing));
      offset += lacing;
      if (lacing < 255) {
        packets.push(concat(...parts));
        parts = [];
        if (packets.length === headerPackets && i !== page.segments.length - 1) return unsupported("Ogg sound starts inside a header page");
      }
    }
    at = page.end;
  }
  if (headerPages[0].segments.length !== 1) return unsupported("Ogg first page holds more than the identification header");
  const comment = packets[1];
  const prefix = codec === "vorbis" ? 7 : 8;
  const read = readVorbisComments(comment.subarray(prefix));
  if (!read) return unsupported("unreadable Ogg comment header");
  const sorted = sortComments(read.comments);
  const bare = concat(comment.subarray(0, prefix), vorbisCommentBody(read.vendor, []), comment.subarray(prefix + read.end));
  const newPages = [bytes.subarray(0, first.end), ...paginateOggHeaders(bytes.subarray(0, first.end), 1, [bare, ...packets.slice(2)])];
  const header = concat(...newPages);
  const shift = newPages.length - headerPages.length;
  let payload: Uint8Array;
  if (shift === 0) payload = bytes.subarray(at);
  else {
    const pages: Uint8Array[] = [];
    for (let pos = at; pos < bytes.length; ) {
      const page = readOggPage(bytes, pos);
      if (!page) return unsupported("unreadable Ogg page");
      if (page.serial !== first.serial) return unsupported("Ogg file with several streams");
      pages.push(renumberOggPage(bytes, page, page.sequence + shift));
      pos = page.end;
    }
    payload = concat(...pages);
  }
  return {
    kind: "split",
    header,
    payload,
    tags: { v: 1, groups: sorted.kept.length > 0 ? [{ format: "vorbis", comments: sorted.kept.map(b64) }] : [] },
    picturesDropped: sorted.pictures,
  };
};

// ---- MP4 (.m4a: AAC, ALAC) ----

/** `ilst` items a player uses: the encoder delay and padding (gapless playback). */
const keptIlstItem = (bytes: Uint8Array, item: Atom) => {
  if (item.type !== "----") return false;
  const children = atomsIn(bytes, item.start + item.header, item.start + item.size);
  const name = children?.find((child) => child.type === "name");
  return name !== undefined && ascii(bytes, name.start + 12, name.size - 12) === "iTunSMPB";
};

/** Padding atoms dropped wherever they are. */
const PADDING_ATOMS: Record<string, true> = { free: true, skip: true, wide: true };

/** `atom` rebuilt from `children`, its header (and full-box prefix of `prefix` bytes) kept. */
const rebuilt = (bytes: Uint8Array, atom: Atom, prefix: number, children: Uint8Array[]) => {
  const out = concat(bytes.subarray(atom.start, atom.start + 8 + prefix), ...children);
  out.set(u32be(out.length), 0);
  return out;
};

const splitMp4 = (bytes: Uint8Array): ParrotSplitOriginal => {
  const top = atomsIn(bytes, 0, bytes.length);
  if (!top) return unsupported("unreadable MP4 atoms");
  if (top.some((atom) => atom.type === "moof")) return unsupported("fragmented MP4");
  const moov = top.find((atom) => atom.type === "moov");
  const mdats = top.filter((atom) => atom.type === "mdat");
  if (!moov || mdats.length !== 1) return unsupported("MP4 without one moov and one mdat");
  const [mdat] = mdats;
  if (moov.header !== 8) return unsupported("64-bit moov");
  const items: string[] = [];
  let pictures = 0;
  // ilst: the gapless item stays, pictures go, every other item goes into the tags object.
  const ilst = (atom: Atom) => {
    const children = atomsIn(bytes, atom.start + 8, atom.start + atom.size);
    if (!children) return null;
    const kept: Uint8Array[] = [];
    for (const item of children) {
      if (item.type === "covr") pictures += 1;
      else if (keptIlstItem(bytes, item)) kept.push(bytes.subarray(item.start, item.start + item.size));
      else items.push(b64(bytes.subarray(item.start, item.start + item.size)));
    }
    return rebuilt(bytes, atom, 0, kept);
  };
  const meta = (atom: Atom) => {
    // iTunes `meta` is a full box (4 bytes of version and flags); QuickTime's has none.
    const prefix = atomsIn(bytes, atom.start + 12, atom.start + atom.size) ? 4 : 0;
    const children = atomsIn(bytes, atom.start + 8 + prefix, atom.start + atom.size);
    if (!children) return null;
    const out: Uint8Array[] = [];
    for (const child of children) {
      if (PADDING_ATOMS[child.type]) continue;
      if (child.type === "ilst") {
        const rebuiltIlst = ilst(child);
        if (!rebuiltIlst) return null;
        out.push(rebuiltIlst);
      } else out.push(bytes.subarray(child.start, child.start + child.size));
    }
    return rebuilt(bytes, atom, prefix, out);
  };
  const container = (atom: Atom): Uint8Array | null => {
    const children = atomsIn(bytes, atom.start + 8, atom.start + atom.size);
    if (!children) return null;
    const out: Uint8Array[] = [];
    for (const child of children) {
      if (PADDING_ATOMS[child.type]) continue;
      const next = child.type === "udta" ? container(child) : child.type === "meta" ? meta(child) : bytes.subarray(child.start, child.start + child.size);
      if (!next) return null;
      out.push(next);
    }
    return rebuilt(bytes, atom, 0, out);
  };
  const newMoov = container(moov);
  if (!newMoov) return unsupported("unreadable moov");
  const payload = bytes.subarray(mdat.start + mdat.header, mdat.start + mdat.size);
  const mdatHeader =
    payload.length + 8 <= 0xffffffff
      ? concat(u32be(payload.length + 8), latin1("mdat"))
      : (() => {
          const large = concat(u32be(1), latin1("mdat"), new Uint8Array(8));
          view(large).setBigUint64(8, BigInt(payload.length + 16));
          return large;
        })();
  const before = top.filter((atom) => atom !== moov && atom !== mdat && !PADDING_ATOMS[atom.type]).map((atom) => bytes.subarray(atom.start, atom.start + atom.size));
  const headerLength = before.reduce((sum, part) => sum + part.length, 0) + newMoov.length + mdatHeader.length;
  const moved = moveChunkOffsets(newMoov, mdat.start + mdat.header, mdat.start + mdat.size, headerLength);
  if (moved) return unsupported(moved);
  return { kind: "split", header: concat(...before, newMoov, mdatHeader), payload, tags: { v: 1, groups: items.length > 0 ? [{ format: "mp4-ilst", items }] : [] }, picturesDropped: pictures };
};

/**
 * Points every `stco`/`co64` chunk offset of `moov` at the same sound once the payload starts at `newStart` instead of
 * `oldStart`; a reason when an offset lies outside the payload or no longer fits.
 */
export const moveChunkOffsets = (moov: Uint8Array, oldStart: number, oldEnd: number, newStart: number): string | null => {
  const data = view(moov);
  const walk = (from: number, to: number): string | null => {
    const atoms = atomsIn(moov, from, to);
    if (!atoms) return "unreadable moov";
    for (const atom of atoms) {
      const body = atom.start + atom.header;
      const end = atom.start + atom.size;
      if (["trak", "mdia", "minf", "stbl"].includes(atom.type)) {
        const inner = walk(body, end);
        if (inner) return inner;
      } else if (atom.type === "stco" || atom.type === "co64") {
        const width = atom.type === "stco" ? 4 : 8;
        const count = data.getUint32(body + 4);
        if (body + 8 + count * width > end) return "chunk offset table runs past its atom";
        for (let i = 0; i < count; i += 1) {
          const at = body + 8 + i * width;
          const old = width === 4 ? data.getUint32(at) : Number(data.getBigUint64(at));
          if (old < oldStart || old >= oldEnd) return "chunk offset outside the sound";
          const moved = old - oldStart + newStart;
          if (width === 4) {
            if (moved > 0xffffffff) return "chunk offset no longer fits";
            data.setUint32(at, moved);
          } else data.setBigUint64(at, BigInt(moved));
        }
      }
    }
    return null;
  };
  return walk(8, moov.length);
};

// ---- WAV ----

/** RIFF chunks that are padding. */
const RIFF_PADDING: Record<string, true> = { JUNK: true, junk: true, "PAD ": true, FLLR: true };

const splitWav = (bytes: Uint8Array): ParrotSplitOriginal => {
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") return unsupported("not a RIFF WAVE file");
  const data = view(bytes);
  const groups: ParrotOriginalTagGroup[] = [];
  let pictures = 0;
  const kept: Uint8Array[] = [];
  let payload: Uint8Array | null = null;
  for (let at = 12; at + 8 <= bytes.length; ) {
    const id = ascii(bytes, at, 4);
    const size = data.getUint32(at + 4, true);
    const end = at + 8 + size;
    if (end > bytes.length) return unsupported(`RIFF chunk ${id} runs past the file`);
    if (id === "data") {
      if (payload) return unsupported("WAV with two data chunks");
      payload = bytes.subarray(at + 8, Math.min(bytes.length, end + (size & 1)));
    } else if (id === "LIST" && ascii(bytes, at + 8, 4) === "INFO") {
      const chunks: string[] = [];
      for (let pos = at + 12; pos + 8 <= end; ) {
        const length = data.getUint32(pos + 4, true);
        const next = pos + 8 + length + (length & 1);
        chunks.push(b64(bytes.subarray(pos, Math.min(end, pos + 8 + length))));
        pos = next;
      }
      if (chunks.length > 0) groups.push({ format: "riff-info", chunks });
    } else if (id === "id3 " || id === "ID3 ") {
      const tag = bytes.subarray(at + 8, end);
      const length = id3v2Length(tag, 0);
      if (length > 0 && length <= tag.length) {
        const read = readId3Frames(tag, 0, length);
        if (read.group) groups.push(read.group);
        pictures += read.pictures;
      }
    } else if (!RIFF_PADDING[id]) kept.push(bytes.subarray(at, Math.min(bytes.length, end + (size & 1))));
    at = end + (size & 1);
  }
  if (!payload) return unsupported("WAV without a data chunk");
  const dataSize = data.getUint32(payload.byteOffset - bytes.byteOffset - 4, true);
  const header = concat(latin1("RIFF"), new Uint8Array(4), latin1("WAVE"), ...kept, latin1("data"), u32le(dataSize));
  view(header).setUint32(4, header.length + payload.length - 8, true);
  return { kind: "split", header, payload, tags: { v: 1, groups }, picturesDropped: pictures };
};

/** Cuts `bytes`, a file of `container` (`audioFormats.ts`), into header, payload and tags; never re-encodes. */
export const splitParrotOriginal = (bytes: Uint8Array, container: string): ParrotSplitOriginal => {
  switch (container) {
    case "mp3":
    case "adts":
      return splitFrames(bytes);
    case "flac":
      return splitFlac(bytes);
    case "ogg":
      return splitOgg(bytes);
    case "mp4":
      return splitMp4(bytes);
    case "wav":
      return splitWav(bytes);
    default:
      return unsupported(`container ${container}`);
  }
};

/** The first payload piece is small so playback starts after little download (PAR-UP-02); the rest are 1 MiB. */
export const PARROT_FIRST_PAYLOAD_PIECE_BYTES = 256 * 1024;
export const PARROT_PAYLOAD_PIECE_BYTES = 1024 * 1024;

/** The pieces stored for a split file: the header (when not empty), then the payload in 256 KiB, then 1 MiB pieces. */
export const parrotSplitPieces = (header: Uint8Array, payload: Uint8Array): Uint8Array[] => {
  const pieces: Uint8Array[] = header.length > 0 ? [header] : [];
  for (let at = 0; at < payload.length; ) {
    const size = at === 0 ? PARROT_FIRST_PAYLOAD_PIECE_BYTES : PARROT_PAYLOAD_PIECE_BYTES;
    pieces.push(payload.subarray(at, at + size));
    at += size;
  }
  return pieces;
};
