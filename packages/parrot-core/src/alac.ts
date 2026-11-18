/*
 * Apple Lossless (ALAC) decoding for Parrot (PAR-FMT-01): neither the desktop app's Chromium nor Android has an ALAC
 * decoder, so Parrot decodes it itself, losslessly.
 *
 * The decoding algorithm (adaptive Golomb entropy decoding, the adaptive FIR predictor, stereo un-mixing) is a port of
 * Apple's ALAC reference decoder (codec/ag_dec.c, dp_dec.c, matrix_dec.c, ALACDecoder.cpp of
 * https://github.com/macosforge/alac):
 *
 *   Copyright (c) 2011 Apple Inc. All rights reserved.
 *
 *   Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance
 *   with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 *   Unless required by applicable law or agreed to in writing, software distributed under the License is distributed
 *   on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for
 *   the specific language governing permissions and limitations under the License.
 *
 * Changes from the original: ported from C/C++ to TypeScript; the MP4 sample-table reading and the WAV output are
 * Parrot's own. The full licence text ships as packages/parrot-core/licenses/apple-alac-LICENSE.txt.
 */

/** The ALACSpecificConfig ("magic cookie") an MP4 `alac` box carries: the stream's fixed parameters. */
export type AlacConfig = {
  frameLength: number;
  bitDepth: number;
  pb: number;
  mb: number;
  kb: number;
  channels: number;
  maxRun: number;
  maxFrameBytes: number;
  avgBitRate: number;
  sampleRate: number;
};

/** Stored files whose codec Parrot decodes itself (the codec column of `track_files`). */
export const isAlacCodec = (codec: string | null | undefined): boolean => codec?.toLowerCase() === "alac";

const u32 = (b: Uint8Array, at: number) => ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
const u16 = (b: Uint8Array, at: number) => (b[at]! << 8) | b[at + 1]!;
const fourcc = (b: Uint8Array, at: number) => String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);

/**
 * Reads the 24-byte ALACSpecificConfig. Accepts the bare config, or any bytes holding an `alac` box around it (an MP4
 * sample entry, a QuickTime `wave` box): the first `alac` box of 36 bytes or more is taken.
 */
export const parseAlacConfig = (bytes: Uint8Array): AlacConfig => {
  let at = -1;
  if (bytes.length === 24) at = 0;
  else {
    for (let i = 0; i + 36 <= bytes.length; i += 1) {
      if (fourcc(bytes, i + 4) === "alac" && u32(bytes, i) >= 36 && u32(bytes, i) <= bytes.length - i) {
        at = i + 12;
        break;
      }
    }
  }
  if (at < 0) throw new Error("alac: no ALACSpecificConfig");
  const config: AlacConfig = {
    frameLength: u32(bytes, at),
    bitDepth: bytes[at + 5]!,
    pb: bytes[at + 6]!,
    mb: bytes[at + 7]!,
    kb: bytes[at + 8]!,
    channels: bytes[at + 9]!,
    maxRun: u16(bytes, at + 10),
    maxFrameBytes: u32(bytes, at + 12),
    avgBitRate: u32(bytes, at + 16),
    sampleRate: u32(bytes, at + 20),
  };
  if (bytes[at + 4] !== 0) throw new Error(`alac: unknown compatible version ${bytes[at + 4]}`);
  if (![16, 20, 24, 32].includes(config.bitDepth)) throw new Error(`alac: unsupported bit depth ${config.bitDepth}`);
  if (config.channels < 1 || config.channels > 8) throw new Error(`alac: unsupported channel count ${config.channels}`);
  if (config.frameLength < 1 || config.frameLength > 65536) throw new Error(`alac: bad frame length ${config.frameLength}`);
  return config;
};

/** MSB-first bit reader over one ALAC frame. Reads past the end yield zero bits (counted, and refused at the end). */
class BitReader {
  private pos = 0;
  constructor(private readonly buf: Uint8Array) {}

  bits(n: number): number {
    let value = 0;
    let left = n;
    while (left > 0) {
      const byte = this.buf[this.pos >>> 3] ?? 0;
      const offset = this.pos & 7;
      const avail = 8 - offset;
      const take = avail < left ? avail : left;
      value = value * (1 << take) + ((byte >>> (avail - take)) & ((1 << take) - 1));
      this.pos += take;
      left -= take;
    }
    return value;
  }

