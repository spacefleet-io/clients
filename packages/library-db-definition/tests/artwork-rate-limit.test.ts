/**
 * @test-id META-ART-RATE-001
 * @level unit (pure shared copy, fake clock, no database, no network)
 * @req META-ART-01
 *
 * Why this exists: on the Jellyfin lane (2026-11-16) the migration of a long series hit the metadata service's 429
 * after 191 pictures and gave up on the other 207 at once (`failed: 207`), leaving them as provider paths until the
 * next library open. A rate limit is a "slow down", not a failure: the copy waits as long as the service asks
 * (Retry-After), or backs off when it does not say, and retries the same picture, so a series ends fully copied
 * without ever bursting at the service.
 */
import { describe, expect, it } from "vitest";
import {
  ARTWORK_COPY_RATE_LIMIT_MAX_RETRIES,
  ARTWORK_COPY_RATE_LIMIT_MAX_WAIT_MS,
  copyMediaArtwork,
  createVaultArtworkUpload,
  type ArtworkCopy,
  type ArtworkCopyStore,
  type ArtworkSlot,
  type ArtworkUploadOutcome,
} from "../src/artworkCopy";

const log = (phase: string, data?: unknown) =>
  console.info(`[artwork-rate-limit] ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const stills = (count: number): ArtworkSlot[] =>
  Array.from({ length: count }, (_, i) => ({ target: "episodeStill" as const, id: `e${i}`, path: `/still-${i}.jpg` }));

const memoryStore = (slots: ArtworkSlot[]) => {
  const applied: ArtworkCopy[] = [];
  const store: ArtworkCopyStore = {
    listArtworkToCopy: () => slots,
    applyArtworkCopies: (_mediaId, copies) => {
      applied.push(...copies);
      return { applied: copies.length, skipped: 0 };
    },
  };
  return { store, applied };
};

describe("rate-limited copy", () => {
  it("waits the service's Retry-After and retries the same picture until every slot is copied", async () => {
    log("phase: setup", { slots: 12, limitedAfter: 5 });
    const { store, applied } = memoryStore(stills(12));
    const calls: string[] = [];
    const waits: number[] = [];
    let limited = 0;
    const upload = async (_kind: string, path: string): Promise<ArtworkUploadOutcome> => {
      calls.push(path);
      // The 6th and 7th asks are refused: the service is over its rate.
      if (calls.length === 6 || calls.length === 7) {
        limited += 1;
        return { status: "rate_limited", retryAfterMs: 7_000 };
      }
      return { status: "ok", key: `asset:image/jpeg::assets/${path.slice(1)}.txt` };
    };
    log("phase: act");
    const result = await copyMediaArtwork({
      store,
      mediaId: "got",
      upload,
      concurrency: 1,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    log("phase: assert", { result, waits, calls: calls.length, limited });
    expect(result).toMatchObject({ total: 12, copied: 12, failed: 0, applied: 12, stoppedForRateLimit: false });
    expect(waits).toEqual([7_000, 7_000]);
    // The refused picture is asked again, never skipped.
    expect(calls[5]).toBe("/still-5.jpg");
    expect(calls[6]).toBe("/still-5.jpg");
    expect(calls[7]).toBe("/still-5.jpg");
    expect(applied.filter((copy) => copy.value !== null)).toHaveLength(12);
  });

  it("holds every worker while one is told to slow down", async () => {
    log("phase: setup", { slots: 9, concurrency: 3 });
    const { store } = memoryStore(stills(9));
    let releaseWait: () => void = () => {};
    let waiting = false;
    const startedWhileWaiting: string[] = [];
    let refusedOnce = false;
    const upload = async (_kind: string, path: string): Promise<ArtworkUploadOutcome> => {
      if (waiting) startedWhileWaiting.push(path);
      await Promise.resolve();
      if (!refusedOnce && path === "/still-1.jpg") {
        refusedOnce = true;
        return { status: "rate_limited", retryAfterMs: 1_000 };
      }
      return { status: "ok", key: `asset:image/jpeg::assets/${path.slice(1)}.txt` };
    };
    log("phase: act");
    const run = copyMediaArtwork({
      store,
      mediaId: "got",
      upload,
      concurrency: 3,
      sleep: (ms) => {
        log("wait", { ms });
        waiting = true;
        return new Promise<void>((resolve) => {
          releaseWait = () => {
            waiting = false;
            resolve();
          };
        });
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    log("phase: during the wait", { startedWhileWaiting });
    expect(waiting).toBe(true);
    releaseWait();
    const result = await run;
    log("phase: assert", { result, startedWhileWaiting });
    expect(startedWhileWaiting).toEqual([]);
    expect(result).toMatchObject({ total: 9, copied: 9, failed: 0 });
  });

  it("backs off when the service gives no Retry-After, caps the wait, and stops after too many refusals", async () => {
    log("phase: setup");
    const { store, applied } = memoryStore(stills(4));
    const waits: number[] = [];
    let calls = 0;
    const upload = async (): Promise<ArtworkUploadOutcome> => {
      calls += 1;
      return calls === 1 ? { status: "rate_limited", retryAfterMs: 10 * 60_000 } : { status: "rate_limited" };
    };
    log("phase: act");
    const result = await copyMediaArtwork({
      store,
      mediaId: "got",
      upload,
      concurrency: 1,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    log("phase: assert", { result, waits, calls });
    // A Retry-After beyond the cap is clamped; without one the wait doubles from 2 s, never above the cap.
    expect(waits[0]).toBe(ARTWORK_COPY_RATE_LIMIT_MAX_WAIT_MS);
    expect(waits.slice(1, 4)).toEqual([4_000, 8_000, 16_000]);
    expect(Math.max(...waits)).toBeLessThanOrEqual(ARTWORK_COPY_RATE_LIMIT_MAX_WAIT_MS);
    expect(waits).toHaveLength(ARTWORK_COPY_RATE_LIMIT_MAX_RETRIES);
    // Then the run stops: the pictures keep their paths for the next schedule.
    expect(result).toMatchObject({ total: 4, copied: 0, failed: 1, stoppedForRateLimit: true });
    expect(applied).toEqual([]);
  });

  it("the vault uploader passes the fetcher's rate limit through", async () => {
    const upload = createVaultArtworkUpload({
      fetchImage: async () => ({ status: "rate_limited", retryAfterMs: 3_000 }),
      storeEncrypted: async () => {
        throw new Error("never stored");
      },
    });
    const outcome = await upload("still", "/x.jpg");
    log("phase: assert", outcome);
    expect(outcome).toEqual({ status: "rate_limited", retryAfterMs: 3_000 });
  });
});
