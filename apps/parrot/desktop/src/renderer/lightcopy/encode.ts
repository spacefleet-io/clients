// PAR-FMT-02's light copy, made in the hidden encoder window (its own renderer process, so neither the app's window
// nor the main process waits on it): Chromium decodes the original (or ParrotAlac's decoder hands over its sound),
// its built-in WebCodecs Opus encoder writes 64 kbps packets, and @space/parrot-core's Ogg writer stores them with the
// pre-skip and end trim that keep the copy gapless.
//
// A song decodes whole (decodeAudioData, which also applies MP3's gapless info) up to WHOLE_DECODE_MAX_MS and
// WHOLE_DECODE_MAX_BYTES; a longer or bigger one streams: its frames are read a few MiB at a time
// (`openParrotAudioStream`), decoded by WebCodecs' AudioDecoder and encoded as they come, so memory stays flat
// however long the song is (an 8.4 h mix crashed Parrot when it went whole, 2026-11-11).
import {
  AlacDecoder,
  decodeAlacMp4,
  OPUS_DEFAULT_PRE_SKIP,
  OPUS_GRANULE_RATE,
  openParrotAudioStream,
  opusHead,
  opusTags,
  PARROT_LIGHT_COPY,
  parrotOpusComments,
  readOpusHeadPreSkip,
  writeOggOpus,
  type AlacByteReader,
  type ParrotCopyTags,
} from "@space/parrot-core";

/** The original's sound as the encoder takes it: planar float samples, one or two channels. */
export type LightCopyPcm = { channels: Float32Array[]; sampleRate: number };

/** Longest song decoded whole: Chromium's decodeAudioData refuses longer ones (Electron 45: 90 min do, 107 do not). */
export const WHOLE_DECODE_MAX_MS = 90 * 60_000;
/** Biggest original decoded whole (it is held in this window's memory, with its decoded sound). */
export const WHOLE_DECODE_MAX_BYTES = 256 * 1024 * 1024;

/** Samples per AudioData handed to the encoder from a whole decode (one second at 48 kHz). */
const FEED_FRAMES = OPUS_GRANULE_RATE;
/** Encoder or decoder requests queued before feeding waits (backpressure: memory stays flat on long songs). */
const MAX_QUEUE = 8;
/** Size of the buffers the encoded packets are packed into. */
const PACKET_ARENA_BYTES = 1024 * 1024;
/** Silence (at 48 kHz) fed past the end so the encoder's delay drains; the Ogg end trim cuts it off again. */
const TAIL_SILENCE_FRAMES = 1920;

/**
 * Decodes `bytes` with Chromium at 48 kHz, down-mixed to stereo when it has more channels (Opus channel mapping 0).
 * Rejects what Chromium cannot decode.
 */
export const decodeToPcm = async (bytes: Uint8Array): Promise<LightCopyPcm> => {
  const probe = new OfflineAudioContext(2, 1, OPUS_GRANULE_RATE);
  const decoded = await probe.decodeAudioData(bytes.slice().buffer);
  let buffer = decoded;
  if (decoded.numberOfChannels > 2) {
    const mix = new OfflineAudioContext(2, decoded.length, OPUS_GRANULE_RATE);
    const source = mix.createBufferSource();
    source.buffer = decoded;
    source.connect(mix.destination);
    source.start();
    buffer = await mix.startRendering();
  }
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
  return { channels, sampleRate: buffer.sampleRate };
};

/**
 * Resamples planar samples to 48 kHz, down-mixed to stereo when there are more channels (ParrotAlac's decoder hands
 * over the file's own rate and channels).
 */
export const resampleTo48k = async (pcm: LightCopyPcm): Promise<LightCopyPcm> => {
  if (pcm.sampleRate === OPUS_GRANULE_RATE && pcm.channels.length <= 2) return pcm;
  const length = pcm.channels[0]?.length ?? 0;
  const source = new AudioBuffer({ numberOfChannels: pcm.channels.length, length: Math.max(1, length), sampleRate: pcm.sampleRate });
  for (const [index, channel] of pcm.channels.entries()) source.copyToChannel(channel as Float32Array<ArrayBuffer>, index);
  const count = Math.min(pcm.channels.length, 2);
  const context = new OfflineAudioContext(count, Math.max(1, Math.round((length * OPUS_GRANULE_RATE) / pcm.sampleRate)), OPUS_GRANULE_RATE);
  const node = context.createBufferSource();
  node.buffer = source;
  node.connect(context.destination);
  node.start();
  const rendered = await context.startRendering();
  return { channels: Array.from({ length: count }, (_, index) => rendered.getChannelData(index)), sampleRate: OPUS_GRANULE_RATE };
};