  signed(n: number): number {
    const value = this.bits(n);
    return value >= 2 ** (n - 1) ? value - 2 ** n : value;
  }

  peek(n: number): number {
    const at = this.pos;
    const value = this.bits(n);
    this.pos = at;
    return value;
  }

  skip(n: number) {
    this.pos += n;
  }

  align() {
    this.pos = (this.pos + 7) & ~7;
  }

  get left(): number {
    return this.buf.length * 8 - this.pos;
  }
}

const log2 = (v: number) => (v > 0 ? 31 - Math.clz32(v) : 0);
const signExtend = (v: number, bits: number) => (bits >= 32 ? v | 0 : (v << (32 - bits)) >> (32 - bits));
const signOf = (v: number) => (v > 0 ? 1 : v < 0 ? -1 : 0);

const ID_SCE = 0;
const ID_CPE = 1;
const ID_LFE = 3;
const ID_DSE = 4;
const ID_FIL = 6;
const ID_END = 7;

/** Where each decoded channel goes, in WAV/FFmpeg order (front L R, centre, LFE, back…), by channel count. */
const CHANNEL_OFFSETS: readonly (readonly number[])[] = [
  [0],
  [0, 1],
  [2, 0, 1],
  [2, 0, 1, 3],
  [2, 0, 1, 3, 4],
  [2, 0, 1, 4, 5, 3],
  [2, 0, 1, 4, 5, 6, 3],
  [2, 6, 7, 0, 1, 4, 5, 3],
];

/** Decodes ALAC frames (one MP4 sample each) to signed integer PCM, one Int32Array per channel. */
export class AlacDecoder {
  readonly config: AlacConfig;
  private readonly error: [Int32Array, Int32Array];
  private readonly extra: [Int32Array, Int32Array];
  private readonly coefs: [Int16Array, Int16Array] = [new Int16Array(32), new Int16Array(32)];

  constructor(config: AlacConfig) {
    this.config = config;
    this.error = [new Int32Array(config.frameLength), new Int32Array(config.frameLength)];
    this.extra = [new Int32Array(config.frameLength), new Int32Array(config.frameLength)];
  }

  /** Decodes one frame. The values are in the stream's bit depth (16-bit: -32768..32767; 24-bit: ±8388608…). */
  decodeFrame(frame: Uint8Array): Int32Array[] {
    const { channels } = this.config;
    const reader = new BitReader(frame);
    const out: Int32Array[] = [];
    let frameSamples = -1;
    let ch = 0;
    while (reader.left >= 3) {
      const element = reader.bits(3);
      if (element === ID_END) break;
      if (element === ID_DSE) {
        reader.skip(4); // element instance tag
        const aligned = reader.bits(1);
        let count = reader.bits(8);
        if (count === 255) count += reader.bits(8);
        if (aligned) reader.align();
        reader.skip(count * 8);
        continue;
      }
      if (element === ID_FIL) {
        let count = reader.bits(4);
        if (count === 15) count += reader.bits(8) - 1;
        reader.skip(count * 8);
        continue;
      }
      if (element !== ID_SCE && element !== ID_CPE && element !== ID_LFE) throw new Error(`alac: unsupported element ${element}`);
      const count = element === ID_CPE ? 2 : 1;
      const offset = CHANNEL_OFFSETS[channels - 1]![ch]!;
      if (ch + count > channels || offset + count > channels) throw new Error("alac: more channels than the config says");
      const samples = this.decodeElement(reader, count, frameSamples);
      if (frameSamples < 0) {
        frameSamples = samples.length > 0 ? samples[0]!.length : 0;
        for (let c = 0; c < channels; c += 1) out.push(new Int32Array(frameSamples));
      }
      for (let c = 0; c < count; c += 1) out[offset + c]!.set(samples[c]!);
      ch += count;
    }
    if (reader.left < 0) throw new Error("alac: frame ends early");
    if (frameSamples < 0) return Array.from({ length: channels }, () => new Int32Array(0));
    if (ch !== channels) throw new Error(`alac: frame has ${ch} of ${channels} channels`);
    return out;
  }

