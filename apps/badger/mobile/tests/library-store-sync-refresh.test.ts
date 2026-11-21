/**
 * @test-id MOBILE-LIBRARY-STORE-SYNC-REFRESH-001
 * @level unit
 * @bugfix
 * @regression-proof
 *
 * Why this exists: after first login + key validation Home stayed on
 * "No media yet" until a manual pull-to-refresh, even though the initial sync
 * had applied every op. The store only re-listed media from ONE place — the
 * `syncFromRemoteIfNewer()` result of the load that started the sync, behind a
 * generation/active-db guard and a `changed` flag. Any other way the ops got
 * applied (a sync whose result the load ignored, a 409 recovery inside the
 * op flush, a guard that flipped while the sync ran) left the UI stale.
 * The store now subscribes to `LibraryDb.onDataChanged` and re-lists whenever
 * remote ops land, regardless of who triggered the sync.
 *
 * Mounts the real LibraryProvider with react-test-renderer around a fake
 * LibraryDb (no React Native runtime needed).
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type * as SharedApi from "@space/shared/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TAG = "[library-store-sync-refresh]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

type Row = { id: string; title: string };

/** Fake LibraryDb: starts empty (snapshot without media), the sync adds rows. */
const fakeDbState = {
  rows: [] as Row[],
  dataListeners: new Set<() => void>(),
  /** What syncFromRemoteIfNewer reports; false emulates "result ignored by the load". */
  syncReportsChange: false,
  closed: false,
};

const makeFakeDb = () => ({
  getDatasetStatus: () => ({ core: true, metadata: true, playback: true }),
  onDatasetStatus: (callback: (status: { core: boolean; metadata: boolean; playback: boolean }) => void) => {
    callback({ core: true, metadata: true, playback: true });
    return () => undefined;
  },
  onDataChanged: (callback: () => void) => {
    fakeDbState.dataListeners.add(callback);
    return () => fakeDbState.dataListeners.delete(callback);
  },
  onSyncProgress: () => () => undefined,
  countLibraryContents: async () => ({ titles: fakeDbState.rows.length, episodes: 0 }),
  listMedia: async () => [...fakeDbState.rows],
  listPlaylists: async () => [],
  readTitleVariants: async () => new Map(),
  countMediaItems: async () => fakeDbState.rows.length,
  flushPending: async () => undefined,
  getVersion: () => 1,
  getPendingOpsCount: () => 0,
  syncFromRemoteIfNewer: async () => {
    // The ops land in the local db and listeners are told, like the real class.
    fakeDbState.rows.push({ id: "m1", title: "Synced movie" }, { id: "m2", title: "Another" });
    fakeDbState.dataListeners.forEach((listener) => listener());
    return fakeDbState.syncReportsChange;
  },
  close: async () => {
    fakeDbState.closed = true;
  },
});

vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => undefined }) },
}));
vi.mock("react-native-sse", () => ({
  default: class {
    onmessage: unknown = null;
    onerror: unknown = null;
    addEventListener() {}
    removeEventListener() {}
    close() {}
  },
}));
vi.mock("../src/lib/libraryDb", () => ({
  LibraryDb: {
    open: async () => makeFakeDb(),
    openLocal: async () => makeFakeDb(),
    clearLocalCache: async () => undefined,
    claimLocalCache: async () => undefined,
  },
  QuotaExceededError: class extends Error {},
}));
vi.mock("../src/lib/onboarding", () => ({
  clearLibraryKey: async () => undefined,
  getStoredLibraryKey: async () => "key",
  isLibraryKeyAcknowledged: async () => true,
  setLibraryKeyAcknowledged: async () => undefined,
}));
vi.mock("../src/lib/mediaCrypto", () => ({ setMediaKeyFromBase64: () => undefined }));
vi.mock("../src/lib/crypto", () => ({ decryptBase64ToBytes: async () => new Uint8Array() }));
vi.mock("../src/lib/networkListener", () => ({ onNetworkRecover: () => () => undefined }));
// The artwork copy (META-ART-01) talks to the metadata service and the storage tunnel: a no-op stand-in here.
vi.mock("../src/lib/libraryArtworkCopy", () => ({ startLibraryArtworkCopy: () => ({ migrate: () => undefined, stop: () => undefined }) }));
vi.mock("../src/lib/libraryTitleVariants", () => ({
  startLibraryTitleVariants: () => ({ request: () => undefined, stop: () => undefined }),
}));
vi.mock("../src/native/pushHandler", () => ({
  getOrCreateDeviceId: async () => "device",
  initializePushNotifications: async () => undefined,
  unregisterPushNotifications: async () => undefined,
}));
// react-i18next's hook resolves a second React copy under the test renderer; the store only needs a stable `t`.
vi.mock("@space/mobile-shell/i18n", () => {
  const value = { t: (key: string) => key, i18n: { language: "en" } };
  return { useTranslation: () => value };
});
vi.mock("../src/store/auth", () => {
  // Stable identity: the store's load effect depends on `user`/`logout`.
  const auth = {
    token: "token",
    user: { id: "u1", isAdmin: false },
    logout: async () => undefined,
    loading: false,
  };
  return { useAuth: () => auth };
});
vi.mock("@space/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof SharedApi>();
  return {
    ...actual,
    getApiBaseUrl: () => "http://api.test",
    getSystemContract: async () => ({ apiVersion: 1, apps: {} }),
    getSystemContractIssue: () => null,
    getLibraryMeta: async () => ({
      exists: true,
      version: 5,
      snapshotVersion: 1,
      updatedAt: null,
      keyProbe: null,
    }),
  };
});

const { LibraryProvider, useLibraryData } = await import("../src/store/library");

const flush = async () => {
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

let renderer: ReactTestRenderer | null = null;
let observedMedia: Row[] = [];

const Probe = () => {
  const { media } = useLibraryData();
  observedMedia = media.map((item) => ({ id: item.id, title: item.title }));
  return null;
};

beforeEach(() => {
  // React's act() reads this flag off the global; the global type has no such field.
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  fakeDbState.rows = [];
  fakeDbState.dataListeners.clear();
  fakeDbState.syncReportsChange = false;
  fakeDbState.closed = false;
  observedMedia = [];
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
  });
  renderer = null;
});

describe("library store refreshes lists when remote ops land", () => {
  it("@bugfix @regression-proof Home lists the synced media without a manual pull-to-refresh", async () => {
    await act(async () => {
      renderer = create(React.createElement(LibraryProvider, null, React.createElement(Probe)));
    });
    await flush();
    log("after first login load + background sync", {
      media: observedMedia.map((row) => row.id),
      dbRows: fakeDbState.rows.length,
    });
    expect(fakeDbState.rows.length, "the sync did apply the ops to the db").toBe(2);
    expect(observedMedia.map((row) => row.id), "Home must show what the sync applied").toEqual(["m1", "m2"]);
  });
});
