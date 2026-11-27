/**
 * @test-id MOBILE-LIBRARY-STORE-RELOAD-DURING-LOAD-001
 * @level unit
 * @bugfix
 * @regression-proof
 *
 * Why this exists: the Apple TV CHECKED suite (badger build 17438, tv-player) opened the first title and got
 * "Could not load this title." The app's log showed the load effect run again while the first load was still waiting
 * on `/library/db/meta`: its cleanup closed the open library (`library.db.closed`), and the new `load()` found the
 * first one in flight (`library.load.inflight`), waited for it and returned. Nothing opened the library again, so
 * every read (`getMediaDetails`, the sync counts: LIBRARY_NOT_OPEN) came back empty while Home still showed the
 * titles. A load asked for after the library was closed now runs once the stale one has finished.
 *
 * Mounts the real LibraryProvider with react-test-renderer around a fake LibraryDb (no React Native runtime).
 * `/library/db/meta` is a promise the test settles by hand, so no assertion depends on timing.
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type * as SharedApi from "@space/shared/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = { id: string; title: string };
type Meta = { exists: boolean; version: number; snapshotVersion: number; updatedAt: null; keyProbe: null };

const ctl = vi.hoisted(() => ({
  /** Each `/library/db/meta` call, held until the test answers it. */
  meta: [] as Array<(value: unknown) => void>,
  opened: 0,
  closed: 0,
  /** What `useAuth` returns; a test swaps in a fresh object (same account) as auth does once `/auth/me` answers. */
  auth: { token: "token", user: { id: "u1" }, logout: async () => undefined, loading: false },
}));

const META: Meta = { exists: true, version: 5, snapshotVersion: 1, updatedAt: null, keyProbe: null };

const makeFakeDb = (rows: Row[]) => {
  ctl.opened += 1;
  const id = ctl.opened;
  let open = true;
  return {
    id,
    getDatasetStatus: () => ({ core: true, metadata: true, playback: true }),
    onDatasetStatus: (callback: (status: { core: boolean; metadata: boolean; playback: boolean }) => void) => {
      callback({ core: true, metadata: true, playback: true });
      return () => undefined;
    },
    onDataChanged: () => () => undefined,
    onSyncProgress: () => () => undefined,
    countLibraryContents: async () => ({ titles: rows.length, episodes: 0 }),
    listMedia: async () => [...rows],
    listPlaylists: async () => [],
    readTitleVariants: async () => new Map(),
    countMediaItems: async () => rows.length,
    getMediaDetails: async (mediaId: string) => {
      if (!open) throw new Error(`db ${id} is closed`);
      return rows.some((row) => row.id === mediaId) ? { id: mediaId, title: mediaId } : null;
    },
    flushPending: async () => undefined,
    getVersion: () => 5,
    getPendingOpsCount: () => 0,
    syncFromRemoteIfNewer: async () => false,
    close: async () => {
      open = false;
      ctl.closed += 1;
    },
  };
};