  private decodeElement(reader: BitReader, channels: number, expectedSamples: number): Int32Array[] {
    const config = this.config;
    reader.skip(4); // element instance tag
    reader.skip(12); // unused header bits
    const hasSize = reader.bits(1);
    const extraBits = reader.bits(2) << 3;
    const bps = config.bitDepth - extraBits + channels - 1;
    if (bps > 32 || bps < 1) throw new Error(`alac: bad sample size ${bps}`);
    const compressed = reader.bits(1) === 0;
    const samples = hasSize ? reader.bits(32) : config.frameLength;
    if (samples < 1 || samples > config.frameLength) throw new Error(`alac: bad frame size ${samples}`);
    if (expectedSamples >= 0 && samples !== expectedSamples) throw new Error("alac: elements of one frame differ in size");
    const output = Array.from({ length: channels }, () => new Int32Array(samples));

    if (!compressed) {
      for (let i = 0; i < samples; i += 1) {
        for (let c = 0; c < channels; c += 1) output[c]![i] = reader.signed(config.bitDepth);
      }
      return output;
    }

    const mixShift = reader.bits(8);
    const mixWeight = reader.bits(8);
    const mode: number[] = [];
    const denShift: number[] = [];
    const pbFactor: number[] = [];
    const order: number[] = [];
    for (let c = 0; c < channels; c += 1) {
      mode[c] = reader.bits(4);
      denShift[c] = reader.bits(4);
      pbFactor[c] = reader.bits(3);
      order[c] = reader.bits(5);
      if (order[c]! >= samples || denShift[c] === 0) throw new Error("alac: bad predictor");
      const coefs = this.coefs[c]!;
      for (let i = order[c]! - 1; i >= 0; i -= 1) coefs[i] = reader.signed(16);
    }
    if (extraBits) {
      for (let i = 0; i < samples; i += 1) {
        for (let c = 0; c < channels; c += 1) this.extra[c]![i] = reader.bits(extraBits);
      }
    }
    for (let c = 0; c < channels; c += 1) {
      const error = this.error[c]!;
      this.entropyDecode(reader, error, samples, bps, Math.floor((pbFactor[c]! * config.pb) / 4));
      if (mode[c] === 15) predict(error, error, samples, bps, this.coefs[c]!, 31, 0);
      else if (mode[c] !== 0) throw new Error(`alac: unknown prediction mode ${mode[c]}`);
      predict(error, output[c]!, samples, bps, this.coefs[c]!, order[c]!, denShift[c]!);
    }

    if (channels === 2 && mixWeight !== 0) {
      const [left, right] = output as [Int32Array, Int32Array];
      for (let i = 0; i < samples; i += 1) {
        let a = left[i]!;
        let b = right[i]!;
        a = (a - (Math.imul(b, mixWeight) >> mixShift)) | 0;
        b = (b + a) | 0;
        left[i] = b;
        right[i] = a;
      }
    }
    if (extraBits) {
      for (let c = 0; c < channels; c += 1) {
        const values = output[c]!;
        const extra = this.extra[c]!;
        for (let i = 0; i < samples; i += 1) values[i] = (values[i]! << extraBits) | extra[i]!;
      }
    }
    return output;
  }

  /** Adaptive Golomb decoding of one channel's prediction errors (ag_dec.c dyn_decomp). */
  private entropyDecode(reader: BitReader, out: Int32Array, samples: number, bps: number, multiplier: number) {
    const { mb, kb } = this.config;
    let history = mb;
    let signModifier = 0;
    for (let i = 0; i < samples; ) {
      let k = log2((history >>> 9) + 3);
      if (k > kb) k = kb;
      let x = scalar(reader, k, bps);
      x = (x + signModifier) >>> 0;
      signModifier = 0;
      out[i] = (x >>> 1) ^ -(x & 1);
      if (x > 0xffff) history = 0xffff;
      else history = (history + x * multiplier - Math.floor((history * multiplier) / 512)) >>> 0;
      if (history < 128 && i + 1 < samples) {
        k = 7 - log2(history) + ((history + 16) >> 6);
        if (k > kb) k = kb;
        const run = scalar(reader, k, 16);
        if (run > 0) {
          if (run >= samples - i) throw new Error("alac: zero run past the frame end");
          out.fill(0, i + 1, i + 1 + run);
          i += run;
        }
        if (run <= 0xffff) signModifier = 1;
        history = 0;
      }
      i += 1;
    }
  }
}

