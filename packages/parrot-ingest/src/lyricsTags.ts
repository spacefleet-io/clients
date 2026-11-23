/**
 * Puts lyrics into a music file's own tags (PAR-LYR-01, PAR-META-04): a file that carries no lyrics gets ours, a file
 * that has any is never changed. Only the tag area is rewritten; the sound bytes are copied as they are (PAR-FMT-01).
 *
 * - MP3 and ADTS `.aac`: an ID3v2 `USLT` frame (a v2.4 tag is added in front when the file has none).
 * - FLAC: a `LYRICS=` Vorbis comment (a comment block is added after STREAMINFO when the file has none).
 * - MP4 (`.m4a`, AAC and ALAC alike): a `©lyr` item in `moov/udta/meta/ilst`; chunk offsets are moved when the
 *   metadata sits before the sound.
 * - Ogg Vorbis and Opus: a `LYRICS=` comment in the comment header; the header pages are laid out again and every
 *   later page of the stream renumbered, its checksum recomputed.
 * - WAV: an ID3v2 `USLT` frame in the file's `id3 ` chunk (added at the end when the file has none).
 *
 * Synced lyrics go in as LRC text in that same field, the form players and Parrot's own reader take as timed lines.
 * Unusual layouts (an unsynchronised ID3 tag, a fragmented MP4, interleaved Ogg headers…) are answered `unsupported`
 * and left as they are.
 */

export type ParrotLyricsWrite =
  | { kind: "written"; bytes: Uint8Array }
  /** The file already carries lyrics of its own: it is never changed. */
  | { kind: "has-lyrics" }
  | { kind: "unsupported"; reason: string };

const ascii = (bytes: Uint8Array, at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length));
const utf8 = (text: string) => new TextEncoder().encode(text);
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
const u32be = (value: number) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
};
const u32le = (value: number) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
};
const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

// ---- MP3: ID3v2 ----

const syncsafe = (bytes: Uint8Array, at: number) => ((bytes[at] & 0x7f) << 21) | ((bytes[at + 1] & 0x7f) << 14) | ((bytes[at + 2] & 0x7f) << 7) | (bytes[at + 3] & 0x7f);
const toSyncsafe = (value: number) => new Uint8Array([(value >> 21) & 0x7f, (value >> 14) & 0x7f, (value >> 7) & 0x7f, value & 0x7f]);

const usltFrame = (major: 3 | 4, text: string) => {
  // v2.4: UTF-8; v2.3 has no UTF-8, so UTF-16 with a byte order mark. Language "XXX" = unknown (ID3v2 spec).
  const body =
    major === 4
      ? concat(new Uint8Array([3]), utf8("XXX"), new Uint8Array([0]), utf8(text))
      : concat(new Uint8Array([1]), utf8("XXX"), new Uint8Array([0xff, 0xfe, 0, 0, 0xff, 0xfe]), new Uint8Array(Buffer.from(text, "utf16le")));
  return concat(utf8("USLT"), major === 4 ? toSyncsafe(body.length) : u32be(body.length), new Uint8Array([0, 0]), body);
};

