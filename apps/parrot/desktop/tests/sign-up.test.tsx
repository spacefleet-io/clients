// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-SIGN-UP-001
 * @level unit
 * @req ACCT-AUTH-10[parrot]
 * @why Chris 2026-11-05: accounts are created "anywhere except on the mobile and tv apps"; the Parrot desktop walk
 *   (2026-11-12) found only sign-in and QR, no way to create an account. Parrot desktop now creates one the way Badger
 *   desktop does (email, password twice, unticked News box, emailed code, shared checks in `@space/shared/signUp`),
 *   and the new account lands in setup at the library key, signed in.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParrotBridge, ParrotLanguage, ParrotState } from "../src/shared/ipc";
import { updateRequiredBridgeStub } from "./updateRequiredBridge";
import { PARROT_STRINGS } from "../src/renderer/src/i18n";
import type { RenderBoundary as RealRenderBoundary } from "@space/ui/render-boundary";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@space/ui", async () => {
  const Pass = ({ children, className }: { children?: React.ReactNode; className?: string }) => <div className={className}>{children}</div>;
  const { RenderBoundary } = await vi.importActual<{ RenderBoundary: typeof RealRenderBoundary }>("@space/ui/render-boundary");
  return {
    RenderBoundary,
    Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { size?: string; variant?: string }) => {
      const { size: _size, variant: _variant, ...rest } = props;
      return <button {...rest}>{children}</button>;
    },
    Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
    Spinner: () => <span />,
    KeySavedWarningDialog: () => null,
    LanguageMenu: ({ current }: { current: string }) => <div data-testid="language-menu">{current}</div>,
    CloseLabelProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    Card: Pass,
    CardContent: Pass,
    CardDescription: Pass,
    CardHeader: Pass,
    CardTitle: Pass,
    Dialog: () => null,
    DialogContent: Pass,
    DialogFooter: Pass,
    DialogHeader: Pass,
    DialogTitle: Pass,
    Label: Pass,
    useSignOutWithKeyCheck: () => ({ requestSignOut: () => undefined, dialog: null }),
  };
});

import App from "../src/renderer/src/App";

const say = (line: string, extra?: unknown) => console.info(`[PARROT-DESKTOP-SIGN-UP-001] ${line}`, extra ?? "");

const baseState = (patch: Partial<ParrotState> = {}): ParrotState => ({
  setup: { step: "libraryKey", done: false, language: "en", folders: [], startAtLogin: false, errorReports: false },
  user: null,
  hasLibraryKey: false,
  asksKeySavedBeforeSignOut: false,
  apiBaseUrl: "http://localhost:3000",
  isDevBuild: true,
  musicFolder: null,
  appVersion: "0.0.0",
  ...patch,
});