/** One Golomb-coded value: a unary prefix of up to 9 ones, then k bits, or an escaped raw value of `bps` bits. */
const scalar = (reader: BitReader, k: number, bps: number): number => {
  let x = 0;
  while (x < 9 && reader.bits(1) === 1) x += 1;
  if (x > 8) return reader.bits(bps);
  if (k !== 1) {
    const extra = reader.peek(k);
    x = x * (2 ** k - 1);
    if (extra > 1) {
      x += extra - 1;
      reader.skip(k);
    } else reader.skip(k - 1);
  }
  return x;
};

/** The adaptive FIR predictor (dp_dec.c unpc_block): rebuilds samples from prediction errors, adapting `coefs`. */
const predict = (error: Int32Array, out: Int32Array, samples: number, bps: number, coefs: Int16Array, order: number, shift: number) => {
  out[0] = error[0]!;
  if (samples <= 1) return;
  if (order === 0) {
    out.set(error.subarray(1, samples), 1);
    return;
  }
  if (order === 31) {
    for (let i = 1; i < samples; i += 1) out[i] = signExtend(out[i - 1]! + error[i]!, bps);
    return;
  }
  let i = 1;
  for (; i <= order && i < samples; i += 1) out[i] = signExtend(out[i - 1]! + error[i]!, bps);
  const round = 2 ** (shift - 1);
  const divisor = 2 ** shift;
  for (; i < samples; i += 1) {
    const base = i - order;
    const d = out[base - 1]!;
    let errorValue = error[i]!;
    let sum = 0;
    for (let j = 0; j < order; j += 1) sum = (sum + Math.imul(out[base + j]! - d, coefs[j]!)) | 0;
    let value = Math.floor((sum + round) / divisor);
    value = (value + d + errorValue) | 0;
    out[i] = signExtend(value, bps);
    const errorSign = signOf(errorValue);
    if (errorSign !== 0) {
      for (let j = 0; j < order && Math.imul(errorValue, errorSign) > 0; j += 1) {
        let delta = (d - out[base + j]!) | 0;
        const sign = signOf(delta) * errorSign;
        coefs[j] = coefs[j]! - sign;
        delta = Math.imul(delta, sign);
        errorValue = (errorValue - Math.imul(delta >> shift, j + 1)) | 0;
      }
    }
  }
};

/** Where one ALAC frame sits in the stored file, and how many samples it decodes to. */
export type AlacPacket = { offset: number; size: number; frames: number };

/** The ALAC track of an MP4 (.m4a) file: its config, its frames, and the part of the decoded audio its edit list keeps. */
export type AlacMp4Index = {
  config: AlacConfig;
  packets: AlacPacket[];
  /** First decoded sample of each packet. */
  packetStarts: number[];
  /** Decoded samples before the audio the edit list keeps (encoder delay; 0 for most files). */
  skipFrames: number;
  /** Samples the song plays, after the edit list (encoder delay and padding trimmed). */
  totalFrames: number;
};

type Box = { type: string; start: number; body: number; end: number };

const boxesIn = (b: Uint8Array, from: number, to: number): Box[] => {
  const out: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = u32(b, at);
    let body = at + 8;
    if (size === 1) {
      size = u32(b, at + 8) * 2 ** 32 + u32(b, at + 12);
      body = at + 16;
    } else if (size === 0) size = to - at;
    if (size < body - at || at + size > to) break;
    out.push({ type: fourcc(b, at + 4), start: at, body, end: at + size });
    at += size;
  }
  return out;
};

const child = (b: Uint8Array, box: Box, type: string) => boxesIn(b, box.body, box.end).find((entry) => entry.type === type);

/** Reads ranges of the stored file: `start..end` inclusive. */
export type AlacByteReader = (start: number, end: number) => Promise<Uint8Array>;

/** Finds the `moov` box of an MP4 of `size` bytes by walking its top-level boxes, and returns its bytes. */
export const readMp4Moov = async (read: AlacByteReader, size: number): Promise<Uint8Array> => {
  let at = 0;
  while (at + 8 <= size) {
    const head = await read(at, Math.min(size, at + 16) - 1);
    let boxSize = u32(head, 0);
    if (boxSize === 1) boxSize = u32(head, 8) * 2 ** 32 + u32(head, 12);
    else if (boxSize === 0) boxSize = size - at;
    if (boxSize < 8) break;
    if (fourcc(head, 4) === "moov") return read(at, Math.min(size, at + boxSize) - 1);
    at += boxSize;
  }
  throw new Error("mp4: the file has no moov box");
};

/** An MP4 audio track's frames in file order, and the part of the decoded audio its edit list keeps. */
export type Mp4AudioTable = Omit<AlacMp4Index, "config">;

