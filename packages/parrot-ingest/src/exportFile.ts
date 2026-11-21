/**
 * OFFL-FILE-01: a song exported from Parrot is a normal file of its stored format, rebuilt from what is stored
 * (PAR-FMT-01): the header with its index at the front, the file's own tags (custom ones included) with the library's
 * names over them, the library's 1200 px cover inside, then the stored sound pieces, byte for byte. Nothing is
 * re-encoded; Ogg pages get new sequence numbers when the header's page count changed, MP4 chunk offsets move by the
 * header's change in size. A file stored whole is handed back as stored.
 */
import type { ParrotCopyTags } from "@space/parrot-core";
import {
  ascii,
  atomsIn,
  box,
  concat,
  latin1,
  type OggPage,
  paginateOggHeaders,
  readOggPage,
  readVorbisComments,
  renumberOggPage,
  toSyncsafe,
  u32be,
  u32le,
  utf8,
  view,
  vorbisCommentBody,
  vorbisCommentKey,
} from "./containerBytes";
import type { ParrotLibraryFile } from "./library";
import { moveChunkOffsets, type ParrotOriginalTagGroup, type ParrotOriginalTags } from "./splitOriginal";

export type ParrotExportCover = { bytes: Uint8Array; mime: string };

export type ParrotExportInput = {
  file: ParrotLibraryFile;
  /** The file's own tags (its tags object, PAR-FMT-01); null for a file stored whole or one that had none. */
  tags: ParrotOriginalTags | null;
  /** The library's names for the song, written over the file's own. */
  names: ParrotCopyTags;
  /** The album's 1200 px cover (PAR-META-04). */
  cover: ParrotExportCover | null;
  /** The plain bytes of `file.chunks[index]`. */
  readChunk: (index: number) => Promise<Uint8Array>;
  signal?: AbortSignal;
};

type Container = "mp3" | "adts" | "flac" | "ogg" | "mp4" | "wav";

/** The stored file's container, from its type (`audioFormats.ts`). */
const containerOf = (mime: string): Container | null => {
  const type = mime.split(";")[0]!.trim().toLowerCase();
  if (type === "audio/mpeg") return "mp3";
  if (type === "audio/aac") return "adts";
  if (type === "audio/flac") return "flac";
  if (type === "audio/ogg") return "ogg";
  if (type === "audio/mp4") return "mp4";
  if (type === "audio/wav") return "wav";
  return null;
};

/** The extension an exported file gets: its stored format's usual one. */
export const parrotExportExtension = (file: Pick<ParrotLibraryFile, "mime" | "codec">): string => {
  const container = containerOf(file.mime);
  if (container === "ogg") return file.codec === "opus" ? ".opus" : ".ogg";
  if (container === "mp4") return ".m4a";
  if (container === "adts") return ".aac";
  return container ? `.${container}` : ".bin";
};

const fromB64 = (text: string) => new Uint8Array(Buffer.from(text, "base64"));
const text = (value: string | number | null | undefined) => (value === null || value === undefined ? null : String(value).trim() || null);
const positive = (value: number | null | undefined) => (value && value > 0 ? value : null);
const lyricsOf = (names: ParrotCopyTags) => text(names.lyrics?.synced ?? names.lyrics?.plain);
/** The number a track or disc field starts with ("3/12" → 3). */
const leadingNumber = (value: string) => Number.parseInt(value.replace(/[^0-9/]/g, ""), 10);
/** The total after the slash of a track or disc field ("3/12" → "/12"), when there is one. */
const totalOf = (value: string) => /\/\d+/.exec(value.replace(/[^0-9/]/g, ""))?.[0] ?? "";

const groupsOf = <Format extends ParrotOriginalTagGroup["format"]>(tags: ParrotOriginalTags | null, format: Format) =>
  (tags?.groups ?? []).filter((group): group is Extract<ParrotOriginalTagGroup, { format: Format }> => group.format === format);