vi.mock("react-native", async () => ({
  ...(await import("./setup/reactNativeMock")).reactNativeBase(),
  Platform: { OS: "ios" },
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
    openCachedSplit: async () => makeFakeDb([{ id: "m1", title: "Saved movie" }]),
    open: async () => makeFakeDb([{ id: "m1", title: "Saved movie" }]),
    openLocal: async () => makeFakeDb([{ id: "m1", title: "Saved movie" }]),
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
vi.mock("../src/lib/libraryArtworkCopy", () => ({ startLibraryArtworkCopy: () => ({ migrate: () => undefined, stop: () => undefined }) }));
vi.mock("../src/lib/libraryTitleVariants", () => ({
  startLibraryTitleVariants: () => ({ request: () => undefined, stop: () => undefined }),
}));
vi.mock("../src/lib/profileSettings", () => ({ attachProfileSettingsLibrary: () => () => undefined }));
vi.mock("../src/native/pushHandler", () => ({
  getOrCreateDeviceId: async () => "device",
  initializePushNotifications: async () => undefined,
  unregisterPushNotifications: async () => undefined,
}));
vi.mock("@space/mobile-shell/i18n", () => {
  const value = { t: (key: string) => key, i18n: { language: "en" } };
  return { useTranslation: () => value };
});
vi.mock("../src/store/auth", () => ({ useAuth: () => ctl.auth }));
vi.mock("@space/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof SharedApi>();
  return {
    ...actual,
    getApiBaseUrl: () => "http://api.test",
    getSystemContract: () => Promise.resolve({ apiVersion: 1, apps: {} }),
    getSystemContractIssue: () => null,
    getLibraryMeta: () => {
      const { promise, resolve } = Promise.withResolvers<unknown>();
      ctl.meta.push(resolve);
      return promise;
    },
  };
});

// Loaded after the mocks above, as the other store tests do.
const { LibraryProvider, useLibraryActions, useLibraryData, useLibraryStatus } = await import("../src/store/library");

const flush = async () => {
  for (let i = 0; i < 30; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

let renderer: ReactTestRenderer | null = null;
let observed: {
  media: string[];
  status: string | null;
  reload: (() => void) | null;
  getMediaDetails: ((id: string) => Promise<unknown>) | null;
} = { media: [], status: null, reload: null, getMediaDetails: null };

const Probe = () => {
  const { media } = useLibraryData();
  const status = useLibraryStatus();
  const { getMediaDetails } = useLibraryActions();
  observed = { media: media.map((item) => item.id), status: status.loadStatus.kind, reload: status.reload, getMediaDetails };
  return null;
};

const dump = (phase: string) =>
  console.info(
    `[library-reload-during-load] ${phase}: ${JSON.stringify({
      media: observed.media,
      status: observed.status,
      opened: ctl.opened,
      closed: ctl.closed,
      metaPending: ctl.meta.length,
    })}`
  );

beforeEach(() => {
  // React's act() reads this flag off the global; the global type has no such field.
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  ctl.meta = [];
  ctl.opened = 0;
  ctl.closed = 0;
  ctl.auth = { token: "token", user: { id: "u1" }, logout: async () => undefined, loading: false };
  observed = { media: [], status: null, reload: null, getMediaDetails: null };
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
  });
  renderer = null;
});

describe("a load asked for while the library is closing reopens it", () => {
  it("@bugfix @regression-proof a reload while the first load waits on /library/db/meta ends with an open library", async () => {
    await act(async () => {
      renderer = create(React.createElement(LibraryProvider, null, React.createElement(Probe)));
    });
    await flush();
    dump("painted from the saved copy, meta pending");
    expect(observed.media).toEqual(["m1"]);
    expect(ctl.meta, "the first load waits on /library/db/meta").toHaveLength(1);

    // The load effect runs again (here: reload) while the first load is still in flight: its cleanup closes the db.
    await act(async () => {
      observed.reload?.();
    });
    await flush();
    dump("reload asked for, first load still in flight");

    // The first load's meta answers; it finishes with its (now closed) library.
    await act(async () => {
      ctl.meta.shift()?.(META);
    });
    await flush();
    dump("first load done");
    // The load asked for after the close runs now and asks for meta again.
    while (ctl.meta.length > 0) {
      await act(async () => {
        ctl.meta.shift()?.(META);
      });
      await flush();
    }
    dump("settled");

    expect(ctl.opened, "the library was opened again after the close").toBeGreaterThan(1);
    expect(await observed.getMediaDetails?.("m1"), "a title opens from the library after the reload").toEqual({ id: "m1", title: "m1" });
    expect(observed.status).toBe("ready");
  });

  it("@bugfix @regression-proof a fresh user object from /auth/me while the first load runs keeps the library open", async () => {
    await act(async () => {
      renderer = create(React.createElement(LibraryProvider, null, React.createElement(Probe)));
    });
    await flush();
    dump("painted from the saved copy, meta pending");

    // Auth swaps in a fresh user object for the same account, and with it a new `logout`.
    ctl.auth = { ...ctl.auth, user: { id: "u1" }, logout: async () => undefined };
    await act(async () => {
      renderer?.update(React.createElement(LibraryProvider, null, React.createElement(Probe)));
    });
    await flush();
    dump("fresh user object rendered");

    while (ctl.meta.length > 0) {
      await act(async () => {
        ctl.meta.shift()?.(META);
      });
      await flush();
    }
    dump("settled");

    expect(ctl.closed, "the same account's library is never closed").toBe(0);
    expect(ctl.opened).toBe(1);
    expect(await observed.getMediaDetails?.("m1")).toEqual({ id: "m1", title: "m1" });
  });
});