/** An Apple Lossless original's sound, decoded by ParrotAlac's decoder (Chromium plays no ALAC), at 48 kHz. */
export const decodeAlacToPcm = (bytes: Uint8Array): Promise<LightCopyPcm> => {
  const decoded = decodeAlacMp4(bytes);
  const scale = 1 / 2 ** (decoded.bitDepth - 1);
  const channels = decoded.samples.map((channel) => {
    const out = new Float32Array(channel.length);
    for (let index = 0; index < channel.length; index += 1) out[index] = channel[index]! * scale;
    return out;
  });
  return resampleTo48k({ channels, sampleRate: decoded.sampleRate });
};

/** Waits for the next `dequeue` of any of `codecs`, or for `failed` to be called. */
const nextDequeue = (codecs: Array<AudioEncoder | AudioDecoder>, failed: { wake: () => void }) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  failed.wake = resolve;
  for (const codec of codecs) codec.addEventListener("dequeue", () => resolve(), { once: true });
  return promise;
};

/**
 * The Opus encoder and Ogg writer of one light copy, fed planar samples at the original's rate as they are decoded
 * (Chromium's encoder resamples to 48 kHz itself).
 */
class OpusLightCopyWriter {
  private readonly packets: Array<{ bytes: Uint8Array; samples: number }> = [];
  private description: Uint8Array | null = null;
  private failure: unknown = null;
  private readonly failed = { wake: () => {} };
  private fed = 0;

  private constructor(
    readonly encoder: AudioEncoder,
    readonly sampleRate: number,
    readonly channelCount: number
  ) {}

  static async open(sampleRate: number, channelCount: number): Promise<OpusLightCopyWriter> {
    if (channelCount < 1 || channelCount > 2) throw new Error(`LIGHT_COPY_CHANNELS: ${channelCount}`);
    let writer: OpusLightCopyWriter | null = null;
    const encoder = new AudioEncoder({
      output: (chunk, metadata) => writer!.collect(chunk, metadata),
      error: (error) => writer!.fail(error),
    });
    writer = new OpusLightCopyWriter(encoder, sampleRate, channelCount);
    // Chromium writes raw Opus packets only (format "ogg" is not supported); an OpusHead in decoderConfig.description,
    // when there is one, gives the real pre-skip, else libopus's default lookahead is used.
    const config = { codec: "opus", sampleRate, numberOfChannels: channelCount, bitrate: PARROT_LIGHT_COPY.bitrateKbps * 1000 } as AudioEncoderConfig;
    const support = await AudioEncoder.isConfigSupported(config);
    if (!support.supported) throw new Error(`LIGHT_COPY_NO_OPUS_ENCODER: ${sampleRate} Hz`);
    encoder.configure(config);
    return writer;
  }

  // Packets are copied into shared 1 MiB arenas: a 3-hour song makes about 550,000 of them, and one buffer each costs
  // several times the Opus itself outside the JS heap.
  private arena = new Uint8Array(0);
  private arenaUsed = 0;

  private collect(chunk: EncodedAudioChunk, metadata?: EncodedAudioChunkMetadata) {
    if (this.arenaUsed + chunk.byteLength > this.arena.length) {
      this.arena = new Uint8Array(Math.max(PACKET_ARENA_BYTES, chunk.byteLength));
      this.arenaUsed = 0;
    }
    const bytes = this.arena.subarray(this.arenaUsed, this.arenaUsed + chunk.byteLength);
    this.arenaUsed += chunk.byteLength;
    chunk.copyTo(bytes);
    const duration = chunk.duration ?? 20_000;
    this.packets.push({ bytes, samples: Math.round((duration * OPUS_GRANULE_RATE) / 1_000_000) });
    const config = metadata?.decoderConfig?.description;
    if (config && !this.description) {
      this.description = config instanceof ArrayBuffer ? new Uint8Array(config.slice(0)) : new Uint8Array((config as ArrayBufferView).buffer.slice(0));
    }
  }

  fail(error: unknown) {
    this.failure ??= error;
    this.failed.wake();
  }

  throwIfFailed() {
    if (this.failure) throw this.failure instanceof Error ? this.failure : new Error(String(this.failure));
  }

  /** Encodes planar samples (one array per channel, all the same length). */
  push(channels: Float32Array[]) {
    const frames = channels[0]?.length ?? 0;
    if (!frames || this.failure) return;
    const planar = new Float32Array(frames * this.channelCount);
    for (let channel = 0; channel < this.channelCount; channel += 1) planar.set(channels[channel]!, channel * frames);
    const data = new AudioData({
      format: "f32-planar",
      sampleRate: this.sampleRate,
      numberOfFrames: frames,
      numberOfChannels: this.channelCount,
      timestamp: Math.round((this.fed * 1_000_000) / this.sampleRate),
      data: planar,
    });
    this.fed += frames;
    this.encoder.encode(data);
    data.close();
  }

