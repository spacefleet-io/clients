/**
 * @test-id MOBILE-VAULT-ART-001
 * @level integration
 * @req META-ART-01
 * @req META-ART-02
 * @req META-ANON-05[badger-mobile]
 * @req META-RELAY-01
 *
 * Why this exists: the phone asked the metadata service for a picture each time a screen drew one (`useMediaImage`
 * -> the `image` op), so browsing a library spent tickets and loaded the service over and over (1,454 `image` lookups
 * for 468 pictures in three days on one router). Chris, 2026-11-16: pictures are fetched at import and stored in the
 * user's vault; "Display reads the local cache first, the vault only on a cache miss, and the metadata service never
 * while browsing. Bound it by bytes, clear it on sign-out, keep it across restarts."
 *
 * Real `useMediaImage`, real `assets.ts` and real decrypted-artwork cache; only the edges are fakes (the file system,
 * the user's storage, the library key's decryption). The metadata runtime is a recording stand-in: any picture call a
 * display path makes is counted, and the count must stay zero. The copy that fills the library with stored copies
 * (`startArtworkCopy`) runs against a fake library: it is the one place the phone spends tickets on pictures.
 *
 * META-ANON-05[badger-mobile]: a picture the copy could not get (no ticket, service unavailable) is never written as
 * "missing"; the slot keeps its path and the next pass retries it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type * as SharedApi from "@space/shared/api";
import { ARTWORK_COPY_PAUSE_MS, type ArtworkCopy, type ArtworkSlot } from "@space/library-db-definition/artworkCopy";
import { createVaultArtworkCache, type ArtworkCacheFileInfo } from "../src/lib/vaultArtworkCache";
import { ARTWORK_COPY_FAILED_RETRY_MS, ARTWORK_COPY_TICKET_FLOOR, startArtworkCopy } from "../src/lib/artworkCopy";

const SUITE = "mobile-vault-art";
const phase = (test: string, name: string) => console.info(`[${SUITE}] ${test} phase: ${name}`);
const dump = (test: string, label: string, value: unknown) => console.info(`[${SUITE}] ${test} state ${label}: ${JSON.stringify(value)}`);

const JPEG_BASE64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7, 6]).toString("base64");
const POSTER_KEY = "assets/5a1b-poster.txt";
const POSTER_REF = `asset:image/jpeg::${POSTER_KEY}`;

// Shared between the hoisted mocks and the tests; reset in beforeEach (files survive vi.resetModules: a restart).
const edge = vi.hoisted(() => ({
  files: new Map<string, string>(),
  vault: new Map<string, string>(),
  downloads: [] as string[],
  /** Every call a display path made into the metadata runtime (must stay empty). */
  metadataCalls: [] as string[],
}));

