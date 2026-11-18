import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { syntheticYuvInput, WAV_CHANNEL_MASKS, writeSyntheticYuv, writeToneWav } from "../src/syntheticMedia";

const dir = mkdtempSync(join(tmpdir(), "sf-synthetic-media-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("synthetic media", () => {
  it("writes whole yuv420p frames, identical for the same seed and different for another", () => {
    const a = join(dir, "a.yuv");
    const b = join(dir, "b.yuv");
    const c = join(dir, "c.yuv");
    writeSyntheticYuv(a, { width: 64, height: 36, frames: 3 });
    writeSyntheticYuv(b, { width: 64, height: 36, frames: 3 });
    writeSyntheticYuv(c, { width: 64, height: 36, frames: 3, seed: 2 });
    expect(statSync(a).size).toBe(3 * ((64 * 36 * 3) / 2));
    expect(readFileSync(a).equals(readFileSync(b))).toBe(true);
    expect(readFileSync(a).equals(readFileSync(c))).toBe(false);
  });

  it("changes the picture from frame to frame", () => {
    const path = join(dir, "moving.yuv");
    writeSyntheticYuv(path, { width: 32, height: 32, frames: 2 });
    const frameSize = (32 * 32 * 3) / 2;
    const bytes = readFileSync(path);
    expect(bytes.subarray(0, frameSize).equals(bytes.subarray(frameSize))).toBe(false);
  });

  it("builds ffmpeg rawvideo input arguments", () => {
    expect(syntheticYuvInput("/x/clip.yuv", { width: 640, height: 360, rate: 25, seconds: 12 })).toEqual([
      "-f", "rawvideo", "-pixel_format", "yuv420p", "-video_size", "640x360", "-framerate", "25",
      "-stream_loop", "-1", "-i", "/x/clip.yuv", "-t", "12",
    ]);
  });

  it("writes a canonical 16-bit mono wav", () => {
    const path = join(dir, "tone.wav");
    writeToneWav(path, { hz: 440, seconds: 0.5, sampleRate: 8000 });
    const bytes = readFileSync(path);
    expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
    expect(bytes.toString("ascii", 8, 16)).toBe("WAVEfmt ");
    expect(bytes.readUInt32LE(24)).toBe(8000);
    expect(bytes.readUInt32LE(40)).toBe(4000 * 2);
    expect(bytes.length).toBe(44 + 4000 * 2);
  });

  it("writes a multichannel wav as WAVE_FORMAT_EXTENSIBLE carrying the layout's channel mask", () => {
    const path = join(dir, "side.wav");
    writeToneWav(path, { hz: 440, seconds: 0.5, sampleRate: 8000, channelMask: WAV_CHANNEL_MASKS["5.1(side)"] });
    const bytes = readFileSync(path);
    console.info(`[synthetic-media] 5.1(side) wav header=${bytes.subarray(0, 68).toString("hex")}`);
    expect(bytes.readUInt32LE(16)).toBe(40); // fmt chunk size
    expect(bytes.readUInt16LE(20)).toBe(0xfffe);
    expect(bytes.readUInt16LE(22)).toBe(6);
    expect(bytes.readUInt16LE(32)).toBe(12); // block align
    expect(bytes.readUInt32LE(40)).toBe(0x60f);
    expect(bytes.toString("ascii", 60, 64)).toBe("data");
    expect(bytes.readUInt32LE(64)).toBe(4000 * 12);
    expect(bytes.readUInt32LE(4)).toBe(bytes.length - 8);
    // Every channel carries the same tone.
    const frame = bytes.subarray(68 + 12 * 5, 68 + 12 * 6);
    for (let channel = 1; channel < 6; channel += 1) expect(frame.readInt16LE(channel * 2)).toBe(frame.readInt16LE(0));
  });
});
