// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-KEY-STEP-001
 * @level unit
 * @req UX-KEY-01[parrot]
 * @req PRIV-KEY-01[parrot]
 * @req UX-KEY-02[parrot]
 * @why Chris (2026-11-12): "the setup step to enter/save the key should be the same shared one between the 2 apps".
 *   Parrot's setup key step is the shared LibraryKeyStep: the account's 12 words open the library, wrong words say
 *   so and keep the user on the step, a key load that fails or runs out of time (UX-KEY-02, the 0.1.72 smoke that hung
 *   on "Loading key…") says why and offers Retry, which shows the new key once main can tell, and the lost-key erase
 *   (the whole account's vault) brings the step back to a fresh key to write down.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateLibraryKeyWords } from "@space/shared/libraryKeyWords";
import type { AccountKeyResult } from "@space/desktop-shell/account-key-check";
import type { ParrotCreateKeyResult, ParrotState } from "../src/shared/ipc";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "[PARROT-DESKTOP-KEY-STEP-001]";

vi.mock("../src/renderer/src/SignOutKeyCheck", () => ({ useSignOutWithKeyCheck: () => ({ requestSignOut: vi.fn(), dialog: null }) }));

import Setup from "../src/renderer/src/Setup";
import { translator } from "../src/renderer/src/i18n";

const state: ParrotState = {
  setup: { step: "libraryKey", done: false, language: "en", folders: [], startAtLogin: false, errorReports: false },
  user: { id: "u1", email: "parrot-test@example.test" },
  hasLibraryKey: false,
  asksKeySavedBeforeSignOut: false,
  apiBaseUrl: "https://api.example.test",
  isDevBuild: false,
  musicFolder: null,
  appVersion: "0.0.0",
};

const accountKey = generateLibraryKeyWords("en", (bytes) => bytes.fill(7));
const freshKey = generateLibraryKeyWords("en", (bytes) => bytes.fill(9));

describe("@req UX-KEY-01 Parrot desktop setup key step (shared LibraryKeyStep)", () => {
  let host: HTMLDivElement;
  let root: Root;
  let current: ParrotState;
  const createLibraryKey = vi.fn(async (): Promise<ParrotCreateKeyResult> => ({ ok: false, error: "hasLibrary" }));
  const setLibraryKey = vi.fn(async (_key: string): Promise<AccountKeyResult> => ({ ok: true }));
  const eraseLibrary = vi.fn(async (_password: string, _code?: string) => ({ status: "erased" as const }));
  const getState = vi.fn(async () => ({ ...state, hasLibraryKey: true }));
  const saveSetup = vi.fn(async (patch: Partial<ParrotState["setup"]>) => ({ ...current, setup: { ...current.setup, ...patch } }));
  const t = translator("en");
  const q = (testId: string) => document.body.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
  const render = () => act(() => root.render(<Setup t={t} state={current} onState={(next) => ((current = next), render())} />));
  const flush = () =>
    act(async () => {
      for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const setValue = (field: HTMLInputElement, value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const dump = (label: string) =>
    console.info(
      `${SUITE} ${label}: mode=${q("key-created") ? "show" : q("library-key-continue") ? "enter" : q("key-checking") ? "checking" : "none"} title=${JSON.stringify(q("setup-libraryKey")?.closest("[class]")?.textContent?.slice(0, 40))} error=${JSON.stringify(q("library-key-step-error")?.textContent ?? null)} create=${q("key-create") !== null} creates=${createLibraryKey.mock.calls.length} keys=${JSON.stringify(setLibraryKey.mock.calls)} erases=${JSON.stringify(eraseLibrary.mock.calls)} saves=${JSON.stringify(saveSetup.mock.calls)} step=${current.setup.step}`,
    );
  const typeKey = async (words: string[]) => {
    const first = host.querySelector('[data-testid="library-key-box-input"]') as HTMLInputElement;
    await setValue(first, words.join(" "));
    await flush();
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    createLibraryKey.mockImplementation(async () => ({ ok: false, error: "hasLibrary" }));
    current = state;
    (window as unknown as { parrot: unknown }).parrot = {
      pairing: { start: vi.fn(), poll: vi.fn(), cancel: vi.fn() },
      createLibraryKey,
      setLibraryKey,
      eraseLibrary,
      getState,
      saveSetup,
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const mount = async () => {
    await act(async () => render());
    await flush();
    dump("mounted");
  };

  it("asks for the account's key when it has one, and the right 12 words open it and move on", async () => {
    await mount();
    expect(host.textContent).toContain(t("key.enterTitle"));
    expect(q("key-created")).toBeNull();
    expect(q("setup-next")).toBeNull();
    await typeKey(accountKey.words);
    const go = q("library-key-continue") as HTMLButtonElement;
    console.info(`${SUITE} continue disabled=${go.disabled}`);
    expect(go.disabled).toBe(false);
    await act(async () => go.click());
    await flush();
    dump("submitted");
    expect(setLibraryKey).toHaveBeenCalledWith(accountKey.keyBase64);
    expect(getState).toHaveBeenCalledTimes(1);
    expect(saveSetup).toHaveBeenCalledWith({ step: "folders" });
  });

  it("wrong words say so and keep the user on the key step", async () => {
    setLibraryKey.mockResolvedValueOnce({ ok: false, error: "wrongKey" });
    await mount();
    await typeKey(freshKey.words);
    await act(async () => (q("library-key-continue") as HTMLButtonElement).click());
    await flush();
    dump("wrong-key");
    expect(setLibraryKey).toHaveBeenCalledWith(freshKey.keyBase64);
    expect(q("library-key-step-error")?.textContent).toBe("That key doesn’t open your library. Check the 12 words and try again.");
    expect(saveSetup).not.toHaveBeenCalled();
    expect(getState).not.toHaveBeenCalled();
  });

  // @bugfix @regression-proof @req UX-KEY-02[parrot]
  it("a key load that ran out of time says so with Retry, deciding nothing, and Retry shows the new key once main can tell", async () => {
    createLibraryKey.mockResolvedValueOnce({ ok: false, error: "network", message: "timeout", errorClass: "timeout" });
    await mount();
    dump("load-failed");
    expect(q("key-load-failed")?.getAttribute("data-error-class")).toBe("timeout");
    expect(host.textContent).toContain("Your key could not be loaded");
    expect(host.textContent).toContain("The server is taking too long to answer.");
    expect(q("key-checking")).toBeNull();
    expect(q("key-created")).toBeNull();
    createLibraryKey.mockResolvedValueOnce({ ok: true, ...freshKey });
    await act(async () => q("key-load-retry")!.click());
    await flush();
    dump("created-after-offline");
    const words = Array.from(host.querySelectorAll('[data-testid="key-created"] [data-testid="library-key-word"]')).map(
      (item) => item.lastElementChild?.textContent ?? "",
    );
    expect(words).toEqual(freshKey.words);
    expect(setLibraryKey).not.toHaveBeenCalled();
  });

  // @req PRIV-KEY-01[parrot]
  it("the lost-key erase sends the password, then the step shows a fresh key to write down", async () => {
    await mount();
    createLibraryKey.mockResolvedValueOnce({ ok: true, ...freshKey });
    // Main forgot this computer's key after the erase.
    getState.mockResolvedValueOnce({ ...state, hasLibraryKey: false });
    await act(async () => q("key-lost-start-new-library")!.click());
    await flush();
    console.info(`${SUITE} erase warning=${JSON.stringify(q("reset-warning")?.textContent)}`);
    expect(q("reset-warning")?.textContent).toContain("in Badger and Parrot");
    await setValue(q("reset-password") as HTMLInputElement, "pw");
    await setValue(q("reset-confirm-word") as HTMLInputElement, "erase");
    await act(async () => (q("reset-submit") as HTMLButtonElement).click());
    await flush();
    dump("erased");
    expect(eraseLibrary).toHaveBeenCalledWith("pw", undefined);
    expect(createLibraryKey).toHaveBeenCalledTimes(2);
    expect(q("reset-submit")).toBeNull();
    expect(q("key-created")).not.toBeNull();
    expect(host.textContent).toContain(t("key.title"));
  });
});
