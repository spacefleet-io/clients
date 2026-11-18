// @bugfix @regression-proof issue #25 — NEW-main-sync-decrypt. The playback
// server decrypted every SFV1 media object with a synchronous
// createDecipheriv on the Electron main event loop (playbackServer.ts
// getObjectPayload / local-object paths, mediaCrypto.ts decryptMediaObject).
// The ultimate run saw the main loop blocked up to 301 ms per segment, which
// showed up as jank and slow seeks.
//
// Fix: decryptMediaObject is async and runs AES-256-GCM on a small
// worker_thread pool (mediaDecryptPool.ts), transferring the payload memory
// instead of copying it. Output is byte-identical and the GCM auth tag is
// still verified. decryptMediaObject takes ownership of its input, so every
// call below hands it a fresh copy.
//
// A seek fans out to the target segment plus its prefetch keys
// (HLS_OBJECT_PREFETCH_COUNT 4 × up to 2 pools = 8). The burst case decrypts
// 8 × 8 MB at once, so a blocking implementation shows up on fast AES-NI dev
// hardware as well as on the slow home PCs the run stood in for.
//
// Load noise: CI runs ~300 test files in 11 parallel forks on a shared
// runner, so the OS can deschedule this thread for tens of ms no matter what
// it runs (staging CI job 29750 saw 46 ms / 80 ms after the fix landed). Each
// case therefore takes the BEST of TRIALS measurements against the unchanged
// 20 ms budget. A blocking decrypt fails every trial (the sync fan-out blocked
// 38–72 ms on each run), so the best trial still catches it, while a
// one-off scheduler stall cannot fail the test alone. Every trial also logs
// an idle baseline (same window, no work) so a failure shows whether the
// runner itself was stalling.
import crypto from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  decryptMediaObject,
  deriveMediaMasterKey,
  deriveObjectKey,
  encryptMediaObject,
  MAGIC,
  NONCE_BYTES,
  SALT_BYTES,
  setMediaMasterKey,
} from "../src/main/mediaCrypto";

const OBJECT_BYTES = 8 * 1024 * 1024;
const SEEK_FANOUT = 8;
const MAX_LOOP_DELAY_MS = 20;
const TRIALS = 7;

const masterKey = deriveMediaMasterKey(crypto.randomBytes(32));

// The pre-fix synchronous implementation, kept as the byte-identity oracle.
const referenceDecrypt = (payload: Buffer) => {
  const salt = payload.subarray(MAGIC.length, MAGIC.length + SALT_BYTES);
  const nonceStart = MAGIC.length + SALT_BYTES;
  const nonce = payload.subarray(nonceStart, nonceStart + NONCE_BYTES);
  const decipher = crypto.createDecipheriv("aes-256-gcm", deriveObjectKey(masterKey, salt), nonce);
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(payload.subarray(payload.length - 16));
  const decrypted = Buffer.concat([
    decipher.update(payload.subarray(nonceStart + NONCE_BYTES, payload.length - 16)),
    decipher.final(),
  ]);
  return decrypted.subarray(6, 6 + decrypted.readUInt32LE(0));
};

// Real timers on purpose: monitorEventLoopDelay samples the real event loop
// against the platform clock, which fake timers cannot drive.
const measureLoopDelayMs = async (work: () => Promise<unknown>) => {
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  histogram.enable();
  // Let the histogram's timer arm before the work starts.
  await sleep(5);
  await work();
  await sleep(5);
  histogram.disable();
  return histogram.max / 1e6;
};

type TrialReport = { label: string; delaysMs: number[]; idleMs: number[]; bestMs: number };

// Runs `trial` TRIALS times, each preceded by an idle-baseline measurement,
// and returns the best (lowest) max loop delay plus the full log.
const measureBestOfTrials = async (label: string, prepare: () => () => Promise<unknown>): Promise<TrialReport> => {
  const delaysMs: number[] = [];
  const idleMs: number[] = [];
  for (let i = 0; i < TRIALS; i += 1) {
    // Prepare outside the window: inputs are copied fresh each trial because
    // decryptMediaObject takes ownership of (and may detach) its input.
    const work = prepare();
    idleMs.push(await measureLoopDelayMs(() => sleep(1)));
    delaysMs.push(await measureLoopDelayMs(work));
  }
  const report = { label, delaysMs, idleMs, bestMs: Math.min(...delaysMs) };
  console.info(
    `[media-decrypt-event-loop] ${label}: best max loop delay ${report.bestMs.toFixed(1)} ms; ` +
      `trials [${delaysMs.map((ms) => ms.toFixed(1)).join(", ")}] ms; ` +
      `idle baseline [${idleMs.map((ms) => ms.toFixed(1)).join(", ")}] ms`,
  );
  return report;
};