describe("Parrot desktop: creating an account (ACCT-AUTH-10)", () => {
  let host: HTMLDivElement;
  let root: Root;
  let state: ParrotState;
  const signUp = vi.fn<ParrotBridge["signUp"]>();
  const verifyEmail = vi.fn<ParrotBridge["verifyEmail"]>();
  const resendVerification = vi.fn<ParrotBridge["resendVerification"]>();
  const signIn = vi.fn<ParrotBridge["signIn"]>();

  const $ = <T extends HTMLElement = HTMLElement>(id: string) => host.querySelector<T>(`[data-testid="${id}"]`);
  const dump = (why: string) =>
    say(`dump (${why})`, {
      screens: [...host.querySelectorAll("[data-testid]")].map((el) => el.getAttribute("data-testid")).slice(0, 40),
      alerts: [...host.querySelectorAll('[role="alert"],[role="status"]')].map((el) => el.textContent),
      signUp: signUp.mock.calls,
      verifyEmail: verifyEmail.mock.calls,
      state,
    });
  const type = async (id: string, text: string) => {
    const input = $<HTMLInputElement>(id);
    if (!input) dump(`no input ${id}`);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const click = async (id: string) => {
    const el = $(id);
    if (!el) dump(`no element ${id}`);
    await act(async () => el!.click());
    await act(async () => undefined);
  };
  const submit = async (id: string) => {
    await act(async () => $<HTMLButtonElement>(id)!.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await act(async () => undefined);
  };
  const mount = async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(<App />));
    await act(async () => undefined);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    state = baseState();
    signUp.mockResolvedValue({ ok: true });
    verifyEmail.mockImplementation(async () => {
      state = { ...state, user: { id: "u-new", email: "celeste@example.com" } };
      return { ok: true, user: { id: "u-new", email: "celeste@example.com" } };
    });
    resendVerification.mockResolvedValue({ ok: true });
    (window as unknown as { parrot: Partial<ParrotBridge> }).parrot = {
      ...updateRequiredBridgeStub(),
      getState: async () => state,
      saveSetup: async (patch) => {
        state = { ...state, setup: { ...state.setup, ...patch } };
        return state;
      },
      signIn,
      signUp,
      verifyEmail,
      resendVerification,
      // A new account has no key yet: the key step makes one (UX-KEY-01).
      createLibraryKey: async () => ({ ok: true as const, keyBase64: "AAAA", words: Array.from({ length: 12 }, (_, i) => `word${i}`) }),
      getAccountLanguage: async () => ({ ok: true as const, language: "en" as const }),
      saveAccountLanguage: async () => true,
      pairing: { start: vi.fn(), poll: vi.fn(), cancel: vi.fn() } as unknown as ParrotBridge["pairing"],
      // No provider configured: no Google, Apple or Microsoft row (ACCT-SIGNIN-05, tests/provider-sign-in.test.tsx).
      providerSignIn: { list: async () => [], start: vi.fn(), complete: vi.fn(), takeReturn: async () => null, onReturn: () => () => undefined },
    };
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("@req ACCT-AUTH-10[parrot] creates an account from the sign-in screen, confirms the emailed code and lands in setup at the library key", async () => {
    await mount();
    say("phase: sign-in screen");
    expect($("signin-create-account")?.textContent).toBe("Create an account");
    await click("signin-create-account");
    expect($("sign-up")).not.toBeNull();
    const news = $<HTMLInputElement>("signup-news-opt-in");
    expect(news?.checked).toBe(false); // ACCT-NEWS-01: unticked until ticked.

    say("phase: fill the form");
    await type("signup-email", "  celeste@example.com ");
    await type("signup-password", "at-the-gate-2000");
    await type("signup-confirm", "at-the-gate-2000");
    await click("signup-news-opt-in");
    await submit("signup-submit");
    expect(signUp).toHaveBeenCalledWith({ email: "celeste@example.com", password: "at-the-gate-2000", newsOptIn: true });

    say("phase: code step");
    if (!$("verify-email")) dump("no code step");
    expect($("verify-email")?.textContent).toContain("We sent a code to celeste@example.com.");
    await type("verify-code", " 123456 ");
    await submit("verify-submit");
    expect(verifyEmail).toHaveBeenCalledWith({ email: "celeste@example.com", code: "123456" });

    say("phase: setup");
    if (!$("setup-libraryKey")) dump("not in setup");
    expect($("sign-in")).toBeNull();
    expect($("setup-libraryKey")).not.toBeNull();
    expect($("signed-in-as")?.textContent).toContain("celeste@example.com");
  });

  it("@req ACCT-AUTH-10[parrot] refuses a short or mismatched password before asking the API (shared checks)", async () => {
    await mount();
    await click("signin-create-account");
    await type("signup-email", "mike@example.com");
    await type("signup-password", "short");
    await type("signup-confirm", "short");
    await submit("signup-submit");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Your password needs at least 8 characters.");
    await type("signup-password", "nook-2003-ok");
    await type("signup-confirm", "nook-2003-no");
    await submit("signup-submit");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("The two passwords are different.");
    expect(signUp).not.toHaveBeenCalled();
  });

  it("says an email already has an account, and a refusal for too many attempts with its minutes", async () => {
    signUp.mockResolvedValueOnce({ ok: false, failure: "emailExists", retryAfterMinutes: 15 });
    signUp.mockResolvedValueOnce({ ok: false, failure: "rateLimited", retryAfterMinutes: 3 });
    await mount();
    await click("signin-create-account");
    await type("signup-email", "celeste@example.com");
    await type("signup-password", "at-the-gate-2000");
    await type("signup-confirm", "at-the-gate-2000");
    await submit("signup-submit");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("This email already has a SpaceFleet account. Sign in instead.");
    await submit("signup-submit");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Too many attempts. Try again in 3 minutes.");
    expect($("verify-email")).toBeNull();
  });

  it("a wrong code says so, a new code can be sent, and the way back is the sign-in form", async () => {
    verifyEmail.mockResolvedValueOnce({ ok: false, failure: "invalidCode", retryAfterMinutes: 15 });
    await mount();
    await click("signin-create-account");
    await type("signup-email", "celeste@example.com");
    await type("signup-password", "fable-2003-ok");
    await type("signup-confirm", "fable-2003-ok");
    await submit("signup-submit");
    await type("verify-code", "000000");
    await submit("verify-submit");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("That code is wrong or has expired. Try again or ask for a new one.");
    await click("verify-resend");
    expect(resendVerification).toHaveBeenCalledWith("celeste@example.com");
    expect(host.querySelector('[role="status"]')?.textContent).toBe("New code sent. Check your inbox.");
    await click("verify-back");
    expect($("signin-email")).not.toBeNull();
  });

  it("a sign-in to an account whose email is not confirmed yet opens the code step for that email", async () => {
    signIn.mockResolvedValueOnce({ ok: false, failure: "emailNotVerified", retryAfterMinutes: 15 });
    await mount();
    await type("signin-email", "celeste@example.com");
    await type("signin-password", "paperboat-2000");
    await submit("signin-submit");
    if (!$("verify-email")) dump("no code step after unverified sign-in");
    expect($("verify-email")?.textContent).toContain("celeste@example.com");
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      "Confirm your email address first with the code we emailed you, then sign in.",
    );
  });

  it("@req ACCT-AUTH-10[parrot] has the sign-up words in Parrot's five languages", () => {
    const keys = Object.keys(PARROT_STRINGS.en).filter((key) => /^(signUp|verify)\.|^signIn\.(noAccount|createAccount)$/.test(key));
    say("sign-up keys", keys.length);
    expect(keys.length).toBe(28);
    for (const language of ["fr", "nl", "de", "es"] as ParrotLanguage[]) {
      for (const key of keys) {
        const text = PARROT_STRINGS[language][key as keyof (typeof PARROT_STRINGS)["en"]];
        expect(text, `${language} ${key}`).toBeTruthy();
      }
      // Translated, not English copied over (the email label may legitimately match).
      expect(PARROT_STRINGS[language]["signUp.title"]).not.toBe(PARROT_STRINGS.en["signUp.title"]);
      expect(PARROT_STRINGS[language]["verify.body"]).toContain("{email}");
    }
  });
});