  /** Waits while the encoder (or `decoder`) has more than MAX_QUEUE requests queued. */
  async room(decoder?: AudioDecoder) {
    while (!this.failure && (this.encoder.encodeQueueSize > MAX_QUEUE || (decoder && decoder.decodeQueueSize > MAX_QUEUE))) {
      await nextDequeue(decoder ? [this.encoder, decoder] : [this.encoder], this.failed);
    }
    this.throwIfFailed();
  }

  /** Drains the encoder and writes the Ogg Opus file, trimmed to the samples pushed. */
  async finish(tags: ParrotCopyTags, vendor: string): Promise<Uint8Array> {
    const samples48k = Math.round((this.fed * OPUS_GRANULE_RATE) / this.sampleRate);
    const tail = Math.ceil((TAIL_SILENCE_FRAMES * this.sampleRate) / OPUS_GRANULE_RATE);
    const fed = this.fed;
    this.push(Array.from({ length: this.channelCount }, () => new Float32Array(tail)));
    this.fed = fed;
    if (!this.failure) await this.encoder.flush().catch((error: unknown) => this.fail(error));
    if (this.encoder.state !== "closed") this.encoder.close();
    this.throwIfFailed();
    const preSkip = readOpusHeadPreSkip(this.description) ?? OPUS_DEFAULT_PRE_SKIP;
    return writeOggOpus({
      head: opusHead({ channels: this.channelCount, preSkip, inputSampleRate: this.sampleRate }),
      tags: opusTags(vendor, parrotOpusComments(tags)),
      packets: this.packets,
      preSkip,
      samples: samples48k,
    });
  }
}

/** Encodes 48 kHz sound held whole to the light copy's Ogg Opus bytes, with `tags` in its OpusTags. */
export const encodeOpusLightCopy = async (pcm: LightCopyPcm, tags: ParrotCopyTags, vendor: string): Promise<Uint8Array> => {
  if (pcm.sampleRate !== OPUS_GRANULE_RATE) throw new Error(`LIGHT_COPY_RATE: ${pcm.sampleRate}`);
  const writer = await OpusLightCopyWriter.open(OPUS_GRANULE_RATE, pcm.channels.length);
  const samples = pcm.channels[0]!.length;
  for (let start = 0; start < samples; start += FEED_FRAMES) {
    writer.push(pcm.channels.map((channel) => channel.subarray(start, Math.min(samples, start + FEED_FRAMES))));
    await writer.room();
  }
  return writer.finish(tags, vendor);
};

/** Down-mixes more than two channels to stereo: even channels to the left, odd ones to the right, averaged. */
const toStereo = (channels: Float32Array[]): Float32Array[] => {
  if (channels.length <= 2) return channels;
  const frames = channels[0]!.length;
  return [0, 1].map((side) => {
    const own = channels.filter((_, index) => index % 2 === side);
    const out = new Float32Array(frames);
    for (const channel of own) for (let i = 0; i < frames; i += 1) out[i]! += channel[i]! / own.length;
    return out;
  });
};

/** Plain WAV samples to planar floats. */
const pcmToPlanar = (bytes: Uint8Array, frames: number, channels: number, bits: number, float: boolean): Float32Array[] => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = bits / 8;
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const at = (frame * channels + channel) * width;
      out[channel]![frame] = float
        ? bits === 64
          ? view.getFloat64(at, true)
          : view.getFloat32(at, true)
        : bits === 8
          ? (view.getUint8(at) - 128) / 128
          : bits === 16
            ? view.getInt16(at, true) / 32_768
            : bits === 24
              ? ((view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getInt8(at + 2) << 16)) / 8_388_608)
              : view.getInt32(at, true) / 2_147_483_648;
    }
  }
  return out;
};

/**
 * Streams an original of `size` bytes through decoder and encoder, reading it a few MiB at a time with `read`
 * (`start..end` inclusive). Never holds the whole original or its whole sound.
 */
