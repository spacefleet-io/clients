/**
 * Artwork costs one anonymous ticket per image (META-ART-02), so it is kept on disk: a library grid must not
 * re-buy its posters on every launch, an empty reserve must never be recorded as "no artwork", and restoring
 * artwork must stop spending when the reserve is empty. IndexedDB itself is not exercised here (no browser);
 * the LRU and the persistence contract run against the in-memory backend.
 */
import { describe, expect, it, vi } from "vitest";
import { createMetadataImageResolver, MetadataUnavailableError, NoTicketError, type ImageKind } from "@space/metadata-client";
import { createArtworkStore, createMemoryArtworkBackend } from "@space/metadata-client/artworkCache";
import { AssetArtworkError } from "../src/renderer/src/lib/assetArtworkError";
import { attachAssets } from "../src/renderer/src/lib/catalogAssetsCore";

const SUITE = "artwork-cache";
const png = (name: string) => `data:image/png;base64,${name}`;

const fakeClient = (answer: (path: string) => string | null | Error) => {
  const calls: Array<[ImageKind, string]> = [];
  return {
    calls,
    client: {
      imageUrl: async (kind: ImageKind, path: string) => {
        calls.push([kind, path]);
        const result = answer(path);
        if (result instanceof Error) throw result;
        return { url: result };
      },
    },
  };
};

describe("artwork store", () => {
  it("evicts the least recently used entries once the byte bound is exceeded", async () => {
    console.info(`[${SUITE}:lru] bound 30 chars, three 10-char values`);
    const backend = createMemoryArtworkBackend();
    let clock = 0;
    const store = createArtworkStore(backend, { maxBytes: 30, now: () => (clock += 1) });
    await store.put("a", "a".repeat(10));
    await store.put("b", "b".repeat(10));
    await store.put("c", "c".repeat(10));
    expect(await store.get("a")).toBe("a".repeat(10)); // a is now the most recent
    await store.put("d", "d".repeat(10)); // evicts b, the oldest
    expect(await store.get("b")).toBeNull();
    expect(await store.get("a")).not.toBeNull();
    expect(await store.get("c")).not.toBeNull();
    expect(await store.get("d")).not.toBeNull();
    expect([...backend.values.keys()].sort()).toEqual(["a", "c", "d"]);
    await store.put("huge", "x".repeat(31)); // larger than the whole bound: not stored
    expect(await store.get("huge")).toBeNull();
  });

  it("rebuilds its index from the backend after a restart, keeping recency, and clear() empties both", async () => {
    console.info(`[${SUITE}:restart] second store over the same backend`);
    const backend = createMemoryArtworkBackend();
    let clock = 0;
    const first = createArtworkStore(backend, { maxBytes: 20, now: () => (clock += 1) });
    await first.put("old", "o".repeat(10));
    await first.put("new", "n".repeat(10));
    const second = createArtworkStore(backend, { maxBytes: 20, now: () => (clock += 1) });
    await second.put("newest", "w".repeat(10));
    expect(await second.get("old")).toBeNull();
    expect(await second.get("new")).not.toBeNull();
    await second.clear();
    expect(backend.values.size).toBe(0);
    expect(await second.get("new")).toBeNull();
  });

  it("never throws: a failing backend is a cache miss", async () => {
    const broken = createMemoryArtworkBackend();
    broken.read = async () => {
      throw new Error("disk");
    };
    broken.write = async () => {
      throw new Error("disk");
    };
    const store = createArtworkStore(broken);
    await expect(store.put("a", "v")).resolves.toBeUndefined();
    await expect(store.get("a")).resolves.toBeNull();
  });
});

