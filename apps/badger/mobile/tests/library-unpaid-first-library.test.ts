/**
 * @test-id MOBILE-LIBRARY-UNPAID-FIRST-LIBRARY-001
 * @level unit
 * @bugfix
 * @regression-proof
 * @req ACCT-UNPAID-06[badger-mobile]
 *
 * Why this exists: an unpaid account whose key was acknowledged but which has no Badger library yet (a key made in
 * Parrot, or a first library refused earlier) sat on "Loading library…" forever. The store's load saw the meta answer
 * "no library", tried to create it, and the API refused with 402 `subscription_unpaid`; the fallback found no saved
 * copy, the load ended "fatal" with `initializing` still true, so the navigator never left the loading screen. The
 * refusal must send the user to the key step, where the setup shows the "Your plan has ended" screen (ACCT-UNPAID-06)
 * and goes on from there once the plan is renewed.
 *
 * Mounts the real LibraryProvider with react-test-renderer around a fake LibraryDb (no React Native runtime needed).
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type * as SharedApi from "@space/shared/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TAG = "[library-unpaid-first-library]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

const ctl = { creates: 0, keyCleared: 0 };

/** The API's unpaid refusal as the phone's storage client raises it. */
class UnpaidRefusal extends Error {
  status = 402;
  payload = { error: "subscription_unpaid", wipeAt: "2027-01-20T00:00:00.000Z" };
  constructor() {
    super("subscription_unpaid");
  }
}

vi.mock("react-native", async () => ({
  ...(await import("./setup/reactNativeMock")).reactNativeBase(),
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
    openCachedSplit: async () => null,
    open: async () => {
      ctl.creates += 1;
      throw new UnpaidRefusal();
    },
    openLocal: async () => {
      throw new Error("no saved library");
    },
    clearLocalCache: async () => undefined,
    claimLocalCache: async () => undefined,
  },
  QuotaExceededError: class extends Error {},
}));
vi.mock("../src/lib/onboarding", () => ({
  clearLibraryKey: async () => {
    ctl.keyCleared += 1;
  },
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
  const auth = { token: "token", user: { id: "u1", isAdmin: false }, logout: async () => undefined, loading: false };
  return { useAuth: () => auth };
});
vi.mock("@space/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof SharedApi>();
  return {
    ...actual,
    getApiBaseUrl: () => "http://api.test",
    getSystemContract: async () => ({ apiVersion: 1, apps: {} }),
    getSystemContractIssue: () => null,
    // The account has its key (made in Parrot) but no Badger library yet.
    getLibraryMeta: async () => ({
      exists: false,
      bootstrapRequired: true,
      version: 0,
      snapshotVersion: null,
      updatedAt: null,
      keyProbe: "probe",
    }),
  };
});

// Dynamic imports: the modules must load after the vi.mock factories above are registered.
const { LibraryProvider, useLibraryStatus } = await import("../src/store/library");
const { resolveNavigatorScreen } = await import("../src/navigation/resolveScreen");

const flush = async () => {
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

let renderer: ReactTestRenderer | null = null;
let loadStatusKind = "";
let screens: string[] = [];

const Probe = () => {
  const status = useLibraryStatus();
  loadStatusKind = status.loadStatus.kind;
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
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  ctl.creates = 0;
  ctl.keyCleared = 0;
  screens = [];
  loadStatusKind = "";
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
  });
  renderer = null;
});

describe("an unpaid account with no Badger library yet", () => {
  it("@bugfix @regression-proof leaves Loading library for the key step's unpaid screen, keeping the key", async () => {
    await act(async () => {
      renderer = create(React.createElement(LibraryProvider, null, React.createElement(Probe)));
    });
    await flush();
    log("after load", { screen: screens.at(-1), status: loadStatusKind, creates: ctl.creates, keyCleared: ctl.keyCleared });

    expect(ctl.creates, "the load tried to create the library").toBe(1);
    expect(screens.at(-1), "the refusal must never leave the user on Loading library").toBe("onboarding");
    expect(loadStatusKind).toBe("needs_key");
    expect(ctl.keyCleared, "the account's key stays: setup goes on with it once the plan is renewed").toBe(0);
  });
});
