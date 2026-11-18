// PAR-FMT-02: reads an original's coded frames one after another, a few MiB of the file at a time, so a song of any
// length can be decoded and re-encoded with memory that does not grow with it. Each format Parrot imports (PAR-UP-01)
// gets its frames cut out here; the decoding is the app's (WebCodecs' AudioDecoder on the desktop, ParrotAlac's
// decoder for Apple Lossless, none for WAV's plain samples).
import { indexAacMoov, indexAlacMoov, readMp4Moov, type AlacConfig, type AlacByteReader } from "./alac";

/** One coded frame (or a block of WAV samples) and how many samples it decodes to (0 when the format does not say). */
export type ParrotAudioPacket = { bytes: Uint8Array; frames: number };

/** How the frames decode, and which decoded samples the song keeps (encoder delay and padding cut). */
export type ParrotAudioTrack = (
  | { kind: "webcodecs"; codec: string; description: Uint8Array | null }
  | { kind: "pcm"; float: boolean; bits: number }
  | { kind: "alac"; config: AlacConfig }
) & {
  sampleRate: number;
  channels: number;
  /** Decoded samples (at `sampleRate`) before the song starts. */
  skipFrames: number;
  /** Samples the song lasts once `skipFrames` are cut, when the file says. */
  totalFrames: number | null;
};

export type ParrotAudioStream = { track: ParrotAudioTrack; packets: AsyncGenerator<ParrotAudioPacket> };

/** Bytes read from the original at a time (by default). */
export const PARROT_AUDIO_READ_BLOCK = 4 * 1024 * 1024;
/** WAV sample frames per packet. */
const PCM_PACKET_FRAMES = 48_000;

/** A forward reader over the original that holds at most a block or two of it. */
class ByteCursor {
  private buffer = new Uint8Array(0);
  /** File offset of `buffer[0]`. */
  private at: number;

  constructor(
    private readonly read: AlacByteReader,
    readonly size: number,
    readonly block: number
  ) {
    this.at = 0;
  }

  get position(): number {
    return this.at;
  }

  get buffered(): Uint8Array {
    return this.buffer;
  }

  /** Buffers at least `count` bytes from the position (fewer at the end of the file); returns how many are there. */
  async fill(count: number): Promise<number> {
    while (this.buffer.length < count && this.at + this.buffer.length < this.size) {
      const from = this.at + this.buffer.length;
      const more = await this.read(from, Math.min(this.size, from + Math.max(this.block, count - this.buffer.length)) - 1);
      if (!more.length) break;
      const joined = new Uint8Array(this.buffer.length + more.length);
      joined.set(this.buffer);
      joined.set(more, this.buffer.length);
      this.buffer = joined;
    }
    return this.buffer.length;
  }

  /** Moves the position forward by `count` bytes. */
  skip(count: number): void {
    if (count <= this.buffer.length) this.buffer = this.buffer.subarray(count);
    else this.buffer = new Uint8Array(0);
    this.at += count;
  }

  /** The next `count` bytes as their own copy; the position moves past them. */
  async take(count: number): Promise<Uint8Array> {
    if ((await this.fill(count)) < count) throw new Error("audio: the file ends early");
    const bytes = this.buffer.slice(0, count);
    this.skip(count);
    return bytes;
  }

  seek(offset: number): void {
    if (offset >= this.at && offset <= this.at + this.buffer.length) this.skip(offset - this.at);
    else {
      this.buffer = new Uint8Array(0);
      this.at = offset;
    }
  }
}

const ascii = (b: Uint8Array, at: number, length: number) => String.fromCharCode(...b.subarray(at, at + length));
const u32be = (b: Uint8Array, at: number) => ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
const u32le = (b: Uint8Array, at: number) => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;
const u16le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8);

/** Skips an ID3v2 tag at the position, if there is one (MP3 and ADTS files often start with one). */
const skipId3 = async (cursor: ByteCursor): Promise<void> => {
  if ((await cursor.fill(10)) < 10) return;
  const b = cursor.buffered;
  if (ascii(b, 0, 3) !== "ID3") return;
  const size = ((b[6]! & 0x7f) << 21) | ((b[7]! & 0x7f) << 14) | ((b[8]! & 0x7f) << 7) | (b[9]! & 0x7f);
  cursor.skip(10 + size + (b[5]! & 0x10 ? 10 : 0));
};

// ── MP3 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

