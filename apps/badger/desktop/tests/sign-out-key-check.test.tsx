// @vitest-environment jsdom
/**
 * @test-id sign-out-key-check
 * @level integration (real hook, real Radix Dialog, real react-router MemoryRouter, real SecuritySection; api, auth and
 *   key storage stubbed)
 * @req ACCT-DEV-03
 * @why The user's own Sign out forgets the library key, and without the saved key the only way back in is typing it
 *   (QR-code sign-in needs another device that still holds the key). A computer that holds the key must ask first;
 *   Cancel must change nothing; "Show my key" must land on Settings › Security with the show-key dialog open; only
 *   "I saved it, sign out" signs out. A computer with no key signs out at once.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../src/renderer/src/i18n/en.json";
import fr from "../src/renderer/src/i18n/fr.json";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "sign-out-key-check";

const auth = vi.hoisted(() => ({ logout: vi.fn(async (_reason: string) => undefined) }));
const keyStore = vi.hoisted(() => ({ key: null as string | null }));

vi.mock("@/auth", () => ({ useAuth: () => ({ token: "tok-1", user: { id: "u1" }, logout: auth.logout }), useHasPassword: () => true }));
vi.mock("../src/renderer/src/auth", () => ({
  useAuth: () => ({ token: "tok-1", user: { id: "u1" }, logout: auth.logout }),
  useHasPassword: () => true,
}));
vi.mock("@/lib/onboarding", () => ({
  getStoredLibraryKey: vi.fn(async () => keyStore.key),
  storeLibraryKey: vi.fn(async () => undefined),
  clearLibraryKey: vi.fn(async () => undefined),
}));
vi.mock("@/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/renderer/src/api")>()),
  getSettings: vi.fn(async () => ({ twoFactorEnabled: false, twoFactorMethod: null })),
}));
vi.mock("@/lib/libraryContext", () => ({
  useLibraryActions: () => ({ exportLocalDb: vi.fn(), clearLocalCache: vi.fn() }),
}));
// `t` must be referentially stable: effects depend on it.
const i18n = vi.hoisted(() => ({ t: (key: string) => key }));
vi.mock("react-i18next", () => ({ useTranslation: () => i18n }));
vi.mock("@/logger", () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log };
  return { rendererLogger: log };
});

import { SHOW_KEY_SETTINGS_PATH, useSignOutWithKeyCheck } from "../src/renderer/src/components/SignOutKeyCheck";
import SecuritySection from "../src/renderer/src/components/settings/sections/SecuritySection";

let currentLocation = "";
const LocationProbe = () => {
  const location = useLocation();
  currentLocation = `${location.pathname}${location.search}`;
  return null;
};

const SignOutHarness = () => {
  const { requestSignOut, dialog } = useSignOutWithKeyCheck();
  return (
    <>
      <button type="button" data-testid="sign-out" onClick={() => void requestSignOut()}>
        nav.signOut
      </button>
      {dialog}
    </>
  );
};

describe("ACCT-DEV-03 desktop Sign out asks whether the library key was saved", () => {
  let container: HTMLDivElement;
  let root: Root;

  const flush = async () => {
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
    });
  };
  const question = () => document.body.querySelector('[data-testid="sign-out-key-check"]');
  const buttonByText = (text: string) =>
    [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as
      | HTMLButtonElement
      | undefined;
  const dump = (label: string) =>
    console.info(
      `[${SUITE}:${label}] location=${currentLocation} question=${Boolean(question())} logout=${JSON.stringify(auth.logout.mock.calls)} focused=${document.activeElement?.textContent?.trim() ?? "none"} dialogs=${[...document.body.querySelectorAll('[role="dialog"]')].map((d) => d.textContent?.slice(0, 60)).join(" | ")}`,
    );

  const mount = async () => {
    console.info(`[${SUITE}] phase=mount storedKey=${keyStore.key ? "present" : "none"}`);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={["/home"]}>
          <LocationProbe />
          <Routes>
            <Route path="/home" element={<SignOutHarness />} />
            <Route path="/settings" element={<SecuritySection />} />
            <Route path="/login" element={<div>login page</div>} />
          </Routes>
        </MemoryRouter>,
      ),
    );
    await flush();
  };
  const pressSignOut = async () => {
    console.info(`[${SUITE}] phase=press-sign-out`);
    await act(async () => (document.body.querySelector('[data-testid="sign-out"]') as HTMLButtonElement).click());
    await flush();
  };

  beforeEach(() => {
    vi.clearAllMocks();
    keyStore.key = "a2V5LWJ5dGVzLWZvci10ZXN0cw==";
    currentLocation = "";
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.innerHTML = "";
  });

  it("a computer holding the key asks first, with Cancel focused, and Cancel keeps it signed in", async () => {
    await mount();
    await pressSignOut();
    dump("asked");
    expect(question()).not.toBeNull();
    expect(question()?.textContent).toContain("nav.signOutKeyCheck.title");
    expect(question()?.textContent).toContain("nav.signOutKeyCheck.body");
    expect(document.activeElement?.textContent?.trim()).toBe("nav.signOutKeyCheck.cancel");
    expect(buttonByText("nav.signOutKeyCheck.showKey")).toBeDefined();
    expect(auth.logout).not.toHaveBeenCalled();

    await act(async () => buttonByText("nav.signOutKeyCheck.cancel")?.click());
    await flush();
    dump("cancelled");
    expect(question()).toBeNull();
    expect(auth.logout).not.toHaveBeenCalled();
    expect(currentLocation).toBe("/home");
  });

  it("confirming signs out once with the key-forgetting reason and lands on the login page", async () => {
    await mount();
    await pressSignOut();
    await act(async () => buttonByText("nav.signOutKeyCheck.confirm")?.click());
    await flush();
    dump("confirmed");
    expect(auth.logout).toHaveBeenCalledTimes(1);
    expect(auth.logout).toHaveBeenCalledWith("signOut");
    expect(currentLocation).toBe("/login");
  });

  it("a computer with no key signs out at once, without asking", async () => {
    keyStore.key = null;
    await mount();
    await pressSignOut();
    dump("no-key");
    expect(question()).toBeNull();
    expect(auth.logout).toHaveBeenCalledTimes(1);
    expect(auth.logout).toHaveBeenCalledWith("signOut");
    expect(currentLocation).toBe("/login");
  });

  it("Show my key opens Settings › Security with the show-key dialog asking for the password", async () => {
    await mount();
    await pressSignOut();
    await act(async () => buttonByText("nav.signOutKeyCheck.showKey")?.click());
    // SettingsRecoveryDialogs is a lazy chunk: poll until it resolves and renders.
    const showKeyDialog = () =>
      [...document.body.querySelectorAll('[role="dialog"]')].find((d) =>
        d.textContent?.includes("settings.recovery.show.dialogTitle"),
      );
    for (let attempt = 0; attempt < 40 && !showKeyDialog(); attempt += 1) {
      console.info(`[${SUITE}] phase=wait-show-key-dialog attempt=${attempt}`);
      await act(async () => new Promise((r) => setTimeout(r, 50)));
    }
    dump("show-key-dialog");
    expect(showKeyDialog()).toBeDefined();
    expect(showKeyDialog()?.textContent).toContain("settings.recovery.show.passwordLabel");
    expect(SHOW_KEY_SETTINGS_PATH).toBe("/settings?section=security&showKey=1");
    expect(question()).toBeNull();
    expect(auth.logout).not.toHaveBeenCalled();
    // The param is dropped once the dialog is open, so a reload or Back does not reopen it.
    expect(currentLocation).toBe("/settings?section=security");
  });

  it("ships the question in every Badger desktop language", () => {
    for (const [lang, table] of Object.entries({ en, fr })) {
      const strings: Record<string, string> = table.nav.signOutKeyCheck;
      console.info(`[${SUITE}] locale=${lang} strings=${JSON.stringify(strings)}`);
      for (const key of ["title", "body", "cancel", "showKey", "confirm"]) expect(strings[key]).toBeTruthy();
    }
  });
});