const writeMp3 = (bytes: Uint8Array, text: string): ParrotLyricsWrite => {
  if (bytes.length < 10 || ascii(bytes, 0, 3) !== "ID3") {
    const frame = usltFrame(4, text);
    return { kind: "written", bytes: concat(utf8("ID3"), new Uint8Array([4, 0, 0]), toSyncsafe(frame.length), frame, bytes) };
  }
  const major = bytes[3];
  const flags = bytes[5];
  if (major !== 3 && major !== 4) return { kind: "unsupported", reason: `ID3v2.${major} tag` };
  // Unsynchronised tags and tags with a footer are rare and easy to damage: left as they are.
  if (flags & 0x80 || flags & 0x10) return { kind: "unsupported", reason: "ID3v2 tag with unsynchronisation or a footer" };
  const tagEnd = 10 + syncsafe(bytes, 6);
  if (tagEnd > bytes.length) return { kind: "unsupported", reason: "ID3v2 tag longer than the file" };
  let at = 10;
  if (flags & 0x40) at += major === 4 ? syncsafe(bytes, 10) : 4 + view(bytes).getUint32(10);
  while (at + 10 <= tagEnd && bytes[at] !== 0) {
    const id = ascii(bytes, at, 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) return { kind: "unsupported", reason: `unreadable ID3v2 frame at ${at}` };
    if (id === "USLT" || id === "SYLT") return { kind: "has-lyrics" };
    const size = major === 4 ? syncsafe(bytes, at + 4) : view(bytes).getUint32(at + 4);
    at += 10 + size;
  }
  if (at > tagEnd) return { kind: "unsupported", reason: "ID3v2 frame past the end of the tag" };
  // The frames as they are, then ours; the old padding goes.
  const frames = concat(bytes.subarray(10, at), usltFrame(major, text));
  const header = concat(bytes.subarray(0, 6), toSyncsafe(frames.length));
  return { kind: "written", bytes: concat(header, frames, bytes.subarray(tagEnd)) };
};

// ---- FLAC: Vorbis comments ----

const LYRICS_COMMENT_KEYS: Record<string, true> = { LYRICS: true, UNSYNCEDLYRICS: true, SYNCEDLYRICS: true, "UNSYNCED LYRICS": true };

/** The comments of a Vorbis comment body (vendor, then `KEY=value` lines); null when it cannot be read. */
const readVorbisComments = (body: Uint8Array): { vendor: Uint8Array; comments: Uint8Array[] } | null => {
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
  return { vendor: body.subarray(4, 4 + vendorLength), comments };
};

const hasLyricsComment = (comments: Uint8Array[]) =>
  comments.some((comment) => {
    const text = new TextDecoder().decode(comment);
    const eq = text.indexOf("=");
    return eq > 0 && LYRICS_COMMENT_KEYS[text.slice(0, eq).toUpperCase()] === true && text.slice(eq + 1).trim() !== "";
  });

const vorbisCommentBody = (vendor: Uint8Array, comments: Uint8Array[]) =>
  concat(u32le(vendor.length), vendor, u32le(comments.length), ...comments.flatMap((comment) => [u32le(comment.length), comment]));

const writeFlac = (bytes: Uint8Array, text: string): ParrotLyricsWrite => {
  if (ascii(bytes, 0, 4) !== "fLaC") return { kind: "unsupported", reason: "no FLAC marker" };
  const blocks: Array<{ type: number; body: Uint8Array }> = [];
  let at = 4;
  for (;;) {
    if (at + 4 > bytes.length) return { kind: "unsupported", reason: "FLAC metadata past the end of the file" };
    const last = (bytes[at] & 0x80) !== 0;
    const type = bytes[at] & 0x7f;
    const length = (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3];
    if (at + 4 + length > bytes.length) return { kind: "unsupported", reason: "FLAC metadata block past the end of the file" };
    blocks.push({ type, body: bytes.subarray(at + 4, at + 4 + length) });
    at += 4 + length;
    if (last) break;
  }
  const lyrics = utf8(`LYRICS=${text}`);
  const index = blocks.findIndex((block) => block.type === 4);
  if (index >= 0) {
    const read = readVorbisComments(blocks[index].body);
    if (!read) return { kind: "unsupported", reason: "unreadable Vorbis comments" };
    if (hasLyricsComment(read.comments)) return { kind: "has-lyrics" };
    blocks[index] = { type: 4, body: vorbisCommentBody(read.vendor, [...read.comments, lyrics]) };
  } else {
    blocks.splice(1, 0, { type: 4, body: vorbisCommentBody(utf8("Parrot"), [lyrics]) });
  }
  if (blocks.some((block) => block.body.length > 0xffffff)) return { kind: "unsupported", reason: "FLAC metadata block too large" };
  const headers = blocks.map((block, i) =>
    concat(
      new Uint8Array([(i === blocks.length - 1 ? 0x80 : 0) | block.type, (block.body.length >> 16) & 0xff, (block.body.length >> 8) & 0xff, block.body.length & 0xff]),
      block.body
    )
  );
  return { kind: "written", bytes: concat(utf8("fLaC"), ...headers, bytes.subarray(at)) };
};

