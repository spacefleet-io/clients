/**
 * @req META-ART-01
 *
 * Why this exists (#470): a matched title kept catalog image paths, so its artwork never reached the user's storage.
 * The desktop's copy after a match goes through the metadata service `image` op (never the catalog image CDN,
 * META-ART-02), encrypts every image on the device and uploads it under a random name; the library then holds
 * asset keys. This drives the real desktop chain (`runDesktopArtworkCopy` → `uploadEncryptedAssetFromMetadata` →
 * real AES-GCM) with the metadata service and the storage tunnel mocked, and watches every fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMetadataImageResolver, MetadataUnavailableError, type ImageKind } from "@space/metadata-client";
import type { ArtworkCopy, ArtworkCopyStore, ArtworkSlot } from "@space/library-db-definition/artworkCopy";
import { ARTWORK_COPY_TICKET_FLOOR, runDesktopArtworkCopy } from "../src/renderer/src/lib/artworkCopy";
import { uploadEncryptedAssetFromMetadata } from "../src/renderer/src/lib/assets";

const SUITE = "artwork-copy-on-match";
const log = (phase: string, data?: unknown) =>
  console.info(`[${SUITE}] ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);
const { resolveArtwork, uploads } = vi.hoisted(() => ({
  resolveArtwork: vi.fn(),
  uploads: [] as Array<{ objectKey: string; bytes: number }>,
}));

vi.mock("@/lib/metadataTickets", () => ({
  resolveArtwork: (kind: string, path: string) => resolveArtwork(kind, path),
}));

vi.mock("@/api", () => ({
  downloadStorageObjectViaTunnel: vi.fn(),
  uploadStorageObjectViaTunnel: vi.fn(async (_token: string, objectKey: string, payload: Uint8Array) => {
    uploads.push({ objectKey, bytes: payload.byteLength });
    return objectKey;
  }),
}));

const KEY = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");

/** The library rows of a matched show: one slot per artwork kind, all still catalog paths. */
const matchedShow = (): ArtworkSlot[] => [
  { target: "mediaPoster", id: "m1", path: "/poster.jpg" },
  { target: "mediaBackdrop", id: "m1", path: "/backdrop.jpg" },
  { target: "seasonPoster", id: "season-1", path: "/s1.jpg" },
  { target: "personProfile", id: "person-1", path: "/anna.jpg" },
  { target: "episodeStill", id: "episode-1", path: "/e1.jpg" },
];

const memoryStore = (slots: ArtworkSlot[]) => {
  const values = new Map(slots.map((slot) => [`${slot.target}:${slot.id}`, slot.path as string | null]));
  const store: ArtworkCopyStore = {
    listArtworkToCopy: () =>
      slots.filter((slot) => values.get(`${slot.target}:${slot.id}`) === slot.path),
    applyArtworkCopies: (_mediaId: string, copies: ArtworkCopy[]) => {
      let applied = 0;
      for (const copy of copies) {
        const key = `${copy.target}:${copy.id}`;
        if (values.get(key) !== copy.path) continue;
        values.set(key, copy.value);
        applied++;
      }
      return { applied, skipped: copies.length - applied };
    },
  };
  return { store, values };
};

let fetched: string[] = [];
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  fetched = [];
  uploads.length = 0;
  resolveArtwork.mockReset();
  // The metadata service answers with the image bytes as a data: URI.
  resolveArtwork.mockImplementation(async (kind: string, path: string) => ({
    status: "ok",
    url: `data:image/jpeg;base64,${Buffer.from(`${kind}${path}`).toString("base64")}`,
  }));
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetched.push(url);
    return originalFetch(input, init);
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const deps = (store: ArtworkCopyStore, ticketsLeft = 600) => ({
  store,
  upload: (kind: Parameters<typeof uploadEncryptedAssetFromMetadata>[2], path: string) =>
    uploadEncryptedAssetFromMetadata("token", KEY, kind, path),
  ticketsLeft: async () => ticketsLeft,
  onApplied: vi.fn(),
});

