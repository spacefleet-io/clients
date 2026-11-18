/**
 * Synthetic ffmpeg inputs for tests that run the SHIPPED ffmpeg. The bundle is a minimal build: its only
 * lavfi source is `color` (no testsrc/testsrc2/sine/anullsrc), so suites cannot generate their clips with
 * `-f lavfi -i testsrc2=...` there. These helpers write the inputs as plain files instead, which only needs
 * the rawvideo and wav demuxers the bundle ships.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type SyntheticVideo = {
  width: number;
  height: number;
  /** Distinct frames in the file; ffmpeg loops it (`-stream_loop -1`) up to the `-t` the caller sets. */
  frames: number;
  /** Luma blocks are `blockSize` x `blockSize` squares of one value: bigger blocks mean a cheaper encode. */
  blockSize?: number;
  seed?: number;
};

/** xorshift32: a fixed seed yields the same bytes on every host, so encodes of the file are repeatable. */
const xorshift32 = (seed: number) => {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
};

/**
 * Writes `frames` raw yuv420p frames of moving block noise. Every frame is different, so x264 has real
 * work to do (a flat clip encodes in milliseconds and a test that needs a running encoder would race it).
 */
export const writeSyntheticYuv = (path: string, video: SyntheticVideo): void => {
  const { width, height, frames, blockSize = 16, seed = 1 } = video;
  const next = xorshift32(seed);
  const lumaSize = width * height;
  const chromaSize = (width >> 1) * (height >> 1);
  const frame = Buffer.alloc(lumaSize + chromaSize * 2, 128);
  const columns = Math.ceil(width / blockSize);
  const rows = Math.ceil(height / blockSize);
  const out = Buffer.alloc(frame.length * frames);
  for (let index = 0; index < frames; index += 1) {
    const blocks = Uint8Array.from({ length: columns * rows }, () => next() & 0xff);
    for (let y = 0; y < height; y += 1) {
      const rowBase = Math.floor(y / blockSize) * columns;
      for (let x = 0; x < width; x += 1) frame[y * width + x] = blocks[rowBase + Math.floor(x / blockSize)]!;
    }
    frame.copy(out, index * frame.length);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, out);
};

/** ffmpeg input arguments that read a file written by {@link writeSyntheticYuv} for `seconds` of video. */
export const syntheticYuvInput = (path: string, video: Pick<SyntheticVideo, "width" | "height"> & { rate: number; seconds: number }): string[] => [
  "-f", "rawvideo",
  "-pixel_format", "yuv420p",
  "-video_size", `${video.width}x${video.height}`,
  "-framerate", String(video.rate),
  "-stream_loop", "-1",
  "-i", path,
  "-t", String(video.seconds),
];

/** WAVEFORMATEXTENSIBLE speaker bits (dwChannelMask): a mask names the file's channel layout to ffmpeg's wav demuxer. */
export const WAV_CHANNEL_MASKS = {
  stereo: 0x3, // FL FR
  "2.1": 0xb, // FL FR LFE
  "5.1": 0x3f, // FL FR FC LFE BL BR
  "5.1(side)": 0x60f, // FL FR FC LFE SL SR
} as const;

/**
 * Writes a 16-bit PCM sine wave as a .wav file (the bundle's ffmpeg demuxes wav but has no `sine` or `anullsrc`
 * source). Mono by default; a `channelMask` writes the tone on every channel of that layout as WAVE_FORMAT_EXTENSIBLE,
 * so ffmpeg reads the layout from the file (the bundle has no AC-3 or PCM encoder to make a multichannel source).
 */
export const writeToneWav = (path: string, tone: { hz: number; seconds: number; sampleRate?: number; channelMask?: number }): void => {
  const { hz, seconds, sampleRate = 48_000, channelMask } = tone;
  let channels = 0;
  for (let mask = channelMask ?? 1; mask; mask &= mask - 1) channels += 1;
  const samples = Math.round(seconds * sampleRate);
  const blockAlign = channels * 2;
  const data = Buffer.alloc(samples * blockAlign);
  for (let i = 0; i < samples; i += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * hz * i) / sampleRate) * 12_000);
    for (let channel = 0; channel < channels; channel += 1) data.writeInt16LE(value, i * blockAlign + channel * 2);
  }
  const fmt = Buffer.alloc(channelMask === undefined ? 16 : 40);
  fmt.writeUInt16LE(channelMask === undefined ? 1 : 0xfffe, 0); // PCM | WAVE_FORMAT_EXTENSIBLE
  fmt.writeUInt16LE(channels, 2);
  fmt.writeUInt32LE(sampleRate, 4);
  fmt.writeUInt32LE(sampleRate * blockAlign, 8);
  fmt.writeUInt16LE(blockAlign, 12);
  fmt.writeUInt16LE(16, 14);
  if (channelMask !== undefined) {
    fmt.writeUInt16LE(22, 16); // cbSize
    fmt.writeUInt16LE(16, 18); // valid bits per sample
    fmt.writeUInt32LE(channelMask, 20);
    // KSDATAFORMAT_SUBTYPE_PCM {00000001-0000-0010-8000-00aa00389b71}
    Buffer.from("0100000000001000800000aa00389b71", "hex").copy(fmt, 24);
  }
  const header = Buffer.alloc(20);
  header.write("RIFF", 0);
  header.writeUInt32LE(4 + 8 + fmt.length + 8 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(fmt.length, 16);
  const dataHeader = Buffer.alloc(8);
  dataHeader.write("data", 0);
  dataHeader.writeUInt32LE(data.length, 4);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.concat([header, fmt, dataHeader, data]));
};