describe("media object decrypt keeps the main event loop free (@bugfix @regression-proof issue #25)", () => {
  let plaintext: Buffer;
  let payload: Buffer;

  beforeAll(() => {
    setMediaMasterKey(masterKey);
    plaintext = crypto.randomBytes(OBJECT_BYTES);
    payload = encryptMediaObject(plaintext, 32 * 1024);
  });

  afterAll(() => {
    setMediaMasterKey(null);
  });

  it("returns byte-identical plaintext to the synchronous GCM reference", async () => {
    const result = await decryptMediaObject(Buffer.from(payload));
    expect(result.wasEncrypted).toBe(true);
    expect(Buffer.isBuffer(result.plaintext)).toBe(true);
    expect(result.plaintext.equals(plaintext)).toBe(true);
    expect(result.plaintext.equals(referenceDecrypt(payload))).toBe(true);
  });

  it("still verifies the auth tag and rejects tampered objects", async () => {
    const badTag = Buffer.from(payload);
    badTag[badTag.length - 1] ^= 0x01;
    await expect(decryptMediaObject(badTag)).rejects.toThrow();

    const badCiphertext = Buffer.from(payload);
    badCiphertext[MAGIC.length + SALT_BYTES + NONCE_BYTES + 100] ^= 0x01;
    await expect(decryptMediaObject(badCiphertext)).rejects.toThrow();
  });

  it("passes plaintext objects through untouched", async () => {
    const raw = Buffer.from("WEBVTT\n\n00:00.000 --> 00:01.000\nhi\n");
    const result = await decryptMediaObject(raw);
    expect(result.wasEncrypted).toBe(false);
    expect(result.plaintext).toBe(raw);
  });

  it("decrypts a payload that shares its ArrayBuffer without detaching the neighbours", async () => {
    const shared = Buffer.alloc(payload.length + 64, 0xab);
    payload.copy(shared, 32);
    const view = shared.subarray(32, 32 + payload.length);
    const result = await decryptMediaObject(view);
    expect(result.plaintext.equals(plaintext)).toBe(true);
    expect(shared.length).toBe(payload.length + 64);
    expect(shared[0]).toBe(0xab);
    expect(view.equals(payload)).toBe(true);
  });

  it(`keeps event-loop delay below ${MAX_LOOP_DELAY_MS} ms while decrypting an 8 MB object`, async () => {
    // Warm the pool so the measurement is steady-state.
    await decryptMediaObject(Buffer.from(payload));
    const results: Buffer[] = [];
    const report = await measureBestOfTrials("single 8 MB object", () => {
      const input = Buffer.from(payload);
      return async () => {
        results.push((await decryptMediaObject(input)).plaintext);
      };
    });
    expect(results).toHaveLength(TRIALS);
    expect(results.every((result) => result.equals(plaintext))).toBe(true);
    expect(report.bestMs).toBeLessThan(MAX_LOOP_DELAY_MS);
  });

  it(`keeps event-loop delay below ${MAX_LOOP_DELAY_MS} ms during a seek fan-out of ${SEEK_FANOUT} × 8 MB objects`, async () => {
    const encrypted = Array.from({ length: SEEK_FANOUT }, () => encryptMediaObject(plaintext, 32 * 1024));
    await decryptMediaObject(Buffer.from(payload));
    const results: Buffer[] = [];
    const report = await measureBestOfTrials(`${SEEK_FANOUT} × 8 MB seek fan-out`, () => {
      const inputs = encrypted.map((item) => Buffer.from(item));
      return async () => {
        const decrypted = await Promise.all(inputs.map((item) => decryptMediaObject(item)));
        results.push(...decrypted.map((result) => result.plaintext));
      };
    });
    expect(results).toHaveLength(TRIALS * SEEK_FANOUT);
    expect(results.every((result) => result.equals(plaintext))).toBe(true);
    expect(report.bestMs).toBeLessThan(MAX_LOOP_DELAY_MS);
  });
});