describe("artwork resolver", () => {
  // @req META-ART-02[badger-desktop]
  it("an image costs one ticket ever: a restart (new resolver, same store) reads it from disk", async () => {
    console.info(`[${SUITE}:one-ticket] resolve, restart, resolve`);
    const backend = createMemoryArtworkBackend();
    const { client, calls } = fakeClient((path) => png(path));
    const first = createMetadataImageResolver(client, { persistent: createArtworkStore(backend) });
    expect(await first.resolve("poster", "/a.jpg")).toBe(png("/a.jpg"));
    expect(await first.resolve("poster", "/b.jpg")).toBe(png("/b.jpg"));
    expect(calls).toHaveLength(2);

    const afterRestart = createMetadataImageResolver(client, { persistent: createArtworkStore(backend) });
    expect(await afterRestart.resolve("poster", "/a.jpg")).toBe(png("/a.jpg"));
    expect(await afterRestart.resolve("poster", "/b.jpg")).toBe(png("/b.jpg"));
    expect(calls).toHaveLength(2);

    // More posters than the memory cache holds: still no second ticket for any of them.
    const small = createMetadataImageResolver(client, { maxEntries: 2, persistent: createArtworkStore(backend) });
    for (let round = 0; round < 2; round += 1) {
      for (const path of ["/a.jpg", "/b.jpg", "/c.jpg", "/d.jpg"]) await small.resolve("poster", path);
    }
    expect(calls.map(([, path]) => path)).toEqual(["/a.jpg", "/b.jpg", "/c.jpg", "/d.jpg"]);
  });

  // @req META-ANON-02[badger-desktop]
  it("sign-out clears memory and disk: the next account re-buys, and a fetch in flight keeps nothing", async () => {
    console.info(`[${SUITE}:sign-out] clear, resolve again`);
    const backend = createMemoryArtworkBackend();
    const gate = Promise.withResolvers<void>();
    let slow = false;
    const { client, calls } = fakeClient((path) => png(path));
    const gated = {
      imageUrl: async (kind: ImageKind, path: string) => {
        if (slow) await gate.promise;
        return client.imageUrl(kind, path);
      },
    };
    const resolver = createMetadataImageResolver(gated, { persistent: createArtworkStore(backend) });
    await resolver.resolve("poster", "/a.jpg");
    await resolver.clear();
    expect(backend.values.size).toBe(0);
    slow = true;
    const inFlight = resolver.resolve("poster", "/b.jpg");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await resolver.clear();
    gate.resolve();
    expect(await inFlight).toBe(png("/b.jpg"));
    expect(backend.values.size).toBe(0);
  });

  // @req META-ART-02[badger-desktop]
  it("tells 'the service has no such image' from 'could not fetch now', and retries the latter later", async () => {
    console.info(`[${SUITE}:outcomes] missing / no ticket / slow down / unavailable`);
    let now = 0;
    const answers: Record<string, string | null | Error> = {
      "/none.jpg": null,
      "/empty.jpg": new NoTicketError(),
      "/down.jpg": new MetadataUnavailableError(503, undefined),
      "/busy.jpg": new MetadataUnavailableError(429, 3, "rate_limited"),
      "/net.jpg": new TypeError("fetch failed"),
    };
    const { client, calls } = fakeClient((path) => (path in answers ? answers[path]! : png(path)));
    const resolver = createMetadataImageResolver(client, { failureTtlMs: 1000, now: () => now });
    expect((await resolver.resolveDetailed("poster", "/none.jpg")).status).toBe("missing");
    expect((await resolver.resolveDetailed("poster", "/empty.jpg")).status).toBe("no_ticket");
    expect(await resolver.resolveDetailed("poster", "/down.jpg")).toEqual({ status: "rate_limited" });
    expect(await resolver.resolveDetailed("poster", "/busy.jpg")).toEqual({ status: "rate_limited", retryAfterMs: 3000 });
    expect((await resolver.resolveDetailed("poster", "/net.jpg")).status).toBe("unavailable");
    expect(calls).toHaveLength(5);
    await resolver.resolveDetailed("poster", "/empty.jpg");
    expect(calls).toHaveLength(5); // remembered for the failure TTL
    // A "slow down" without a Retry-After is held for the failure TTL, so a screen of pickers does not re-ask.
    expect(await resolver.resolveDetailed("poster", "/down.jpg")).toEqual({ status: "rate_limited", retryAfterMs: 1000 });
    expect(calls).toHaveLength(5);
    // A "slow down" is remembered for its Retry-After only, answering the time still left.
    now = 2000;
    expect(await resolver.resolveDetailed("poster", "/busy.jpg")).toEqual({ status: "rate_limited", retryAfterMs: 1000 });
    expect(calls).toHaveLength(5);
    answers["/empty.jpg"] = png("/empty.jpg");
    expect(await resolver.resolve("poster", "/empty.jpg")).toBe(png("/empty.jpg"));
    expect(calls).toHaveLength(6);
    now = 3000;
    answers["/busy.jpg"] = png("/busy.jpg");
    expect(await resolver.resolve("poster", "/busy.jpg")).toBe(png("/busy.jpg"));
    // Past the failure TTL the Retry-After-less refusal is asked again.
    answers["/down.jpg"] = png("/down.jpg");
    expect(await resolver.resolve("poster", "/down.jpg")).toBe(png("/down.jpg"));
    expect(calls).toHaveLength(8);
  });
});

