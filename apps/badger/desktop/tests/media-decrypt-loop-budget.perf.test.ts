// Perf lane (issue #3350 C6): the absolute main-loop budget of the media decrypt pool (issue #25). The gating suite
// checks the same work relative to the blocking reference (media-decrypt-event-loop.test.ts); this file keeps the
// 20 ms number itself, which only means something on an unloaded machine, so it runs in the non-gating perf lane
// (`bun run test:perf`, vitest.perf.config.ts) and never in the default suite.
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decryptMediaObject, deriveMediaMasterKey, encryptMediaObject, setMediaMasterKey } from "../src/main/mediaCrypto";
import { formatMs, measureIdleLoopDelayMs, measureLoopDelayMs } from "./_helpers/loopDelay";

const OBJECT_BYTES = 8 * 1024 * 1024;
const SEEK_FANOUT = 8;
const MAX_LOOP_DELAY_MS = 20;
const TRIALS = 7;

// Best of TRIALS: a one-off scheduler stall cannot fail the budget alone, a blocking decrypt fails every trial.
const bestLoopDelayMs = async (label: string, prepare: () => () => Promise<unknown>) => {
  const delaysMs: number[] = [];
  const idleMs: number[] = [];
  for (let i = 0; i < TRIALS; i += 1) {
    const work = prepare();
    idleMs.push(await measureIdleLoopDelayMs());
    delaysMs.push(await measureLoopDelayMs(work));
  }
  const bestMs = Math.min(...delaysMs);
  console.info(
    `[media-decrypt-loop-budget] ${label}: best ${bestMs.toFixed(1)} ms (budget ${MAX_LOOP_DELAY_MS} ms); ` +
      `trials ${formatMs(delaysMs)}; idle baseline ${formatMs(idleMs)}`,
  );
  return bestMs;
};

describe("media decrypt main-loop budget (perf lane, issue #25)", () => {
  let objects: Buffer[];

  beforeAll(async () => {
    setMediaMasterKey(deriveMediaMasterKey(crypto.randomBytes(32)));
    const plaintext = crypto.randomBytes(OBJECT_BYTES);
    objects = Array.from({ length: SEEK_FANOUT }, () => encryptMediaObject(plaintext, 32 * 1024));
    // Warm the pool so the measurement is steady-state.
    await decryptMediaObject(Buffer.from(objects[0]!));
  });

  afterAll(() => {
    setMediaMasterKey(null);
  });

  it(`keeps event-loop delay below ${MAX_LOOP_DELAY_MS} ms while decrypting an 8 MB object`, async () => {
    const bestMs = await bestLoopDelayMs("single 8 MB object", () => {
      const input = Buffer.from(objects[0]!);
      return () => decryptMediaObject(input);
    });
    expect(bestMs).toBeLessThan(MAX_LOOP_DELAY_MS);
  });

  it(`keeps event-loop delay below ${MAX_LOOP_DELAY_MS} ms during a seek fan-out of ${SEEK_FANOUT} × 8 MB objects`, async () => {
    const bestMs = await bestLoopDelayMs(`${SEEK_FANOUT} × 8 MB seek fan-out`, () => {
      const inputs = objects.map((item) => Buffer.from(item));
      return () => Promise.all(inputs.map((item) => decryptMediaObject(item)));
    });
    expect(bestMs).toBeLessThan(MAX_LOOP_DELAY_MS);
  });
});