// ---- MP4: moov/udta/meta/ilst/©lyr ----

type Atom = { type: string; start: number; size: number; header: number };

/** The atoms in `bytes[from, to)`; null when one is unreadable or uses a 64-bit / to-the-end size. */
const atomsIn = (bytes: Uint8Array, from: number, to: number): Atom[] | null => {
  const atoms: Atom[] = [];
  let at = from;
  while (at + 8 <= to) {
    const size = view(bytes).getUint32(at);
    if (size < 8 || at + size > to) return null;
    atoms.push({ type: ascii(bytes, at + 4, 4), start: at, size, header: 8 });
    at += size;
  }
  return at === to ? atoms : null;
};

const box = (type: string, ...children: Uint8Array[]) => {
  const body = concat(...children);
  return concat(u32be(8 + body.length), new Uint8Array([...type].map((c) => c.charCodeAt(0) & 0xff)), body);
};
const LYR = "\u00a9lyr";
const lyrAtom = (text: string) => box(LYR, box("data", u32be(1), u32be(0), utf8(text)));
const mdirHandler = () => box("hdlr", new Uint8Array(8), utf8("mdirappl"), new Uint8Array(9));

/** `children` of a container with `insert` added at its end, the container's size grown to match. */
const grown = (bytes: Uint8Array, atom: Atom, insertAt: number, insert: Uint8Array) => {
  const out = concat(bytes.subarray(atom.start, insertAt), insert, bytes.subarray(insertAt, atom.start + atom.size));
  out.set(u32be(atom.size + insert.length), 0);
  return out;
};

/** Moves every `stco`/`co64` chunk offset in `moov` by `delta` (the sound moved by that many bytes). */
const shiftChunkOffsets = (moov: Uint8Array, delta: number): boolean => {
  const walk = (from: number, to: number): boolean => {
    const atoms = atomsIn(moov, from, to);
    if (!atoms) return false;
    for (const atom of atoms) {
      const bodyStart = atom.start + atom.header;
      const end = atom.start + atom.size;
      if (["trak", "mdia", "minf", "stbl"].includes(atom.type)) {
        if (!walk(bodyStart, end)) return false;
      } else if (atom.type === "stco" || atom.type === "co64") {
        const data = view(moov);
        const count = data.getUint32(bodyStart + 4);
        const width = atom.type === "stco" ? 4 : 8;
        if (bodyStart + 8 + count * width > end) return false;
        for (let i = 0; i < count; i += 1) {
          const at = bodyStart + 8 + i * width;
          if (width === 4) {
            const moved = data.getUint32(at) + delta;
            if (moved > 0xffffffff) return false;
            data.setUint32(at, moved);
          } else data.setBigUint64(at, data.getBigUint64(at) + BigInt(delta));
        }
      }
    }
    return true;
  };
  return walk(8, moov.length);
};