describe("restoring artwork from the catalog", () => {
  const details = (episodeCount: number, castCount: number) =>
    ({
      title: "t",
      posterPath: "/poster.jpg",
      backdropPath: "/backdrop.jpg",
      cast: Array.from({ length: castCount }, (_, i) => ({ id: i, name: `c${i}`, profilePath: `/cast${i}.jpg` })),
      seasons: [{ seasonNumber: 1, name: "s", posterPath: "/season.jpg" }],
      episodes: Array.from({ length: episodeCount }, (_, i) => ({ seasonNumber: 1, episodeNumber: i + 1, name: "e", stillPath: `/still${i}.jpg` })),
    }) as never;

  // @req META-ART-02[badger-desktop]
  it("stops spending at the first empty reserve, keeps the catalog paths it could not copy, and leaves stills lazy", async () => {
    console.info(`[${SUITE}:restore] reserve runs out after 2 images`);
    let spent = 0;
    const uploaded: string[] = [];
    const upload = vi.fn(async (_kind: ImageKind, path: string) => {
      if (spent >= 2) throw new AssetArtworkError("no_ticket");
      spent += 1;
      uploaded.push(path);
      return `assets/${path}`;
    });
    const result = (await attachAssets(details(300, 10), { upload })) as unknown as {
      posterPath: string | null;
      backdropPath: string | null;
      cast: Array<{ profilePath: string | null }>;
      episodes: Array<{ stillPath: string | null }>;
    };
    expect(result.posterPath).toBe("assets//poster.jpg");
    expect(result.backdropPath).toBe("assets//backdrop.jpg");
    // Nothing is recorded as "no artwork": what could not be copied keeps its path to be resolved later.
    expect(result.cast.every((c) => typeof c.profilePath === "string" && c.profilePath.startsWith("/cast"))).toBe(true);
    expect(result.episodes.every((e) => e.stillPath?.startsWith("/still"))).toBe(true);
    // Workers already running when the reserve ran dry may each hit it once; the other ~10 images are never tried.
    expect(upload.mock.calls.length).toBeLessThanOrEqual(2 + 3 + 1);
    expect(upload.mock.calls.length).toBeLessThan(13);
    expect(uploaded).toEqual(["/poster.jpg", "/backdrop.jpg"]);
  });

  it("an image the service says does not exist is recorded as missing; any other failure keeps the path", async () => {
    console.info(`[${SUITE}:restore-missing] missing vs unavailable`);
    const upload = async (_kind: ImageKind, path: string) => {
      if (path === "/poster.jpg") throw new AssetArtworkError("missing");
      if (path === "/backdrop.jpg") throw new AssetArtworkError("unavailable");
      throw new Error("storage upload failed");
    };
    const result = (await attachAssets(details(0, 1), { upload })) as unknown as {
      posterPath: string | null;
      backdropPath: string | null;
      cast: Array<{ profilePath: string | null }>;
    };
    expect(result.posterPath).toBeNull();
    expect(result.backdropPath).toBe("/backdrop.jpg");
    expect(result.cast[0]!.profilePath).toBe("/cast0.jpg");
  });

  it("fetches at bounded concurrency", async () => {
    console.info(`[${SUITE}:concurrency] 12 cast photos`);
    let running = 0;
    let peak = 0;
    const upload = async (_kind: ImageKind, path: string) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return `assets/${path}`;
    };
    await attachAssets(details(0, 12), { upload });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("never copies episode stills up front, whatever the user's config (each would cost a ticket)", async () => {
    console.info(`[${SUITE}:stills-lazy] 3 episodes`);
    const upload = vi.fn(async (_kind: ImageKind, path: string) => `assets/${path}`);
    const result = (await attachAssets(details(3, 0), { upload })) as unknown as { episodes: Array<{ stillPath: string | null }> };
    console.info(`[${SUITE}:stills-lazy] upload kinds`, JSON.stringify(upload.mock.calls.map(([kind]) => kind)));
    expect(upload.mock.calls.filter(([kind]) => kind === "still")).toHaveLength(0);
    expect(result.episodes.map((e) => e.stillPath)).toEqual(["/still0.jpg", "/still1.jpg", "/still2.jpg"]);
  });
});
