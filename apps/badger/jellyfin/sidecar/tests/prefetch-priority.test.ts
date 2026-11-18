import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { defaultPrefetchPlan, loadIntegrationConfig } from "../src/config";
import { type ObjectFetcher, ObjectStore } from "../src/objectStore";

const GIB = 1024 * 1024 * 1024;
const KEYS = Array.from({ length: 80 }, (_, index) => `s${index}`);

/** A download of `chunks` chunks, 1 ms apart, that honours the store's pause between chunks like the tunnel does. */
const chunkedFetcher = (chunks: number, received: string[], started: string[]): ObjectFetcher =>
  async (key, _purpose, onChunk) => {
    started.push(key);
    for (let index = 0; index < chunks; index += 1) {
      await sleep(1);
      received.push(key);
      await onChunk?.();
    }
    return Buffer.from(key);
  };

describe("the wanted segment goes before prefetches (#955)", () => {
  it("@req INTG-JF-06[badger-jellyfin] prefetch depth and parallelism follow the host, an explicit count still wins", () => {
    expect(defaultPrefetchPlan(2, 16 * GIB)).toEqual({ count: 1, parallel: 1 });
    expect(defaultPrefetchPlan(8, 4 * GIB)).toEqual({ count: 1, parallel: 1 });
    expect(defaultPrefetchPlan(4, 8 * GIB)).toEqual({ count: 2, parallel: 1 });
    expect(defaultPrefetchPlan(8, 8 * GIB)).toEqual({ count: 2, parallel: 1 });
    expect(defaultPrefetchPlan(8, 16 * GIB)).toEqual({ count: 3, parallel: 2 });

    const lowEnd = loadIntegrationConfig({}, "/tmp", 8 * GIB, 4);
    expect([lowEnd.prefetchCount, lowEnd.prefetchParallel]).toEqual([2, 1]);
    const strong = loadIntegrationConfig({ HEADLESS_PREFETCH_COUNT: "1" }, "/tmp", 32 * GIB, 16);
    expect([strong.prefetchCount, strong.prefetchParallel]).toEqual([1, 1]);
    const off = loadIntegrationConfig({ HEADLESS_PREFETCH_COUNT: "0" }, "/tmp", 32 * GIB, 16);
    expect(off.prefetchCount).toBe(0);
  });

  it("@req INTG-JF-06[badger-jellyfin] running prefetches pause while a seek target downloads, then finish", async () => {
    const received: string[] = [];
    const started: string[] = [];
    const store = new ObjectStore({ fetcher: chunkedFetcher(20, received, started), masterKey: null, prefetchCount: 3, prefetchParallel: 3 });
    store.registerSequence(KEYS);

    await store.get("s0");
    expect(started).toEqual(["s0", "s1", "s2", "s3"]);
    expect(store.stats.prefetchRunning).toBe(3);

    const from = received.length;
    await store.get("s50");
    const during = received.slice(from, received.lastIndexOf("s50") + 1);
    expect(during.filter((key) => key === "s50")).toHaveLength(20);
    // Each prefetch may finish the one chunk it was already receiving, then waits.
    for (const key of ["s1", "s2", "s3"]) expect(during.filter((entry) => entry === key).length, key).toBeLessThanOrEqual(1);

    await expect.poll(() => store.stats.inflight + store.stats.prefetchQueued, { timeout: 5_000 }).toBe(0);
    for (const key of ["s1", "s2", "s3", "s51", "s52", "s53"]) expect(received.filter((entry) => entry === key), key).toHaveLength(20);
  });

  it("@req INTG-JF-06[badger-jellyfin] a seek drops the prefetches still queued for the old position", async () => {
    const received: string[] = [];
    const started: string[] = [];
    const store = new ObjectStore({ fetcher: chunkedFetcher(5, received, started), masterKey: null, prefetchCount: 3, prefetchParallel: 1 });
    store.registerSequence(KEYS);

    await store.get("s0");
    expect(store.stats).toMatchObject({ prefetchRunning: 1, prefetchQueued: 2 });
    await store.get("s40");
    await expect.poll(() => store.stats.inflight + store.stats.prefetchQueued, { timeout: 5_000 }).toBe(0);

    expect(started).toEqual(["s0", "s1", "s40", "s41", "s42", "s43"]);
  });

  it("@req INTG-JF-06[badger-jellyfin] asking for a segment that is being prefetched waits for that download, not a new one", async () => {
    const received: string[] = [];
    const started: string[] = [];
    const store = new ObjectStore({ fetcher: chunkedFetcher(5, received, started), masterKey: null, prefetchCount: 2, prefetchParallel: 1 });
    store.registerSequence(KEYS);

    await store.get("s0");
    expect((await store.get("s1")).toString()).toBe("s1");
    expect(started.filter((key) => key === "s1")).toHaveLength(1);
  });
});
