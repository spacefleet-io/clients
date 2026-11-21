// @vitest-environment jsdom
/**
 * @test-id BADGER-DESKTOP-KEY-SAVED-WARNING-001
 * @level unit
 * @req ACCT-DEV-04[badger-desktop]
 * @req UX-KEY-01[badger-desktop]
 * @why Chris (2026-11-11): people who don't know what encryption is click through "store your key somewhere safe".
 *   The new-key screen has no checkbox any more, only "I've saved my key", which opens a plain warning: only
 *   "Yes, I understand" creates the library; "Go back" returns to the same key.
 *   Chris (2026-11-12): "It asks for a key but lists the words underneath the input field? … None of these makes
 *   sense." So the screen that shows a new key is titled "Your library key", has no input field, and its button reads
 *   "I've written it down" (UX-KEY-01).
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readLibraryKeyInput } from "@space/shared/libraryKeyWords";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "[BADGER-DESKTOP-KEY-SAVED-WARNING-001]";

const mocks = vi.hoisted(() => ({
  storeLibraryKey: vi.fn(async (_key: string) => undefined),
  acknowledgeLibraryKey: vi.fn(async () => undefined),
  activateRemoteLibrary: vi.fn(async (_token: string, _key: string) => undefined),
  t: (key: string) => key,
  auth: { user: { id: "u1", email: "a@b.c" }, token: "own-session", logout: async () => undefined },
  libraryActions: {} as Record<string, unknown>,
}));

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
// ACCT-PROF-03: the key screen reads the profile list to count the title question; none here, so no question.
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
const shownWords = () =>
  Array.from(container.querySelectorAll('[data-testid="library-key-word"]')).map((item) => item.lastElementChild?.textContent ?? "");
const shownKey = () => shownWords().join(" ");
const dump = (label: string) =>
  console.info(
    `${SUITE} ${label}: warning=${q("key-saved-warning") !== null} key=${shownKey().slice(0, 9)}… activated=${mocks.activateRemoteLibrary.mock.calls.length} library=${q("library") !== null}`,
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

const click = async (testId: string) => {
  await act(async () => q(testId)!.click());
  await flush();
};

mocks.libraryActions = { reload: () => undefined, clearLocalCache: async () => undefined, activateRemoteLibrary: mocks.activateRemoteLibrary };

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(window, { sf: { setMediaKey: vi.fn(async () => undefined) } });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("@req ACCT-DEV-04 Badger desktop new key: I've saved my key, then the warning", () => {
  it("shows the key as 12 numbered lowercase words with Copy, no checkbox, one plain line and one button", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await mount();
    dump("mounted");
    const words = shownWords();
    const [storedKey, storedWords] = mocks.storeLibraryKey.mock.calls[0] as unknown as [string, string[]];
    console.info(`${SUITE} words=${JSON.stringify(words)} stored=${storedKey} storedWords=${JSON.stringify(storedWords)}`);
    expect(words).toHaveLength(12);
    expect(words.every((word) => word === word.toLowerCase())).toBe(true);
    expect(storedWords).toEqual(words);
    expect(readLibraryKeyInput(words.join(" "))).toEqual({ status: "ok", keyBase64: storedKey, words });
    await act(async () => {
      (container.querySelector('[data-testid="key-copy"]') as HTMLButtonElement).click();
    });
    expect(writeText).toHaveBeenCalledWith(words.join(" "));
    expect(container.querySelector('[role="checkbox"], input[type="checkbox"]')).toBeNull();
    // The one plain sentence, said once (the card printed it twice under a page subtitle saying the same).
    const said = (container.textContent?.split("nobody, not even us, can get your media library back").length ?? 0) - 1;
    console.info(`${SUITE} show sentence count=${said} text=${JSON.stringify(container.textContent?.slice(0, 200))}`);
    expect(said).toBe(1);
    const heading = container.querySelector("h1")?.textContent;
    const fields = container.querySelectorAll("input, textarea").length;
    console.info(`${SUITE} show screen heading=${JSON.stringify(heading)} fields=${fields} button=${JSON.stringify(q("key-saved")?.textContent)}`);
    // UX-KEY-01: the show screen never looks like the enter screen: its own title, and nothing to type into.
    expect(heading).toBe("onboarding.key.title");
    expect(fields).toBe(0);
    expect(q("library-key-input")).toBeNull();
    expect(q("key-saved")?.textContent).toBe("I've written it down");
    expect(q("key-saved-warning")).toBeNull();
  });

  it("opens the warning on I've saved my key, and Go back keeps the same key without creating anything", async () => {
    await mount();
    const key = shownKey();
    await click("key-saved");
    dump("saved-clicked");
    const warning = q("key-saved-warning")!;
    expect(warning).not.toBeNull();
    expect(warning.textContent).toContain("You'll need this key every time you sign in on a new device or app.");
    expect(warning.textContent).toContain("We can't see your key and we can't reset it.");
    expect(warning.textContent).toContain("If you lose it, your media library can't be recovered, by anyone, including us.");
    expect(warning.textContent).not.toMatch(/encrypt|end-to-end|cryptograph/i);
    expect(mocks.activateRemoteLibrary).not.toHaveBeenCalled();
    await click("key-saved-warning-back");
    dump("went-back");
    expect(q("key-saved-warning")).toBeNull();
    expect(shownKey()).toBe(key);
    expect(mocks.storeLibraryKey).toHaveBeenCalledTimes(1);
    expect(mocks.activateRemoteLibrary).not.toHaveBeenCalled();
    expect(q("library")).toBeNull();
  });

  it("creates the library with the shown key only on Yes, I understand", async () => {
    await mount();
    const stored = mocks.storeLibraryKey.mock.calls[0]![0];
    await click("key-saved");
    expect(q("key-saved-warning-confirm")?.textContent).toBe("Yes, I understand");
    await click("key-saved-warning-confirm");
    dump("confirmed");
    expect(mocks.activateRemoteLibrary).toHaveBeenCalledWith("own-session", stored);
    expect(mocks.acknowledgeLibraryKey).toHaveBeenCalled();
    expect(q("library")).not.toBeNull();
  });
});