export const encodeStreamedLightCopy = async (input: {
  read: AlacByteReader;
  size: number;
  container: string;
  codec: string;
  tags: ParrotCopyTags;
  vendor: string;
}): Promise<Uint8Array> => {
  const { track, packets } = await openParrotAudioStream(input);
  // Set from the decoder's callbacks: typed by assertion so TypeScript does not narrow them to their first value.
  let writer = null as OpusLightCopyWriter | null;
  let opening = null as Promise<OpusLightCopyWriter> | null;
  // Cuts the decoded sound to the song (encoder delay and padding) and hands it to the encoder.
  let decoded = 0;
  let kept = 0;
  const take = (channels: Float32Array[], sampleRate: number) => {
    const ratio = sampleRate / track.sampleRate;
    const skip = Math.round(track.skipFrames * ratio);
    const total = track.totalFrames === null ? Infinity : Math.round(track.totalFrames * ratio);
    const frames = channels[0]?.length ?? 0;
    const from = Math.max(0, skip - decoded);
    const to = Math.min(frames, from + Math.max(0, total - kept));
    decoded += frames;
    if (to <= from) return;
    kept += to - from;
    writer!.push(toStereo(channels).map((channel) => channel.subarray(from, to)));
  };

  if (track.kind !== "webcodecs") {
    writer = await OpusLightCopyWriter.open(track.sampleRate, Math.min(2, track.channels));
    const alac = track.kind === "alac" ? new AlacDecoder(track.config) : null;
    const scale = track.kind === "alac" ? 1 / 2 ** (track.config.bitDepth - 1) : 1;
    for await (const packet of packets) {
      if (alac) {
        const samples = alac.decodeFrame(packet.bytes);
        take(
          samples.map((channel) => Float32Array.from(channel, (value) => value * scale)),
          track.sampleRate
        );
      } else if (track.kind === "pcm") take(pcmToPlanar(packet.bytes, packet.frames, track.channels, track.bits, track.float), track.sampleRate);
      await writer.room();
    }
    return writer.finish(input.tags, input.vendor);
  }

  // WebCodecs: the encoder opens on the first decoded sound (HE-AAC decodes at twice the rate its header says).
  let failure: unknown = null;
  const failed = { wake: () => {} };
  const pendingOutput: AudioData[] = [];
  const drain = () => {
    while (writer && pendingOutput.length) {
      const data = pendingOutput.shift()!;
      const channels = Array.from({ length: data.numberOfChannels }, (_, plane) => {
        const out = new Float32Array(data.numberOfFrames);
        data.copyTo(out, { planeIndex: plane, format: "f32-planar" });
        return out;
      });
      const rate = data.sampleRate;
      data.close();
      take(channels, rate);
    }
  };
  const decoder = new AudioDecoder({
    output: (data) => {
      pendingOutput.push(data);
      if (!writer && !opening) {
        opening = OpusLightCopyWriter.open(data.sampleRate, Math.min(2, data.numberOfChannels));
        opening.then(
          (opened) => {
            writer = opened;
            drain();
            failed.wake();
          },
          (error: unknown) => {
            failure ??= error;
            failed.wake();
          }
        );
      }
      drain();
    },
    error: (error) => {
      failure ??= error;
      failed.wake();
    },
  });
  const config: AudioDecoderConfig = {
    codec: track.codec,
    sampleRate: track.sampleRate,
    numberOfChannels: track.channels,
    ...(track.description ? { description: track.description } : {}),
  };
  const support = await AudioDecoder.isConfigSupported(config);
  if (!support.supported) throw new Error(`LIGHT_COPY_NO_DECODER: ${track.codec}`);
  decoder.configure(config);
  let timestamp = 0;
  const assertGoing = () => {
    if (failure) throw failure instanceof Error ? failure : new Error(String(failure));
  };
  for await (const packet of packets) {
    assertGoing();
    decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: Math.round((timestamp * 1_000_000) / track.sampleRate), data: packet.bytes }));
    timestamp += packet.frames;
    while (!failure && (decoder.decodeQueueSize > MAX_QUEUE || (writer?.encoder.encodeQueueSize ?? 0) > MAX_QUEUE || pendingOutput.length > MAX_QUEUE)) {
      await nextDequeue(writer ? [decoder, writer.encoder] : [decoder], failed);
    }
  }
  assertGoing();
  await decoder.flush();
  if (decoder.state !== "closed") decoder.close();
  if (opening) await opening;
  assertGoing();
  if (!writer) throw new Error("LIGHT_COPY_NOTHING_DECODED");
  drain();
  return (writer as OpusLightCopyWriter).finish(input.tags, input.vendor);
};

/** Bytes of the hidden window's original read whole, a few MiB per request. */
export const readWhole = async (read: AlacByteReader, size: number): Promise<Uint8Array> => {
  const bytes = new Uint8Array(size);
  for (let start = 0; start < size; start += 8 * 1024 * 1024) bytes.set(await read(start, Math.min(size, start + 8 * 1024 * 1024) - 1), start);
  return bytes;
};

/** Whether a song decodes whole (WHOLE_DECODE_MAX_MS, WHOLE_DECODE_MAX_BYTES) or streams. */
export const decodesWhole = (song: { size: number; durationMs: number | null }): boolean =>
  song.size <= WHOLE_DECODE_MAX_BYTES && (song.durationMs ?? 0) <= WHOLE_DECODE_MAX_MS;