// ---- Pictures ----

/** Width and height of a JPEG or PNG; zeros when unreadable (FLAC and Vorbis allow them). */
const pictureSize = (bytes: Uint8Array) => {
  const data = view(bytes);
  if (bytes.length >= 24 && ascii(bytes, 1, 3) === "PNG") return { width: data.getUint32(16), height: data.getUint32(20) };
  for (let at = 2; bytes[0] === 0xff && bytes[1] === 0xd8 && at + 9 < bytes.length; ) {
    if (bytes[at] !== 0xff) break;
    const marker = bytes[at + 1];
    const length = data.getUint16(at + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: data.getUint16(at + 7), height: data.getUint16(at + 5) };
    at += 2 + length;
  }
  return { width: 0, height: 0 };
};

/** A FLAC picture (block 6 body, also what METADATA_BLOCK_PICTURE holds in base64): the front cover. */
const flacPicture = (cover: ParrotExportCover) => {
  const mime = latin1(cover.mime);
  const { width, height } = pictureSize(cover.bytes);
  return concat(u32be(3), u32be(mime.length), mime, u32be(0), u32be(width), u32be(height), u32be(24), u32be(0), u32be(cover.bytes.length), cover.bytes);
};

// ---- ID3v2 (MP3, ADTS; inside WAV; before a FLAC that had one) ----

/** Frames the library's names replace. */
const ID3_NAMED: Record<string, true> = { TIT2: true, TPE1: true, TALB: true, TPE2: true, TRCK: true, TPOS: true, TDRC: true, TYER: true, TDAT: true, TCON: true, USLT: true, APIC: true };

const id3Frame = (major: number, id: string, body: Uint8Array) => concat(latin1(id), major === 4 ? toSyncsafe(body.length) : u32be(body.length), new Uint8Array(2), body);
/** Text in the frame encoding this version has for any language: UTF-8 in v2.4, UTF-16 with a byte order mark in v2.3. */
const id3Encoded = (major: number, value: string) =>
  major === 4 ? concat(new Uint8Array([3]), utf8(value)) : concat(new Uint8Array([1, 0xff, 0xfe]), new Uint8Array(Buffer.from(value, "utf16le")));
const id3Terminator = (major: number) => (major === 4 ? new Uint8Array(1) : new Uint8Array(2));

/** The value text of a kept text frame (header of 10 bytes, then encoding and text). */
const id3FrameText = (frame: Uint8Array) => ascii(frame, 11, frame.length - 11);

/**
 * One ID3v2 tag: the file's own frames of `major` (those the names replace left out), then the library's names, then
 * the cover. A track or disc number the library agrees with keeps the file's own frame, total included.
 */
const id3Tag = (groups: Array<Extract<ParrotOriginalTagGroup, { format: "id3v2" }>>, names: ParrotCopyTags, cover: ParrotExportCover | null) => {
  const major = groups.find((group) => group.major === 3 || group.major === 4)?.major ?? 4;
  const own = groups.filter((group) => group.major === major).flatMap((group) => group.frames.map(fromB64));
  const frames: Uint8Array[] = [];
  const named = (id: string, value: string | null) => {
    if (value) frames.push(id3Frame(major, id, id3Encoded(major, value)));
  };
  const number = (id: string, value: number | null) => {
    const ownFrame = own.find((frame) => ascii(frame, 0, 4) === id);
    if (value && ownFrame && leadingNumber(id3FrameText(ownFrame)) === value) frames.push(ownFrame);
    else named(id, value ? String(value) : null);
  };
  frames.push(...own.filter((frame) => !ID3_NAMED[ascii(frame, 0, 4)]));
  named("TIT2", text(names.title));
  named("TPE1", text(names.artist));
  named("TALB", text(names.album));
  named("TPE2", text(names.albumArtist));
  number("TRCK", positive(names.number));
  number("TPOS", positive(names.disc));
  named(major === 4 ? "TDRC" : "TYER", text(positive(names.year)));
  named("TCON", text(names.genre));
  const lyrics = lyricsOf(names);
  if (lyrics) {
    const encoded = id3Encoded(major, lyrics);
    frames.push(id3Frame(major, "USLT", concat(encoded.subarray(0, 1), latin1("XXX"), major === 4 ? new Uint8Array(0) : new Uint8Array([0xff, 0xfe]), id3Terminator(major), encoded.subarray(1))));
  }
  if (cover) frames.push(id3Frame(major, "APIC", concat(new Uint8Array([0]), latin1(cover.mime), new Uint8Array([0, 3, 0]), cover.bytes)));
  const body = concat(...frames);
  return concat(latin1("ID3"), new Uint8Array([major, 0, 0]), toSyncsafe(body.length), body);
};

