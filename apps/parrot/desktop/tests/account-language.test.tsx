// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-ACCOUNT-LANGUAGE-001
 * @level integration (real App, SignIn and Setup screens, real Radix Dialog, real shared reconcile; `window.parrot` mocked)
 * @req UX-I18N-07
 * @why Chris 2026-11-11: one account has one language, shared across apps, profiles and emails. Before sign-in the
 *   language picked on the sign-in screen lives on this computer; right after a fresh sign-in, if the account already
 *   has a different language, the user is asked which one, and the answer applies to the whole account. An account
 *   without a language takes this computer's; a matching one changes nothing; a failed read never blocks the sign-in.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParrotBridge, ParrotLanguage, ParrotState } from "../src/shared/ipc";
import { updateRequiredBridgeStub } from "./updateRequiredBridge";
import App from "../src/renderer/src/App";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "[PARROT-DESKTOP-ACCOUNT-LANGUAGE-001]";

const signedOut = (language: ParrotLanguage): ParrotState => ({
  setup: { step: "libraryKey", done: false, language, folders: [], startAtLogin: false, errorReports: false },
  user: null,
  hasLibraryKey: false,
  asksKeySavedBeforeSignOut: false,
  apiBaseUrl: "http://localhost:3000",
  isDevBuild: true,
  musicFolder: null,
  appVersion: "0.0.0",
});

describe("@req UX-I18N-07 Parrot desktop: the account's language after a fresh sign-in", () => {
  let host: HTMLDivElement;
  let root: Root;
  let state: ParrotState;
  let account: { ok: true; language: ParrotLanguage | null } | { ok: false };
  const saveSetup = vi.fn(async (patch: Partial<ParrotState["setup"]>) => {
    state = { ...state, setup: { ...state.setup, ...patch } };
    return state;
  });
  const saveAccountLanguage = vi.fn(async (_language: ParrotLanguage) => true);
  const signIn = vi.fn(async () => {
    state = { ...state, user: { id: "u1", email: "a@b.c" } };
    return { ok: true as const, user: { id: "u1", email: "a@b.c" } };
  });

  const flush = async () => {
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
    });
  };
  const type = (testId: string, value: string) => {
    const input = host.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const signInWithEmail = async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(<App />));
    await flush();
    await act(async () => {
      type("signin-email", "a@b.c");
      type("signin-password", "secret");
    });
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="signin-submit"]')!.click());
    await flush();
  };
  const prompt = () => document.body.querySelector('[data-testid="account-language-dialog"]');
  const dump = (label: string) =>
    console.info(
      `${SUITE} ${label}: prompt=${JSON.stringify(prompt()?.textContent ?? null)} saveSetup=${JSON.stringify(saveSetup.mock.calls)} saveAccountLanguage=${JSON.stringify(saveAccountLanguage.mock.calls)} setup=${Boolean(host.querySelector('[data-testid^="setup-"]'))}`,
    );

  beforeEach(() => {
    vi.clearAllMocks();
    (window as unknown as { parrot: Partial<ParrotBridge> }).parrot = {
      ...updateRequiredBridgeStub(),
      getState: async () => state,
      saveSetup,
      signIn,
      getAccountLanguage: async () => account,
      saveAccountLanguage,
      // Setup lands on the key step, which asks main for a new key first (tests/setup-key-step.test.tsx).
      createLibraryKey: async () => ({ ok: false as const, error: "hasLibrary" as const }),
      // No provider configured: no Google, Apple or Microsoft row (ACCT-SIGNIN-05, tests/provider-sign-in.test.tsx).
      providerSignIn: { list: async () => [], start: vi.fn(), complete: vi.fn(), takeReturn: async () => null, onReturn: () => () => undefined },
    };
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    document.body.innerHTML = "";
  });

  it("asks which language when the account's differs, in this computer's language, and applies the pick", async () => {
    state = signedOut("en");
    account = { ok: true, language: "fr" };
    await signInWithEmail();
    dump("asked");
    expect(prompt()?.textContent).toContain("Which language do you want?");
    expect(prompt()?.textContent).toContain("Your account is set to French, and this device to English.");
    // Setup waits for the answer.
    expect(host.querySelector('[data-testid^="setup-"]')).toBeNull();

    await act(async () => document.body.querySelector<HTMLButtonElement>('[data-testid="account-language-account"]')!.click());
    await flush();
    dump("picked the account's");
    expect(document.body.querySelector('[data-testid="account-language-account"]')).toBeNull();
    expect(saveSetup).toHaveBeenCalledWith({ language: "fr" });
    expect(saveAccountLanguage).not.toHaveBeenCalled();
    expect(document.documentElement.lang).toBe("fr");
    expect(host.querySelector('[data-testid="setup-libraryKey"]')).not.toBeNull();
  });

  it("saves this computer's language to the account when that one is picked", async () => {
    state = signedOut("en");
    account = { ok: true, language: "de" };
    await signInWithEmail();
    await act(async () => document.body.querySelector<HTMLButtonElement>('[data-testid="account-language-device"]')!.click());
    await flush();
    dump("picked the device's");
    expect(saveAccountLanguage).toHaveBeenCalledWith("en");
    expect(saveSetup).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="setup-libraryKey"]')).not.toBeNull();
  });

  it("gives an account without a language this computer's, without asking", async () => {
    state = signedOut("nl");
    account = { ok: true, language: null };
    await signInWithEmail();
    dump("adopted");
    expect(prompt()).toBeNull();
    expect(saveAccountLanguage).toHaveBeenCalledWith("nl");
    expect(host.querySelector('[data-testid="setup-libraryKey"]')).not.toBeNull();
  });

  it("changes nothing when the account already speaks this computer's language, or cannot be read", async () => {
    for (const read of [{ ok: true, language: "es" }, { ok: false }] as const) {
      state = signedOut("es");
      account = read;
      await signInWithEmail();
      dump(`read ${JSON.stringify(read)}`);
      expect(prompt()).toBeNull();
      expect(saveAccountLanguage).not.toHaveBeenCalled();
      expect(saveSetup).not.toHaveBeenCalled();
      expect(host.querySelector('[data-testid="setup-libraryKey"]')).not.toBeNull();
      await act(async () => root.unmount());
      host.remove();
    }
    // afterEach unmounts once more.
    host = document.createElement("div");
    root = createRoot(host);
  });
});