type Mp4AudioTrak = { trak: Box; mdia: Box; stbl: Box; entry: Box };

/** The audio tracks of a `moov` box, each with its first sample entry (`alac`, `mp4a`…). */
const mp4AudioTraks = (moov: Uint8Array): { root: Box; traks: Mp4AudioTrak[] } => {
  const [root] = boxesIn(moov, 0, moov.length);
  if (!root || root.type !== "moov") throw new Error("mp4: not a moov box");
  const traks: Mp4AudioTrak[] = [];
  for (const trak of boxesIn(moov, root.body, root.end).filter((box) => box.type === "trak")) {
    const mdia = child(moov, trak, "mdia");
    const minf = mdia && child(moov, mdia, "minf");
    const stbl = minf && child(moov, minf, "stbl");
    const stsd = stbl && child(moov, stbl, "stsd");
    if (!mdia || !stbl || !stsd) continue;
    const entry = boxesIn(moov, stsd.body + 8, stsd.end)[0];
    if (entry) traks.push({ trak, mdia, stbl, entry });
  }
  return { root, traks };
};

/** Reads a track's sample table (sizes, chunk offsets, durations) and edit list, in samples at `sampleRate`. */
const readMp4AudioTable = (moov: Uint8Array, root: Box, track: Mp4AudioTrak, sampleRate: number, defaultFrames: number): Mp4AudioTable => {
  const { trak, mdia, stbl } = track;
  const mvhd = child(moov, root, "mvhd");
  const movieTimescale = mvhd ? u32(moov, mvhd.body + (moov[mvhd.body] === 1 ? 20 : 12)) : 0;
  const mdhd = child(moov, mdia, "mdhd");
  const mediaTimescale = mdhd ? u32(moov, mdhd.body + (moov[mdhd.body] === 1 ? 20 : 12)) : sampleRate;
  const toSamples = (units: number) => (mediaTimescale === sampleRate || !mediaTimescale ? units : Math.round((units * sampleRate) / mediaTimescale));

  const stsz = child(moov, stbl, "stsz");
  const stsc = child(moov, stbl, "stsc");
  const stco = child(moov, stbl, "stco") ?? child(moov, stbl, "co64");
  const stts = child(moov, stbl, "stts");
  if (!stsz || !stsc || !stco || !stts) throw new Error("mp4: incomplete sample table");
  const fixedSize = u32(moov, stsz.body + 4);
  const count = u32(moov, stsz.body + 8);
  const sizes = Array.from({ length: count }, (_, i) => (fixedSize !== 0 ? fixedSize : u32(moov, stsz.body + 12 + i * 4)));
  const wide = stco.type === "co64";
  const chunkCount = u32(moov, stco.body + 4);
  const chunkOffsets = Array.from({ length: chunkCount }, (_, i) =>
    wide ? u32(moov, stco.body + 8 + i * 8) * 2 ** 32 + u32(moov, stco.body + 12 + i * 8) : u32(moov, stco.body + 8 + i * 4)
  );
  const runs = Array.from({ length: u32(moov, stsc.body + 4) }, (_, i) => ({
    firstChunk: u32(moov, stsc.body + 8 + i * 12),
    perChunk: u32(moov, stsc.body + 12 + i * 12),
  }));
  const deltas: number[] = [];
  for (let i = 0, n = u32(moov, stts.body + 4); i < n && deltas.length < count; i += 1) {
    const repeat = u32(moov, stts.body + 8 + i * 8);
    const delta = toSamples(u32(moov, stts.body + 12 + i * 8));
    for (let r = 0; r < repeat && deltas.length < count; r += 1) deltas.push(delta);
  }
  while (deltas.length < count) deltas.push(defaultFrames);

  const packets: AlacPacket[] = [];
  let sample = 0;
  for (let chunk = 0; chunk < chunkCount && sample < count; chunk += 1) {
    const run = runs.findLast((entry) => entry.firstChunk <= chunk + 1);
    let offset = chunkOffsets[chunk]!;
    for (let s = 0; s < (run?.perChunk ?? 0) && sample < count; s += 1, sample += 1) {
      packets.push({ offset, size: sizes[sample]!, frames: deltas[sample]! });
      offset += sizes[sample]!;
    }
  }
  const packetStarts: number[] = [];
  let decoded = 0;
  for (const packet of packets) {
    packetStarts.push(decoded);
    decoded += packet.frames;
  }

  // Gapless (PAR-PLAY-03): the first non-empty edit says which decoded samples play (encoder delay and padding cut).
  let skipFrames = 0;
  let totalFrames = decoded;
  const elst = (() => {
    const edts = child(moov, trak, "edts");
    return edts && child(moov, edts, "elst");
  })();
  if (elst) {
    const version = moov[elst.body]!;
    const entries = u32(moov, elst.body + 4);
    const width = version === 1 ? 20 : 12;
    for (let i = 0; i < entries; i += 1) {
      const at = elst.body + 8 + i * width;
      const duration = version === 1 ? u32(moov, at) * 2 ** 32 + u32(moov, at + 4) : u32(moov, at);
      const rawMediaTime = version === 1 ? u32(moov, at + 8) * 2 ** 32 + u32(moov, at + 12) : u32(moov, at + 4);
      const empty = version === 1 ? rawMediaTime === 2 ** 64 - 1 || rawMediaTime >= 2 ** 63 : rawMediaTime === 0xffffffff;
      if (empty) continue;
      skipFrames = Math.min(decoded, toSamples(rawMediaTime));
      const kept = movieTimescale > 0 && duration > 0 ? Math.round((duration * sampleRate) / movieTimescale) : decoded - skipFrames;
      totalFrames = Math.max(0, Math.min(decoded - skipFrames, kept));
      break;
    }
  }
  return { packets, packetStarts, skipFrames, totalFrames };
};

