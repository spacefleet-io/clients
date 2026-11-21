/**
 * @test-id MOBILE-LIBRARY-STORE-PULL-REFRESH-001
 * @level unit
 * @bugfix
 * @regression-proof
 * @req UX-REFRESH-01
 *
 * Why this exists: pulling to refresh on Home, Media library or a playlist
 * called the store's `reload()`, which closes the library db and sets the
 * dataset back to "not ready". The navigator then swaps the whole app for the
 * "Loading library" screen and remounts the tabs on Home, so the user lost the
 * page they were on. A pull refresh must sync and re-list the open library in
 * place: the dataset stays ready and the db is never reopened.
 *
 * Mounts the real LibraryProvider with react-test-renderer around a fake
 * LibraryDb (no React Native runtime needed).
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type * as SharedApi from "@space/shared/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TAG = "[library-store-pull-refresh]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

type Row = { id: string; title: string };

const fakeDbState = {
  rows: [{ id: "m1", title: "Cached movie" }] as Row[],
  /** Rows the next sync brings in (a title added or renamed on another device). */
  remoteRows: [] as Row[],
  opens: 0,
  syncs: 0,
  closed: 0,
  /** Syncs that throw before succeeding (a server error during the load's background sync). */
  failingSyncs: 0,
  /** False = the API answers but cannot confirm the snapshot (storage gateway down). */
  metaExists: true,
  /** The meta request answers 401 (session revoked). */
  metaRejected: false,
  /** The meta request fails at the network (no connection, server down). */
  metaDown: false,
  /** The stored key no longer opens the server's key probe (key rotated on another device). */
  keyRejected: false,
  logouts: 0,
};

const makeFakeDb = () => {
  fakeDbState.opens += 1;
  return {
    getDatasetStatus: () => ({ core: true, metadata: true, playback: true }),
    onDatasetStatus: (callback: (status: { core: boolean; metadata: boolean; playback: boolean }) => void) => {
      callback({ core: true, metadata: true, playback: true });
      return () => undefined;
    },
    onDataChanged: () => () => undefined,
    listMedia: async () => [...fakeDbState.rows],
    listPlaylists: async () => [],
    readTitleVariants: async () => new Map(),
    countMediaItems: async () => fakeDbState.rows.length,
    flushPending: async () => undefined,
    getVersion: () => 1,
    getPendingOpsCount: () => 0,
    syncFromRemoteIfNewer: async () => {
      fakeDbState.syncs += 1;
      if (fakeDbState.failingSyncs > 0) {
        fakeDbState.failingSyncs -= 1;
        throw new Error("Network request failed");
      }
      if (fakeDbState.remoteRows.length === 0) return false;
      fakeDbState.rows = [...fakeDbState.remoteRows];
      fakeDbState.remoteRows = [];
      return true;
    },
    close: async () => {
      fakeDbState.closed += 1;
    },
  };
};

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => undefined }) },
}));
/** The library's live stream, so a test can deliver a server message as the API does when it answers again. */
const sse = vi.hoisted(() => ({ last: null as { onmessage: ((event: { data?: string }) => void) | null } | null }));
vi.mock("react-native-sse", () => ({
  default: class {
    onmessage: unknown = null;
    onerror: unknown = null;
    constructor() {
      sse.last = this as never;
    }
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
vi.mock("../src/lib/crypto", () => ({
  decryptBase64ToBytes: async () => {
    if (fakeDbState.keyRejected) throw new Error("bad key");
    return new Uint8Array();
  },
}));
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
    logout: async () => {
      fakeDbState.logouts += 1;
    },
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
    getLibraryMeta: async () => {
      if (fakeDbState.metaRejected) throw new actual.ApiError(401, { error: "unauthorized" });
      if (fakeDbState.metaDown) throw new TypeError("Network request failed");
      return {
        exists: fakeDbState.metaExists,
        bootstrapRequired: false,
        version: 5,
        snapshotVersion: 1,
        updatedAt: null,
        keyProbe: "probe",
      };
    },
  };
});

// Dynamic imports: the modules must load after the vi.mock factories above are registered.
const { LibraryProvider, useLibraryData, useLibraryStatus } = await import("../src/store/library");
const { resolveNavigatorScreen } = await import("../src/navigation/resolveScreen");

const flush = async () => {
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

let renderer: ReactTestRenderer | null = null;
let refresh: (() => Promise<void>) | null = null;
let loadStatusKind = "";
/** The store's `error`: what Home and the Library draw as a line above their content. */
let observedError: string | null = null;
let observedMedia: Row[] = [];
/** Every navigator screen the provider state produced, in render order. */
let screens: string[] = [];

const Probe = () => {
  const status = useLibraryStatus();
  refresh = status.refresh;
  loadStatusKind = status.loadStatus.kind;
  observedError = status.error;
  const { media } = useLibraryData();
  observedMedia = media.map((item) => ({ id: item.id, title: item.title }));
  screens.push(
    resolveNavigatorScreen({
      authLoading: false,
      user: { id: "u1" },
      contractIssue: status.contractIssue,
      formatTooNew: status.formatTooNew !== null,
      needsKey: status.needsKey,
      errorReportsAnswered: true,
      initializing: status.initializing,
      datasetStatus: status.datasetStatus,
    }),
  );
  return null;
};

beforeEach(() => {
  // React's act() reads this flag off the global; the global type has no such field.
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  fakeDbState.rows = [{ id: "m1", title: "Cached movie" }];
  fakeDbState.remoteRows = [];
  fakeDbState.opens = 0;
  fakeDbState.syncs = 0;
  fakeDbState.closed = 0;
  fakeDbState.failingSyncs = 0;
  fakeDbState.metaExists = true;
  fakeDbState.metaRejected = false;
  fakeDbState.metaDown = false;
  fakeDbState.keyRejected = false;
  fakeDbState.logouts = 0;
  observedMedia = [];
  screens = [];
  refresh = null;
  loadStatusKind = "";
  observedError = null;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
  });
  renderer = null;
});