vi.mock("react-native-fs", () => ({
  default: {
    CachesDirectoryPath: "/phone-cache",
    exists: async (path: string) => edge.files.has(path) || [...edge.files.keys()].some((f) => f.startsWith(`${path}/`)),
    mkdir: async () => undefined,
    writeFile: async (path: string, base64: string) => void edge.files.set(path, base64),
    readFile: async (path: string) => edge.files.get(path) ?? "",
    readDir: async (dir: string) =>
      [...edge.files].filter(([p]) => p.startsWith(`${dir}/`)).map(([path, data]) => ({ path, size: data.length, isFile: () => true, mtime: new Date(0) })),
    unlink: async (path: string) => {
      for (const p of [...edge.files.keys()]) if (p === path || p.startsWith(`${path}/`)) edge.files.delete(p);
    },
    touch: async () => undefined,
    moveFile: async (from: string, to: string) => {
      edge.files.set(to, edge.files.get(from) ?? "");
      edge.files.delete(from);
    },
  },
}));
vi.mock("react-native-quick-crypto", async () => {
  const nodeCrypto = await import("node:crypto");
  return { default: { createHash: (algo: string) => nodeCrypto.createHash(algo), randomUUID: () => nodeCrypto.randomUUID() } };
});
vi.mock("@space/shared/api", async (importOriginal) => ({
  ...(await importOriginal<typeof SharedApi>()),
  downloadStorageObjectViaTunnel: async (_token: string, objectKey: string) => {
    edge.downloads.push(objectKey);
    const stored = edge.vault.get(objectKey);
    if (stored === undefined) throw new Error(`no object ${objectKey}`);
    return new TextEncoder().encode(stored);
  },
}));
// The library key's decryption: the stored text is "enc:" + the picture's base64.
vi.mock("../src/lib/crypto", () => ({
  decryptBase64ToBytes: async (_key: string, text: string) => new Uint8Array(Buffer.from(text.replace(/^enc:/u, ""), "base64")),
}));
vi.mock("../src/lib/onboarding", () => ({ getStoredLibraryKey: async () => "library-key" }));
vi.mock("../src/store/auth", () => ({ useAuth: () => ({ token: "session-token", loading: false }) }));
// The metadata runtime as a recorder: every picture entry point a display path could reach counts a call.
vi.mock("../src/lib/metadata/runtime", () => {
  const record = (name: string) => (...args: unknown[]) => {
    edge.metadataCalls.push(`${name}(${args.map((a) => (typeof a === "function" ? "fn" : JSON.stringify(a))).join(",")})`);
    return name.endsWith("getCached") ? null : () => undefined;
  };
  const recorder = (prefix: string) => new Proxy({}, { get: (_target, key) => record(`${prefix}.${String(key)}`) });
  return {
    metadataClient: recorder("metadataClient"),
    metadataImages: recorder("metadataImages"),
    fetchArtworkImage: record("fetchArtworkImage"),
    ticketsHeld: async () => 600,
    onTicketsArrived: () => () => undefined,
  };
});

const MOBILE_ROOT = resolve(import.meta.dirname, "..");

/**
 * Renders `useMediaImage(path, kind)` the way every phone screen does, and reads back what it would draw.
 * Imported per render on purpose: after `vi.resetModules()` this loads fresh modules, which is how the test models an
 * app restart (in-memory cache gone, files on disk kept).
 */
const renderImage = async (path: string | null, kind: "poster" | "backdrop" | "still" | "profile" = "poster") => {
  const { useMediaImage } = await import("../src/lib/useMediaImage");
  const seen: Array<string | null> = [];
  const Probe = () => {
    seen.push(useMediaImage(path, kind));
    return null;
  };
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(React.createElement(Probe));
  });
  return { tree, seen, latest: () => seen.at(-1) ?? null };
};

/** Flushes the loads' promise chains (fake file system and storage resolve on the next turn) inside act(). */
const settle = async () => {
  for (let i = 0; i < 20; i += 1) {
    await act(async () => {
      await new Promise((r) => setImmediate(r));
    });
  }
};

// react-test-renderer's act() outside a jsdom environment.
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let mounted: ReactTestRenderer[] = [];

beforeEach(() => {
  vi.resetModules();
  edge.files.clear();
  edge.vault.clear();
  edge.downloads.length = 0;
  edge.metadataCalls.length = 0;
  edge.vault.set(POSTER_KEY, `enc:${JPEG_BASE64}`);
});

afterEach(async () => {
  for (const tree of mounted) await act(async () => tree.unmount());
  mounted = [];
});