/** Indexes the ALAC track of an MP4 from its `moov` box (bytes of the whole box, header included). */
export const indexAlacMoov = (moov: Uint8Array): AlacMp4Index => {
  const { root, traks } = mp4AudioTraks(moov);
  const track = traks.find((entry) => entry.entry.type === "alac");
  if (!track) throw new Error("alac: no ALAC track");
  const config = parseAlacConfig(moov.subarray(track.entry.body + 28, track.entry.end));
  return { config, ...readMp4AudioTable(moov, root, track, config.sampleRate, config.frameLength) };
};

/** The AAC track of an MP4: its AudioSpecificConfig (WebCodecs' `description`) and its frames. */
export type Mp4AacIndex = Mp4AudioTable & { audioObjectType: number; audioSpecificConfig: Uint8Array; sampleRate: number; channels: number };

/** Reads an MPEG-4 descriptor's tag and length at `at`; returns where its body starts. */
const readDescriptor = (b: Uint8Array, at: number) => {
  const tag = b[at]!;
  let length = 0;
  let body = at + 1;
  for (let i = 0; i < 4; i += 1) {
    const byte = b[body++]!;
    length = (length << 7) | (byte & 0x7f);
    if (!(byte & 0x80)) break;
  }
  return { tag, length, body };
};

/** The AudioSpecificConfig inside an `esds` box (ES_Descriptor → DecoderConfigDescriptor → DecoderSpecificInfo). */
const esdsAudioSpecificConfig = (b: Uint8Array, esds: Box): Uint8Array => {
  const es = readDescriptor(b, esds.body + 4);
  if (es.tag !== 0x03) throw new Error("mp4: esds without an ES descriptor");
  const flags = b[es.body + 2]!;
  let at = es.body + 3;
  if (flags & 0x80) at += 2;
  if (flags & 0x40) at += 1 + b[at]!;
  if (flags & 0x20) at += 2;
  const decoderConfig = readDescriptor(b, at);
  if (decoderConfig.tag !== 0x04) throw new Error("mp4: esds without a decoder config");
  const specific = readDescriptor(b, decoderConfig.body + 13);
  if (specific.tag !== 0x05 || specific.length < 2) throw new Error("mp4: esds without an AudioSpecificConfig");
  return b.slice(specific.body, specific.body + specific.length);
};

