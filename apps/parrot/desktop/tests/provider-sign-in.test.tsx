// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-PROVIDER-SIGN-IN-001
 * @level unit
 * @req ACCT-SIGNIN-05[parrot] ACCT-SIGNIN-07[parrot]
 * @why ACCT-SIGNIN-05 on Parrot desktop: under the email form of the sign-in and sign-up screens, an "or" line, then a
 *   Google, Apple or Microsoft button only for the providers the API lists, in that order; a button starts the sign-in
 *   with the hash of a secret the window keeps (main opens the provider in the system browser), and the screen
 *   finishes it when main hands over the `parrot://auth/provider` outcome, the second sign-in step included.
 *   ACCT-SIGNIN-07: every button is a 54 px square, radius 13, named "Sign in with …", the provider's name captioned
 *   under it. The screen renders for real; the preload bridge is replaced.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findProviderReturn, PROVIDER_SIGN_IN_ERRORS, type ProviderReturn } from "@space/shared/providerSignIn";
import type { ParrotBridge, ParrotLanguage, ParrotProviderCompleteResult, ParrotState } from "../src/shared/ipc";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@space/ui", () => {
  const Pass = ({ children, className }: { children?: React.ReactNode; className?: string }) => <div className={className}>{children}</div>;
  return {
    Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { size?: string; variant?: string }) => {
      const { size: _size, variant: _variant, ...rest } = props;
      return <button {...rest}>{children}</button>;
    },
    Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
    Spinner: () => <span />,
    LanguageMenu: ({ current }: { current: string }) => <div data-testid="language-menu">{current}</div>,
    Card: Pass,
    CardContent: Pass,
    CardDescription: Pass,
    CardHeader: Pass,
    CardTitle: Pass,
    Dialog: ({ open, children }: { open?: boolean; children?: React.ReactNode }) => (open ? <>{children}</> : null),
    DialogContent: ({ children, ...rest }: React.HTMLAttributes<HTMLDivElement>) => <div {...rest}>{children}</div>,
    DialogFooter: Pass,
    DialogHeader: Pass,
    DialogTitle: Pass,
    Label: ({ children, htmlFor }: { children?: React.ReactNode; htmlFor?: string }) => <label htmlFor={htmlFor}>{children}</label>,
    cn: (...names: unknown[]) => names.filter(Boolean).join(" "),
  };
});

import SignIn from "../src/renderer/src/SignIn";
import { passwordResetText } from "@space/desktop-shell/components";
import { PROVIDER_VERIFIER_KEY } from "../src/renderer/src/ProviderSignIn";
import { PARROT_STRINGS, translator } from "../src/renderer/src/i18n";

const SUITE = "PARROT-DESKTOP-PROVIDER-SIGN-IN-001";
const dump = (line: string, extra?: unknown) => console.info(`[${SUITE}] ${line}`, extra === undefined ? "" : JSON.stringify(extra));

const sha256Base64url = (value: string) => createHash("sha256").update(value).digest("base64url");
const resetText = passwordResetText("en");

const state: ParrotState = {
  setup: { step: "libraryKey", done: false, language: "en", folders: [], startAtLogin: false, errorReports: false },
  user: null,
  hasLibraryKey: false,
  asksKeySavedBeforeSignOut: false,
  apiBaseUrl: "http://localhost:3000",
  isDevBuild: true,
  musicFolder: null,
  appVersion: "0.0.0",
} as ParrotState;

