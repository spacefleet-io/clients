/**
 * @test-id PARROT-MOBILE-KEPT-001
 * @level unit
 * @req PAR-OFFL-01[parrot]
 * @req PAR-OFFL-02[parrot]
 * @why The phone keeps songs through the shared keeping loop and the native download engine. Each kept song file must
 *   reach the engine as one titled "song" download with its chunk objects and gateways, or the notification and the
 *   offline file go wrong; songs a library load finds missing wait for Wi-Fi while a keep by hand goes at once; the
 *   library copy is kept for offline use only while something is kept; and sign-out leaves no kept song on the phone.
 *   The engine, storage and library are mocked; the downloads themselves are tried on a device.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ParrotCore from "@space/parrot-core";
import type * as KeptModule from "../src/lib/kept";

const log = (phase: string, detail: unknown = {}) => console.info(`[PARROT-MOBILE-KEPT-001] phase=${phase}`, JSON.stringify(detail));

const fake = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  network: "cellular",
  items: [] as { id: string; kind: string; status: string }[],
  enqueued: [] as Record<string, unknown>[],
  removed: [] as string[][],
  copyKept: [] as boolean[],
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => fake.storage.get(key) ?? null,
    setItem: async (key: string, value: string) => void fake.storage.set(key, value),
    removeItem: async (key: string) => void fake.storage.delete(key),
  },
}));
vi.mock("@space/mobile-media-proxy", () => ({ resolveGatewayCandidates: async () => ["https://gw.test"] }));
vi.mock("@space/mobile-media-proxy/downloads", () => ({
  EMPTY_DOWNLOADS_STATE: { items: [] },
  downloadNotificationLabels: () => ({}),
  downloadsNativeAvailable: () => true,
  nativeConfigure: async () => undefined,
  nativeGetState: async () => ({ items: fake.items }),
  nativeGetStatus: async () => ({ networkType: fake.network }),
  nativeResume: async () => undefined,
  parseDownloadsState: (raw: unknown) => raw,
  subscribeNativeState: () => () => undefined,
  nativeEnqueue: async (spec: Record<string, unknown>) => {
    fake.enqueued.push(spec);
    fake.items.push({ id: spec.id as string, kind: spec.kind as string, status: "queued" });
  },
  nativeRemove: async (ids: string[]) => {
    fake.removed.push(ids);
    fake.items = fake.items.filter((item) => !ids.includes(item.id));
  },
}));
vi.mock("@space/mobile-shell/i18n", () => ({ translate: (key: string) => key }));
vi.mock("@space/mobile-shell/logger", () => ({ scopeLogger: () => ({ info: (line: string) => console.info(`[PARROT-MOBILE-KEPT-001] ${line}`) }) }));
vi.mock("../src/lib/library", async () => {
  const { keepLibraryFromRows } = await vi.importActual<typeof ParrotCore>("@space/parrot-core");
  const file = (id: string, trackId: string, mime = "audio/mpeg", lossless = false) => ({
    id,
    trackId,
    mime,
    lossless,
    bitrateKbps: lossless ? null : 320,
    sizeBytes: 1000,
    lightCopy: false,
    createdAt: 1,
  });
  return {
    readKeepLibrary: async () =>
      keepLibraryFromRows({
        tracks: [
          { id: "t1", albumId: "a1" },
          { id: "t2", albumId: "a1" },
        ],
        playlists: [],
        files: [file("f1", "t1"), file("f1flac", "t1", "audio/flac", true), file("f2", "t2")],
      }),
    fileForDownload: async ({ trackId }: { trackId: string }) => ({
      title: `Song ${trackId}`,
      artistName: "Nova",
      chunks: [{ objectKey: `obj-${trackId}-a` }, { objectKey: `obj-${trackId}-a` }, { objectKey: `obj-${trackId}-b` }],
    }),
    setLibraryCopyKept: async (kept: boolean) => void fake.copyKept.push(kept),
  };
});

/** Keeping runs its downloads after `keepItem` returns; a library-load run waits for that run first. */
const settled = async (kept: typeof KeptModule) => kept.keptLibraryLoaded();