describe("desktop copy of matched artwork (META-ART-01)", () => {
  it("@req META-ART-01[badger-desktop] every artwork kind ends as an encrypted asset key; no catalog URL is fetched", async () => {
    const { store, values } = memoryStore(matchedShow());
    const d = deps(store);
    log("phase: run");
    const result = await runDesktopArtworkCopy(d, "m1");
    log("phase: done", { result, values: Object.fromEntries(values), uploads, fetched, resolved: resolveArtwork.mock.calls });

    expect(result).toMatchObject({ total: 5, copied: 5, applied: 5, failed: 0, stoppedForTickets: false });
    expect(resolveArtwork.mock.calls.map(([kind]) => kind).sort()).toEqual(["backdrop", "poster", "poster", "profile", "still"]);
    for (const [slot, value] of values) {
      expect(value, slot).toMatch(/^asset:image\/jpeg::assets\/[0-9a-f-]{36}\.txt$/);
    }
    expect(new Set(uploads.map((upload) => upload.objectKey)).size, "each image gets its own random name").toBe(5);
    expect(uploads.every((upload) => upload.bytes > 0)).toBe(true);
    expect(fetched.length).toBe(5);
    expect(fetched.every((url) => url.startsWith("data:")), "only the metadata service's data: answers are read").toBe(true);
    expect(fetched.some((url) => /^https?:/.test(url))).toBe(false);
    expect(d.onApplied).toHaveBeenCalledTimes(1);
  });

  it("@req META-ART-01[badger-desktop] a failure is non-fatal: the catalog path stays and the next run copies it", async () => {
    const { store, values } = memoryStore(matchedShow());
    resolveArtwork.mockImplementation(async (kind: string, path: string) =>
      path === "/e1.jpg"
        ? { status: "unavailable" }
        : path === "/backdrop.jpg"
          ? { status: "missing" }
          : { status: "ok", url: `data:image/jpeg;base64,${Buffer.from(`${kind}${path}`).toString("base64")}` }
    );
    const first = await runDesktopArtworkCopy(deps(store), "m1");
    log("phase: first", { first, values: Object.fromEntries(values) });
    expect(first).toMatchObject({ copied: 3, missing: 1, failed: 1 });
    expect(values.get("episodeStill:episode-1")).toBe("/e1.jpg");
    expect(values.get("mediaBackdrop:m1")).toBeNull();

    resolveArtwork.mockImplementation(async () => ({ status: "ok", url: "data:image/jpeg;base64,AAAA" }));
    const second = await runDesktopArtworkCopy(deps(store), "m1");
    log("phase: retry", { second, values: Object.fromEntries(values) });
    expect(second).toMatchObject({ total: 1, copied: 1 });
    expect(values.get("episodeStill:episode-1")).toMatch(/^asset:/);
  });

  it("@req META-ART-01[badger-desktop] leaves the ticket floor for the user's own lookups", async () => {
    const { store } = memoryStore(matchedShow());
    const result = await runDesktopArtworkCopy(deps(store, ARTWORK_COPY_TICKET_FLOOR), "m1");
    log("phase: floor", result);
    expect(result.stoppedForTickets).toBe(true);
    expect(resolveArtwork).not.toHaveBeenCalled();
    expect(uploads).toEqual([]);
  });

  it("@req META-ART-01[badger-desktop] a 429 from the metadata service waits its Retry-After and copies the same picture, never marking it failed", async () => {
    const { store, values } = memoryStore(matchedShow());
    // The real resolver over a service that refuses the first three asks with 429 Retry-After: 2.
    let refusalsLeft = 3;
    const asked: string[] = [];
    // One fake clock: the copy's wait advances it, and the resolver remembers a refusal against it.
    let clock = 0;
    const resolver = createMetadataImageResolver(
      {
        imageUrl: async (kind: ImageKind, path: string) => {
          asked.push(path);
          if (refusalsLeft > 0) {
            refusalsLeft -= 1;
            throw new MetadataUnavailableError(429, 2, "rate_limited");
          }
          return { url: `data:image/jpeg;base64,${Buffer.from(`${kind}${path}`).toString("base64")}` };
        },
      },
      { now: () => clock }
    );
    resolveArtwork.mockImplementation((kind: ImageKind, path: string) => resolver.resolveDetailed(kind, path));
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
      clock += ms;
    };
    log("phase: run under 429");
    const result = await runDesktopArtworkCopy({ ...deps(store), sleep }, "m1");
    log("phase: done", { result, waits, asked: asked.length, values: Object.fromEntries(values) });
    expect(result).toMatchObject({ total: 5, copied: 5, failed: 0, stoppedForRateLimit: false });
    expect(waits.length).toBeGreaterThan(0);
    expect(waits.every((ms) => ms > 0 && ms <= 2000)).toBe(true);
    for (const [slot, value] of values) expect(value, slot).toMatch(/^asset:/);
  });
});
