/**
 * @test-id MOBILE-SELF-UPDATE-CONSENT-001
 * @level unit
 * @req REL-UPD-06
 * @why Chris 2026-11-18: F-Droid's Inclusion Policy asks for the user's consent before an app updates itself, so a
 *   hand-installed APK asks once, as a setup step with Yes preselected, and reaches our repository only after a yes.
 *   A store-managed install and an installer we don't know never check on their own.
 */
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLIENT_UI_LANGUAGES } from "@space/shared/i18n";
import { answerConsent, resetSelfUpdate, startSelfUpdate, useSelfUpdate } from "../src/controller";
import { selfUpdateText } from "../src/strings";

const { native, storage } = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  native: {
    getInstallSource: vi.fn(),
    getInstalledApp: vi.fn(async () => ({ packageName: "com.spacebadger.mobile", versionName: "0.1.2", versionCode: 15000, signers: ["aa"] })),
    fetchRepoEntry: vi.fn(async () => {
      throw new Error("offline");
    }),
    fetchVerifiedText: vi.fn(),
    downloadApk: vi.fn(),
    cancelDownload: vi.fn(),
    canRequestPackageInstalls: vi.fn(),
    openInstallPermission: vi.fn(),
    install: vi.fn(),
    addListener: vi.fn(),
    removeListeners: vi.fn(),
  },
}));

vi.mock("react-native", () => ({
  NativeModules: { SelfUpdate: native },
  NativeEventEmitter: class {
    addListener() {
      return { remove: () => undefined };
    }
  },
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => storage.get(key) ?? null,
    setItem: async (key: string, value: string) => void storage.set(key, value),
  },
}));
// The hook outside React: the current state.
vi.mock("react", async (original) => ({ ...(await original<typeof React>()), useSyncExternalStore: (_: unknown, get: () => unknown) => get() }));

const launch = async (installing: string | null, initiating: string | null = null) => {
  native.getInstallSource.mockResolvedValue({ installing, initiating });
  await startSelfUpdate("badger");
};

beforeEach(() => {
  resetSelfUpdate();
  storage.clear();
  native.fetchRepoEntry.mockClear();
});

describe("self-update consent (REL-UPD-06)", () => {
  // @req REL-UPD-06
  it("asks a hand install first and reaches nothing before the answer", async () => {
    await launch(null);
    expect(useSelfUpdate().consentPending).toBe(true);
    expect(native.fetchRepoEntry).not.toHaveBeenCalled();
  });

  // @req REL-UPD-06
  it("checks at once after a yes, and never asks again", async () => {
    await launch(null);
    await answerConsent(true);
    expect(native.fetchRepoEntry).toHaveBeenCalledTimes(1);
    expect(useSelfUpdate()).toMatchObject({ consentPending: false, autoUpdate: true });
    resetSelfUpdate();
    await launch(null);
    expect(useSelfUpdate().consentPending).toBe(false);
    expect(native.fetchRepoEntry).toHaveBeenCalledTimes(2);
  });

  // @req REL-UPD-06
  it("after a no, stays off the network and leaves the switch off", async () => {
    await launch(null);
    await answerConsent(false);
    resetSelfUpdate();
    await launch(null);
    expect(useSelfUpdate()).toMatchObject({ consentPending: false, autoUpdate: false });
    expect(native.fetchRepoEntry).not.toHaveBeenCalled();
  });

  // @req REL-UPD-06
  it("a store-managed install and an unknown installer get no step and no check on launch", async () => {
    await launch("com.looker.droidify", "com.looker.droidify");
    expect(useSelfUpdate()).toMatchObject({ manager: "managed", consentPending: false });
    resetSelfUpdate();
    await launch("com.example.someupdater");
    expect(useSelfUpdate()).toMatchObject({ manager: "unknown", consentPending: false });
    expect(native.fetchRepoEntry).not.toHaveBeenCalled();
  });

  // @req REL-UPD-06
  it("says the consent step in every app language", () => {
    for (const { code: language } of CLIENT_UI_LANGUAGES) {
      for (const key of ["consentTitle", "consentBody", "consentYes", "consentNo"] as const) {
        expect(selfUpdateText(language, key, { app: "Badger" }), `${language} ${key}`).not.toMatch(/^consent|\{app\}/);
      }
    }
  });
});
