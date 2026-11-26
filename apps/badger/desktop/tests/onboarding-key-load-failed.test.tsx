// @vitest-environment jsdom
/**
 * @test-id BADGER-DESKTOP-KEY-LOAD-FAILED-001
 * @level unit
 * @bugfix @regression-proof
 * @req UX-KEY-02[badger-desktop]
 * @why Badger desktop 0.1.72's release smoke (2026-11-26) sat on "Loading key…" for 39 and 61 s
 *   while a prod disk stall slowed `GET /library/db/meta`: the key step waited on it with no bound and said nothing.
 *   Now a read that fails or runs out of time shows "Your key could not be loaded" with Retry, Retry reads the meta
 *   again, and a failed read decides nothing: no new words, and a key kept on this computer stays.
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@space/sdk";
import type * as Sdk from "@space/sdk";

type SdkModule = typeof Sdk;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "[BADGER-DESKTOP-KEY-LOAD-FAILED-001]";

const mocks = vi.hoisted(() => ({
  getLibraryMetaForKeyStep: vi.fn(),
  getStoredLibraryKey: vi.fn(async (): Promise<string | null> => null),
  clearLibraryKey: vi.fn(async () => undefined),
  storeLibraryKey: vi.fn(async (_key: string) => undefined),
  logout: vi.fn(async () => undefined),
  t: (key: string) => key,
  auth: {} as Record<string, unknown>,
  libraryActions: {} as Record<string, unknown>,
}));
mocks.auth = { user: { id: "u1", email: "a@b.c" }, token: "own-session", logout: mocks.logout };

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t, i18n: { language: "en" } }),
}));
vi.mock("../src/renderer/src/auth", () => ({ useAuth: () => mocks.auth }));
// The real ApiError, so the screen's error class reads the status: vi.mock factories run before static imports.
vi.mock("../src/renderer/src/api", async () => ({
  ApiError: (await vi.importActual<SdkModule>("@space/sdk")).ApiError,
  getLibraryMetaForKeyStep: mocks.getLibraryMetaForKeyStep,
  resetLibrary: vi.fn(),
  rotateLibraryKey: vi.fn(),
}));
vi.mock("../src/renderer/src/lib/onboarding", () => ({
  acknowledgeLibraryKey: vi.fn(async () => undefined),
  clearLibraryKey: mocks.clearLibraryKey,
  getStoredLibraryKey: mocks.getStoredLibraryKey,
  isLibraryKeyAcknowledged: vi.fn(async () => false),
  storeLibraryKey: mocks.storeLibraryKey,
}));
vi.mock("../src/renderer/src/lib/libraryContext", () => ({
  isDecryptFailureMessage: () => false,
  useLibraryShell: () => ({ error: null }),
  useLibraryActions: () => mocks.libraryActions,
}));
vi.mock("../src/renderer/src/lib/profileStore", () => ({ useProfiles: () => ({ profiles: [], activeId: null }) }));
vi.mock("../src/renderer/src/lib/libraryDb", () => ({ LibraryDb: { open: vi.fn(), hasLocalCache: vi.fn(async () => false) } }));
vi.mock("../src/renderer/src/lib/config", () => ({
  loadClientConfig: () => ({ configured: true, uiLanguage: "en" }),
  saveClientConfig: vi.fn(),
}));
vi.mock("../src/renderer/src/lib/accountUiLanguage", () => ({ pickUiLanguage: vi.fn() }));
vi.mock("../src/renderer/src/lib/pairedSignIn", () => ({ verifyPairedKey: vi.fn() }));
vi.mock("../src/renderer/src/lib/pairedSignInDeps", () => ({ pairedKeyCheckDeps: {} }));
vi.mock("@space/ui", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  LanguageMenu: () => null,
}));

import OnboardingKey from "../src/renderer/src/pages/OnboardingKey";

let container: HTMLDivElement;
let root: Root;
const q = (testId: string) => document.body.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
  });
};
const words = () => container.querySelectorAll('[data-testid="library-key-word"]').length;
const dump = (label: string) =>
  console.info(
    `${SUITE} ${label}: failed=${q("key-load-failed")?.dataset.errorClass ?? "no"} words=${words()} reads=${mocks.getLibraryMetaForKeyStep.mock.calls.length} stored=${mocks.storeLibraryKey.mock.calls.length} cleared=${mocks.clearLibraryKey.mock.calls.length} text=${JSON.stringify(container.textContent?.slice(0, 160))}`,
  );

const mount = async () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/onboarding/key"]}>
        <Routes>
          <Route path="/onboarding/key" element={<OnboardingKey />} />
          <Route path="/" element={<div data-testid="library" />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await flush();
};

const timeout = () => new ApiError(0, { error: "timeout" });

mocks.libraryActions = { reload: () => undefined, clearLocalCache: async () => undefined, activateRemoteLibrary: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getStoredLibraryKey.mockResolvedValue(null);
  Object.assign(window, { sf: { setMediaKey: vi.fn(async () => undefined) } });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("@req UX-KEY-02 Badger desktop: a key step whose meta read fails shows Retry", () => {
  it("a read that runs out of time shows the error with Retry, no new words; Retry recovers", async () => {
    mocks.getLibraryMetaForKeyStep
      .mockRejectedValueOnce(timeout())
      .mockResolvedValueOnce({ exists: false, keyProbe: null, bootstrapRequired: true });
    await mount();
    dump("after stall");
    expect(q("key-load-failed")?.dataset.errorClass).toBe("timeout");
    expect(container.textContent).toContain("Your key could not be loaded");
    expect(container.textContent).toContain("The server is taking too long to answer");
    expect(container.textContent).not.toContain("onboarding.key.loading");
    expect(words()).toBe(0);
    expect(mocks.storeLibraryKey).not.toHaveBeenCalled();

    await act(async () => q("key-load-retry")!.click());
    await flush();
    dump("after retry");
    expect(mocks.getLibraryMetaForKeyStep).toHaveBeenCalledTimes(2);
    expect(q("key-load-failed")).toBeNull();
    expect(words()).toBe(12);
  });

  it("with a key kept on this computer, a failed read keeps it and shows Retry", async () => {
    mocks.getStoredLibraryKey.mockResolvedValue("a2VwdA==");
    mocks.getLibraryMetaForKeyStep.mockRejectedValueOnce(new TypeError("fetch failed"));
    await mount();
    dump("stored key, unreachable");
    expect(q("key-load-failed")?.dataset.errorClass).toBe("unreachable");
    expect(container.textContent).toContain("The server cannot be reached");
    expect(mocks.clearLibraryKey).not.toHaveBeenCalled();
    expect(mocks.storeLibraryKey).not.toHaveBeenCalled();
    expect(mocks.logout).not.toHaveBeenCalled();
  });
});