// ---- Vorbis comments (FLAC, Ogg) ----

/** Comment keys the library's names replace. */
const VORBIS_NAMED: Record<string, true> = {
  TITLE: true,
  ARTIST: true,
  ALBUM: true,
  ALBUMARTIST: true,
  "ALBUM ARTIST": true,
  TRACKNUMBER: true,
  DISCNUMBER: true,
  DATE: true,
  YEAR: true,
  GENRE: true,
  LYRICS: true,
  UNSYNCEDLYRICS: true,
  METADATA_BLOCK_PICTURE: true,
  COVERART: true,
  COVERARTMIME: true,
};

const vorbisComments = (tags: ParrotOriginalTags | null, names: ParrotCopyTags, cover: ParrotExportCover | null) => {
  const own = groupsOf(tags, "vorbis").flatMap((group) => group.comments.map(fromB64));
  const valueOf = (comment: Uint8Array) => Buffer.from(comment).toString("utf8").slice(comment.indexOf(0x3d) + 1);
  const out = own.filter((comment) => !VORBIS_NAMED[vorbisCommentKey(comment)]);
  const add = (key: string, value: string | null) => {
    if (value) out.push(utf8(`${key}=${value}`));
  };
  const number = (key: string, value: number | null) => {
    const ownComment = own.find((comment) => vorbisCommentKey(comment) === key);
    if (value && ownComment && leadingNumber(valueOf(ownComment)) === value) out.push(ownComment);
    else add(key, value ? String(value) : null);
  };
  add("TITLE", text(names.title));
  add("ARTIST", text(names.artist));
  add("ALBUM", text(names.album));
  add("ALBUMARTIST", text(names.albumArtist));
  number("TRACKNUMBER", positive(names.number));
  number("DISCNUMBER", positive(names.disc));
  add("DATE", text(positive(names.year)));
  add("GENRE", text(names.genre));
  add("LYRICS", lyricsOf(names));
  if (cover) add("METADATA_BLOCK_PICTURE", Buffer.from(flacPicture(cover)).toString("base64"));
  return out;
};

const VENDOR = latin1("SpaceParrot");

// ---- Per container: the stored header in, the rebuilt header out ----

/** How the stored pieces after the header are passed on: as they are, or Ogg pages renumbered by `shift`. */
type Rebuilt = { header: Uint8Array; oggShift: number };

const rebuildFrames = (input: ParrotExportInput): Rebuilt => ({ header: id3Tag(groupsOf(input.tags, "id3v2"), input.names, input.cover), oggShift: 0 });

