// The light copy's file (PAR-FMT-02): Opus packets in an Ogg file as RFC 7845 lays it out, so every player trims
// the encoder's delay at the start (pre-skip) and the padding at the end (the last page's granule position): a light
// copy plays gapless like its original. Pure TypeScript: the desktop's encoder window writes it, tests read it back.

/** Opus always counts its granule positions at 48 kHz (RFC 7845 §4). */
export const OPUS_GRANULE_RATE = 48_000;

/** libopus's encoder delay at 48 kHz, used when the encoder does not report its own (RFC 7845 §4.2). */
export const OPUS_DEFAULT_PRE_SKIP = 312;

const encoder = new TextEncoder();

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let r = i << 24;
    for (let j = 0; j < 8; j += 1) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();

/** Ogg's page checksum (CRC-32, polynomial 0x04c11db7, no reflection, initial 0). */
export const oggCrc = (bytes: Uint8Array): number => {
  let crc = 0;
  for (const byte of bytes) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]!) >>> 0;
  return crc >>> 0;
};

/** The identification header (RFC 7845 §5.1). Channel mapping family 0: mono or stereo. */
export const opusHead = (input: { channels: number; preSkip: number; inputSampleRate: number }): Uint8Array => {
  const head = new Uint8Array(19);
  const view = new DataView(head.buffer);
  head.set(encoder.encode("OpusHead"), 0);
  head[8] = 1;
  head[9] = input.channels;
  view.setUint16(10, input.preSkip, true);
  view.setUint32(12, input.inputSampleRate, true);
  view.setInt16(16, 0, true);
  head[18] = 0;
  return head;
};

/** The pre-skip of an OpusHead (an encoder's `decoderConfig.description`), or null when the bytes are not one. */
export const readOpusHeadPreSkip = (bytes: Uint8Array | null | undefined): number | null => {
  if (!bytes || bytes.length < 19 || new TextDecoder().decode(bytes.subarray(0, 8)) !== "OpusHead") return null;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(10, true);
};

/** The comment header (RFC 7845 §5.2): `vendor`, then `KEY=value` comments. */
export const opusTags = (vendor: string, comments: string[]): Uint8Array => {
  const parts = [encoder.encode(vendor), ...comments.map((comment) => encoder.encode(comment))];
  const out = new Uint8Array(8 + 4 + 4 + parts.reduce((sum, part) => sum + 4 + part.length, 0) - 4);
  const view = new DataView(out.buffer);
  out.set(encoder.encode("OpusTags"), 0);
  let at = 8;
  const put = (part: Uint8Array) => {
    view.setUint32(at, part.length, true);
    out.set(part, at + 4);
    at += 4 + part.length;
  };
  put(parts[0]!);
  view.setUint32(at, comments.length, true);
  at += 4;
  for (const part of parts.slice(1)) put(part);
  return out;
};

/**
 * What the light copy keeps of its original's tags (PAR-FMT-02): names, numbers and lyrics. No picture: the album's
 * cover is stored once, as its 1200 px and 500 px copies.
 */
export type ParrotCopyTags = {
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  albumArtist?: string | null;
  number?: number | null;
  disc?: number | null;
  year?: number | null;
  genre?: string | null;
  lyrics?: { synced: string | null; plain: string | null } | null;
};

/** Vorbis comments for `tags` (the names Ogg players read); lyrics in LYRICS, timed (LRC) when the original had them so. */
export const parrotOpusComments = (tags: ParrotCopyTags): string[] => {
  const comments: string[] = [];
  const add = (key: string, value: string | number | null | undefined) => {
    if (value === null || value === undefined) return;
    const text = String(value).trim();
    if (text) comments.push(`${key}=${text}`);
  };
  add("TITLE", tags.title);
  add("ARTIST", tags.artist);
  add("ALBUM", tags.album);
  add("ALBUMARTIST", tags.albumArtist);
  if (tags.number && tags.number > 0) add("TRACKNUMBER", tags.number);
  if (tags.disc && tags.disc > 0) add("DISCNUMBER", tags.disc);
  add("DATE", tags.year);
  add("GENRE", tags.genre);
  add("LYRICS", tags.lyrics?.synced ?? tags.lyrics?.plain);
  return comments;
};

const FLAG_CONTINUED = 0x01;
const FLAG_BOS = 0x02;
const FLAG_EOS = 0x04;
/** Pages close at this many payload bytes (or 255 lacing values), as libogg does. */
const PAGE_TARGET_BYTES = 4096;

type PendingPacket = { bytes: Uint8Array; granuleAfter: bigint };

/**
 * Writes one Ogg Opus stream. `packets` are the encoder's packets in order with the 48 kHz samples each one decodes to
 * (pre-skip included); `samples` is the length of the real audio at 48 kHz. The last page's granule position is
 * `preSkip + samples`, which trims the encoder's padding (RFC 7845 §4.4), so the encoder must have been fed at least
 * `preSkip` samples of silence past the audio.
 */