const writeMp4 = (bytes: Uint8Array, text: string): ParrotLyricsWrite => {
  const top = atomsIn(bytes, 0, bytes.length);
  if (!top) return { kind: "unsupported", reason: "unreadable MP4 atoms" };
  if (top.some((atom) => atom.type === "moof")) return { kind: "unsupported", reason: "fragmented MP4" };
  const moov = top.find((atom) => atom.type === "moov");
  const mdat = top.find((atom) => atom.type === "mdat");
  if (!moov || !mdat) return { kind: "unsupported", reason: "MP4 without moov or mdat" };
  const find = (type: string, from: number, to: number) => {
    const atoms = atomsIn(bytes, from, to);
    return atoms === null ? undefined : (atoms.find((atom) => atom.type === type) ?? null);
  };
  const moovBody = moov.start + 8;
  const moovEnd = moov.start + moov.size;
  const udta = find("udta", moovBody, moovEnd);
  if (udta === undefined) return { kind: "unsupported", reason: "unreadable moov" };
  // The path that exists, and what has to be added under its deepest atom.
  let newMoov: Uint8Array;
  if (!udta) {
    const added = box("udta", box("meta", new Uint8Array(4), mdirHandler(), box("ilst", lyrAtom(text))));
    newMoov = grown(bytes, moov, moovEnd, added);
  } else {
    const udtaEnd = udta.start + udta.size;
    const meta = find("meta", udta.start + 8, udtaEnd);
    if (meta === undefined) return { kind: "unsupported", reason: "unreadable udta" };
    if (!meta) {
      const added = box("meta", new Uint8Array(4), mdirHandler(), box("ilst", lyrAtom(text)));
      const newUdta = grown(bytes, udta, udtaEnd, added);
      newMoov = concat(bytes.subarray(moov.start, udta.start), newUdta, bytes.subarray(udtaEnd, moovEnd));
    } else {
      const metaEnd = meta.start + meta.size;
      // `meta` is a full box: 4 bytes of version and flags before its children.
      const ilst = find("ilst", meta.start + 12, metaEnd);
      if (ilst === undefined) return { kind: "unsupported", reason: "unreadable meta" };
      let newMeta: Uint8Array;
      if (!ilst) {
        newMeta = grown(bytes, meta, metaEnd, box("ilst", lyrAtom(text)));
      } else {
        const ilstEnd = ilst.start + ilst.size;
        const items = atomsIn(bytes, ilst.start + 8, ilstEnd);
        if (!items) return { kind: "unsupported", reason: "unreadable ilst" };
        if (items.some((item) => item.type === LYR)) return { kind: "has-lyrics" };
        const newIlst = grown(bytes, ilst, ilstEnd, lyrAtom(text));
        newMeta = concat(bytes.subarray(meta.start, ilst.start), newIlst, bytes.subarray(ilstEnd, metaEnd));
        newMeta.set(u32be(newMeta.length), 0);
      }
      const newUdta = concat(bytes.subarray(udta.start, meta.start), newMeta, bytes.subarray(metaEnd, udtaEnd));
      newUdta.set(u32be(newUdta.length), 0);
      newMoov = concat(bytes.subarray(moov.start, udta.start), newUdta, bytes.subarray(udtaEnd, moovEnd));
    }
    newMoov.set(u32be(newMoov.length), 0);
  }
  const delta = newMoov.length - moov.size;
  // The sound comes after the metadata: every chunk offset moves with it.
  if (moov.start < mdat.start && !shiftChunkOffsets(newMoov, delta)) return { kind: "unsupported", reason: "chunk offsets could not be moved" };
  return { kind: "written", bytes: concat(bytes.subarray(0, moov.start), newMoov, bytes.subarray(moovEnd)) };
};

// ---- Ogg (Vorbis, Opus): the comment header ----

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
const oggCrc = (page: Uint8Array) => {
  let crc = 0;
  for (let i = 0; i < page.length; i += 1) crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) ^ (i >= 22 && i < 26 ? 0 : page[i])) & 0xff]) >>> 0;
  return crc;
};

type OggPage = { start: number; end: number; flags: number; serial: number; segments: Uint8Array; body: Uint8Array };

const readOggPage = (bytes: Uint8Array, at: number): OggPage | null => {
  if (at + 27 > bytes.length || ascii(bytes, at, 4) !== "OggS" || bytes[at + 4] !== 0) return null;
  const count = bytes[at + 26];
  if (at + 27 + count > bytes.length) return null;
  const segments = bytes.subarray(at + 27, at + 27 + count);
  const bodyLength = segments.reduce((sum, value) => sum + value, 0);
  const bodyStart = at + 27 + count;
  if (bodyStart + bodyLength > bytes.length) return null;
  return { start: at, end: bodyStart + bodyLength, flags: bytes[at + 5], serial: view(bytes).getUint32(at + 14, true), segments, body: bytes.subarray(bodyStart, bodyStart + bodyLength) };
};