type Mp3Header = { version: number; sampleRate: number; channels: number; frameBytes: number; frames: number; sideInfo: number };

const MP3_BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const MP3_RATES = [44_100, 48_000, 32_000];
/** Samples the MP3 decoder outputs before the first encoded one (LAME's "decoder delay"). */
const MP3_DECODER_DELAY = 529;

/** An MPEG audio layer III frame header at `at`, or null. */
export const readMp3Header = (b: Uint8Array, at: number): Mp3Header | null => {
  if (b[at] !== 0xff || (b[at + 1]! & 0xe0) !== 0xe0) return null;
  const versionBits = (b[at + 1]! >> 3) & 3;
  const layerBits = (b[at + 1]! >> 1) & 3;
  const bitrateIndex = b[at + 2]! >> 4;
  const rateIndex = (b[at + 2]! >> 2) & 3;
  if (versionBits === 1 || layerBits !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const mpeg1 = versionBits === 3;
  const sampleRate = MP3_RATES[rateIndex]! / (mpeg1 ? 1 : versionBits === 2 ? 2 : 4);
  const kbps = (mpeg1 ? MP3_BITRATES_V1 : MP3_BITRATES_V2)[bitrateIndex]!;
  const frames = mpeg1 ? 1152 : 576;
  const channels = b[at + 3]! >> 6 === 3 ? 1 : 2;
  const frameBytes = Math.floor((frames / 8) * kbps * 1000 / sampleRate) + ((b[at + 2]! >> 1) & 1);
  const sideInfo = mpeg1 ? (channels === 1 ? 17 : 32) : channels === 1 ? 9 : 17;
  return { version: versionBits, sampleRate, channels, frameBytes, frames, sideInfo };
};

/** The Xing/Info frame's frame count and LAME delay and padding, or null when the frame is audio. */
const readXing = (frame: Uint8Array, header: Mp3Header): { frames: number | null; delay: number; padding: number } | null => {
  const at = 4 + header.sideInfo;
  const tag = ascii(frame, at, 4);
  if (tag !== "Xing" && tag !== "Info") return null;
  const flags = u32be(frame, at + 4);
  let p = at + 8;
  let frames: number | null = null;
  if (flags & 1) {
    frames = u32be(frame, p);
    p += 4;
  }
  if (flags & 2) p += 4;
  if (flags & 4) p += 100;
  if (flags & 8) p += 4;
  // LAME (and FFmpeg's "Lavc") tag: 12 bits of encoder delay and 12 of padding, 21 bytes in.
  if (p + 24 > frame.length || !/^(LAME|Lavc|Lavf|GOGO)/.test(ascii(frame, p, 4))) return { frames, delay: 0, padding: 0 };
  const delay = (frame[p + 21]! << 4) | (frame[p + 22]! >> 4);
  const padding = ((frame[p + 22]! & 0x0f) << 8) | frame[p + 23]!;
  return { frames, delay, padding };
};

const openMp3 = async (cursor: ByteCursor): Promise<ParrotAudioStream> => {
  await skipId3(cursor);
  // The first header followed by a second one where its length says: a real frame, not stray bytes.
  let first!: Mp3Header;
  for (;;) {
    if ((await cursor.fill(4)) < 4) throw new Error("audio: no MP3 frame");
    const header = readMp3Header(cursor.buffered, 0);
    if (header) {
      const need = header.frameBytes + 4;
      const atEnd = (await cursor.fill(need)) < need;
      if (atEnd ? cursor.position + header.frameBytes >= cursor.size : readMp3Header(cursor.buffered, header.frameBytes)) {
        first = header;
        break;
      }
    }
    cursor.skip(1);
  }
  const firstFrame = await cursor.take(first!.frameBytes);
  const xing = readXing(firstFrame, first!);
  const skipFrames = MP3_DECODER_DELAY + (xing?.delay ?? 0);
  const totalFrames = xing?.frames != null && (xing.delay || xing.padding) ? xing.frames * first!.frames - xing.delay - xing.padding : null;

  async function* packets(): AsyncGenerator<ParrotAudioPacket> {
    if (!xing) yield { bytes: firstFrame, frames: first!.frames };
    for (;;) {
      if ((await cursor.fill(4)) < 4) return;
      const header = readMp3Header(cursor.buffered, 0);
      if (!header || header.version !== first!.version || header.sampleRate !== first!.sampleRate) {
        cursor.skip(1);
        continue;
      }
      if ((await cursor.fill(header.frameBytes)) < header.frameBytes) return;
      yield { bytes: await cursor.take(header.frameBytes), frames: header.frames };
    }
  }
  return {
    track: { kind: "webcodecs", codec: "mp3", description: null, sampleRate: first!.sampleRate, channels: first!.channels, skipFrames, totalFrames },
    packets: packets(),
  };
};

// ── ADTS (raw AAC) ──────────────────────────────────────────────────────────────────────────────────────────────────

const AAC_RATES = [96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 12_000, 11_025, 8_000, 7_350];

const readAdtsHeader = (b: Uint8Array, at: number) => {
  if (b[at] !== 0xff || (b[at + 1]! & 0xf6) !== 0xf0) return null;
  const sampleRate = AAC_RATES[(b[at + 2]! >> 2) & 0x0f];
  const frameBytes = ((b[at + 3]! & 0x03) << 11) | (b[at + 4]! << 3) | (b[at + 5]! >> 5);
  if (!sampleRate || frameBytes < 7) return null;
  return {
    objectType: (b[at + 2]! >> 6) + 1,
    sampleRate,
    channels: ((b[at + 2]! & 0x01) << 2) | (b[at + 3]! >> 6),
    frameBytes,
    frames: 1024 * ((b[at + 6]! & 0x03) + 1),
  };
};

const openAdts = async (cursor: ByteCursor): Promise<ParrotAudioStream> => {
  await skipId3(cursor);
  if ((await cursor.fill(7)) < 7) throw new Error("audio: no ADTS frame");
  const first = readAdtsHeader(cursor.buffered, 0);
  if (!first) throw new Error("audio: no ADTS frame");
  async function* packets(): AsyncGenerator<ParrotAudioPacket> {
    for (;;) {
      if ((await cursor.fill(7)) < 7) return;
      const header = readAdtsHeader(cursor.buffered, 0);
      if (!header) {
        cursor.skip(1);
        continue;
      }
      if ((await cursor.fill(header.frameBytes)) < header.frameBytes) return;
      // Without a description, WebCodecs' AAC decoder takes ADTS frames whole.
      yield { bytes: await cursor.take(header.frameBytes), frames: header.frames };
    }
  }
  return {
    track: {
      kind: "webcodecs",
      codec: `mp4a.40.${first.objectType}`,
      description: null,
      sampleRate: first.sampleRate,
      channels: first.channels || 2,
      skipFrames: 0,
      totalFrames: null,
    },
    packets: packets(),
  };
};

// ── FLAC ────────────────────────────────────────────────────────────────────────────────────────────────────────────

const crc8 = (b: Uint8Array, from: number, to: number): number => {
  let crc = 0;
  for (let i = from; i < to; i += 1) {
    crc ^= b[i]!;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
};

type FlacFrameHeader = { blockSize: number; number: number; variable: boolean; key: number };

/** A FLAC frame header at `at` whose CRC-8 holds, or null (also when the buffer ends inside it). */
export const readFlacFrameHeader = (b: Uint8Array, at: number): FlacFrameHeader | null => {
  if (at + 6 > b.length || b[at] !== 0xff || (b[at + 1]! & 0xfe) !== 0xf8) return null;
  const blockCode = b[at + 2]! >> 4;
  const rateCode = b[at + 2]! & 0x0f;
  const channelCode = b[at + 3]! >> 4;
  const depthCode = (b[at + 3]! >> 1) & 0x07;
  if (blockCode === 0 || rateCode === 15 || channelCode > 10 || depthCode === 3 || b[at + 3]! & 1) return null;
  let p = at + 4;
  // UTF-8-style coded frame (or sample) number.
  const lead = b[p]!;
  let extra = 0;
  let number = lead;
  if (lead >= 0xfe) return null;
  if (lead & 0x80) {
    extra = lead >= 0xfc ? 5 : lead >= 0xf8 ? 4 : lead >= 0xf0 ? 3 : lead >= 0xe0 ? 2 : lead >= 0xc0 ? 1 : -1;
    if (extra < 0) return null;
    number = lead & (0x3f >> extra);
  }
  p += 1;
  if (p + extra > b.length) return null;
  for (let i = 0; i < extra; i += 1, p += 1) {
    if ((b[p]! & 0xc0) !== 0x80) return null;
    number = number * 64 + (b[p]! & 0x3f);
  }
  let blockSize = blockCode === 1 ? 192 : blockCode <= 5 ? 576 << (blockCode - 2) : blockCode >= 8 ? 256 << (blockCode - 8) : 0;
  if (blockCode === 6) blockSize = b[p++]! + 1;
  else if (blockCode === 7) {
    blockSize = ((b[p]! << 8) | b[p + 1]!) + 1;
    p += 2;
  }
  if (rateCode === 12) p += 1;
  else if (rateCode === 13 || rateCode === 14) p += 2;
  if (p >= b.length || crc8(b, at, p) !== b[p]) return null;
  // The channel assignment changes from frame to frame (stereo decorrelation); the sample rate and depth codes do not.
  return { blockSize, number, variable: (b[at + 1]! & 1) === 1, key: rateCode | (depthCode << 4) };
};

const openFlac = async (cursor: ByteCursor): Promise<ParrotAudioStream> => {
  await skipId3(cursor);
  const magic = await cursor.take(4);
  if (ascii(magic, 0, 4) !== "fLaC") throw new Error("audio: not a FLAC file");
  let streamInfo: Uint8Array | null = null;
  for (let last = false; !last; ) {
    const head = await cursor.take(4);
    last = (head[0]! & 0x80) !== 0;
    const length = (head[1]! << 16) | (head[2]! << 8) | head[3]!;
    if ((head[0]! & 0x7f) === 0) streamInfo = await cursor.take(length);
    else cursor.skip(length);
  }
  if (!streamInfo || streamInfo.length < 18) throw new Error("audio: FLAC without STREAMINFO");
  const sampleRate = (streamInfo[10]! << 12) | (streamInfo[11]! << 4) | (streamInfo[12]! >> 4);
  const channels = ((streamInfo[12]! >> 1) & 0x07) + 1;
  const total = (streamInfo[13]! & 0x0f) * 2 ** 32 + u32be(streamInfo, 14);
  // WebCodecs' FLAC description: the "fLaC" marker and the STREAMINFO block, marked as the last one.
  const description = new Uint8Array(8 + streamInfo.length);
  description.set([0x66, 0x4c, 0x61, 0x43, 0x80, 0, 0, streamInfo.length]);
  description.set(streamInfo, 8);

  async function* packets(): AsyncGenerator<ParrotAudioPacket> {
    if ((await cursor.fill(16)) < 16) return;
    let current = readFlacFrameHeader(cursor.buffered, 0);
    if (!current) throw new Error("audio: no FLAC frame after the metadata");
    let searchFrom = 2;
    for (;;) {
      const b = cursor.buffered;
      let next = -1;
      let nextHeader: FlacFrameHeader | null = null;
      const expected = current.variable ? current.number + current.blockSize : current.number + 1;
      for (let i = searchFrom; i + 16 <= b.length; i += 1) {
        if (b[i] !== 0xff) continue;
        const header = readFlacFrameHeader(b, i);
        // A sync code inside the audio data is rare, one with a good CRC, the same stream parameters and the next
        // frame number rarer still.
        if (header && header.key === current.key && header.variable === current.variable && header.number === expected) {
          next = i;
          nextHeader = header;
          break;
        }
      }
      if (next < 0) {
        searchFrom = Math.max(2, b.length - 15);
        if (cursor.position + b.length < cursor.size) {
          await cursor.fill(b.length + cursor.block);
          continue;
        }
        if (b.length) yield { bytes: await cursor.take(b.length), frames: current.blockSize };
        return;
      }
      yield { bytes: await cursor.take(next), frames: current.blockSize };
      current = nextHeader!;
      searchFrom = 2;
    }
  }
  return {
    track: { kind: "webcodecs", codec: "flac", description, sampleRate, channels, skipFrames: 0, totalFrames: total || null },
    packets: packets(),
  };
};

// ── Ogg (Vorbis, Opus) ──────────────────────────────────────────────────────────────────────────────────────────────

/** The last granule position of the stream `serial`, from the file's last pages. */
const lastOggGranule = async (read: AlacByteReader, size: number, serial: number): Promise<number | null> => {
  const from = Math.max(0, size - 65_536);
  const tail = await read(from, size - 1);
  for (let i = tail.length - 27; i >= 0; i -= 1) {
    if (tail[i] !== 0x4f || ascii(tail, i, 4) !== "OggS" || u32le(tail, i + 14) !== serial) continue;
    const low = u32le(tail, i + 6);
    const high = u32le(tail, i + 10);
    if (high === 0xffffffff && low === 0xffffffff) continue;
    return high * 2 ** 32 + low;
  }
  return null;
};

/** Samples (at 48 kHz) an Opus packet decodes to, from its TOC byte (RFC 6716 §3.1). */
export const opusPacketFrames = (packet: Uint8Array): number => {
  if (!packet.length) return 0;
  const config = packet[0]! >> 3;
  const perFrame = config < 12 ? [480, 960, 1920, 2880][config & 3]! : config < 16 ? [480, 960][config & 1]! : [120, 240, 480, 960][config & 3]!;
  const code = packet[0]! & 3;
  const count = code === 0 ? 1 : code === 3 ? (packet[1] ?? 0) & 0x3f : 2;
  return perFrame * count;
};

const openOgg = async (cursor: ByteCursor, read: AlacByteReader): Promise<ParrotAudioStream> => {
  let serial: number | null = null;
  let partial: Uint8Array[] = [];
  const ready: Uint8Array[] = [];
  /** Reads pages until a whole packet of the stream is there; null at the end of the file. */
  const nextPacket = async (): Promise<Uint8Array | null> => {
    while (!ready.length) {
      if ((await cursor.fill(27)) < 27) return null;
      const head = cursor.buffered;
      if (ascii(head, 0, 4) !== "OggS") {
        cursor.skip(1);
        continue;
      }
      const segments = head[26]!;
      if ((await cursor.fill(27 + segments)) < 27 + segments) return null;
      const lacing = cursor.buffered.slice(27, 27 + segments);
      const pageSerial = u32le(cursor.buffered, 14);
      const bodyBytes = lacing.reduce((sum, value) => sum + value, 0);
      const page = await cursor.take(27 + segments + bodyBytes);
      serial ??= pageSerial;
      if (pageSerial !== serial) continue;
      let at = 27 + segments;
      for (const value of lacing) {
        partial.push(page.subarray(at, at + value));
        at += value;
        if (value < 255) {
          const length = partial.reduce((sum, part) => sum + part.length, 0);
          const packet = new Uint8Array(length);
          let offset = 0;
          for (const part of partial) {
            packet.set(part, offset);
            offset += part.length;
          }
          ready.push(packet);
          partial = [];
        }
      }
    }
    return ready.shift()!;
  };

  const head = await nextPacket();
  if (!head) throw new Error("audio: empty Ogg file");
  if (ascii(head, 0, 8) === "OpusHead") {
    await nextPacket(); // OpusTags
    const preSkip = u16le(head, 10);
    const last = await lastOggGranule(read, cursor.size, serial!);
    async function* packets(): AsyncGenerator<ParrotAudioPacket> {
      for (let packet = await nextPacket(); packet; packet = await nextPacket()) yield { bytes: packet, frames: opusPacketFrames(packet) };
    }
    return {
      track: {
        kind: "webcodecs",
        codec: "opus",
        description: head,
        sampleRate: 48_000,
        channels: head[9]!,
        // The decoder drops the pre-skip itself (it reads it from the OpusHead description).
        skipFrames: 0,
        totalFrames: last === null ? null : Math.max(0, last - preSkip),
      },
      packets: packets(),
    };
  }
  if (head[0] === 1 && ascii(head, 1, 6) === "vorbis") {
    const comments = await nextPacket();
    const setup = await nextPacket();
    if (!comments || !setup) throw new Error("audio: Vorbis headers missing");
    // WebCodecs' Vorbis description: the three header packets, Xiph-laced.
    const lace = (length: number) => [...Array<number>(Math.floor(length / 255)).fill(255), length % 255];
    const sizes = [...lace(head.length), ...lace(comments.length)];
    const description = new Uint8Array(1 + sizes.length + head.length + comments.length + setup.length);
    description[0] = 2;
    description.set(sizes, 1);
    description.set(head, 1 + sizes.length);
    description.set(comments, 1 + sizes.length + head.length);
    description.set(setup, 1 + sizes.length + head.length + comments.length);
    const last = await lastOggGranule(read, cursor.size, serial!);
    async function* packets(): AsyncGenerator<ParrotAudioPacket> {
      for (let packet = await nextPacket(); packet; packet = await nextPacket()) yield { bytes: packet, frames: 0 };
    }
    return {
      track: { kind: "webcodecs", codec: "vorbis", description, sampleRate: u32le(head, 12), channels: head[11]!, skipFrames: 0, totalFrames: last },
      packets: packets(),
    };
  }
  throw new Error("audio: the Ogg stream is neither Opus nor Vorbis");
};

// ── WAV ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const openWav = async (cursor: ByteCursor): Promise<ParrotAudioStream> => {
  const riff = await cursor.take(12);
  if (ascii(riff, 0, 4) !== "RIFF" || ascii(riff, 8, 4) !== "WAVE") throw new Error("audio: not a WAV file");
  let format: { float: boolean; bits: number; channels: number; sampleRate: number; blockAlign: number } | null = null;
  for (;;) {
    const chunk = await cursor.take(8);
    const id = ascii(chunk, 0, 4);
    const length = u32le(chunk, 4);
    if (id === "fmt ") {
      const fmt = await cursor.take(length + (length & 1));
      let tag = u16le(fmt, 0);
      if (tag === 0xfffe && length >= 26) tag = u16le(fmt, 24);
      if (tag !== 1 && tag !== 3) throw new Error(`audio: WAV format ${tag} is not plain samples`);
      format = { float: tag === 3, channels: u16le(fmt, 2), sampleRate: u32le(fmt, 4), blockAlign: u16le(fmt, 12), bits: u16le(fmt, 14) };
      continue;
    }
    if (id === "data") {
      if (!format) throw new Error("audio: WAV data before its format");
      const end = length === 0 || length === 0xffffffff ? cursor.size : Math.min(cursor.size, cursor.position + length);
      const { blockAlign } = format;
      async function* packets(): AsyncGenerator<ParrotAudioPacket> {
        while (cursor.position + blockAlign <= end) {
          const frames = Math.min(PCM_PACKET_FRAMES, Math.floor((end - cursor.position) / blockAlign));
          yield { bytes: await cursor.take(frames * blockAlign), frames };
        }
      }
      return {
        track: {
          kind: "pcm",
          float: format.float,
          bits: format.bits,
          sampleRate: format.sampleRate,
          channels: format.channels,
          skipFrames: 0,
          totalFrames: Math.floor((end - cursor.position) / blockAlign),
        },
        packets: packets(),
      };
    }
    cursor.skip(length + (length & 1));
  }
};

// ── MP4 (AAC, Apple Lossless) ───────────────────────────────────────────────────────────────────────────────────────

const openMp4 = async (cursor: ByteCursor, read: AlacByteReader, codec: string): Promise<ParrotAudioStream> => {
  const moov = await readMp4Moov(read, cursor.size);
  const alac = codec.toLowerCase() === "alac";
  const index = alac ? indexAlacMoov(moov) : indexAacMoov(moov);
  async function* packets(): AsyncGenerator<ParrotAudioPacket> {
    for (const packet of index.packets) {
      cursor.seek(packet.offset);
      yield { bytes: await cursor.take(packet.size), frames: packet.frames };
    }
  }
  const timing = { skipFrames: index.skipFrames, totalFrames: index.totalFrames };
  if ("config" in index)
    return { track: { kind: "alac", config: index.config, sampleRate: index.config.sampleRate, channels: index.config.channels, ...timing }, packets: packets() };
  return {
    track: {
      kind: "webcodecs",
      codec: `mp4a.40.${index.audioObjectType}`,
      description: index.audioSpecificConfig,
      sampleRate: index.sampleRate,
      channels: index.channels,
      ...timing,
    },
    packets: packets(),
  };
};

/**
 * Opens an original of `size` bytes for frame-by-frame reading. `container` and `codec` are the track file's (PAR-UP-01's
 * formats); `read` returns bytes `start..end` inclusive and is called for a few MiB at a time.
 */
export const openParrotAudioStream = (input: {
  read: AlacByteReader;
  size: number;
  container: string;
  codec: string;
  /** Bytes per read of the frames (PARROT_AUDIO_READ_BLOCK unless given). */
  blockBytes?: number;
}): Promise<ParrotAudioStream> => {
  const cursor = new ByteCursor(input.read, input.size, input.blockBytes ?? PARROT_AUDIO_READ_BLOCK);
  switch (input.container) {
    case "mp3":
      return openMp3(cursor);
    case "adts":
      return openAdts(cursor);
    case "flac":
      return openFlac(cursor);
    case "ogg":
      return openOgg(cursor, input.read);
    case "wav":
      return openWav(cursor);
    case "mp4":
      return openMp4(cursor, input.read, input.codec);
    default:
      throw new Error(`audio: no frame reader for the ${input.container} container`);
  }
};