/** Indexes the AAC (`mp4a`) track of an MP4 from its `moov` box (bytes of the whole box, header included). */
export const indexAacMoov = (moov: Uint8Array): Mp4AacIndex => {
  const { root, traks } = mp4AudioTraks(moov);
  const track = traks.find((entry) => entry.entry.type === "mp4a");
  if (!track) throw new Error("mp4: no AAC track");
  const { entry } = track;
  // AudioSampleEntry: 8 bytes of SampleEntry, then version, channel count (+16), sample rate 16.16 (+24); QuickTime
  // versions 1 and 2 add 16 and 36 bytes before the child boxes.
  const version = u16(moov, entry.body + 8);
  const childrenAt = entry.body + 28 + (version === 1 ? 16 : version === 2 ? 36 : 0);
  const esds = boxesIn(moov, childrenAt, entry.end).find((box) => box.type === "esds");
  if (!esds) throw new Error("mp4: AAC track without esds");
  const audioSpecificConfig = esdsAudioSpecificConfig(moov, esds);
  let audioObjectType = audioSpecificConfig[0]! >> 3;
  if (audioObjectType === 31) audioObjectType = 32 + (((audioSpecificConfig[0]! & 0x07) << 3) | (audioSpecificConfig[1]! >> 5));
  const channels = u16(moov, entry.body + 16);
  const sampleRate = u32(moov, entry.body + 24) >>> 16;
  return { audioObjectType, audioSpecificConfig, sampleRate, channels, ...readMp4AudioTable(moov, root, track, sampleRate, 1024) };
};

/** Indexes the ALAC track of a stored MP4 by reading only its box headers and its `moov`. */
export const indexAlacMp4 = async (read: AlacByteReader, size: number): Promise<AlacMp4Index> => indexAlacMoov(await readMp4Moov(read, size));

/** Bytes per sample of the WAV Parrot serves: 16-bit stays 16, 20- and 24-bit become 24 (20 shifted up), 32 stays 32. */
const wavBytesPerSample = (bitDepth: number) => (bitDepth === 16 ? 2 : bitDepth === 32 ? 4 : 3);

/** The WAV a decoded ALAC song is served as: its size and its header. */
export const alacWavLayout = (index: AlacMp4Index) => {
  const { channels, sampleRate, bitDepth } = index.config;
  const bytesPerSample = wavBytesPerSample(bitDepth);
  const frameBytes = channels * bytesPerSample;
  const dataBytes = index.totalFrames * frameBytes;
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  header.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  view.setUint32(4, 36 + dataBytes, true);
  header.set([0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20], 8); // WAVEfmt
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // integer PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * frameBytes, true);
  view.setUint16(32, frameBytes, true);
  view.setUint16(34, bytesPerSample * 8, true);
  header.set([0x64, 0x61, 0x74, 0x61], 36); // data
  view.setUint32(40, dataBytes, true);
  return { header, frameBytes, bytesPerSample, size: header.length + dataBytes };
};

/** Writes decoded frames (samples `from..to` exclusive of each channel) as interleaved little-endian WAV PCM. */
const interleave = (samples: Int32Array[], from: number, to: number, bitDepth: number): Uint8Array => {
  const bytesPerSample = wavBytesPerSample(bitDepth);
  const shift = bitDepth === 20 ? 4 : 0;
  const out = new Uint8Array((to - from) * samples.length * bytesPerSample);
  let at = 0;
  for (let i = from; i < to; i += 1) {
    for (const channel of samples) {
      const value = channel[i]! << shift;
      out[at] = value & 0xff;
      out[at + 1] = (value >> 8) & 0xff;
      if (bytesPerSample >= 3) out[at + 2] = (value >> 16) & 0xff;
      if (bytesPerSample === 4) out[at + 3] = (value >> 24) & 0xff;
      at += bytesPerSample;
    }
  }
  return out;
};

/**
 * Serves bytes `start..end` (inclusive) of the WAV an ALAC song decodes to (alacWavLayout), decoding only the frames
 * the range covers, so a player can seek anywhere. `readStream` yields the stored file's bytes `start..end` in order.
 */