/** A page with granule 0 (header pages carry no sound), its sequence number and CRC filled in. */
const oggPage = (template: Uint8Array, flags: number, sequence: number, segments: number[], body: Uint8Array) => {
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

/** Header packets laid out in pages of at most 255 lacing values, each packet ending where Ogg says it ends. */
const paginate = (template: Uint8Array, firstSequence: number, packets: Uint8Array[]) => {
  const pages: Uint8Array[] = [];
  let segments: number[] = [];
  let parts: Uint8Array[] = [];
  let continued = false;
  let nextContinued = false;
  const flush = () => {
    pages.push(oggPage(template, continued ? 1 : 0, firstSequence + pages.length, segments, concat(...parts)));
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
    // The last header packet closes its page: the sound starts on a fresh one (Vorbis I and RFC 7845 both ask it).
    if (index === packets.length - 1 && segments.length > 0) flush();
  }
  return pages;
};

const writeOgg = (bytes: Uint8Array, text: string): ParrotLyricsWrite => {
  const first = readOggPage(bytes, 0);
  if (!first || !(first.flags & 2)) return { kind: "unsupported", reason: "no Ogg first page" };
  const opus = ascii(first.body, 0, 8) === "OpusHead";
  if (!opus && ascii(first.body, 0, 7) !== "\u0001vorbis") return { kind: "unsupported", reason: "Ogg stream neither Vorbis nor Opus" };
  // The first page holds the identification header alone; then come the comment header (and Vorbis's setup header).
  if (first.segments.length !== 1 || first.segments[0] === 255) return { kind: "unsupported", reason: "unusual Ogg first page" };
  const headerCount = opus ? 2 : 3;
  const packets: Uint8Array[] = [];
  let pending: Uint8Array[] = [];
  let at = first.end;
  let sequence = 1;
  while (packets.length < headerCount - 1) {
    const page = readOggPage(bytes, at);
    if (!page || page.serial !== first.serial) return { kind: "unsupported", reason: "Ogg headers unreadable or interleaved" };
    if (view(bytes).getUint32(page.start + 18, true) !== sequence) return { kind: "unsupported", reason: "Ogg page out of sequence" };
    let offset = 0;
    for (const [index, size] of page.segments.entries()) {
      pending.push(page.body.subarray(offset, offset + size));
      offset += size;
      if (size < 255) {
        packets.push(concat(...pending));
        pending = [];
        // The headers must end on a page boundary, with no sound packet sharing their last page.
        if (packets.length === headerCount - 1 && index !== page.segments.length - 1) return { kind: "unsupported", reason: "sound shares the last Ogg header page" };
      }
    }
    at = page.end;
    sequence += 1;
  }
  const magic = opus ? 8 : 7;
  const comment = packets[0];
  if (ascii(comment, 0, magic) !== (opus ? "OpusTags" : "\u0003vorbis")) return { kind: "unsupported", reason: "no Ogg comment header" };
  const read = readVorbisComments(comment.subarray(magic));
  if (!read) return { kind: "unsupported", reason: "unreadable Vorbis comments" };
  if (hasLyricsComment(read.comments)) return { kind: "has-lyrics" };
  const oldBody = vorbisCommentBody(read.vendor, read.comments);
  // What follows the comments stays: Vorbis's framing bit, Opus's optional binary data.
  const tail = comment.subarray(magic + oldBody.length);
  const newComment = concat(comment.subarray(0, magic), vorbisCommentBody(read.vendor, [...read.comments, utf8(`LYRICS=${text}`)]), tail);
  const headerPages = paginate(bytes.subarray(first.start, first.end), 1, [newComment, ...packets.slice(1)]);
  // Every later page moves by the change in header page count: its sequence number and CRC follow.
  const shift = 1 + headerPages.length - sequence;
  const rest: Uint8Array[] = [];
  for (let pageAt = at; pageAt < bytes.length; ) {
    const page = readOggPage(bytes, pageAt);
    if (!page) return { kind: "unsupported", reason: `unreadable Ogg page at ${pageAt}` };
    const copy = bytes.slice(page.start, page.end);
    if (page.serial === first.serial && shift !== 0) {
      const data = view(copy);
      data.setUint32(18, data.getUint32(18, true) + shift, true);
      data.setUint32(22, 0, true);
      data.setUint32(22, oggCrc(copy), true);
    }
    rest.push(copy);
    pageAt = page.end;
  }
  return { kind: "written", bytes: concat(bytes.subarray(first.start, first.end), ...headerPages, ...rest) };
};

// ---- WAV: an `id3 ` chunk ----

const writeWav = (bytes: Uint8Array, text: string): ParrotLyricsWrite => {
  if (bytes.length < 12 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") return { kind: "unsupported", reason: "no RIFF WAVE header" };
  const chunks: Array<{ id: string; start: number; end: number }> = [];
  let at = 12;
  while (at + 8 <= bytes.length) {
    const size = view(bytes).getUint32(at + 4, true);
    const end = at + 8 + size + (size % 2);
    if (at + 8 + size > bytes.length) return { kind: "unsupported", reason: "WAV chunk past the end of the file" };
    chunks.push({ id: ascii(bytes, at, 4), start: at, end: Math.min(end, bytes.length) });
    at = end;
  }
  if (!chunks.some((chunk) => chunk.id === "data")) return { kind: "unsupported", reason: "WAV without data" };
  const tags = chunks.filter((chunk) => chunk.id.toLowerCase() === "id3 ");
  if (tags.length > 1) return { kind: "unsupported", reason: "WAV with several ID3 chunks" };
  const old = tags[0];
  const oldTag = old ? bytes.subarray(old.start + 8, old.start + 8 + view(bytes).getUint32(old.start + 4, true)) : new Uint8Array();
  if (old && ascii(oldTag, 0, 3) !== "ID3") return { kind: "unsupported", reason: "WAV ID3 chunk without an ID3v2 tag" };
  // The chunk holds a plain ID3v2 tag: the MP3 writer adds the frame, or answers that lyrics are there already.
  const written = writeMp3(oldTag, text);
  if (written.kind !== "written") return written;
  const tag = written.bytes;
  const chunk = concat(utf8(old ? ascii(bytes, old.start, 4) : "id3 "), u32le(tag.length), tag, new Uint8Array(tag.length % 2));
  const body = old ? concat(bytes.subarray(12, old.start), chunk, bytes.subarray(old.end)) : concat(bytes.subarray(12, chunks[chunks.length - 1].end), chunk);
  if (body.length + 4 > 0xffffffff) return { kind: "unsupported", reason: "WAV too large" };
  return { kind: "written", bytes: concat(utf8("RIFF"), u32le(body.length + 4), utf8("WAVE"), body) };
};

/** The containers whose tags Parrot writes lyrics into: every one it imports (PAR-UP-01). */
export const PARROT_LYRICS_TAG_CONTAINERS = ["mp3", "flac", "mp4", "adts", "ogg", "wav"] as const;

/**
 * `bytes` with `lyrics` (LRC text when synced, else plain) added to the file's own tags, by `container` as the library
 * stores it (`PARROT_LYRICS_TAG_CONTAINERS`); `has-lyrics` when the file already carries some. An ADTS `.aac` takes
 * an ID3v2 tag in front, as an MP3 does.
 */
export const writeParrotLyricsTag = (bytes: Uint8Array, container: string, lyrics: string): ParrotLyricsWrite => {
  if (lyrics.trim() === "") return { kind: "unsupported", reason: "no lyrics to write" };
  if (container === "mp3" || container === "adts") return writeMp3(bytes, lyrics);
  if (container === "flac") return writeFlac(bytes, lyrics);
  if (container === "mp4") return writeMp4(bytes, lyrics);
  if (container === "ogg") return writeOgg(bytes, lyrics);
  if (container === "wav") return writeWav(bytes, lyrics);
  return { kind: "unsupported", reason: `${container} files are left as they are` };
};
