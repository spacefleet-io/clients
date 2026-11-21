// @vitest-environment jsdom
/**
 * @test-id BADGER-DESKTOP-KEY-FROM-DEVICE-001
 * @level unit
 * @req ACCT-PAIR-01[badger-desktop]
 * @req UX-KEY-01[badger-desktop]
 * @req PRIV-KEY-01[badger-desktop]
 * @why The key screen offers "Get the key from another device": it opens the shared pairing view in key mode, and an
 *   approved key is checked (PairedKeyCheck) before it is kept like a typed key and the library opens. A key that does
 *   not open the library stores nothing and leaves the user on the key screen.
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateLibraryKeyWords } from "@space/shared/libraryKeyWords";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "[BADGER-DESKTOP-KEY-FROM-DEVICE-001]";

const mocks = vi.hoisted(() => ({
  storeLibraryKey: vi.fn(async (_key: string, _words?: string[] | null) => undefined),
  decryptBase64ToBytes: vi.fn(async (_key: string, _blob: string) => new Uint8Array()),
  acknowledgeLibraryKey: vi.fn(async () => undefined),
  activateRemoteLibrary: vi.fn(async (_token: string, _key: string) => undefined),
  verifyPairedKey: vi.fn(async (_deps: unknown, _token: string, _key: string) => "verified" as "verified" | "mismatch"),
  // Stable across renders: the page's key-load effect depends on them, like the real providers' memoized values.
  t: (key: string) => key,
  auth: { user: { id: "u1", email: "a@b.c" }, token: "own-session", logout: async () => undefined },
  libraryActions: {} as Record<string, unknown>,
  // What brought the user to the enter screen: a library on the server (remote), none found (missing), a key that failed (invalid).
  libraryMeta: { exists: true, keyProbe: "probe", bootstrapRequired: false } as { exists: boolean; keyProbe: string | null; bootstrapRequired: boolean },
  libraryError: null as Error | null,
  pairProps: null as null | {
    mode?: string;
    onApproved: (approved: { status: "approved"; token: string; user: { id: string; email: string }; libraryKey: string }) => Promise<string>;
    onBack: () => void;
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t, i18n: { language: "en" } }),
}));
vi.mock("../src/renderer/src/auth", () => ({
  useAuth: () => mocks.auth,
}));
vi.mock("../src/renderer/src/api", () => ({
  ApiError: class ApiError extends Error {
    status = 0;
  },
  getLibraryMetaForKeyStep: vi.fn(async () => mocks.libraryMeta),
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
  useLibraryShell: () => ({ error: mocks.libraryError }),
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
vi.mock("../src/renderer/src/lib/pairedSignIn", () => ({ verifyPairedKey: mocks.verifyPairedKey }));
vi.mock("../src/renderer/src/lib/pairedSignInDeps", () => ({ pairedKeyCheckDeps: { name: "pairedKeyCheckDeps" } }));
vi.mock("../src/renderer/src/lib/crypto", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  decryptBase64ToBytes: mocks.decryptBase64ToBytes,
}));
vi.mock("@space/ui", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  LanguageMenu: () => <div data-testid="language-menu" />,
}));
// The shared key step (UX-KEY-01) opens the pairing view from its own file.
vi.mock("../../../../packages/desktop-shell/src/components/pair-with-phone", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  default: (props: NonNullable<typeof mocks.pairProps>) => {
    mocks.pairProps = props;
    return (
      <div data-testid="pair-with-phone" data-mode={props.mode}>
        <button data-testid="pair-back" onClick={props.onBack}>
          back
        </button>
      </div>
    );
  },
}));

import OnboardingKey from "../src/renderer/src/pages/OnboardingKey";

const approved = { status: "approved" as const, token: "own-session", user: { id: "u1", email: "a@b.c" }, libraryKey: "KEY-FROM-PHONE" };

let container: HTMLDivElement;
let root: Root;
const q = (testId: string) => container.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
  });
};
const dump = (label: string) =>
  console.info(
    `${SUITE} ${label}: link=${q("key-from-another-device") !== null} pair=${q("pair-with-phone")?.dataset.mode ?? "none"} library=${q("library") !== null} stored=${JSON.stringify(mocks.storeLibraryKey.mock.calls)}`,
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

mocks.libraryActions = { reload: () => undefined, clearLocalCache: async () => undefined, activateRemoteLibrary: mocks.activateRemoteLibrary };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pairProps = null;
  mocks.libraryMeta = { exists: true, keyProbe: "probe", bootstrapRequired: false };
  mocks.libraryError = null;
  Object.assign(window, { sf: { pairing: { start: vi.fn(), poll: vi.fn(), cancel: vi.fn() }, setMediaKey: vi.fn(async () => undefined) } });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("@req ACCT-PAIR-01 Badger desktop key screen: get the key from another device", () => {
  it("opens the shared pairing view in key mode and goes back to typing", async () => {
    await mount();
    dump("mounted");
    expect(q("key-from-another-device")?.textContent).toContain("Get the key from another device");
    expect(q("key-from-another-device")?.textContent).toContain(
      "Use any Badger or Parrot app you're signed in to, on any device or profile of this account: approve the code shown here.",
    );
    await act(async () => q("key-from-another-device")!.click());
    dump("link-clicked");
    expect(q("pair-with-phone")?.dataset.mode).toBe("key");
    await act(async () => q("pair-back")!.click());
    dump("back");
    expect(q("pair-with-phone")).toBeNull();
    expect(q("key-from-another-device")).not.toBeNull();
  });

  it("checks an approved key, keeps it like a typed key and opens the library", async () => {
    await mount();
    await act(async () => q("key-from-another-device")!.click());
    let check = "";
    await act(async () => {
      check = await mocks.pairProps!.onApproved(approved);
    });
    await flush();
    dump("approved");
    expect(check).toBe("verified");
    expect(mocks.verifyPairedKey).toHaveBeenCalledWith({ name: "pairedKeyCheckDeps" }, "own-session", "KEY-FROM-PHONE", "u1");
    expect(mocks.storeLibraryKey).toHaveBeenCalledWith("KEY-FROM-PHONE", null);
    expect(mocks.acknowledgeLibraryKey).toHaveBeenCalled();
    expect(mocks.activateRemoteLibrary).toHaveBeenCalledWith("own-session", "KEY-FROM-PHONE");
    expect(q("library")).not.toBeNull();
  });

  it("stores nothing when the key does not open the library", async () => {
    mocks.verifyPairedKey.mockResolvedValueOnce("mismatch");
    await mount();
    await act(async () => q("key-from-another-device")!.click());
    let check = "";
    await act(async () => {
      check = await mocks.pairProps!.onApproved(approved);
    });
    await flush();
    dump("mismatch");
    expect(check).toBe("mismatch");
    expect(mocks.storeLibraryKey).not.toHaveBeenCalled();
    expect(q("library")).toBeNull();
    expect(q("pair-with-phone")).not.toBeNull();
  });

  it("hides the link when the preload has no pairing bridge", async () => {
    Object.assign(window, { sf: {} });
    await mount();
    dump("no-bridge");
    expect(q("key-from-another-device")).toBeNull();
  });
});

// UX-KEY-01: the key is typed into 12 numbered word boxes; a pasted copy fills them all; the old base64 form still works.
describe("@req UX-KEY-01 Badger desktop key screen: type the library key as 12 words", () => {
  const key = generateLibraryKeyWords("en", (bytes) => bytes.fill(9));
  const continueButton = () => q("library-key-continue") as HTMLButtonElement;
  const boxes = () => Array.from(container.querySelectorAll('[data-testid="library-key-box"]'));
  /** Types `text` into box `box` (a whole copied key goes into one box, as when pasted). */
  const type = async (text: string, box = 0) => {
    const field = container.querySelectorAll<HTMLInputElement>('[data-testid="library-key-box-input"]')[box];
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, text);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    console.info(
      `${SUITE} typed=${JSON.stringify(text)} box=${box + 1} continue=${continueButton().disabled ? "disabled" : "enabled"} message=${JSON.stringify(q("library-key-message")?.textContent ?? null)} boxes=${JSON.stringify(boxes().map((item) => `${item.getAttribute("data-state")}:${item.querySelector("input")?.value}`))}`,
    );
  };
  /** Pastes `text` (a copied key, numbered and on several lines) into box `box`. */
  const paste = async (text: string, box: number) => {
    const field = container.querySelectorAll<HTMLInputElement>('[data-testid="library-key-box-input"]')[box];
    const event = Object.assign(new Event("paste", { bubbles: true, cancelable: true }), { clipboardData: { getData: () => text } });
    await act(async () => {
      field.dispatchEvent(event);
    });
    console.info(
      `${SUITE} pasted=${JSON.stringify(text)} box=${box + 1} continue=${continueButton().disabled ? "disabled" : "enabled"} boxes=${JSON.stringify(boxes().map((item) => `${item.getAttribute("data-state")}:${item.querySelector("input")?.value}`))}`,
    );
  };
  const submit = async () => {
    await act(async () => continueButton().click());
    await flush();
    dump("submitted");
  };

  it("opens the library from the first 4 letters of each word in any case, with the key the words name", async () => {
    await mount();
    await type(key.words.slice(0, 5).map((word) => word.slice(0, 4).toUpperCase()).join(" "));
    expect(continueButton().disabled).toBe(true);
    await paste(key.words.map((word, index) => `${index + 1}. ${word.slice(0, 4).toUpperCase()}`).join("\n"), 7);
    expect(boxes().map((item) => item.querySelector("input")?.value)).toEqual(key.words);
    expect(continueButton().disabled).toBe(false);
    await submit();
    expect(mocks.decryptBase64ToBytes).toHaveBeenCalledWith(key.keyBase64, "probe");
    expect(mocks.storeLibraryKey).toHaveBeenCalledWith(key.keyBase64, key.words);
    expect(mocks.activateRemoteLibrary).toHaveBeenCalledWith("own-session", key.keyBase64);
    expect(q("library")).not.toBeNull();
  });

  it("shows 12 numbered word boxes, and a quiet start-a-new-library link below Continue that opens the reset confirmation", async () => {
    await mount();
    dump("enter-key");
    // UX-KEY-01: titled for entering, 12 empty boxes, and no key word shown anywhere (no grid, no example).
    console.info(`${SUITE} enter heading=${JSON.stringify(container.querySelector("h1")?.textContent)} grid=${q("library-key-words") !== null}`);
    expect(container.querySelector("h1")?.textContent).toBe("onboarding.key.enterTitle");
    // One sentence under the title, said once (it was printed three ways: a banner and the card's text twice).
    const sentences = container.textContent?.split("onboarding.key.enterSubtitle").length ?? 0;
    console.info(`${SUITE} enter sentence count=${sentences - 1} text=${JSON.stringify(container.textContent?.slice(0, 200))}`);
    expect(sentences - 1).toBe(1);
    expect(container.textContent).not.toContain("onboarding.key.reason");
    expect(boxes()).toHaveLength(12);
    expect(boxes().every((item) => item.querySelector("input")?.value === "")).toBe(true);
    expect(q("library-key-words")).toBeNull();
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
    const link = q("key-lost-start-new-library") as HTMLButtonElement;
    expect(link.textContent).toBe("Lost your key? Erase this media library and start over");
    expect(continueButton().compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.body.textContent).not.toContain("This erases the entire library of this account");
    await act(async () => link.click());
    dump("lost-key link clicked");
    // PRIV-KEY-01: the warning says the whole account's library goes, every profile, both apps.
    expect(document.body.textContent).toContain("for every profile: all music, movies and shows");
    expect(document.body.textContent).toContain("in Badger and Parrot");
    expect(document.querySelector('[data-testid="reset-other-device"]')?.textContent).toContain("even on another profile of this account");
  });

  it("keeps the language button in the window's top-right, Continue bottom-right, then an \"or\" line and the other-device card", async () => {
    await mount();
    const menu = q("language-menu");
    const keyPanel = q("library-key-input")?.closest("form")?.parentElement ?? null;
    console.info(`${SUITE} language menu=${menu !== null} in card=${keyPanel?.contains(menu) ?? null} controls=${JSON.stringify(menu?.parentElement?.className)}`);
    expect(menu).not.toBeNull();
    expect(container.querySelector("form")!.contains(menu)).toBe(false);
    expect(menu!.parentElement!.className).toContain("fixed");
    expect(menu!.parentElement!.className).toContain("right-8");
    // UX-SETUP-08: the main button is the last one of its row (bottom-right).
    const row = continueButton().parentElement!;
    const buttons = Array.from(row.querySelectorAll("button"));
    console.info(`${SUITE} row=${JSON.stringify(buttons.map((button) => button.dataset.testid ?? button.textContent))}`);
    expect(buttons.at(-1)).toBe(continueButton());
    // UX-KEY-01: under it, the "or" line, then the whole-width card that opens the code (the phone sign-in card's look).
    const card = q("key-from-another-device")!;
    const divider = q("key-other-device-divider")!;
    console.info(`${SUITE} card=${card.tagName} divider=${JSON.stringify(divider?.textContent)} in row=${row.contains(card)}`);
    expect(row.contains(card)).toBe(false);
    expect(card.tagName).toBe("BUTTON");
    expect(divider.textContent).toBe("or");
    expect(continueButton().compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(divider.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("says what the lost-key line does, and erases only once the user types the confirm word", async () => {
    await mount();
    expect(q("key-lost-note")?.textContent).toBe("Without the key, nobody can open this media library, not even us.");
    await act(async () => q("key-lost-start-new-library")!.click());
    await flush();
    const submitButton = document.querySelector('[data-testid="reset-submit"]') as HTMLButtonElement;
    const word = document.querySelector('[data-testid="reset-confirm-word"]') as HTMLInputElement;
    const password = document.querySelector('[data-testid="reset-password"]') as HTMLInputElement;
    const setValue = async (field: HTMLInputElement, value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
    // The safe choice has the focus: Enter or Space right away cancels.
    console.info(`${SUITE} reset focus=${JSON.stringify(document.activeElement?.textContent)} checkbox=${document.querySelector('[role="checkbox"]') !== null}`);
    expect(document.activeElement?.getAttribute("data-testid")).toBe("reset-cancel");
    expect(document.querySelector('[role="dialog"] [role="checkbox"]')).toBeNull();
    await setValue(password, "pw");
    expect(submitButton.disabled).toBe(true);
    await setValue(word, "nope");
    expect(submitButton.disabled).toBe(true);
    await setValue(word, " ERASE ");
    console.info(`${SUITE} reset submit=${submitButton.disabled ? "disabled" : "enabled"}`);
    expect(submitButton.disabled).toBe(false);
  });

  // @bugfix @regression-proof: a fresh device (no library found, "missing") or a saved key that failed ("invalid")
  // put a banner above the card, so the screen said two sentences.
  it.each([
    ["remote", () => undefined],
    ["missing", () => (mocks.libraryMeta = { exists: false, keyProbe: null, bootstrapRequired: false })],
    ["invalid", () => (mocks.libraryError = new Error("decrypt failed"))],
  ])("says exactly one sentence when the screen opens for a %s key", async (reason, arrange) => {
    arrange();
    await mount();
    const text = container.textContent ?? "";
    const said = text.split("onboarding.key.enterSubtitle").length - 1;
    const keys = text.match(/onboarding\.key\.[A-Za-z]+/g) ?? [];
    console.info(`${SUITE} reason=${reason} sentence count=${said} keys=${JSON.stringify(keys)}`);
    expect(container.querySelector("h1")?.textContent).toBe("onboarding.key.enterTitle");
    expect(said).toBe(1);
    expect(text).not.toContain("onboarding.key.reason");
  });

  it("marks an unknown word in its own box and keeps Continue off", async () => {
    await mount();
    await type(key.words[0], 0);
    await type("zzzzq", 1);
    expect(boxes()[0].getAttribute("data-state")).toBe("ok");
    expect(boxes()[1].getAttribute("data-state")).toBe("unknown");
    expect(q("library-key-message")).toBeNull();
    expect(continueButton().disabled).toBe(true);
    expect(mocks.storeLibraryKey).not.toHaveBeenCalled();
  });

  it("says once, under the boxes, when 12 real words are not a key", async () => {
    await mount();
    await type([key.words[1], key.words[0], ...key.words.slice(2)].join(" "));
    expect(q("library-key-message")?.textContent).toBe("These words don’t form a valid key. Check each word against the ones you saved.");
    expect(continueButton().disabled).toBe(true);
  });

  it("still accepts the old 44-character key and keeps no words with it", async () => {
    await mount();
    await type(key.keyBase64);
    expect(continueButton().disabled).toBe(false);
    await submit();
    expect(mocks.decryptBase64ToBytes).toHaveBeenCalledWith(key.keyBase64, "probe");
    expect(mocks.storeLibraryKey).toHaveBeenCalledWith(key.keyBase64, null);
    expect(q("library")).not.toBeNull();
  });

  // PRIV-KEY-01: one key per account. With no Badger library yet, a key the account already has (made in Parrot)
  // still decides: a wrong key would encrypt Badger's library under it and split the apps for good. WebCrypto
  // rejects a wrong key with a bare OperationError, which said "could not validate" instead of "doesn't match".
  it("says a wrong key doesn't match when the account has a key but no library yet", async () => {
    mocks.libraryMeta = { exists: false, keyProbe: "probe", bootstrapRequired: true };
    mocks.decryptBase64ToBytes.mockRejectedValueOnce(Object.assign(new Error("The operation failed"), { name: "OperationError" }));
    await mount();
    await type(key.words.join(" "));
    await submit();
    expect(mocks.decryptBase64ToBytes).toHaveBeenCalledWith(key.keyBase64, "probe");
    expect(mocks.storeLibraryKey).not.toHaveBeenCalled();
    expect(q("library")).toBeNull();
    expect(container.textContent).toContain("That key doesn’t open your media library. Check the 12 words and try again.");
    expect(container.textContent).not.toContain("onboarding.key.errorValidate");
  });

  it("takes the account's key when it has a key but no library yet", async () => {
    mocks.libraryMeta = { exists: false, keyProbe: "probe", bootstrapRequired: true };
    await mount();
    await type(key.words.join(" "));
    await submit();
    expect(mocks.decryptBase64ToBytes).toHaveBeenCalledWith(key.keyBase64, "probe");
    expect(mocks.storeLibraryKey).toHaveBeenCalledWith(key.keyBase64, key.words);
  });
});
