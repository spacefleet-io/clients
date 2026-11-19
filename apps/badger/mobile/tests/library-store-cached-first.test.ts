/**
 * @test-id MOBILE-LIBRARY-STORE-CACHED-FIRST-001
 * @level unit
 * @bugfix
 * @regression-proof
 *
 * Why this exists: a cold start showed nothing until FOUR sequential network calls had answered
 * (`/system/contract`, `/library/db/meta`, then `LibraryDb.open` asked `/library/db/meta` a second time)
 * before it even looked at the library already saved on the phone. On a slow link that is seconds of spinner
 * and on a stalled API it was the whole request timeout (measured: ~24 s) with the saved library sitting on
 * disk. The store now opens the saved split cache first (no network), paints Home from it, and only then
 * settles the contract verdict and the sync; every preflight request is bounded.
 *
 * Mounts the real LibraryProvider with react-test-renderer around a fake LibraryDb (no React Native runtime).
 * Every network stall below is a promise that never resolves, so no assertion depends on timing.
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type * as SharedApi from "@space/shared/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = { id: string; title: string };
type LibraryMetaStub = { exists: boolean; version: number; snapshotVersion: number; updatedAt: null; keyProbe: null };

const never = <T>() => new Promise<T>(() => undefined);

const ctl = vi.hoisted(() => ({
  cachedRows: null as { id: string; title: string }[] | null,
  contract: null as Promise<unknown> | null,
  contractIssue: null as string | null,
  meta: null as Promise<unknown> | null,
  openCalls: [] as unknown[][],
  openLocalCalls: 0,
  /** What `openLocal` finds saved on the phone; null = nothing (it throws LIBRARY_CACHE_MISSING like the real one). */
  localRows: null as { id: string; title: string }[] | null,
  metaCalls: 0,
  closed: 0,
  syncCalls: 0,
  /** The signed-in account's admin flag (ACCT-AUTH-07: it must change nothing in the app). */
  isAdmin: false,
  keyCleared: 0,
  cacheCleared: 0,
  /** The kept key does not open the account's probe. */
  keyRejected: false,
  /** `attachProfileSettingsLibrary` calls: the active profile's settings bound to an open library (ACCT-SQUAD-03). */
  attached: 0,
  /** The background sync's answer: null = no change at once; a promise = held until the test resolves it with the
   * rows the server has (null there = nothing new). */
  sync: null as Promise<{ id: string; title: string }[] | null> | null,
  /** The user has passed the key step (`isLibraryKeyAcknowledged`). */
  keyAck: true,
}));

