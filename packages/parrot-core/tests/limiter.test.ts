import { describe, expect, it } from "bun:test";
import { PARROT_LIMITER, ParrotLimiter } from "../src/limiter";

const TAG = "[PARROT-CORE-LIMITER]";
const RATE = 48_000;
const CEILING = 10 ** (PARROT_LIMITER.thresholdDb / 20);

const sine = (hz: number, amplitude: number, seconds: number) =>
  Float32Array.from({ length: Math.round(seconds * RATE) }, (_, index) => amplitude * Math.sin((2 * Math.PI * hz * index) / RATE));

/** Runs both channels through the limiter in 128-sample blocks, as an audio worklet does. */
const run = (limiter: ParrotLimiter, left: Float32Array, right: Float32Array) => {
  const out = [new Float32Array(left.length), new Float32Array(right.length)];
  for (let start = 0; start < left.length; start += 128) {
    const frames = Math.min(128, left.length - start);
    limiter.process([left.subarray(start, start + frames), right.subarray(start, start + frames)], [out[0]!.subarray(start, start + frames), out[1]!.subarray(start, start + frames)], frames);
  }
  return out;
};

const loudest = (channels: Float32Array[]) => Math.max(...channels.map((samples) => samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0)));

describe("Even out volume limiter at Loud (PAR-PLAY-03 item 2)", () => {
  // @req PAR-PLAY-03
  it("keeps every sample at or under −1 dB when Loud lifts a song past full scale", () => {
    console.info(TAG, "[ceiling] phase: a song lifted +9 dB, peaks near +6 dBFS, with sudden drum hits");
    const lift = 10 ** (9 / 20);
    const left = sine(220, 0.5 * lift, 2);
    const right = sine(331, 0.45 * lift, 2);
    for (let hit = 0; hit < 8; hit += 1) left[Math.round((hit + 0.5) * RATE * 0.25)] = 0.99 * lift * (hit % 2 ? -1 : 1);
    const limiter = new ParrotLimiter(RATE, 2);
    const out = run(limiter, left, right);
    const peak = loudest(out);
    console.info(TAG, "[ceiling] input peak", loudest([left, right]).toFixed(4), "output peak", peak.toFixed(6), "ceiling", CEILING.toFixed(6), "latency", limiter.latency);
    expect(loudest([left, right])).toBeGreaterThan(1.5);
    expect(peak).toBeLessThanOrEqual(CEILING + 1e-6);
    expect(limiter.latency).toBe(Math.round((RATE * PARROT_LIMITER.attackMs) / 1000) - 1);
  });

  // @req PAR-PLAY-03
  it("passes audio under −1 dB through untouched, only delayed by the 5 ms look-ahead", () => {
    const left = sine(440, 0.5, 0.5);
    const right = sine(550, 0.8, 0.5);
    const limiter = new ParrotLimiter(RATE, 2);
    const out = run(limiter, left, right);
    let worst = 0;
    for (let index = limiter.latency; index < left.length; index += 1) {
      worst = Math.max(worst, Math.abs(out[0]![index]! - left[index - limiter.latency]!), Math.abs(out[1]![index]! - right[index - limiter.latency]!));
    }
    console.info(TAG, "[clean] largest difference from the delayed input", worst, "gain", limiter.currentGain);
    expect(worst).toBeLessThan(1e-6);
    expect(limiter.currentGain).toBe(1);
  });

  // @req PAR-PLAY-03
  it("comes back up with the 100 ms decay after a peak, and does nothing while off", () => {
    const limiter = new ParrotLimiter(RATE, 1);
    const burst = new Float32Array(RATE);
    burst.fill(2, 0, 480);
    burst.fill(0.1, 480);
    const out = new Float32Array(RATE);
    limiter.process([burst], [out], burst.length);
    const at = (ms: number) => out[Math.round((ms / 1000) * RATE) + limiter.latency]! / 0.1;
    console.info(TAG, "[decay] gain 10 ms, 100 ms, 500 ms after the burst", at(20), at(110), at(510));
    expect(at(110)).toBeGreaterThan(at(20));
    expect(at(110)).toBeLessThan(1);
    expect(at(510)).toBeGreaterThan(0.99);
    const off = new ParrotLimiter(RATE, 1);
    off.limiting = false;
    const passed = new Float32Array(RATE);
    off.process([burst], [passed], burst.length);
    console.info(TAG, "[off] peak with the limiter off", loudest([passed]));
    expect(loudest([passed])).toBe(2);
  });
});