export async function* readAlacAsWav(
  index: AlacMp4Index,
  start: number,
  end: number,
  readStream: (start: number, end: number) => AsyncIterable<Uint8Array>
): AsyncGenerator<Uint8Array> {
  const layout = alacWavLayout(index);
  if (start < layout.header.length) {
    yield layout.header.subarray(start, Math.min(layout.header.length, end + 1));
    if (end < layout.header.length) return;
    start = layout.header.length;
  }
  const firstFrame = Math.floor((start - layout.header.length) / layout.frameBytes) + index.skipFrames;
  const lastFrame = Math.floor((end - layout.header.length) / layout.frameBytes) + index.skipFrames;
  let skipBytes = (start - layout.header.length) % layout.frameBytes;
  let remaining = end - start + 1;

  // Packet covering a decoded sample: the last packet starting at or before it.
  const packetAt = (frame: number) => {
    let low = 0;
    let high = index.packetStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (index.packetStarts[mid]! <= frame) low = mid;
      else high = mid - 1;
    }
    return low;
  };
  const first = packetAt(firstFrame);
  const last = packetAt(lastFrame);
  const decoder = new AlacDecoder(index.config);

  const span = index.packets.slice(first, last + 1);
  const ascending = span.every((packet, i) => i === 0 || packet.offset >= span[i - 1]!.offset + span[i - 1]!.size);
  // Sequential reader over the stored bytes: one stream when the frames are in file order (always, in practice).
  let stream: AsyncIterator<Uint8Array> | null = null;
  let streamPos = 0;
  let pending = new Uint8Array(0);
  const openAt = (offset: number, until: number) => {
    void stream?.return?.();
    stream = readStream(offset, until)[Symbol.asyncIterator]();
    streamPos = offset;
    pending = new Uint8Array(0);
  };
  const take = async (offset: number, size: number, until: number): Promise<Uint8Array> => {
    if (!stream || offset < streamPos || offset > streamPos + pending.length + 4 * 1024 * 1024) openAt(offset, until);
    while (streamPos + pending.length < offset + size) {
      const next = await stream!.next();
      if (next.done) throw new Error("alac: stored file ends early");
      const joined = new Uint8Array(pending.length + next.value.length);
      joined.set(pending);
      joined.set(next.value, pending.length);
      pending = joined;
    }
    const bytes = pending.slice(offset - streamPos, offset - streamPos + size);
    const drop = offset + size - streamPos;
    pending = pending.subarray(drop);
    streamPos += drop;
    return bytes;
  };

  try {
    const spanEnd = ascending ? span[span.length - 1]!.offset + span[span.length - 1]!.size - 1 : 0;
    for (let p = first; p <= last && remaining > 0; p += 1) {
      const packet = index.packets[p]!;
      const bytes = await take(packet.offset, packet.size, ascending ? spanEnd : packet.offset + packet.size - 1);
      const samples = decoder.decodeFrame(bytes);
      const packetStart = index.packetStarts[p]!;
      const decodedFrames = samples[0]?.length ?? 0;
      const from = Math.max(0, firstFrame - packetStart);
      const to = Math.min(decodedFrames, lastFrame - packetStart + 1, index.skipFrames + index.totalFrames - packetStart);
      if (to <= from) continue;
      let pcm = interleave(samples, from, to, index.config.bitDepth);
      if (skipBytes) {
        pcm = pcm.subarray(skipBytes);
        skipBytes = 0;
      }
      if (pcm.length > remaining) pcm = pcm.subarray(0, remaining);
      remaining -= pcm.length;
      yield pcm;
    }
  } finally {
    void (stream as AsyncIterator<Uint8Array> | null)?.return?.();
  }
  // A file whose frames decode to fewer samples than its tables say: the promised length is filled with silence.
  if (remaining > 0) yield new Uint8Array(remaining);
}

/** Decodes a whole ALAC .m4a held in memory, edit list applied: one Int32Array per channel. */
export const decodeAlacMp4 = (bytes: Uint8Array): { sampleRate: number; channels: number; bitDepth: number; samples: Int32Array[] } => {
  const moovBox = boxesIn(bytes, 0, bytes.length).find((box) => box.type === "moov");
  if (!moovBox) throw new Error("alac: the file has no moov box");
  const index = indexAlacMoov(bytes.subarray(moovBox.start, moovBox.end));
  const { channels, sampleRate, bitDepth } = index.config;
  const samples = Array.from({ length: channels }, () => new Int32Array(index.totalFrames));
  const decoder = new AlacDecoder(index.config);
  const stop = index.skipFrames + index.totalFrames;
  index.packets.forEach((packet, p) => {
    const start = index.packetStarts[p]!;
    if (start >= stop || start + packet.frames <= index.skipFrames) return;
    const decoded = decoder.decodeFrame(bytes.subarray(packet.offset, packet.offset + packet.size));
    const from = Math.max(0, index.skipFrames - start);
    const to = Math.min(decoded[0]?.length ?? 0, stop - start);
    for (let c = 0; c < channels; c += 1) samples[c]!.set(decoded[c]!.subarray(from, to), start + from - index.skipFrames);
  });
  return { sampleRate, channels, bitDepth, samples };
};