const makeFakeDb = (rows: Row[]) => ({
  getDatasetStatus: () => ({ core: true, metadata: true, playback: true }),
  onDatasetStatus: (callback: (status: { core: boolean; metadata: boolean; playback: boolean }) => void) => {
    callback({ core: true, metadata: true, playback: true });
    return () => undefined;
  },
  onDataChanged: () => () => undefined,
  listMedia: async () => [...rows],
  listPlaylists: async () => [],
  readTitleVariants: async () => new Map(),
  countMediaItems: async () => rows.length,
  flushPending: async () => undefined,
  getVersion: () => 7,
  getPendingOpsCount: () => 0,
  syncFromRemoteIfNewer: async () => {
    ctl.syncCalls += 1;
    const next = ctl.sync ? await ctl.sync : null;
    if (!next) return false;
    rows.splice(0, rows.length, ...next);
    return true;
  },
  close: async () => {
    ctl.closed += 1;
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
    openCachedSplit: async () => (ctl.cachedRows ? makeFakeDb(ctl.cachedRows) : null),
    open: async (...args: unknown[]) => {
      ctl.openCalls.push(args);
      return makeFakeDb([{ id: "remote", title: "Downloaded" }]);
    },
    openLocal: async () => {
      ctl.openLocalCalls += 1;
      if (!ctl.localRows) throw new Error("LIBRARY_CACHE_MISSING");
      return makeFakeDb(ctl.localRows);
    },
    clearLocalCache: async () => {
      ctl.cacheCleared += 1;
    },
    claimLocalCache: async () => undefined,
  },
  QuotaExceededError: class extends Error {},
}));
vi.mock("../src/lib/onboarding", () => ({
  clearLibraryKey: async () => {
    ctl.keyCleared += 1;
  },
  getStoredLibraryKey: async () => "key",
  isLibraryKeyAcknowledged: async () => ctl.keyAck,
  setLibraryKeyAcknowledged: async () => undefined,
}));
vi.mock("../src/lib/mediaCrypto", () => ({ setMediaKeyFromBase64: () => undefined }));
vi.mock("../src/lib/crypto", () => ({
  decryptBase64ToBytes: async () => {
    if (ctl.keyRejected) throw new Error("bad tag");
    return new Uint8Array();
  },
}));
vi.mock("../src/lib/networkListener", () => ({ onNetworkRecover: () => () => undefined }));
// The artwork copy (META-ART-01) talks to the metadata service and the storage tunnel: a no-op stand-in here.
vi.mock("../src/lib/libraryArtworkCopy", () => ({ startLibraryArtworkCopy: () => ({ migrate: () => undefined, stop: () => undefined }) }));
vi.mock("../src/lib/libraryTitleVariants", () => ({
  startLibraryTitleVariants: () => ({ request: () => undefined, stop: () => undefined }),
}));
vi.mock("../src/lib/profileSettings", () => ({
  attachProfileSettingsLibrary: () => {
    ctl.attached += 1;
    return () => undefined;
  },
}));
vi.mock("../src/native/pushHandler", () => ({
  getOrCreateDeviceId: async () => "device",
  initializePushNotifications: async () => undefined,
  unregisterPushNotifications: async () => undefined,
}));
vi.mock("@space/mobile-shell/i18n", () => {
  const value = { t: (key: string) => key, i18n: { language: "en" } };
  return { useTranslation: () => value };
});
vi.mock("../src/store/auth", () => {
  // Stable identity: the store's load effect depends on `logout`.
  const auth = {
    token: "token",
    user: {
      id: "u1",
      get isAdmin() {
        return ctl.isAdmin;
      },
    },
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
    getSystemContract: () => ctl.contract ?? Promise.resolve({ apiVersion: 1, apps: {} }),
    getSystemContractIssue: () => ctl.contractIssue,
    getLibraryMeta: () => {
      ctl.metaCalls += 1;
      return (
        ctl.meta ??
        Promise.resolve({ exists: true, version: 5, snapshotVersion: 1, updatedAt: null, keyProbe: null })
      );
    },
  };
});

const { LibraryProvider, useLibraryActions, useLibraryData, useLibraryStatus } = await import("../src/store/library");