describe("Parrot desktop: Google, Apple and Microsoft sign-in", () => {
  let host: HTMLDivElement;
  let root: Root;
  let providers: string[];
  let held: ProviderReturn | null;
  let nudges: Array<() => void>;
  const onState = vi.fn();
  const getState = vi.fn(async () => ({ ...state, user: { id: "u1", email: "a@b.c" } }));
  const start = vi.fn(async (_provider: string, _challenge: string) => ({ ok: true as const }));
  const complete = vi.fn(async (_input: { code: string; verifier: string; twoFactorCode?: string; resendTwoFactor?: boolean }): Promise<ParrotProviderCompleteResult> => ({
    ok: true,
    user: { id: "u1", email: "a@b.c" },
  }));
  const takeReturn = vi.fn(async () => {
    const outcome = held;
    held = null;
    return outcome;
  });
  const resetRequest = vi.fn<ParrotBridge["passwordReset"]["request"]>();
  const resetConfirm = vi.fn<ParrotBridge["passwordReset"]["confirm"]>();

  const flush = async () => {
    for (let i = 0; i < 5; i += 1) await act(async () => undefined);
  };
  const mount = async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(<SignIn t={translator("en")} state={state} onState={onState} />));
    await flush();
  };
  const rowIds = () => [...host.querySelectorAll('[data-testid^="provider-sign-in-"]')].map((el) => el.getAttribute("data-testid")).filter((id) => /-(google|apple|microsoft)$/.test(id ?? ""));
  const nudge = async (outcome: ProviderReturn) => {
    held = outcome;
    await act(async () => {
      for (const n of nudges) n();
    });
    await flush();
  };
  const type = async (input: HTMLInputElement, text: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    providers = [];
    held = null;
    nudges = [];
    resetRequest.mockResolvedValue({ ok: true });
    resetConfirm.mockResolvedValue({ ok: true });
    (window as unknown as { parrot: Partial<ParrotBridge> }).parrot = {
      getState,
      saveAccountLanguage: async () => true,
      passwordReset: { request: resetRequest, confirm: resetConfirm },
      providerSignIn: {
        list: vi.fn(async () => providers as never),
        start: start as never,
        complete,
        takeReturn,
        onReturn: (callback: () => void) => {
          nudges.push(callback);
          return () => {
            nudges = nudges.filter((n) => n !== callback);
          };
        },
      },
    } as Partial<ParrotBridge>;
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  // @req ACCT-SIGNIN-05[parrot]
  it("@req ACCT-SIGNIN-05[parrot] draws no row and no provider 'or' line while no provider is configured", async () => {
    await mount();
    dump("rows", rowIds());
    expect(rowIds()).toEqual([]);
    expect(host.querySelector('[data-testid="provider-sign-in-divider"]')).toBeNull();
    expect(host.querySelector('[data-testid="signin-email"]')).not.toBeNull();
  });

  // @req ACCT-SIGNIN-05[parrot] @req ACCT-SIGNIN-07[parrot]
  it("@req ACCT-SIGNIN-05[parrot] @req ACCT-SIGNIN-07[parrot] draws the email form, the 'or' line, then 54 px square buttons in Google, Apple, Microsoft order", async () => {
    providers = ["microsoft", "google", "apple"];
    await mount();
    dump("rows", rowIds());
    expect(rowIds()).toEqual(["provider-sign-in-google", "provider-sign-in-apple", "provider-sign-in-microsoft"]);
    const apple = host.querySelector<HTMLButtonElement>('[data-testid="provider-sign-in-apple"]')!;
    expect(apple.getAttribute("aria-label")).toBe("Sign in with Apple");
    expect(apple.textContent).toBe("");
    expect(host.querySelector('[data-testid="provider-sign-in-apple-caption"]')?.textContent).toBe("Apple");
    for (const id of rowIds()) {
      const row = host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;
      dump("button style", { id, width: row.style.width, height: row.style.height, radius: row.style.borderRadius });
      expect(row.style.height).toBe("54px");
      expect(row.style.width).toBe("54px");
      expect(row.style.borderRadius).toBe("13px");
    }
    const divider = host.querySelector('[data-testid="provider-sign-in-divider"]')!;
    expect(divider.textContent).toBe("or");
    const email = host.querySelector('[data-testid="signin-email"]')!;
    expect(email.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(divider.compareDocumentPosition(apple) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // @req ACCT-SIGNIN-05[parrot]
  it("@req ACCT-SIGNIN-05[parrot] puts 'Forgot password?' with the email form: under Sign in, before the 'or' line", async () => {
    providers = ["google", "apple", "microsoft"];
    await mount();
    const submit = host.querySelector('[data-testid="signin-submit"]')!;
    const forgot = host.querySelector('[data-testid="forgot-password"]')!;
    const divider = host.querySelector('[data-testid="provider-sign-in-divider"]')!;
    dump("forgot", forgot?.textContent);
    expect(forgot.textContent).toBe(resetText("button"));
    expect(submit.compareDocumentPosition(forgot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(forgot.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // @req ACCT-SIGNIN-05[parrot]
  it("@req ACCT-SIGNIN-05[parrot] 'Forgot password?' asks main for a code, then sets the new password and says so on the sign-in screen", async () => {
    await mount();
    await type(host.querySelector<HTMLInputElement>('[data-testid="signin-email"]')!, "celeste@example.com");
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="forgot-password"]')!.click());
    await flush();
    const dialog = () => host.querySelector('[data-testid="password-reset-dialog"]');
    expect(dialog()).not.toBeNull();
    expect(host.querySelector<HTMLInputElement>("#resetEmail")!.value).toBe("celeste@example.com");
    await act(async () => dialog()!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await flush();
    expect(resetRequest).toHaveBeenCalledWith("celeste@example.com");
    expect(host.querySelector('[data-testid="password-reset-notice"]')?.textContent).toBe(resetText("noticeSent"));
    await type(host.querySelector<HTMLInputElement>("#resetCode")!, "123456");
    await type(host.querySelector<HTMLInputElement>("#resetPassword")!, "at-the-gate-2000");
    await type(host.querySelector<HTMLInputElement>("#resetPasswordConfirm")!, "at-the-gate-2000");
    await act(async () => dialog()!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await flush();
    dump("reset confirm calls", resetConfirm.mock.calls);
    expect(resetConfirm).toHaveBeenCalledWith({ email: "celeste@example.com", code: "123456", newPassword: "at-the-gate-2000" });
    expect(dialog()).toBeNull();
    expect(host.querySelector('[data-testid="signin-notice"]')?.textContent).toBe(resetText("noticeComplete"));
  });

  // @req ACCT-SIGNIN-05[parrot]
  it("@req ACCT-SIGNIN-05[parrot] a refused reset request says when to try again and stays on the email step", async () => {
    resetRequest.mockResolvedValueOnce({ ok: false, failure: "tooManyAttempts", retryAfterMinutes: 7 });
    await mount();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="forgot-password"]')!.click());
    await flush();
    await type(host.querySelector<HTMLInputElement>("#resetEmail")!, "celeste@example.com");
    await act(async () => host.querySelector('[data-testid="password-reset-dialog"] form')!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await flush();
    const alert = host.querySelector('[data-testid="password-reset-dialog"] [role="alert"]');
    dump("refused", alert?.textContent);
    expect(alert?.textContent).toBe("Too many attempts. Try again in 7 minutes.");
    expect(host.querySelector("#resetCode")).toBeNull();
  });

  // @req ACCT-SIGNIN-05[parrot]
  it("@req ACCT-SIGNIN-05[parrot] names the buttons 'Sign up with' on the sign-up screen", async () => {
    providers = ["google"];
    await mount();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="signin-create-account"]')!.click());
    await flush();
    dump("sign-up rows", rowIds());
    expect(host.querySelector('[data-testid="sign-up"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="provider-sign-in-google"]')?.getAttribute("aria-label")).toBe("Sign up with Google");
  });

  // @req ACCT-SIGNIN-05[parrot]
  it("@req ACCT-SIGNIN-05[parrot] starts with the hash of a kept secret and says to finish in the browser", async () => {
    providers = ["google", "microsoft"];
    await mount();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="provider-sign-in-microsoft"]')!.click());
    await flush();
    const [provider, challenge] = start.mock.calls[0]!;
    const verifier = localStorage.getItem(PROVIDER_VERIFIER_KEY)!;
    dump("start", { provider, verifierLength: verifier.length });
    expect(provider).toBe("microsoft");
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toBe(sha256Base64url(verifier));
    expect(host.querySelector('[data-testid="provider-sign-in-notice"]')?.textContent).toBe("Finish signing in in your browser. Parrot comes back once you're done.");
  });

  // @req ACCT-SIGNIN-05[parrot]
  it("@req ACCT-SIGNIN-05[parrot] says when the sign-in could not start", async () => {
    providers = ["google"];
    start.mockResolvedValueOnce({ ok: false, failure: "serverError", retryAfterMinutes: 0 } as never);
    await mount();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="provider-sign-in-google"]')!.click());
    await flush();
    const notice = host.querySelector('[data-testid="provider-sign-in-notice"]');
    dump("notice", notice?.textContent);
    expect(notice?.getAttribute("role")).toBe("alert");
    expect(notice?.textContent).toBe("Could not start the sign-in. Please try again.");
  });

  // @req ACCT-SIGNIN-05[parrot]
  it("@req ACCT-SIGNIN-05[parrot] finishes with the code main hands over and the kept secret, then signs in", async () => {
    localStorage.setItem(PROVIDER_VERIFIER_KEY, "kept-secret");
    await mount();
    expect(complete).not.toHaveBeenCalled();
    await nudge({ code: "one-time-code-0123456789" });
    dump("complete calls", complete.mock.calls);
    expect(complete).toHaveBeenCalledWith({ code: "one-time-code-0123456789", verifier: "kept-secret" });
    expect(getState).toHaveBeenCalled();
    expect(onState).toHaveBeenCalledWith(expect.objectContaining({ user: { id: "u1", email: "a@b.c" } }));
    expect(localStorage.getItem(PROVIDER_VERIFIER_KEY)).toBeNull();
  });

  // @req ACCT-SIGNIN-05[parrot]
  it("@req ACCT-SIGNIN-05[parrot] takes an outcome that came before the screen listened", async () => {
    localStorage.setItem(PROVIDER_VERIFIER_KEY, "kept-secret");
    held = { code: "early-code-0123456789" };
    await mount();
    dump("complete calls", complete.mock.calls);
    expect(complete).toHaveBeenCalledWith({ code: "early-code-0123456789", verifier: "kept-secret" });
  });

  // @req ACCT-SIGNIN-05[parrot]
  it("@req ACCT-SIGNIN-05[parrot] asks for the second step, sends it with the same code, and can send a new code", async () => {
    localStorage.setItem(PROVIDER_VERIFIER_KEY, "kept-secret");
    complete.mockResolvedValueOnce({ ok: false, failure: "twoFactorRequired", method: "email", retryAfterMinutes: 0 });
    complete.mockResolvedValueOnce({ ok: false, failure: "twoFactorRequired", method: "email", retryAfterMinutes: 0 });
    held = { code: "one-time-code-0123456789" };
    await mount();
    expect(onState).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="provider-second-step"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="signin-email"]')).toBeNull();
    expect(rowIds()).toEqual([]);
    expect(host.textContent).toContain("Enter the code from your second sign-in step.");
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="provider-second-step-resend"]')!.click());
    await flush();
    await type(host.querySelector<HTMLInputElement>('[data-testid="provider-second-step-code"]')!, " 123456 ");
    await act(async () => {
      host.querySelector('[data-testid="provider-second-step"]')!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();
    dump("second step calls", complete.mock.calls);
    expect(complete.mock.calls[1]?.[0]).toEqual({ code: "one-time-code-0123456789", verifier: "kept-secret", resendTwoFactor: true });
    expect(complete.mock.calls[2]?.[0]).toEqual({ code: "one-time-code-0123456789", verifier: "kept-secret", twoFactorCode: "123456" });
    expect(onState).toHaveBeenCalledTimes(1);
  });

  // @req ACCT-SIGNIN-05[parrot]
  it("@req ACCT-SIGNIN-05[parrot] says why when the provider sign-in came back with an error, from the sign-up screen too", async () => {
    providers = ["google"];
    localStorage.setItem(PROVIDER_VERIFIER_KEY, "kept-secret");
    await mount();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="signin-create-account"]')!.click());
    await flush();
    expect(host.querySelector('[data-testid="sign-up"]')).not.toBeNull();
    await nudge({ error: "cancelled" });
    const notice = host.querySelector('[data-testid="provider-sign-in-notice"]');
    dump("notice", notice?.textContent);
    expect(host.querySelector('[data-testid="sign-up"]')).toBeNull();
    expect(host.querySelector('[data-testid="signin-email"]')).not.toBeNull();
    expect(notice?.textContent).toBe("The sign-in was cancelled.");
    expect(complete).not.toHaveBeenCalled();
    expect(localStorage.getItem(PROVIDER_VERIFIER_KEY)).toBeNull();
  });

  // @req ACCT-SIGNIN-05[parrot]
  it("@req ACCT-SIGNIN-05[parrot] a spent code says the sign-in expired", async () => {
    localStorage.setItem(PROVIDER_VERIFIER_KEY, "kept-secret");
    complete.mockResolvedValueOnce({ ok: false, error: "invalid_code" });
    await mount();
    await nudge({ code: "spent-code-0123456789" });
    dump("notice", host.querySelector('[data-testid="provider-sign-in-notice"]')?.textContent);
    expect(host.querySelector('[data-testid="provider-sign-in-notice"]')?.textContent).toBe("This sign-in has expired or was started elsewhere. Please try again.");
    expect(onState).not.toHaveBeenCalled();
  });

  // @req ACCT-SIGNIN-05[parrot]
  it("@req ACCT-SIGNIN-05[parrot] main reads the parrot://auth/provider link from a launch or second-instance argv", () => {
    const argv = ["/usr/bin/parrot", "--no-sandbox", "parrot://auth/provider?signinCode=abc0123456789abcdef"];
    dump("argv", argv);
    expect(findProviderReturn("parrot", argv)).toEqual({ code: "abc0123456789abcdef" });
    expect(findProviderReturn("parrot", ["/usr/bin/parrot", "parrot://auth/provider?signinError=cancelled"])).toEqual({ error: "cancelled" });
    expect(findProviderReturn("parrot", ["/usr/bin/parrot", "badger://auth/provider?signinCode=abc0123456789abcdef"])).toBeNull();
    expect(findProviderReturn("parrot", ["/usr/bin/parrot", "parrot://billing/return?paymentId=p1"])).toBeNull();
    const main = readFileSync(resolve(import.meta.dirname, "../src/main/index.ts"), "utf8");
    const secondInstance = main.slice(main.indexOf('app.on("second-instance"'));
    expect(secondInstance.indexOf("findProviderReturn")).toBeGreaterThan(-1);
    expect(secondInstance.indexOf("findProviderReturn")).toBeLessThan(secondInstance.indexOf("findPaymentReturn"));
    expect(main).toContain('returnTo: providerReturnAddress("parrot")');
    expect(main).toContain('surface: "desktop"');
  });

  // @req ACCT-SIGNIN-05[parrot]
  it("@req ACCT-SIGNIN-05[parrot] has the provider words in Parrot's five languages, every return error included", () => {
    const keys = Object.keys(PARROT_STRINGS.en).filter((key) => key.startsWith("signIn.provider."));
    dump("provider keys", keys.length);
    for (const code of PROVIDER_SIGN_IN_ERRORS) expect(keys).toContain(`signIn.provider.errors.${code}`);
    for (const language of ["fr", "nl", "de", "es"] as ParrotLanguage[]) {
      for (const key of keys) expect(PARROT_STRINGS[language][key as keyof (typeof PARROT_STRINGS)["en"]], `${language} ${key}`).toBeTruthy();
      expect(PARROT_STRINGS[language]["signIn.provider.continueInBrowser"]).not.toBe(PARROT_STRINGS.en["signIn.provider.continueInBrowser"]);
      expect(PARROT_STRINGS[language]["signIn.provider.signInWith"]).toContain("{provider}");
    }
  });
});