export const writeOggOpus = (input: {
  head: Uint8Array;
  tags: Uint8Array;
  packets: ReadonlyArray<{ bytes: Uint8Array; samples: number }>;
  preSkip: number;
  samples: number;
  serial?: number;
}): Uint8Array => {
  const serial = (input.serial ?? 0x5041_5252) >>> 0; // "PARR"
  const pages: Uint8Array[] = [];
  let sequence = 0;

  const page = (segments: number[], body: Uint8Array[], granule: bigint, flags: number) => {
    const size = body.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(27 + segments.length + size);
    const view = new DataView(out.buffer);
    out.set(encoder.encode("OggS"), 0);
    out[4] = 0;
    out[5] = flags;
    view.setBigInt64(6, granule, true);
    view.setUint32(14, serial, true);
    view.setUint32(18, sequence, true);
    sequence += 1;
    out[26] = segments.length;
    out.set(segments, 27);
    let at = 27 + segments.length;
    for (const part of body) {
      out.set(part, at);
      at += part.length;
    }
    view.setUint32(22, oggCrc(out), true);
    pages.push(out);
  };

  /** Lays `packets` out on pages that start fresh; `last` marks the stream's final page. */
  const emit = (packets: PendingPacket[], last: boolean, firstFlags = 0) => {
    let segments: number[] = [];
    let body: Uint8Array[] = [];
    let bodySize = 0;
    let granule = -1n;
    let continued = false;
    let flags = firstFlags;
    const flush = (final: boolean) => {
      page(segments, body, granule, flags | (continued ? FLAG_CONTINUED : 0) | (final && last ? FLAG_EOS : 0));
      flags = 0;
      segments = [];
      body = [];
      bodySize = 0;
      granule = -1n;
    };
    for (const [index, packet] of packets.entries()) {
      let offset = 0;
      // Lacing: 255-byte segments, then one shorter (possibly 0) segment that ends the packet.
      for (;;) {
        const left = packet.bytes.length - offset;
        const take = Math.min(255, left);
        segments.push(take);
        body.push(packet.bytes.subarray(offset, offset + take));
        bodySize += take;
        offset += take;
        const ended = take < 255;
        if (ended) granule = packet.granuleAfter;
        if (segments.length === 255 || (ended && bodySize >= PAGE_TARGET_BYTES)) {
          const final = ended && index === packets.length - 1;
          flush(final);
          // The next page continues this packet when it did not end on the one just written.
          continued = !ended;
          if (final) return;
        }
        if (ended) break;
      }
    }
    if (segments.length) flush(true);
  };

  emit([{ bytes: input.head, granuleAfter: 0n }], false, FLAG_BOS);
  emit([{ bytes: input.tags, granuleAfter: 0n }], false);
  const end = BigInt(input.preSkip + input.samples);
  let decoded = 0n;
  const audio: PendingPacket[] = input.packets.map((packet) => {
    decoded += BigInt(packet.samples);
    return { bytes: packet.bytes, granuleAfter: decoded < end ? decoded : end };
  });
  if (decoded < end) throw new Error(`OGG_OPUS_SHORT: ${decoded} samples encoded, ${end} needed`);
  emit(audio, true);
  const out = new Uint8Array(pages.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of pages) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

/** One page of an Ogg stream as `readOggPages` finds it. */
export type OggPage = { flags: number; granule: bigint; serial: number; sequence: number; crcOk: boolean; segments: number[]; body: Uint8Array };

/** Splits an Ogg stream into its pages, checking each page's checksum (tests and diagnostics). */
export const readOggPages = (bytes: Uint8Array): OggPage[] => {
  const pages: OggPage[] = [];
  let at = 0;
  while (at + 27 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + at);
    if (new TextDecoder().decode(bytes.subarray(at, at + 4)) !== "OggS") throw new Error(`OGG_BAD_PAGE at ${at}`);
    const count = bytes[at + 26]!;
    const segments = [...bytes.subarray(at + 27, at + 27 + count)];
    const size = segments.reduce((sum, value) => sum + value, 0);
    const end = at + 27 + count + size;
    const copy = bytes.slice(at, end);
    new DataView(copy.buffer).setUint32(22, 0, true);
    pages.push({
      flags: bytes[at + 5]!,
      granule: view.getBigInt64(6, true),
      serial: view.getUint32(14, true),
      sequence: view.getUint32(18, true),
      crcOk: oggCrc(copy) === view.getUint32(22, true),
      segments,
      body: bytes.subarray(at + 27 + count, end),
    });
    at = end;
  }
  return pages;
};

/** The packets of an Ogg stream (one logical stream), joined across pages. */
export const readOggPackets = (pages: OggPage[]): Uint8Array[] => {
  const packets: Uint8Array[] = [];
  let parts: Uint8Array[] = [];
  for (const page of pages) {
    let offset = 0;
    for (const segment of page.segments) {
      parts.push(page.body.subarray(offset, offset + segment));
      offset += segment;
      if (segment < 255) {
        const size = parts.reduce((sum, part) => sum + part.length, 0);
        const packet = new Uint8Array(size);
        let at = 0;
        for (const part of parts) {
          packet.set(part, at);
          at += part.length;
        }
        packets.push(packet);
        parts = [];
      }
    }
  }
  return packets;
};