const flush = async () => {
  for (let i = 0; i < 20; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

let renderer: ReactTestRenderer | null = null;
let observedMedia: string[] = [];
/** The key step's "done" (`acknowledgeKey`) from the last render. */
let acknowledgeKey: (() => Promise<void>) | null = null;
/** `kind` is the LoadStatus discriminant; `null` before the first render. */
let observedStatus: { kind: string; initializing: boolean; contractIssue: string | null; settled: boolean } | null = null;
/** Every (media count, settled) pair a render saw, in order (UX-WAIT-04). */
let renders: { media: number; settled: boolean }[] = [];

const Probe = () => {
  const { media } = useLibraryData();
  observedMedia = media.map((item) => item.id);
  const status = useLibraryStatus();
  observedStatus = { kind: status.loadStatus.kind, initializing: status.initializing, contractIssue: status.contractIssue, settled: status.settled };
  renders.push({ media: media.length, settled: status.settled });
  acknowledgeKey = useLibraryActions().acknowledgeKey;
  return null;
};

const mount = async () => {
  await act(async () => {
    renderer = create(React.createElement(LibraryProvider, null, React.createElement(Probe)));
  });
  await flush();
};

beforeEach(() => {
  // React's act() reads this flag off the global; the global type has no such field.
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  ctl.cachedRows = null;
  ctl.contract = null;
  ctl.contractIssue = null;
  ctl.meta = null;
  ctl.openCalls = [];
  ctl.openLocalCalls = 0;
  ctl.localRows = [{ id: "local", title: "Local fallback" }];
  ctl.metaCalls = 0;
  ctl.closed = 0;
  ctl.syncCalls = 0;
  ctl.isAdmin = false;
  ctl.keyCleared = 0;
  ctl.cacheCleared = 0;
  ctl.keyRejected = false;
  ctl.attached = 0;
  ctl.sync = null;
  ctl.keyAck = true;
  acknowledgeKey = null;
  renders = [];
  observedMedia = [];
  observedStatus = null;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.useRealTimers();
  await act(async () => {
    renderer?.unmount();
  });
  renderer = null;
});

describe("library store paints the saved library before the network answers", () => {
  it("@bugfix @regression-proof Home shows the saved library while /system/contract and /library/db/meta never answer", async () => {
    ctl.cachedRows = [{ id: "m1", title: "Saved movie" }];
    ctl.contract = never();
    ctl.meta = never();

    await mount();

    expect(observedMedia, "the saved library must render without any network answer").toEqual(["m1"]);
    expect(observedStatus?.kind).toBe("ready");
    expect(observedStatus?.initializing, "the loading-library screen must be gone").toBe(false);
    expect(ctl.openCalls, "the saved copy was used, not a network open").toEqual([]);
  });

  // @req ACCT-AUTH-07[badger-mobile]
  it("an admin account loads its library like any other account", async () => {
    ctl.isAdmin = true;
    ctl.cachedRows = [{ id: "m1", title: "Saved movie" }];

    await mount();

    console.info(`[library-store:admin] isAdmin=${ctl.isAdmin} media=${JSON.stringify(observedMedia)} status=${JSON.stringify(observedStatus)}`);
    expect(observedMedia, "an admin's library must load, not be skipped").toEqual(["m1"]);
    expect(observedStatus?.kind).toBe("ready");
  });

  it("@bugfix @regression-proof a saved library stays on screen, flagged offline, when /library/db/meta fails", async () => {
    ctl.cachedRows = [{ id: "m1", title: "Saved movie" }];
    ctl.meta = Promise.reject(new Error("Network request failed"));

    await mount();

    expect(observedMedia).toEqual(["m1"]);
    expect(observedStatus?.kind).toBe("offline");
    expect(ctl.openCalls).toEqual([]);
    expect(ctl.syncCalls, "nothing to sync against without meta").toBe(0);
  });

  it("syncs the saved library in the background once meta answers, without opening a second db", async () => {
    ctl.cachedRows = [{ id: "m1", title: "Saved movie" }];

    await mount();

    expect(observedMedia).toEqual(["m1"]);
    expect(observedStatus?.kind).toBe("ready");
    expect(ctl.syncCalls).toBe(1);
    expect(ctl.openCalls, "no network open when the cache could be opened").toEqual([]);
    expect(ctl.metaCalls, "meta is requested once per load").toBe(1);
  });

  it("clears the painted library when the contract verdict then blocks this build", async () => {
    ctl.cachedRows = [{ id: "m1", title: "Saved movie" }];
    ctl.contractIssue = "app_update_required";

    await mount();

    expect(observedMedia, "a blocked build must not keep showing the library").toEqual([]);
    expect(observedStatus?.kind).toBe("fatal");
    expect(observedStatus?.contractIssue).toBe("app_update_required");
    expect(ctl.closed, "the painted db is closed").toBe(1);
    expect(ctl.metaCalls, "the blocked verdict ends the load before meta").toBe(0);
  });

  it("without a saved library, opens the download with the meta it already has (one meta request)", async () => {
    await mount();

    expect(observedMedia).toEqual(["remote"]);
    expect(observedStatus?.kind).toBe("ready");
    expect(ctl.metaCalls).toBe(1);
    expect(ctl.openCalls).toHaveLength(1);
    expect(ctl.openCalls[0]?.[2], "LibraryDb.open receives the fetched meta").toMatchObject({ exists: true, version: 5 });
  });

  it("@bugfix @regression-proof a stalled /library/db/meta times out and falls back to the local copy", async () => {
    vi.useFakeTimers();
    ctl.meta = never<LibraryMetaStub>();

    await mount();
    expect(observedStatus?.kind, "still waiting on meta, nothing saved to paint").toBe("loading");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    await flush();

    expect(observedStatus?.kind).toBe("offline");
    expect(ctl.openLocalCalls).toBe(1);
    expect(observedMedia).toEqual(["local"]);
  });
});

// Since the account-wide erase (UX-KEY-01), "no Badger library" is only a server without a library when the account
// still has its key (a probe, e.g. made by Parrot); with no probe AND no library the account's key was erased.
const NO_BADGER_LIBRARY = { exists: false, bootstrapRequired: true, version: 0, snapshotVersion: 0, updatedAt: null, keyProbe: "probe" };

describe("a server with no library never wipes the saved library", () => {
  // @req LIB-SYNC-03[badger-mobile]
  it("@bugfix @regression-proof keeps the saved library on screen when meta reports no library on the server", async () => {
    ctl.cachedRows = [{ id: "m1", title: "Saved movie" }];
    ctl.meta = Promise.resolve(NO_BADGER_LIBRARY);

    await mount();

    expect(observedMedia, "the saved library must survive a server that has none").toEqual(["m1"]);
    expect(observedStatus?.kind).toBe("ready");
    expect(ctl.syncCalls, "there is no server library to sync against").toBe(0);
    expect(ctl.closed, "the saved db stays open").toBe(0);
    expect(ctl.keyCleared + ctl.cacheCleared, "the account still has this key").toBe(0);
  });

  // @req LIB-SYNC-03[badger-mobile]
  it("@bugfix @regression-proof keeps a library saved in the older combined format when meta reports no library", async () => {
    // openCachedSplit only reads the split format, so the saved library is not painted before meta answers.
    ctl.localRows = [{ id: "old", title: "Saved before the split format" }];
    ctl.meta = Promise.resolve(NO_BADGER_LIBRARY);

    await mount();

    console.info("[library-store-cached-first] combined cache, no server library", { observedMedia, observedStatus });
    expect(ctl.openLocalCalls).toBe(1);
    expect(observedMedia, "the saved library must survive a server that has none").toEqual(["old"]);
    expect(observedStatus?.kind).toBe("ready");
    expect(ctl.syncCalls, "there is no server library to sync against").toBe(0);
    expect(ctl.closed, "the saved db stays open").toBe(0);
  });

  /**
   * @bugfix @regression-proof
   * Pairing sign-in (ACCT-PAIR-01) on an account whose key was made in Parrot: the pairing brings the key, so the key
   * step (which creates Badger's library for such a key) never runs. The store showed an empty home with NO library
   * open, so the profile's settings were never bound (`attachProfileSettingsLibrary`) and the setup's "How should
   * titles appear?" step stayed a blank sky forever (ACCT-PROF-03). Badger's library is now created with the key.
   */
  // @req ACCT-PROF-03[badger-mobile,badger-tv]
  it("@bugfix @regression-proof creates Badger's library with the account's key when neither a saved nor a server library exists (pairing sign-in)", async () => {
    const T = "[library-store:no-badger-library]";
    ctl.localRows = null;
    ctl.meta = Promise.resolve(NO_BADGER_LIBRARY);

    await mount();

    console.info(T, { observedMedia, observedStatus, openCalls: ctl.openCalls.length, attached: ctl.attached, openLocalCalls: ctl.openLocalCalls, keyCleared: ctl.keyCleared });
    expect(observedStatus?.kind).toBe("ready");
    expect(ctl.openCalls, "Badger's library is created with the account's key").toHaveLength(1);
    expect(ctl.openCalls[0]?.[1], "with the key the pairing brought").toBe("key");
    expect(ctl.openCalls[0]?.[2], "LibraryDb.open bootstraps from the absent meta").toMatchObject({ exists: false, bootstrapRequired: true });
    expect(ctl.attached, "the profile's settings are bound to the library, so the title question can render").toBe(1);
    expect(ctl.keyCleared + ctl.cacheCleared, "the account's key is kept").toBe(0);
  });
});

/**
 * @req UX-KEY-01[badger-mobile,badger-tv]
 * Main 2026-11-12: "On start (and on foreground if cheap), the app checks that its kept key still matches the
 * account's library/probe. A mismatch or a missing probe means: forget the key, clear the local library cache, go to
 * the shared key step (enter if there's a probe, create if none). A network failure keeps the key."
 */
describe("a kept key the account no longer has is forgotten at start (UX-KEY-01)", () => {
  it("erased elsewhere (no probe, no library): closes the saved library, forgets the key, clears the cache, asks for a key", async () => {
    ctl.cachedRows = [{ id: "m1", title: "Saved movie" }];
    ctl.meta = Promise.resolve({ ...NO_BADGER_LIBRARY, keyProbe: null });

    await mount();

    console.info("[library-store-cached-first] erased elsewhere", { observedMedia, observedStatus, ctl: { keyCleared: ctl.keyCleared, cacheCleared: ctl.cacheCleared, closed: ctl.closed, syncCalls: ctl.syncCalls } });
    expect(observedStatus?.kind).toBe("needs_key");
    expect(observedMedia).toEqual([]);
    expect(ctl.keyCleared).toBe(1);
    expect(ctl.cacheCleared).toBe(1);
    expect(ctl.closed, "the saved library under the old key is closed").toBe(1);
    expect(ctl.syncCalls, "nothing syncs with the forgotten key").toBe(0);
  });

  it("remade elsewhere (the probe does not open with the kept key): forgets it the same way", async () => {
    ctl.cachedRows = [{ id: "m1", title: "Saved movie" }];
    ctl.keyRejected = true;
    ctl.meta = Promise.resolve({ exists: true, version: 5, snapshotVersion: 1, updatedAt: null, keyProbe: "other-probe" });

    await mount();

    console.info("[library-store-cached-first] remade elsewhere", { observedStatus, keyCleared: ctl.keyCleared, cacheCleared: ctl.cacheCleared });
    expect(observedStatus?.kind).toBe("needs_key");
    expect(ctl.keyCleared).toBe(1);
    expect(ctl.cacheCleared).toBe(1);
    expect(ctl.syncCalls).toBe(0);
    expect(ctl.openCalls).toEqual([]);
  });
});

// Chris 2026-11-18: "The badger app shows the empty library 'upload your first media on desktop' before the library
// loads." A saved copy with no titles painted as ready while the sync that brings the titles still ran.
describe("the library says what it holds only once the sync has answered (UX-WAIT-04)", () => {
  // @req UX-WAIT-04[badger-mobile] @req UX-WAIT-04[badger-tv]
  it("@bugfix a saved empty copy is not 'empty' while the sync runs; the titles it brings arrive before 'settled'", async () => {
    ctl.cachedRows = [];
    const { promise, resolve: answer } = Promise.withResolvers<{ id: string; title: string }[] | null>();
    ctl.sync = promise;

    await mount();
    console.info("[UX-WAIT-04:store] sync pending", JSON.stringify({ observedMedia, observedStatus, syncCalls: ctl.syncCalls }));
    expect(ctl.syncCalls, "the background sync started").toBe(1);
    expect(observedMedia).toEqual([]);
    expect(observedStatus?.settled, "an empty saved copy is not a verdict while the sync runs").toBe(false);

    await act(async () => {
      answer([{ id: "m1", title: "Synced movie" }]);
    });
    await flush();
    console.info("[UX-WAIT-04:store] sync done", JSON.stringify({ observedMedia, observedStatus, renders }));
    expect(observedMedia).toEqual(["m1"]);
    expect(observedStatus?.settled).toBe(true);
    expect(
      renders.filter((render) => render.media === 0 && render.settled),
      "no render ever said 'empty' on the way to the synced titles",
    ).toEqual([]);
  });

  // @req UX-WAIT-04[badger-mobile]
  it("an empty library is settled once the sync confirms nothing is new", async () => {
    ctl.cachedRows = [];
    const { promise, resolve: answer } = Promise.withResolvers<{ id: string; title: string }[] | null>();
    ctl.sync = promise;
    await mount();
    expect(observedStatus?.settled).toBe(false);
    await act(async () => {
      answer(null);
    });
    await flush();
    console.info("[UX-WAIT-04:store] confirmed empty", JSON.stringify({ observedMedia, observedStatus }));
    expect(observedMedia).toEqual([]);
    expect(observedStatus?.settled).toBe(true);
  });

  // @req UX-WAIT-04[badger-mobile]
  it("a saved library with titles shows at once, before the sync answers", async () => {
    ctl.cachedRows = [{ id: "m1", title: "Saved movie" }];
    ctl.sync = never();
    await mount();
    console.info("[UX-WAIT-04:store] saved titles", JSON.stringify({ observedMedia, observedStatus }));
    expect(observedMedia).toEqual(["m1"]);
    expect(observedStatus?.settled).toBe(false);
  });

  // @req UX-WAIT-04[badger-mobile]
  it("offline with a saved copy is settled: the saved copy is all there is to show", async () => {
    ctl.cachedRows = [];
    ctl.meta = Promise.reject(new Error("Network request failed"));
    await mount();
    console.info("[UX-WAIT-04:store] offline", JSON.stringify({ observedMedia, observedStatus }));
    expect(observedStatus?.kind).toBe("offline");
    expect(observedStatus?.settled).toBe(true);
  });

  // @req UX-WAIT-04[badger-mobile] @req UX-WAIT-04[badger-tv]
  it("@bugfix after the key step at sign-in, a saved empty copy is not 'empty' while the sync runs", async () => {
    ctl.keyAck = false;
    ctl.cachedRows = [];
    const { promise, resolve: answer } = Promise.withResolvers<{ id: string; title: string }[] | null>();
    ctl.sync = promise;
    await mount();
    console.info("[UX-WAIT-04:store] key step", JSON.stringify({ observedStatus }));
    expect(observedStatus?.kind).toBe("needs_key");
    expect(observedStatus?.settled, "the key step says nothing about what the library holds").toBe(false);

    ctl.keyAck = true;
    renders = [];
    await act(async () => {
      await acknowledgeKey?.();
    });
    await flush();
    console.info("[UX-WAIT-04:store] key given, sync pending", JSON.stringify({ observedMedia, observedStatus, syncCalls: ctl.syncCalls }));
    expect(ctl.syncCalls, "the background sync started").toBe(1);
    expect(observedStatus?.settled, "an empty saved copy is not a verdict while the sync runs").toBe(false);

    await act(async () => {
      answer([{ id: "m1", title: "Synced movie" }]);
    });
    await flush();
    console.info("[UX-WAIT-04:store] key given, sync done", JSON.stringify({ observedMedia, observedStatus, renders }));
    expect(observedMedia).toEqual(["m1"]);
    expect(observedStatus?.settled).toBe(true);
    expect(renders.filter((render) => render.media === 0 && render.settled)).toEqual([]);
  });
});