describe("phone screens show only the user's stored copies (MOBILE-VAULT-ART-001)", () => {
  // @req META-ART-02
  it("a picture whose copy is not made yet shows the placeholder and asks the metadata service nothing", async () => {
    const T = "not-copied";
    phase(T, "arrange: every picture kind, each still holding a metadata-service path");
    const views = [];
    for (const [path, kind] of [
      ["/poster.jpg", "poster"],
      ["/backdrop.jpg", "backdrop"],
      ["/still.jpg", "still"],
      ["/profile.jpg", "profile"],
    ] as const) {
      const view = await renderImage(path, kind);
      mounted.push(view.tree);
      views.push({ kind, view });
    }

    phase(T, "act: let every effect and load run");
    await settle();

    phase(T, "assert: placeholders, zero metadata calls, nothing downloaded or written");
    dump(T, "drawn", views.map(({ kind, view }) => ({ kind, url: view.latest() })));
    dump(T, "metadata calls", edge.metadataCalls);
    dump(T, "edges", { downloads: edge.downloads, files: [...edge.files.keys()] });
    expect(edge.metadataCalls, "a display path must never call the metadata service for a picture").toEqual([]);
    expect(views.map(({ view }) => view.latest())).toEqual([null, null, null, null]);
    expect(edge.downloads).toEqual([]);
    expect(edge.files.size).toBe(0);
  });

  // @req META-ART-01
  it("a stored copy comes from the user's storage once, then from the decrypted file on the phone, also after a restart; sign-out deletes it", async () => {
    const T = "vault-copy";
    phase(T, "arrange: a title whose poster was copied into the user's storage");
    const first = await renderImage(POSTER_REF);
    mounted.push(first.tree);
    await settle();
    dump(T, "first render", { url: first.latest(), downloads: edge.downloads, files: [...edge.files.keys()] });
    expect(first.latest()).toMatch(/^file:\/\/\/phone-cache\/assets\/[0-9a-f]+\.jpg$/u);
    expect(edge.downloads).toEqual([POSTER_KEY]);
    expect([...edge.files.values()]).toEqual([JPEG_BASE64]);

    phase(T, "act: a second screen shows the same poster in this session");
    const second = await renderImage(POSTER_REF);
    mounted.push(second.tree);
    dump(T, "second render", { seen: second.seen, downloads: edge.downloads.length });
    expect(second.seen[0], "a picture already shown paints on the first frame").toBe(first.latest());
    expect(edge.downloads).toHaveLength(1);

    phase(T, "act: restart (fresh modules, the files stay)");
    vi.resetModules();
    const restarted = await renderImage(POSTER_REF);
    mounted.push(restarted.tree);
    await settle();
    dump(T, "after restart", { url: restarted.latest(), downloads: edge.downloads.length });
    expect(restarted.latest()).toBe(first.latest());
    expect(edge.downloads, "the decrypted file survives a restart: no second download").toHaveLength(1);

    phase(T, "act: sign out (the ticket lifecycle's erase clears the cache)");
    // Same fresh module instance the restarted render used (see renderImage).
    const assets = await import("../src/lib/assets");
    await assets.clearAssetUrlCache();
    dump(T, "after sign-out", { files: [...edge.files.keys()], cached: assets.getCachedAssetUrl(POSTER_REF) });
    expect(edge.files.size).toBe(0);
    expect(assets.getCachedAssetUrl(POSTER_REF)).toBeNull();
    const runtimeSource = readFileSync(resolve(MOBILE_ROOT, "src/lib/metadata/runtime.ts"), "utf8");
    expect(runtimeSource, "sign-out (the ticket lifecycle's erase) empties the decrypted-artwork cache").toMatch(/eraseOnSignOut[\s\S]*clearAssetUrlCache\(\)/u);
    expect(edge.metadataCalls).toEqual([]);
  });

  // @req META-ART-01
  it("the cache stays under its byte bound, least recently used out first", async () => {
    const T = "byte-bound";
    const disk = new Map<string, ArtworkCacheFileInfo>();
    let clock = 0;
    const cache = createVaultArtworkCache({
      maxBytes: 1000,
      now: () => clock,
      hash: (input) => Buffer.from(input).toString("hex").slice(-16),
      files: {
        pathFor: (name) => `/c/${name}`,
        exists: async (path) => disk.has(path),
        writeBase64: async (path, base64) => void disk.set(path, { path, size: Math.ceil((base64.length * 3) / 4), mtime: ++clock }),
        list: async () => [...disk.values()],
        remove: async (path) => void disk.delete(path),
        removeAll: async () => disk.clear(),
        touch: async (path, mtime) => {
          const entry = disk.get(path);
          if (entry) entry.mtime = mtime;
        },
      },
    });
    const picture = Buffer.alloc(400, 7).toString("base64");
    const ref = (name: string) => `asset:image/jpeg::assets/${name}.txt`;

    phase(T, "act: three 400-byte pictures into a 1000-byte cache");
    for (const name of ["a", "b", "c"]) await cache.put(ref(name), picture);
    dump(T, "after three", [...disk.values()]);
    expect(disk.size, "the oldest picture went out").toBe(2);
    expect(cache.getCached(ref("a"))).toBeNull();

    phase(T, "act: use b again (a restart: read from disk), then store d");
    vi.resetModules();
    const loads: string[] = [];
    const restarted = createVaultArtworkCache({
      maxBytes: 1000,
      now: () => ++clock,
      hash: (input) => Buffer.from(input).toString("hex").slice(-16),
      files: {
        pathFor: (name) => `/c/${name}`,
        exists: async (path) => disk.has(path),
        writeBase64: async (path, base64) => void disk.set(path, { path, size: Math.ceil((base64.length * 3) / 4), mtime: ++clock }),
        list: async () => [...disk.values()],
        remove: async (path) => void disk.delete(path),
        removeAll: async () => disk.clear(),
        touch: async (path, mtime) => {
          const entry = disk.get(path);
          if (entry) entry.mtime = mtime;
        },
      },
    });
    const b = await restarted.load(ref("b"), async (key) => {
      loads.push(key);
      return picture;
    });
    await restarted.put(ref("d"), picture);
    dump(T, "after use and d", { files: [...disk.values()], loads, b });
    expect(loads, "b came from the file on disk").toEqual([]);
    expect(restarted.getCached(ref("b"))).not.toBeNull();
    expect(restarted.getCached(ref("c")), "c was used least recently: it went out").toBeNull();
    expect(disk.size).toBe(2);
  });

  // @req META-ART-02
  // @req META-RELAY-01
  it("no phone display file reaches the metadata service for a picture", () => {
    const T = "display-scan";
    const displayFiles = [
      "src/lib/useMediaImage.ts",
      "src/lib/assets.ts",
      "src/lib/vaultArtworkCache.ts",
      "src/components/MediaArtwork.tsx",
      "src/components/PosterCard.tsx",
      "src/components/ContinueHero.tsx",
      "src/screens/MediaDetailsScreen.tsx",
      "src/screens/PlayerScreen.tsx",
      "src/screens/TvRemoteScreen.tsx",
      "src/screens/player/PlayerOverlays.tsx",
    ];
    const findings = displayFiles.map((file) => {
      const source = readFileSync(resolve(MOBILE_ROOT, file), "utf8");
      return {
        file,
        pictureLookups: [...source.matchAll(/metadataImages|imageUrl\(|fetchArtworkImage|watchMediaImage|\/t\/p\/(?:w\d+|original)\/|metadata\/relay/gu)].map((m) => m[0]),
      };
    });
    dump(T, "findings", findings);
    expect(findings.filter((f) => f.pictureLookups.length > 0)).toEqual([]);
    const hook = readFileSync(resolve(MOBILE_ROOT, "src/lib/useMediaImage.ts"), "utf8");
    expect(hook, "the display hook imports nothing from the metadata modules").not.toMatch(/from "\.\/metadata\//u);
  });
});

describe("the artwork copy: the one place the phone spends tickets on pictures (MOBILE-VAULT-ART-001)", () => {
  type FakeTitle = { slots: ArtworkSlot[] };
  const fakeLibrary = (titles: Record<string, FakeTitle>) => {
    const applied: Array<{ mediaId: string; copies: ArtworkCopy[] }> = [];
    return {
      applied,
      library: {
        listMediaWithArtworkToCopy: async () => Object.keys(titles).filter((id) => titles[id]!.slots.length > 0),
        listArtworkToCopy: async (mediaId: string) => titles[mediaId]?.slots ?? [],
        applyArtworkCopies: async (mediaId: string, copies: ArtworkCopy[]) => {
          applied.push({ mediaId, copies });
          const title = titles[mediaId]!;
          title.slots = title.slots.filter((slot) => !copies.some((c) => c.target === slot.target && c.id === slot.id));
          return { applied: copies.length, skipped: 0 };
        },
      },
    };
  };

  // @req META-ART-01
  // @req META-ANON-05[badger-mobile]
  it("copies each title's pictures into the user's storage, one title at a time with a pause, keeps a path it could not get, and stops at the ticket floor", async () => {
    const T = "copy";
    const titles: Record<string, FakeTitle> = {
      friends: { slots: [{ target: "mediaPoster", id: "friends", path: "/friends.jpg" }, { target: "episodeStill", id: "ep1", path: "/ep1.jpg" }] },
      heat: { slots: [{ target: "mediaPoster", id: "heat", path: "/heat.jpg" }, { target: "mediaBackdrop", id: "heat", path: "/heat-wide.jpg" }] },
      alien: { slots: [{ target: "mediaPoster", id: "alien", path: "/alien.jpg" }] },
    };
    const { library, applied } = fakeLibrary(titles);
    let tickets = ARTWORK_COPY_TICKET_FLOOR + 4;
    const fetched: string[] = [];
    const sleeps: number[] = [];
    const logs: Array<{ event: string; detail: Record<string, unknown> }> = [];
    const run = startArtworkCopy({
      library,
      fetchImage: async (kind, path) => {
        fetched.push(`${kind}:${path}`);
        tickets -= 1;
        // The service is busy for the backdrop: it must stay a path, never become "no picture".
        if (path === "/heat-wide.jpg") return { status: "unavailable" };
        return { status: "ok", bytes: new Uint8Array([1, 2, 3]), contentType: "image/jpeg" };
      },
      storeEncrypted: async (_bytes, contentType) => `asset:${contentType}::assets/copy-${fetched.length}.txt`,
      ticketsHeld: async () => tickets,
      log: (event, detail) => {
        logs.push({ event, detail });
        console.info(`[${SUITE}] ${T} app log ${event} ${JSON.stringify(detail)}`);
      },
      sleep: async (ms) => void sleeps.push(ms),
    });

    phase(T, "act: the library opens (migration of an existing library)");
    const scheduled = await run.migrate();
    await run.idle();
    dump(T, "result", { scheduled, fetched, applied, sleeps, tickets, left: Object.fromEntries(Object.entries(titles).map(([id, t]) => [id, t.slots])) });

    phase(T, "assert: stored references written back, the busy picture kept as a path, the floor kept");
    expect(scheduled).toBe(3);
    expect(applied.flatMap((a) => a.copies.map((c) => c.value))).toEqual(
      expect.arrayContaining([expect.stringMatching(/^asset:image\/jpeg::assets\/copy-\d+\.txt$/u)]),
    );
    expect(applied.flatMap((a) => a.copies).every((c) => c.value !== null), "an unavailable picture is never written as missing").toBe(true);
    expect(titles.heat!.slots.map((s) => s.path)).toContain("/heat-wide.jpg");
    expect(tickets, "the copy leaves the floor of tickets for the user's own lookups").toBeGreaterThanOrEqual(ARTWORK_COPY_TICKET_FLOOR);
    expect(fetched.length).toBe(4);
    expect(titles.alien!.slots, "the last title waits for more tickets").toHaveLength(1);
    expect(sleeps.length, "titles are paced").toBeGreaterThanOrEqual(1);
    expect(sleeps.every((ms) => ms > 0 && ms <= ARTWORK_COPY_PAUSE_MS)).toBe(true);

    phase(T, "act: tickets arrive; the next pass finishes the job");
    tickets = 600;
    await run.migrate();
    await run.idle();
    dump(T, "after refill", { fetched, left: Object.fromEntries(Object.entries(titles).map(([id, t]) => [id, t.slots])) });
    expect(titles.alien!.slots).toEqual([]);
    expect(titles.friends!.slots).toEqual([]);
    run.stop();
  });

  // @req META-ART-01
  // @req META-ANON-05[badger-mobile]
  // Why: a picture the service keeps failing on was asked again on every sync and every ticket batch, spending a
  // ticket each time; and a copy still uploading at sign-out stored the picture and put its plaintext back into the
  // cache sign-out had just emptied.
  it("a title whose picture failed waits before it is tried again; after a stop nothing more is stored", async () => {
    const T = "copy-retry-stop";
    const titles: Record<string, FakeTitle> = {
      heat: { slots: [{ target: "mediaBackdrop", id: "heat", path: "/heat-wide.jpg" }] },
    };
    const { library } = fakeLibrary(titles);
    let clock = 1_000;
    let busy = true;
    const fetched: string[] = [];
    const stored: string[] = [];
    const run = startArtworkCopy({
      library,
      fetchImage: async (_kind, path) => {
        fetched.push(path);
        // Sign-out lands while this picture is on its way.
        if (path === "/alien.jpg") run.stop();
        return busy ? { status: "unavailable" } : { status: "ok", bytes: new Uint8Array([1]), contentType: "image/jpeg" };
      },
      storeEncrypted: async (_bytes, contentType) => {
        stored.push(contentType);
        return `asset:${contentType}::assets/copy-${stored.length}.txt`;
      },
      ticketsHeld: async () => 600,
      log: (event, detail) => console.info(`[${SUITE}] ${T} app log ${event} ${JSON.stringify(detail)}`),
      sleep: async () => undefined,
      now: () => clock,
    });

    phase(T, "act: first pass, the service is busy");
    await run.migrate();
    await run.idle();
    phase(T, "act: a sync and a ticket batch right after");
    const again = await run.migrate();
    await run.idle();
    dump(T, "after quick passes", { fetched, again });
    expect(fetched, "the failed picture is not asked again within the cool-down").toEqual(["/heat-wide.jpg"]);
    expect(again).toBe(0);

    phase(T, "act: the cool-down is over and the service answers");
    clock += ARTWORK_COPY_FAILED_RETRY_MS + 1;
    busy = false;
    await run.migrate();
    await run.idle();
    dump(T, "after cool-down", { fetched, stored, left: titles.heat!.slots });
    expect(fetched).toEqual(["/heat-wide.jpg", "/heat-wide.jpg"]);
    expect(titles.heat!.slots).toEqual([]);

    phase(T, "act: sign-out stops the copy while a picture is being fetched");
    titles.alien = { slots: [{ target: "mediaPoster", id: "alien", path: "/alien.jpg" }] };
    const storedBefore = stored.length;
    await run.migrate();
    await run.idle();
    dump(T, "after stop", { fetched, stored, left: titles.alien.slots });
    expect(fetched.at(-1)).toBe("/alien.jpg");
    expect(stored.length, "nothing is stored after the stop").toBe(storedBefore);
    expect(titles.alien.slots, "the path stays for the next session").toHaveLength(1);
  });

  // @req META-ART-02
  // Why: sign-out empties the cache; a copy that started before it must not write its plaintext back afterwards.
  it("a copy that started before a sign-out keeps nothing in the emptied cache", async () => {
    const T = "put-after-reset";
    const disk = new Map<string, string>();
    const cache = createVaultArtworkCache({
      hash: (input) => Buffer.from(input).toString("hex").slice(-16),
      files: {
        pathFor: (name) => `/c/${name}`,
        exists: async (path) => disk.has(path),
        writeBase64: async (path, base64) => void disk.set(path, base64),
        list: async () => [...disk.entries()].map(([path, data]) => ({ path, size: data.length, mtime: 0 })),
        remove: async (path) => void disk.delete(path),
        removeAll: async () => disk.clear(),
      },
    });
    const startedEpoch = cache.epoch();
    phase(T, "act: sign-out lands while the upload runs, then the copy finishes");
    await cache.reset();
    const url = await cache.put(POSTER_REF, JPEG_BASE64, startedEpoch);
    dump(T, "disk", [...disk.keys()]);
    expect(url).toBeNull();
    expect(disk.size).toBe(0);
    expect(cache.getCached(POSTER_REF)).toBeNull();
  });
});