describe("pull to refresh keeps the user on the current page", () => {
  it("@bugfix @regression-proof syncs and re-lists in place without leaving the main screen", async () => {
    await act(async () => {
      renderer = create(React.createElement(LibraryProvider, null, React.createElement(Probe)));
    });
    await flush();
    log("after load", { screen: screens.at(-1), opens: fakeDbState.opens, syncs: fakeDbState.syncs, status: loadStatusKind });
    expect(screens.at(-1)).toBe("main");
    const opensBefore = fakeDbState.opens;
    const syncsBefore = fakeDbState.syncs;

    fakeDbState.remoteRows = [
      { id: "m1", title: "Renamed movie" },
      { id: "m2", title: "New movie" },
    ];
    screens = [];
    await act(async () => {
      await refresh?.();
    });
    await flush();
    log("after pull refresh", {
      screens: [...new Set(screens)],
      opens: fakeDbState.opens,
      closed: fakeDbState.closed,
      syncs: fakeDbState.syncs,
      media: observedMedia,
    });

    expect(new Set(screens), "the navigator must never leave the main screen during a pull refresh").toEqual(new Set(["main"]));
    expect(fakeDbState.closed, "the open library db must not be closed").toBe(0);
    expect(fakeDbState.opens, "the library db must not be reopened").toBe(opensBefore);
    expect(fakeDbState.syncs, "a pull refresh syncs with the server").toBe(syncsBefore + 1);
    expect(observedMedia, "the lists show what the sync brought").toEqual([
      { id: "m1", title: "Renamed movie" },
      { id: "m2", title: "New movie" },
    ]);
  });

  // @req LIB-SYNC-03[badger-mobile]
  it("@bugfix @regression-proof syncs in place when the saved library is on screen but offline", async () => {
    fakeDbState.failingSyncs = 1;
    await act(async () => {
      renderer = create(React.createElement(LibraryProvider, null, React.createElement(Probe)));
    });
    await flush();
    log("after load with failed sync", { screen: screens.at(-1), status: loadStatusKind, syncs: fakeDbState.syncs });
    expect(loadStatusKind, "the failed background sync leaves the library offline").toBe("offline");
    expect(screens.at(-1)).toBe("main");
    const opensBefore = fakeDbState.opens;

    fakeDbState.remoteRows = [{ id: "m3", title: "Synced after recovery" }];
    screens = [];
    await act(async () => {
      await refresh?.();
    });
    await flush();
    log("after offline pull refresh", {
      screens: [...new Set(screens)],
      opens: fakeDbState.opens,
      closed: fakeDbState.closed,
      status: loadStatusKind,
      media: observedMedia,
    });

    expect(new Set(screens), "an offline pull must not leave the main screen either").toEqual(new Set(["main"]));
    expect(fakeDbState.closed, "the open library db must not be closed").toBe(0);
    expect(fakeDbState.opens, "the library db must not be reopened").toBe(opensBefore);
    expect(loadStatusKind, "a sync that works clears the offline state").toBe("ready");
    expect(observedMedia).toEqual([{ id: "m3", title: "Synced after recovery" }]);
  });

  // @req UX-TV-14[badger-tv]
  it("@bugfix @regression-proof leaves offline by itself once the live stream answers again", async () => {
    // Séjour, 2026-11-08: the API restarted, the stream reconnected and synced, and "Offline" stayed until a reload.
    fakeDbState.failingSyncs = 1;
    await act(async () => {
      renderer = create(React.createElement(LibraryProvider, null, React.createElement(Probe)));
    });
    await flush();
    expect(loadStatusKind).toBe("offline");

    fakeDbState.remoteRows = [{ id: "m4", title: "Added while offline" }];
    await act(async () => {
      sse.last?.onmessage?.({ data: JSON.stringify({ exists: true, version: 6, snapshotVersion: 1, keyProbe: "probe" }) });
    });
    await flush();
    log("after stream message", { status: loadStatusKind, media: observedMedia, opens: fakeDbState.opens });
    expect(loadStatusKind, "a stream message from the server clears the offline state").toBe("ready");
    expect(observedMedia).toEqual([{ id: "m4", title: "Added while offline" }]);
    expect(fakeDbState.closed, "recovery happens in place").toBe(0);
  });

  // @req LIB-SYNC-03[badger-mobile]
  it("stays offline when the pull cannot confirm the server's library", async () => {
    fakeDbState.failingSyncs = 1;
    await act(async () => {
      renderer = create(React.createElement(LibraryProvider, null, React.createElement(Probe)));
    });
    await flush();
    expect(loadStatusKind).toBe("offline");
    const syncsBefore = fakeDbState.syncs;

    // The API answers, but the snapshot is unavailable: the sync would skip the server without an error.
    fakeDbState.metaExists = false;
    screens = [];
    await act(async () => {
      await refresh?.();
    });
    await flush();
    log("after unconfirmed pull refresh", { screens: [...new Set(screens)], status: loadStatusKind, syncs: fakeDbState.syncs });

    expect(new Set(screens)).toEqual(new Set(["main"]));
    expect(loadStatusKind, "an unconfirmed server must not read as back online").toBe("offline");
    expect(fakeDbState.syncs, "no sync runs against an unconfirmed snapshot").toBe(syncsBefore);
  });

  it("signs out when the pull finds the session rejected", async () => {
    await act(async () => {
      renderer = create(React.createElement(LibraryProvider, null, React.createElement(Probe)));
    });
    await flush();
    fakeDbState.metaRejected = true;
    await act(async () => {
      await refresh?.();
    });
    await flush();
    log("after rejected-session pull", { logouts: fakeDbState.logouts, status: loadStatusKind });
    expect(fakeDbState.logouts, "a 401 on the pull signs the user out, as on the load").toBe(1);
  });

  it("asks for the key again when the pull finds the key rotated", async () => {
    await act(async () => {
      renderer = create(React.createElement(LibraryProvider, null, React.createElement(Probe)));
    });
    await flush();
    fakeDbState.keyRejected = true;
    const syncsBefore = fakeDbState.syncs;
    await act(async () => {
      await refresh?.();
    });
    await flush();
    log("after rotated-key pull", { screen: screens.at(-1), status: loadStatusKind, syncs: fakeDbState.syncs });
    expect(loadStatusKind).toBe("needs_key");
    expect(screens.at(-1), "the key entry screen takes over").toBe("onboarding");
    expect(fakeDbState.syncs, "nothing syncs with a key that no longer opens the library").toBe(syncsBefore);
  });
});

// UX-NOTICE-02[badger-mobile]: Chris 2026-11-13, the phone drew "Offline mode: using cached media library." as a red
// line above Home and the Library, under the offline banner that already said it. Offline lives in `loadStatus` alone
// (the tab bar's small sign and the passing notice); `error` stays for real errors, so no line is drawn. The TV reads
// the same store, so its Home and Library draw no offline line either; its lasting sign is the top-row pill (UX-TV-14).
describe("offline leaves no error line on the pages", () => {
  // @req UX-NOTICE-02[badger-mobile] @req UX-NOTICE-02[badger-tv]
  it("@bugfix @regression-proof opening the saved library without a connection sets offline and no error", async () => {
    fakeDbState.metaDown = true;
    await act(async () => {
      renderer = create(React.createElement(LibraryProvider, null, React.createElement(Probe)));
    });
    await flush();
    log("after offline load", { screen: screens.at(-1), status: loadStatusKind, error: observedError, media: observedMedia });
    expect(loadStatusKind).toBe("offline");
    expect(observedMedia, "the saved library stays on screen").toEqual([{ id: "m1", title: "Cached movie" }]);
    expect(observedError, "offline is not an error line").toBeNull();
  });
});