export type SyntheticPgsCue = {
  startS: number;
  endS: number;
  /** Box position and size on the `width` x `height` canvas. */
  x: number;
  y: number;
  w: number;
  h: number;
};

/** One PGS segment: `PG`, 90 kHz PTS + DTS, segment type, payload size, payload. */
const pgsSegment = (ptsS: number, type: number, payload: Buffer): Buffer => {
  const header = Buffer.alloc(13);
  header.write("PG", 0, "ascii");
  header.writeUInt32BE(Math.round(ptsS * 90_000) >>> 0, 2);
  header.writeUInt32BE(0, 6);
  header.writeUInt8(type, 10);
  header.writeUInt16BE(payload.length, 11);
  return Buffer.concat([header, payload]);
};

/** PGS run-length code of `length` pixels of palette entry `color` (the long forms fit any run up to 16383). */
const pgsRun = (color: number, length: number): number[] => {
  if (color === 0) return length < 64 ? [0, length] : [0, 0x40 | (length >> 8), length & 0xff];
  if (length < 3) return Array.from({ length }, () => color);
  return length < 64 ? [0, 0x80 | length, color] : [0, 0xc0 | (length >> 8), length & 0xff, color];
};

/** RLE bitmap of a `w` x `h` box: palette entry 2 (black) border of `border` pixels around entry 1 (yellow). */
const pgsBoxRle = (w: number, h: number, border: number): Buffer => {
  const bytes: number[] = [];
  for (let row = 0; row < h; row += 1) {
    if (row < border || row >= h - border) bytes.push(...pgsRun(2, w));
    else bytes.push(...pgsRun(2, border), ...pgsRun(1, w - 2 * border), ...pgsRun(2, border));
    bytes.push(0, 0);
  }
  return Buffer.from(bytes);
};

/**
 * Writes a raw HDMV PGS (.sup) stream with one opaque box per cue. ffmpeg has no PGS encoder, and the media format
 * test set needs a PGS file it may redistribute: every display set is built here byte by byte (presentation
 * composition, window, palette, object, end), and each cue is cleared at `endS` by an empty composition.
 */
export const writeSyntheticPgs = (path: string, pgs: { width: number; height: number; cues: SyntheticPgsCue[] }): void => {
  const segments: Buffer[] = [];
  pgs.cues.forEach((cue, index) => {
    const composition = (objects: number, state: number) => {
      const pcs = Buffer.alloc(11 + objects * 8);
      pcs.writeUInt16BE(pgs.width, 0);
      pcs.writeUInt16BE(pgs.height, 2);
      pcs.writeUInt8(0x10, 4); // frame rate code, ignored by decoders
      pcs.writeUInt16BE(index * 2 + (objects ? 0 : 1), 5);
      pcs.writeUInt8(state, 7);
      pcs.writeUInt8(0, 8); // palette update flag
      pcs.writeUInt8(0, 9); // palette id
      pcs.writeUInt8(objects, 10);
      if (objects) {
        pcs.writeUInt16BE(0, 11); // object id
        pcs.writeUInt8(0, 13); // window id
        pcs.writeUInt8(0, 14); // not cropped
        pcs.writeUInt16BE(cue.x, 15);
        pcs.writeUInt16BE(cue.y, 17);
      }
      return pcs;
    };
    const window = Buffer.alloc(10);
    window.writeUInt8(1, 0);
    window.writeUInt8(0, 1);
    window.writeUInt16BE(cue.x, 2);
    window.writeUInt16BE(cue.y, 4);
    window.writeUInt16BE(cue.w, 6);
    window.writeUInt16BE(cue.h, 8);
    // Palette: 1 = yellow (Y 210, Cr 146, Cb 16), 2 = black, both opaque (BT.709 limited range).
    const palette = Buffer.from([0, 0, 1, 210, 146, 16, 255, 2, 16, 128, 128, 255]);
    const rle = pgsBoxRle(cue.w, cue.h, 4);
    const object = Buffer.alloc(11 + rle.length);
    object.writeUInt16BE(0, 0); // object id
    object.writeUInt8(0, 2); // version
    object.writeUInt8(0xc0, 3); // first and last fragment
    object.writeUIntBE(rle.length + 4, 4, 3); // data length counts width + height
    object.writeUInt16BE(cue.w, 7);
    object.writeUInt16BE(cue.h, 9);
    rle.copy(object, 11);
    segments.push(
      pgsSegment(cue.startS, 0x16, composition(1, 0x80)), // epoch start
      pgsSegment(cue.startS, 0x17, window),
      pgsSegment(cue.startS, 0x14, palette),
      pgsSegment(cue.startS, 0x15, object),
      pgsSegment(cue.startS, 0x80, Buffer.alloc(0)),
      pgsSegment(cue.endS, 0x16, composition(0, 0x00)),
      pgsSegment(cue.endS, 0x17, window),
      pgsSegment(cue.endS, 0x80, Buffer.alloc(0)),
    );
  });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.concat(segments));
};