const rebuildFlac = (header: Uint8Array, input: ParrotExportInput): Rebuilt => {
  if (ascii(header, 0, 4) !== "fLaC") throw new Error("stored FLAC header without its fLaC marker");
  const blocks: Uint8Array[] = [];
  for (let at = 4; at < header.length; ) {
    const length = (header[at + 1] << 16) | (header[at + 2] << 8) | header[at + 3];
    blocks.push(header.slice(at, at + 4 + length));
    at += 4 + length;
  }
  const block = (type: number, body: Uint8Array) => concat(new Uint8Array([type, (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff]), body);
  blocks.push(block(4, vorbisCommentBody(VENDOR, vorbisComments(input.tags, input.names, null))));
  if (input.cover) blocks.push(block(6, flacPicture(input.cover)));
  for (const each of blocks) each[0] &= 0x7f;
  blocks[blocks.length - 1]![0] |= 0x80;
  // A FLAC that came with an ID3v2 tag gets its own frames back in one, before the marker, as it had them.
  const id3 = groupsOf(input.tags, "id3v2");
  const lead = id3.length > 0 ? id3Tag(id3, {}, null) : new Uint8Array(0);
  return { header: concat(lead, latin1("fLaC"), ...blocks), oggShift: 0 };
};

const rebuildOgg = (header: Uint8Array, input: ParrotExportInput): Rebuilt => {
  const pages: OggPage[] = [];
  const packets: Uint8Array[] = [];
  let parts: Uint8Array[] = [];
  for (let at = 0; at < header.length; ) {
    const page = readOggPage(header, at);
    if (!page) throw new Error("unreadable stored Ogg header page");
    pages.push(page);
    let offset = 0;
    for (const lacing of page.segments) {
      parts.push(page.body.subarray(offset, offset + lacing));
      offset += lacing;
      if (lacing < 255) {
        packets.push(concat(...parts));
        parts = [];
      }
    }
    at = page.end;
  }
  const first = pages[0];
  const comment = packets[1];
  if (!first || !comment) throw new Error("stored Ogg header without a comment packet");
  const prefix = ascii(comment, 0, 7) === "\x03vorbis" ? 7 : 8;
  const read = readVorbisComments(comment.subarray(prefix));
  if (!read) throw new Error("unreadable stored Ogg comment header");
  const tagged = concat(comment.subarray(0, prefix), vorbisCommentBody(read.vendor, vorbisComments(input.tags, input.names, input.cover)), comment.subarray(prefix + read.end));
  const firstPage = header.subarray(0, first.end);
  const newPages = [firstPage, ...paginateOggHeaders(firstPage, 1, [tagged, ...packets.slice(2)])];
  return { header: concat(...newPages), oggShift: newPages.length - pages.length };
};

/** iTunes item names the library's names replace. */
const ILST_NAMED: Record<string, true> = { "©nam": true, "©ART": true, "©alb": true, aART: true, trkn: true, disk: true, "©day": true, "©gen": true, gnre: true, "©lyr": true, covr: true };

/** The `ilst` items: the file's own (named ones left out), the library's names, the cover. */
const ilstItems = (input: ParrotExportInput) => {
  const own = groupsOf(input.tags, "mp4-ilst").flatMap((group) => group.items.map(fromB64));
  const items = own.filter((item) => !ILST_NAMED[ascii(item, 4, 4)]);
  const textItem = (type: string, value: string | null) => {
    if (value) items.push(box(type, box("data", u32be(1), u32be(0), utf8(value))));
  };
  /** trkn/disk: the number from the library, the total from the file's own item when it had one. */
  const numberItem = (type: string, value: number | null, length: number) => {
    if (!value) return;
    const body = new Uint8Array(length);
    const ownItem = own.find((item) => ascii(item, 4, 4) === type);
    if (ownItem && ownItem.length >= 24 + 6) body.set(ownItem.subarray(24 + 4, 24 + 6), 4);
    view(body).setUint16(2, value);
    items.push(box(type, box("data", u32be(0), u32be(0), body)));
  };
  textItem("©nam", text(input.names.title));
  textItem("©ART", text(input.names.artist));
  textItem("©alb", text(input.names.album));
  textItem("aART", text(input.names.albumArtist));
  numberItem("trkn", positive(input.names.number), 8);
  numberItem("disk", positive(input.names.disc), 6);
  textItem("©day", text(positive(input.names.year)));
  textItem("©gen", text(input.names.genre));
  textItem("©lyr", lyricsOf(input.names));
  if (input.cover) items.push(box("covr", box("data", u32be(input.cover.mime === "image/png" ? 14 : 13), u32be(0), input.cover.bytes)));
  return items;
};

/** `meta` of an iTunes file: a full box, its handler `mdir`, then `ilst`. */
const ITUNES_HDLR = box("hdlr", u32be(0), u32be(0), latin1("mdir"), latin1("appl"), new Uint8Array(9));

const rebuildMp4 = (header: Uint8Array, payloadBytes: number, input: ParrotExportInput): Rebuilt => {
  // Top atoms up to `mdat`, whose header closes the stored header.
  const data = view(header);
  let mdatAt = 0;
  while (mdatAt + 8 <= header.length && ascii(header, mdatAt + 4, 4) !== "mdat" && data.getUint32(mdatAt) >= 8) mdatAt += data.getUint32(mdatAt);
  const top = atomsIn(header, 0, mdatAt);
  if (!top || mdatAt + 8 > header.length) throw new Error("unreadable stored MP4 header");
  const children = (atom: { start: number; size: number }, skip: number) => atomsIn(header, atom.start + 8 + skip, atom.start + atom.size) ?? [];
  const whole = (atom: { start: number; size: number }) => header.subarray(atom.start, atom.start + atom.size);
  const items = ilstItems(input);
  const newMeta = () => box("meta", u32be(0), ITUNES_HDLR, box("ilst", ...items));
  const moov = top.find((atom) => atom.type === "moov");
  if (!moov) throw new Error("stored MP4 header without moov");
  const moovChildren = children(moov, 0);
  const udta = moovChildren.find((atom) => atom.type === "udta");
  const rebuiltUdta = (() => {
    if (!udta) return box("udta", newMeta());
    const udtaChildren = children(udta, 0);
    const meta = udtaChildren.find((atom) => atom.type === "meta");
    if (!meta) return box("udta", ...udtaChildren.map(whole), newMeta());
    const prefix = atomsIn(header, meta.start + 12, meta.start + meta.size) ? 4 : 0;
    const metaChildren = children(meta, prefix);
    const kept = metaChildren.filter((atom) => atom.type !== "ilst").map(whole);
    // The stored ilst keeps what a player needs (the gapless item, PAR-FMT-01): it stays, ahead of the tags.
    const storedIlst = metaChildren.find((atom) => atom.type === "ilst");
    const playerItems = storedIlst ? children(storedIlst, 0).map(whole) : [];
    const hasHandler = metaChildren.some((atom) => atom.type === "hdlr");
    const metaBox = box("meta", header.subarray(meta.start + 8, meta.start + 8 + prefix), ...(hasHandler ? [] : [ITUNES_HDLR]), ...kept, box("ilst", ...playerItems, ...items));
    return box("udta", ...udtaChildren.map((atom) => (atom === meta ? metaBox : whole(atom))));
  })();
  const newMoov = box("moov", ...moovChildren.filter((atom) => atom !== udta).map(whole), rebuiltUdta);
  const before = top.filter((atom) => atom !== moov).map(whole);
  const mdatHeader = header.subarray(mdatAt);
  const newLength = before.reduce((sum, part) => sum + part.length, 0) + newMoov.length + mdatHeader.length;
  const moved = moveChunkOffsets(newMoov, header.length, header.length + payloadBytes, newLength);
  if (moved) throw new Error(`stored MP4 header: ${moved}`);
  return { header: concat(...before, newMoov, mdatHeader), oggShift: 0 };
};

/** RIFF INFO ids the library's names replace. */
const INFO_NAMED: Record<string, true> = { INAM: true, IART: true, IPRD: true, ITRK: true, ICRD: true, IGNR: true };

const rebuildWav = (header: Uint8Array, input: ParrotExportInput): Rebuilt => {
  const data = view(header);
  if (ascii(header, 0, 4) !== "RIFF" || ascii(header, header.length - 8, 4) !== "data") throw new Error("unreadable stored WAV header");
  const riffChunk = (id: string, body: Uint8Array) => concat(latin1(id), u32le(body.length), body, new Uint8Array(body.length & 1));
  const own = groupsOf(input.tags, "riff-info").flatMap((group) => group.chunks.map(fromB64));
  const info = own.filter((chunk) => !INFO_NAMED[ascii(chunk, 0, 4)]).map((chunk) => concat(chunk, new Uint8Array(chunk.length & 1)));
  const add = (id: string, value: string | null) => {
    if (value) info.push(riffChunk(id, concat(utf8(value), new Uint8Array(1))));
  };
  add("INAM", text(input.names.title));
  add("IART", text(input.names.artist));
  add("IPRD", text(input.names.album));
  add("ITRK", text(positive(input.names.number)));
  add("ICRD", text(positive(input.names.year)));
  add("IGNR", text(input.names.genre));
  const list = info.length > 0 ? riffChunk("LIST", concat(latin1("INFO"), ...info)) : new Uint8Array(0);
  const id3 = riffChunk("id3 ", id3Tag(groupsOf(input.tags, "id3v2"), input.names, input.cover));
  const added = list.length + id3.length;
  const out = concat(header.subarray(0, header.length - 8), list, id3, header.subarray(header.length - 8));
  view(out).setUint32(4, data.getUint32(4, true) + added, true);
  return { header: out, oggShift: 0 };
};

// ---- The file ----

/** Ogg pages of the stored sound pieces, sequence numbers moved by `shift`, as whole pages. */
async function* renumbered(pieces: AsyncIterable<Uint8Array>, shift: number): AsyncIterable<Uint8Array> {
  let carry: Uint8Array = new Uint8Array(0);
  for await (const piece of pieces) {
    carry = carry.length > 0 ? concat(carry, piece) : piece;
    const out: Uint8Array[] = [];
    let at = 0;
    for (let page = readOggPage(carry, at); page; page = readOggPage(carry, at)) {
      out.push(renumberOggPage(carry, page, page.sequence + shift));
      at = page.end;
    }
    carry = carry.slice(at);
    if (out.length > 0) yield concat(...out);
  }
  if (carry.length > 0) throw new Error("stored Ogg sound ends inside a page");
}

/**
 * The song as a normal file of its stored format (OFFL-FILE-01), piece by piece: the rebuilt header, then the stored
 * sound pieces. A file stored whole is its stored pieces.
 */
export async function* rebuildParrotTrackFile(input: ParrotExportInput): AsyncIterable<Uint8Array> {
  const { file, signal } = input;
  const read = async (index: number) => {
    signal?.throwIfAborted();
    return input.readChunk(index);
  };
  if (file.headerBytes === null) {
    for (let index = 0; index < file.chunks.length; index += 1) yield await read(index);
    return;
  }
  const container = containerOf(file.mime);
  if (!container) throw new Error(`no export for ${file.mime}`);
  const first = file.headerBytes > 0 ? 1 : 0;
  const header = first ? await read(0) : new Uint8Array(0);
  if (header.length !== file.headerBytes) throw new Error(`stored header is ${header.length} bytes, the library says ${file.headerBytes}`);
  const payloadBytes = file.chunks.slice(first).reduce((sum, chunk) => sum + chunk.plainSize, 0);
  const rebuilt =
    container === "mp3" || container === "adts"
      ? rebuildFrames(input)
      : container === "flac"
        ? rebuildFlac(header, input)
        : container === "ogg"
          ? rebuildOgg(header, input)
          : container === "mp4"
            ? rebuildMp4(header, payloadBytes, input)
            : rebuildWav(header, input);
  yield rebuilt.header;
  async function* pieces() {
    for (let index = first; index < file.chunks.length; index += 1) yield await read(index);
  }
  if (rebuilt.oggShift === 0) yield* pieces();
  else yield* renumbered(pieces(), rebuilt.oggShift);
}
