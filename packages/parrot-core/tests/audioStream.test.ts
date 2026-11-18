import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { openParrotAudioStream, type ParrotAudioPacket } from "../src/audioStream";

// 2.5 s of a 440 Hz tone at 44.1 kHz, stereo, in each format Parrot imports (0.5 s for WAV); made with
// `ffmpeg -f lavfi -i sine=frequency=440:sample_rate=44100:duration=2.5 -ac 2 …`.
const dir = join(import.meta.dir, "fixtures", "stream");
const SAMPLES = 110_250;

/** Opens a fixture reading 1000 bytes at a time, so frames cross reads as they do in a long file's 4 MiB blocks. */
const open = async (name: string, container: string, codec: string) => {
  const bytes = new Uint8Array(readFileSync(join(dir, name)));
  const requests: number[] = [];
  const stream = await openParrotAudioStream({
    size: bytes.length,
    container,
    codec,
    blockBytes: 1000,
    read: async (start, end) => {
      requests.push(end + 1 - start);
      return bytes.slice(start, end + 1);
    },
  });
  const packets: ParrotAudioPacket[] = [];
  for await (const packet of stream.packets) packets.push(packet);
  return { track: stream.track, packets, frames: packets.reduce((sum, packet) => sum + packet.frames, 0), bytes, requests };
};

describe("openParrotAudioStream (PAR-FMT-02 light copies of any length)", () => {
  it("cuts MP3 frames and reads LAME's delay and padding (the Info frame is not audio)", async () => {
    const { track, packets, frames } = await open("tone.mp3", "mp3", "mp3");
    expect(track).toMatchObject({ kind: "webcodecs", codec: "mp3", sampleRate: 44_100, channels: 2, totalFrames: SAMPLES });
    expect(track.skipFrames).toBeGreaterThan(529);
    expect(packets.every((packet) => packet.bytes[0] === 0xff && packet.frames === 1152)).toBe(true);
    expect(frames - track.skipFrames).toBeGreaterThanOrEqual(SAMPLES);
  });

  it("cuts FLAC frames at real frame headers and describes the stream with its STREAMINFO", async () => {
    const { track, packets, frames, bytes } = await open("tone.flac", "flac", "flac");
    expect(track).toMatchObject({ kind: "webcodecs", codec: "flac", sampleRate: 44_100, channels: 2, totalFrames: SAMPLES, skipFrames: 0 });
    if (track.kind !== "webcodecs") throw new Error("kind");
    expect(Array.from(track.description!.subarray(0, 5))).toEqual([0x66, 0x4c, 0x61, 0x43, 0x80]);
    expect(frames).toBe(SAMPLES);
    // Every byte after the metadata lands in exactly one frame.
    const audio = packets.reduce((sum, packet) => sum + packet.bytes.length, 0);
    expect(bytes.length - audio).toBeLessThan(8_500);
    expect(packets.every((packet) => packet.bytes[0] === 0xff && (packet.bytes[1]! & 0xfe) === 0xf8)).toBe(true);
  });

  it("cuts ADTS frames whole (WebCodecs takes them without a description)", async () => {
    const { track, packets, frames } = await open("tone.aac", "adts", "aac");
    expect(track).toMatchObject({ kind: "webcodecs", codec: "mp4a.40.2", description: null, sampleRate: 44_100, channels: 2 });
    expect(packets.every((packet) => packet.bytes[0] === 0xff)).toBe(true);
    expect(frames).toBeGreaterThanOrEqual(SAMPLES);
  });

  it("reads an AAC .m4a's frames from its sample table, with its AudioSpecificConfig and edit list", async () => {
    const { track, frames } = await open("tone.m4a", "mp4", "aac");
    expect(track).toMatchObject({ kind: "webcodecs", codec: "mp4a.40.2", sampleRate: 44_100, channels: 2, skipFrames: 1024, totalFrames: SAMPLES });
    if (track.kind !== "webcodecs") throw new Error("kind");
    expect(track.description!.length).toBeGreaterThanOrEqual(2);
    expect(frames).toBeGreaterThanOrEqual(SAMPLES + 1024);
  });

  it("reads an Apple Lossless .m4a's frames for ParrotAlac's decoder", async () => {
    const { track, frames } = await open("tone-alac.m4a", "mp4", "alac");
    expect(track).toMatchObject({ kind: "alac", sampleRate: 44_100, channels: 2, totalFrames: SAMPLES });
    expect(frames).toBeGreaterThanOrEqual(SAMPLES);
  });

  it("joins Ogg pages into Opus packets, the OpusHead as description and the length from the last granule", async () => {
    const { track, packets, frames } = await open("tone.opus", "ogg", "opus");
    expect(track).toMatchObject({ kind: "webcodecs", codec: "opus", sampleRate: 48_000, channels: 2, totalFrames: 120_000 });
    if (track.kind !== "webcodecs") throw new Error("kind");
    expect(new TextDecoder().decode(track.description!.subarray(0, 8))).toBe("OpusHead");
    expect(packets.length).toBeGreaterThan(100);
    expect(frames).toBeGreaterThanOrEqual(120_000);
  });

  it("joins Ogg pages into Vorbis packets, the three headers Xiph-laced as description", async () => {
    const { track, packets } = await open("tone.ogg", "ogg", "vorbis");
    expect(track).toMatchObject({ kind: "webcodecs", codec: "vorbis", sampleRate: 44_100, channels: 2, totalFrames: SAMPLES });
    if (track.kind !== "webcodecs") throw new Error("kind");
    expect(track.description![0]).toBe(2);
    expect(packets.length).toBeGreaterThan(50);
  });

  it("hands over WAV samples as they are, in blocks", async () => {
    const { track, frames } = await open("tone.wav", "wav", "pcm_s16le");
    expect(track).toMatchObject({ kind: "pcm", float: false, bits: 16, sampleRate: 44_100, channels: 2, totalFrames: 22_050 });
    expect(frames).toBe(22_050);
  });

  it("reads the frames a block at a time, never the whole file", async () => {
    for (const [name, container, codec] of [
      ["tone.flac", "flac", "flac"],
      ["tone.mp3", "mp3", "mp3"],
      ["tone-alac.m4a", "mp4", "alac"],
    ] as const) {
      const { requests, bytes } = await open(name, container, codec);
      expect(requests.length).toBeGreaterThan(5);
      // The MP4 index (`moov`) is read whole; it holds no audio.
      expect(Math.max(...requests)).toBeLessThan(bytes.length / 4);
    }
  });
});
