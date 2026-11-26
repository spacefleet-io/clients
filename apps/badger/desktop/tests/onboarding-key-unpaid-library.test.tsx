// @vitest-environment jsdom
/**
 * @test-id BADGER-DESKTOP-UNPAID-SETUP-001
 * @level unit
 * @req ACCT-UNPAID-06[badger-desktop]
 * @why An unpaid account's first library was refused with 402 `subscription_unpaid` and the key step said "Could not
 *   create the initial library". The step now shows, in its place, that the plan has ended and the library can be set
 *   up once it is renewed: Try again keeps the key and says the plan is not renewed yet while still refused, and Renew
 *   renews the current plan in place, reads the account again and goes on with the same key once it is paid.
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountAccess } from "@space/shared/accountAccess";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "[BADGER-DESKTOP-UNPAID-SETUP-001]";

const mocks = vi.hoisted(() => ({
  storeLibraryKey: vi.fn(async (_key: string) => undefined),
  acknowledgeLibraryKey: vi.fn(async () => undefined),
  activateRemoteLibrary: vi.fn(async (_token: string, _key: string) => undefined),
  getSubscription: vi.fn(async (_token: string) => ({ plan: "tier1", billingPeriod: "monthly", storageAddonCount: 0 })),
  getMe: vi.fn(),
  planRun: vi.fn(async (_request: unknown, _billing: unknown) => ({ kind: "changed" })),
  setUser: vi.fn(),
  t: (key: string) => key,
  auth: {} as Record<string, unknown>,
  libraryActions: {} as Record<string, unknown>,
}));
mocks.auth = { user: { id: "u1", email: "a@b.c" }, token: "own-session", logout: async () => undefined, setUser: mocks.setUser };

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t, i18n: { language: "en" } }),
}));
vi.mock("../src/renderer/src/auth", () => ({ useAuth: () => mocks.auth }));
vi.mock("../src/renderer/src/api", () => ({
  ApiError: class ApiError extends Error {
    status = 0;
  },
  // A brand-new account: the server never had a library, so the screen makes a key.
  getLibraryMetaForKeyStep: vi.fn(async () => ({ exists: false, keyProbe: null, bootstrapRequired: true })),
  resetLibrary: vi.fn(),
  rotateLibraryKey: vi.fn(),
  getSubscription: mocks.getSubscription,
  getMe: mocks.getMe,
}));
// Renew's plan change is Settings' own (tested there); here it only says whether the renewal was applied.
vi.mock("../src/renderer/src/lib/planChange", () => ({
  useAccountPlanChange: () => ({ run: mocks.planRun }),
  useBillingStatus: () => ({ billing: null, loaded: true, refresh: vi.fn() }),
  planChangeResultMessage: () => "plan change message",
}));
vi.mock("../src/renderer/src/lib/onboarding", () => ({
  acknowledgeLibraryKey: mocks.acknowledgeLibraryKey,
  clearLibraryKey: vi.fn(async () => undefined),
  getStoredLibraryKey: vi.fn(async () => null),
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

const paid: AccountAccess = { state: "paid", paidUntil: "2099-12-23T00:00:00Z", billingPeriod: "monthly", wipeAt: null, qosTier: "paid" };
// What the Badger IPC hands the renderer: the 402's message, without its status.
const refusal = () => new Error("subscription_unpaid");

let container: HTMLDivElement;
let root: Root;
const q = (testId: string) => document.body.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 0);
      await promise;
    }
  });
};
const click = async (testId: string) => {
  await act(async () => q(testId)!.click());
  await flush();
};
const dump = (label: string) =>
  console.info(
    `${SUITE} ${label}: unpaid=${q("unpaid-setup-step") !== null} title=${JSON.stringify(container.querySelector("h1")?.textContent ?? null)} message=${JSON.stringify(q("unpaid-setup-message")?.textContent ?? null)} activations=${mocks.activateRemoteLibrary.mock.calls.length} library=${q("library") !== null}`,
  );

mocks.libraryActions = { reload: () => undefined, clearLocalCache: async () => undefined, activateRemoteLibrary: mocks.activateRemoteLibrary };

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.activateRemoteLibrary.mockImplementation(async () => Promise.reject(refusal()));
  Object.assign(window, { sf: { setMediaKey: vi.fn(async () => undefined) } });
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
  await click("key-saved");
  await click("key-saved-warning-confirm");
  dump("refused");
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ACCT-UNPAID-06: Badger desktop's library step for an unpaid account", () => {
  it("says the plan ended in place of the step, with Renew and Try again, and not the generic failure", () => {
    expect(q("unpaid-setup-step")).not.toBeNull();
    expect(container.querySelector("h1")?.textContent).toBe("Your plan has ended");
    expect(container.textContent).toContain("Your media library can be set up once your plan is renewed.");
    expect(q("unpaid-setup-renew")?.textContent).toBe("Renew");
    expect(container.textContent).not.toContain("onboarding.key.errorCreate");
    expect(mocks.acknowledgeLibraryKey).not.toHaveBeenCalled();
    expect(q("library")).toBeNull();
  });

  it("Try again keeps the same key and says the plan is not renewed yet while still refused", async () => {
    const key = mocks.activateRemoteLibrary.mock.calls[0]![1];
    await click("unpaid-setup-try-again");
    dump("try again");
    expect(mocks.activateRemoteLibrary).toHaveBeenCalledTimes(2);
    expect(mocks.activateRemoteLibrary).toHaveBeenLastCalledWith("own-session", key);
    expect(q("unpaid-setup-message")?.textContent).toBe("Your plan is not renewed yet.");
    expect(q("library")).toBeNull();
  });

  it("Renew renews the current plan, reads the account again and goes on with the same key once it is paid", async () => {
    const key = mocks.activateRemoteLibrary.mock.calls[0]![1];
    mocks.getMe.mockResolvedValue({ user: { id: "u1", email: "a@b.c" }, access: paid });
    mocks.activateRemoteLibrary.mockImplementation(async () => undefined);
    await click("unpaid-setup-renew");
    dump("renewed");
    expect(mocks.planRun).toHaveBeenCalledWith(expect.objectContaining({ plan: "tier1", billingPeriod: "monthly", addonCount: 0 }), null);
    expect(mocks.setUser).toHaveBeenCalledWith(expect.objectContaining({ access: paid }));
    expect(mocks.activateRemoteLibrary).toHaveBeenLastCalledWith("own-session", key);
    expect(mocks.acknowledgeLibraryKey).toHaveBeenCalled();
    expect(q("library")).not.toBeNull();
  });
});
