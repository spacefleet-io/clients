/**
 * @test-id PARROT-CORE-COVER-CACHE-001
 * @level unit
 * @req PAR-META-04[parrot]
 * @why PAR-META-04 / PAR-COPY-01: the web player and the phone show album covers from the user's own storage through
 *   this one cache. A slip here downloads a cover again on every re-render, floods the storage tunnel with a grid's
 *   worth of downloads at once, keeps a broken cover blank for good, or leaks a cover past sign-out.
 * @covers packages/parrot-core/src/coverCache.ts
 */
import { describe, expect, it } from "bun:test";
import { createParrotCoverCache, PARROT_COVER_DOWNLOADS } from "../src/coverCache";

const log = (message: string, data?: unknown) => console.info(`[PARROT-CORE-COVER-CACHE-001] ${message}`, data === undefined ? "" : JSON.stringify(data));

/** A fetch whose downloads finish only when the test says so. */
const setup = (concurrency?: number) => {
  const started: string[] = [];
  const failures: string[] = [];
  const pending = new Map<string, { resolve: (address: string | null) => void; reject: (error: Error) => void }>();
  let running = 0;
  let mostAtOnce = 0;
  const cache = createParrotCoverCache({
    concurrency,
    fetch: (objectKey) => {
      started.push(objectKey);
      running += 1;
      mostAtOnce = Math.max(mostAtOnce, running);
      const { promise, resolve, reject } = Promise.withResolvers<string | null>();
      pending.set(objectKey, { resolve, reject });
      return promise.finally(() => {
        running -= 1;
      });
    },
    failed: (objectKey, error) => failures.push(`${objectKey}: ${error instanceof Error ? error.message : String(error)}`),
  });
  const finish = async (objectKey: string, address: string | null | Error) => {
    const job = pending.get(objectKey)!;
    pending.delete(objectKey);
    if (address instanceof Error) job.reject(address);
    else job.resolve(address);
    // Let the cache's promise chain (keep the address, hand the slot on) settle: microtasks only, no clock.
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  return { cache, started, failures, finish, mostAtOnce: () => mostAtOnce };
};

describe("parrot cover cache", () => {
  it("fetches a cover once, shares one fetch between two asks, and answers a kept one at once", async () => {
    const { cache, started, finish } = setup();
    const first = cache.load("assets/1");
    const second = cache.load("assets/1");
    expect(cache.peek("assets/1")).toBeNull();
    await finish("assets/1", "blob:1");
    expect(await first).toBe("blob:1");
    expect(await second).toBe("blob:1");
    expect(cache.peek("assets/1")).toBe("blob:1");
    expect(await cache.load("assets/1")).toBe("blob:1");
    log("started", started);
    expect(started).toEqual(["assets/1"]);
  });

  // @bugfix @regression-proof: a kept cover whose picture turns out broken can be fetched again (the phone deletes
  // the bad file first); the other kept covers stay.
  it("forgets one kept cover so the next ask fetches it again", async () => {
    const { cache, started, finish } = setup();
    const one = cache.load("assets/1");
    const two = cache.load("assets/2");
    await finish("assets/1", "file:///1.img");
    await finish("assets/2", "file:///2.img");
    await Promise.all([one, two]);
    cache.forget("assets/1");
    expect(cache.peek("assets/1")).toBeNull();
    expect(cache.peek("assets/2")).toBe("file:///2.img");
    const again = cache.load("assets/1");
    await finish("assets/1", "file:///1.img");
    log("after forget", { started });
    expect(await again).toBe("file:///1.img");
    expect(started).toEqual(["assets/1", "assets/2", "assets/1"]);
  });

  it("runs at most the limit of fetches at once, in the order asked", async () => {
    const { cache, started, finish, mostAtOnce } = setup();
    const keys = Array.from({ length: 10 }, (_, i) => `assets/${i}`);
    const loads = keys.map((key) => cache.load(key));
    expect(started).toEqual(keys.slice(0, PARROT_COVER_DOWNLOADS));
    expect(cache.stats()).toEqual({ kept: 0, running: PARROT_COVER_DOWNLOADS, waiting: 10 - PARROT_COVER_DOWNLOADS });
    for (const key of keys) await finish(key, `blob:${key}`);
    expect(await Promise.all(loads)).toEqual(keys.map((key) => `blob:${key}`));
    log("order", { started, mostAtOnce: mostAtOnce() });
    expect(started).toEqual(keys);
    expect(mostAtOnce()).toBe(PARROT_COVER_DOWNLOADS);
    expect(cache.stats()).toEqual({ kept: 10, running: 0, waiting: 0 });
  });

  it("answers null for a failed or non-picture cover, keeps neither, and tries a failure again on the next ask", async () => {
    const { cache, started, failures, finish } = setup();
    const broken = cache.load("assets/broken");
    const text = cache.load("assets/text");
    await finish("assets/broken", new Error("download failed: 502"));
    await finish("assets/text", null);
    expect(await broken).toBeNull();
    expect(await text).toBeNull();
    log("failures", failures);
    expect(failures).toEqual(["assets/broken: download failed: 502"]);
    expect(cache.peek("assets/broken")).toBeNull();
    const again = cache.load("assets/broken");
    await finish("assets/broken", "blob:fixed");
    expect(await again).toBe("blob:fixed");
    expect(started.filter((key) => key === "assets/broken")).toHaveLength(2);
  });

  it("release answers the kept addresses, drops waiting fetches and keeps nothing a running one brings back", async () => {
    const { cache, started, finish } = setup(1);
    const kept = cache.load("assets/kept");
    await finish("assets/kept", "blob:kept");
    await kept;
    const running = cache.load("assets/running");
    const waiting = cache.load("assets/waiting");
    expect(cache.release()).toEqual(["blob:kept"]);
    expect(await waiting).toBeNull();
    await finish("assets/running", "blob:late");
    expect(await running).toBeNull();
    expect(cache.peek("assets/running")).toBeNull();
    expect(cache.peek("assets/kept")).toBeNull();
    log("started", started);
    expect(started).toEqual(["assets/kept", "assets/running"]);
    // The cache works again after a release, its slot freed by the late fetch.
    const next = cache.load("assets/next");
    await finish("assets/next", "blob:next");
    expect(await next).toBe("blob:next");
  });

  it("passes the current() check that turns false once released", async () => {
    let seen: (() => boolean) | null = null;
    const cache = createParrotCoverCache({
      fetch: async (_objectKey, current) => {
        seen = current;
        return "blob:1";
      },
      failed: () => undefined,
    });
    await cache.load("assets/1");
    expect(seen!()).toBe(true);
    cache.release();
    expect(seen!()).toBe(false);
  });
});

/**
 * @test-id PARROT-CORE-COVER-KEEP-001
 * @level unit
 * @req PAR-COPY-01[parrot]
 * @why Chris 2026-11-16: the local copy of the vault's pictures is bounded by bytes. The desktop and the phone keep
 *   covers on disk across restarts; without a bound that folder grows with every album ever shown. This is the one
 *   rule both use to choose what goes: the least recently shown covers first, never the one just kept.
 */
describe("PARROT-CORE-COVER-KEEP-001 the kept covers' byte bound", () => {
  const log = (phase: string, detail: unknown) => console.info(`[PARROT-CORE-COVER-KEEP-001] phase=${phase}`, JSON.stringify(detail));

  it("drops the least recently shown covers until the rest fit, never the one just kept", async () => {
    const { parrotCoversToDrop } = await import("../src/coverCache");
    const kept = [
      { name: "new", size: 40, usedAt: 50 },
      { name: "old", size: 30, usedAt: 10 },
      { name: "mid", size: 30, usedAt: 30 },
      { name: "fresh", size: 20, usedAt: 40 },
    ];
    log("arrange", { kept, maxBytes: 70 });
    const drop = parrotCoversToDrop(kept, 70, "new");
    log("assert", { drop });
    expect(drop).toEqual(["old", "mid"]);
    expect(parrotCoversToDrop(kept, 1_000)).toEqual([]);
    // The cover just kept stays even when it alone is over the bound.
    expect(parrotCoversToDrop([{ name: "huge", size: 500, usedAt: 1 }, { name: "a", size: 1, usedAt: 2 }], 100, "huge")).toEqual(["a"]);
  });

  it("sets a bound per device", async () => {
    const { PARROT_COVER_KEEP_BYTES } = await import("../src/coverCache");
    log("bounds", PARROT_COVER_KEEP_BYTES);
    expect(PARROT_COVER_KEEP_BYTES.desktop).toBeGreaterThan(PARROT_COVER_KEEP_BYTES.phone);
    expect(PARROT_COVER_KEEP_BYTES.phone).toBeGreaterThanOrEqual(50 * 1024 * 1024);
  });
});