const load = async () => {
  vi.resetModules();
  return import("../src/lib/kept");
};

beforeEach(() => {
  fake.storage.clear();
  fake.network = "cellular";
  fake.items = [];
  fake.enqueued = [];
  fake.removed = [];
  fake.copyKept = [];
});

describe("keeping songs on the phone", () => {
  it("hands a kept song to the engine as one titled song download, at once even off Wi-Fi", async () => {
    const kept = await load();
    await kept.startKeeping("token-1");
    await kept.keptLibraryLoaded();
    await kept.keepItem("song", "t2", null);
    await settled(kept);
    log("keep-song", fake.enqueued);
    expect(fake.enqueued).toHaveLength(1);
    expect(fake.enqueued[0]).toMatchObject({
      id: "f2",
      mediaId: "t2",
      title: "Song t2",
      subtitle: "Nova",
      kind: "song",
      formatId: "f2",
      codec: "audio/mpeg",
      estimatedBytes: 1000,
      objects: [
        ["obj-t2-a", 0],
        ["obj-t2-b", 0],
      ],
      gatewayCandidates: ["https://gw.test"],
    });
    expect(fake.storage.has("parrot.kept")).toBe(true);
    expect(fake.copyKept.at(-1)).toBe(true);
    expect(kept.getKeptStatus().entries.map((entry) => [entry.kind, entry.id])).toEqual([["song", "t2"]]);
  });

  it("asks which copy when a song has two, and keeps the one chosen", async () => {
    const kept = await load();
    await kept.startKeeping("token-1");
    await kept.keptLibraryLoaded();
    const choices = await kept.keepChoices("album", "a1");
    log("choices", choices);
    expect(choices.length).toBeGreaterThanOrEqual(2);
    const flac = choices.find((choice) => choice.lossless)!;
    await kept.keepItem("album", "a1", flac.key);
    await settled(kept);
    expect(fake.enqueued.map((spec) => spec.id).sort()).toEqual(["f1flac", "f2"]);
  });

  it("waits for Wi-Fi before a library load downloads what is missing", async () => {
    const first = await load();
    await first.startKeeping("token-1");
    await first.keptLibraryLoaded();
    await first.keepItem("album", "a1", null);
    await settled(first);
    // The engine lost the songs (an app reinstall keeps AsyncStorage on some phones): a reload finds them missing.
    fake.items = [];
    fake.enqueued = [];
    const second = await load();
    await second.startKeeping("token-1");
    await second.keptLibraryLoaded();
    log("cellular-reload", { enqueued: fake.enqueued.length });
    expect(fake.enqueued).toEqual([]);
    fake.network = "wifi";
    await second.keptLibraryLoaded();
    log("wifi-reload", { enqueued: fake.enqueued.map((spec) => spec.id) });
    expect(fake.enqueued.map((spec) => spec.id).sort()).toEqual(["f1flac", "f2"]);
  });

  it("unkeeping drops the song from the engine, and sign-out leaves nothing kept", async () => {
    const kept = await load();
    await kept.startKeeping("token-1");
    await kept.keptLibraryLoaded();
    await kept.keepItem("song", "t1", null);
    await kept.keepItem("song", "t2", null);
    await settled(kept);
    await kept.unkeepItem("song", "t2");
    await settled(kept);
    log("unkeep", { removed: fake.removed, items: fake.items });
    expect(fake.items.map((item) => item.id)).toEqual(["f1flac"]);
    await kept.clearKeeping();
    log("sign-out", { items: fake.items, storage: [...fake.storage.keys()] });
    expect(fake.items).toEqual([]);
    expect(fake.storage.has("parrot.kept")).toBe(false);
    expect(fake.copyKept.at(-1)).toBe(false);
    expect(kept.getKeptStatus()).toBe(kept.EMPTY_KEPT_STATUS);
  });
});
