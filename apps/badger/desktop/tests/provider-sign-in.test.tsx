// @vitest-environment jsdom
/**
 * ACCT-SIGNIN-05 on Badger desktop: under the email form, an "or" line, then a Google, Apple or Microsoft button only
 * for the providers the API lists, in that order, start the sign-in with the hash of a secret the computer keeps and
 * open the provider in the system browser, and finish it when main hands over the `badger://auth/provider` outcome.
 * ACCT-SIGNIN-07: every button is a 54 px square named "Sign in with …", the provider's name captioned under it. The
 * screens render for real; the API and the preload bridge are replaced.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { createHash } from "node:crypto";
import type * as RouterDom from "react-router-dom";
import type { ProviderReturn } from "@space/shared/providerSignIn";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "badger-desktop-provider-sign-in";

const h = vi.hoisted(() => {
  class ApiError extends Error {
    payload: { error?: string; method?: string };
    status = 401;
    constructor(payload: { error?: string; method?: string }) {
      super(payload.error);
      this.payload = payload;
    }
  }
  return {
    ApiError,
    providers: [] as string[],
    listSignInProviders: vi.fn(async () => ({ providers: [] as string[] })),
    startProviderSignIn: vi.fn(async (..._args: unknown[]) => ({ url: "https://accounts.example.test/authorize" })),
    completeProviderSignIn: vi.fn(async (..._args: unknown[]) => ({ token: "session-token", user: { id: "u1" } })),
    setSession: vi.fn(),
    navigate: vi.fn(),
    open: vi.fn(),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { provider?: string }) => (options?.provider ? `${key}:${options.provider}` : key),
    i18n: { language: "fr" },
  }),
}));
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof RouterDom>()),
  useNavigate: () => h.navigate,
}));
vi.mock("../src/renderer/src/auth", () => ({
  useAuth: () => ({ login: vi.fn(), systemIssue: null, setSession: h.setSession }),
}));
vi.mock("../src/renderer/src/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ApiError: h.ApiError,
  signup: vi.fn(),
  confirmPasswordReset: vi.fn(),
  requestPasswordReset: vi.fn(),
  listSignInProviders: h.listSignInProviders,
  startProviderSignIn: h.startProviderSignIn,
  completeProviderSignIn: h.completeProviderSignIn,
}));
vi.mock("@space/ui", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  LanguageMenu: () => <button data-testid="language-menu">language</button>,
}));
vi.mock("@space/desktop-shell/components", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  PairWithPhone: () => <div data-testid="pair-with-phone" />,
  ApiHostSettingsButton: () => <button data-testid="server-picker">server</button>,
}));

import Login from "../src/renderer/src/pages/Login";
import Signup from "../src/renderer/src/pages/Signup";
import { PROVIDER_VERIFIER_KEY } from "@space/desktop-shell/provider-sign-in";

const sha256Base64url = (text: string) => createHash("sha256").update(text).digest("base64url");

/** The preload bridge: `takeReturn` hands over what main holds (once), `onReturn` is main's nudge. */
const bridge = {
  held: null as ProviderReturn | null,
  nudges: new Set<() => void>(),
  takeReturn: vi.fn(async () => {
    const value = bridge.held;
    bridge.held = null;
    return value;
  }),
  onReturn: (callback: () => void) => {
    bridge.nudges.add(callback);
    return () => bridge.nudges.delete(callback);
  },
};

describe(`[${SUITE}] provider rows`, () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    for (const fn of [h.listSignInProviders, h.startProviderSignIn, h.completeProviderSignIn, h.setSession, h.navigate, h.open, bridge.takeReturn]) {
      fn.mockClear();
    }
    h.listSignInProviders.mockImplementation(async () => ({ providers: h.providers }));
    bridge.held = null;
    bridge.nudges.clear();
    localStorage.clear();
    Object.assign(window, { sf: { pairing: {}, providerSignIn: { takeReturn: bridge.takeReturn, onReturn: bridge.onReturn } } });
    vi.stubGlobal("open", h.open);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, "sf");
  });

  const flush = async () => {
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  };

  const render = async (page: React.ReactElement, url = "/login") => {
    await act(async () => {
      root.render(<MemoryRouter initialEntries={[url]}>{page}</MemoryRouter>);
    });
    await flush();
  };

  const rowIds = () =>
    [...container.querySelectorAll<HTMLButtonElement>('button[data-testid^="provider-sign-in-"]')].map((row) => row.dataset.testid);
  const follows = (before: Element, after: Element) => Boolean(before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING);

  // @req ACCT-SIGNIN-05[badger-desktop]
  it("@req ACCT-SIGNIN-05[badger-desktop] draws no row and no 'or' line while no provider is configured", async () => {
    h.providers = [];
    await render(<Login />);
    console.info(`[${SUITE}] unconfigured rows=${JSON.stringify(rowIds())}`);
    expect(h.listSignInProviders).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="provider-sign-in-rows"]')).toBeNull();
    expect(container.querySelector('[data-testid="provider-sign-in-divider"]')).toBeNull();
    expect(container.querySelector("#email")).not.toBeNull();
  });

  // @req ACCT-SIGNIN-05[badger-desktop] @req ACCT-SIGNIN-07[badger-desktop]
  it("@req ACCT-SIGNIN-05[badger-desktop] @req ACCT-SIGNIN-07[badger-desktop] draws the form, the 'or' line, then 54 px square buttons in Google, Apple, Microsoft order", async () => {
    h.providers = ["microsoft", "google", "apple"];
    await render(<Login />);
    console.info(`[${SUITE}] rows=${JSON.stringify(rowIds())}`);
    expect(rowIds()).toEqual(["provider-sign-in-google", "provider-sign-in-apple", "provider-sign-in-microsoft"]);
    const apple = container.querySelector<HTMLButtonElement>('[data-testid="provider-sign-in-apple"]')!;
    // The row titles come from `@space/shared/providerSignIn` in the window's language (French here).
    expect(apple.getAttribute("aria-label")).toBe("Se connecter avec Apple");
    expect(apple.textContent).toBe("");
    expect(container.querySelector('[data-testid="provider-sign-in-apple-caption"]')?.textContent).toBe("Apple");
    for (const id of rowIds()) {
      const row = container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;
      expect(row.style.height).toBe("54px");
      expect(row.style.width).toBe("54px");
      expect(row.style.borderRadius).toBe("13px");
    }
    expect(apple.style.background).toBe("rgb(0, 0, 0)");
    const divider = container.querySelector('[data-testid="provider-sign-in-divider"]')!;
    expect(divider.textContent).toBe("ou");
    expect(follows(container.querySelector("#password")!, divider)).toBe(true);
    expect(follows(divider, apple)).toBe(true);
  });

  // @req ACCT-SIGNIN-05[badger-desktop]
  it("@req ACCT-SIGNIN-05[badger-desktop] puts 'Forgot password?' with the form: under Sign in, before the 'or' line", async () => {
    h.providers = ["google", "apple", "microsoft"];
    await render(<Login />);
    const submit = container.querySelector('button[type="submit"]')!;
    const forgot = container.querySelector('[data-testid="forgot-password"]')!;
    const divider = container.querySelector('[data-testid="provider-sign-in-divider"]')!;
    console.info(`[${SUITE}] forgot text=${forgot.textContent}`);
    expect(forgot.textContent).toBe("Mot de passe oublié ?");
    expect(follows(submit, forgot)).toBe(true);
    expect(follows(forgot, divider)).toBe(true);
  });

  // @req ACCT-SIGNIN-05[badger-desktop]
  it("@req ACCT-SIGNIN-05[badger-desktop] draws only the configured providers, titled 'Sign up with' on the sign-up screen", async () => {
    h.providers = ["google"];
    await render(<Signup />, "/signup");
    expect(rowIds()).toEqual(["provider-sign-in-google"]);
    const google = container.querySelector('[data-testid="provider-sign-in-google"]')!;
    expect(google.getAttribute("aria-label")).toBe("S'inscrire avec Google");
    expect(follows(container.querySelector("#email")!, google)).toBe(true);
  });

  // @req ACCT-SIGNIN-05[badger-desktop]
  it("@req ACCT-SIGNIN-05[badger-desktop] starts with the hash of a kept secret and opens the provider in the browser", async () => {
    h.providers = ["google", "microsoft"];
    await render(<Login />);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="provider-sign-in-microsoft"]')!.click();
    });
    await flush();
    const [provider, input] = h.startProviderSignIn.mock.calls[0] as [
      string,
      { returnTo: string; surface: string; clientChallenge: string; uiLanguage: string },
    ];
    const verifier = localStorage.getItem(PROVIDER_VERIFIER_KEY)!;
    console.info(`[${SUITE}] start provider=${provider} returnTo=${input.returnTo} surface=${input.surface} language=${input.uiLanguage}`);
    expect(provider).toBe("microsoft");
    expect(input.returnTo).toBe("badger://auth/provider");
    expect(input.surface).toBe("desktop");
    expect(input.uiLanguage).toBe("fr");
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(input.clientChallenge).toBe(sha256Base64url(verifier));
    expect(h.open).toHaveBeenCalledWith("https://accounts.example.test/authorize", "_blank", "noopener,noreferrer");
    expect(container.textContent).toContain("login.provider.continueInBrowser");
  });

  // @req ACCT-SIGNIN-05[badger-desktop]
  it("@req ACCT-SIGNIN-05[badger-desktop] finishes with the code main hands over and the kept secret, then opens the account", async () => {
    localStorage.setItem(PROVIDER_VERIFIER_KEY, "kept-secret");
    await render(<Login />);
    expect(h.completeProviderSignIn).not.toHaveBeenCalled();
    bridge.held = { code: "one-time-code-0123456789" };
    await act(async () => {
      for (const nudge of bridge.nudges) nudge();
    });
    await flush();
    console.info(`[${SUITE}] complete calls=${JSON.stringify(h.completeProviderSignIn.mock.calls)}`);
    expect(h.completeProviderSignIn).toHaveBeenCalledTimes(1);
    expect(h.completeProviderSignIn.mock.calls[0]?.slice(0, 2)).toEqual(["one-time-code-0123456789", "kept-secret"]);
    expect(h.setSession).toHaveBeenCalledWith("session-token", { id: "u1" });
    expect(h.navigate).toHaveBeenCalledWith("/");
    expect(localStorage.getItem(PROVIDER_VERIFIER_KEY)).toBeNull();
  });

  // @req ACCT-SIGNIN-05[badger-desktop]
  it("@req ACCT-SIGNIN-05[badger-desktop] asks for the second step and sends it with the same code", async () => {
    localStorage.setItem(PROVIDER_VERIFIER_KEY, "kept-secret");
    h.completeProviderSignIn.mockImplementationOnce(async () => {
      throw new h.ApiError({ error: "two_factor_required", method: "totp" });
    });
    bridge.held = { code: "one-time-code-0123456789" };
    await render(<Login />);
    expect(h.setSession).not.toHaveBeenCalled();
    const codeInput = container.querySelector<HTMLInputElement>('input[autocomplete="one-time-code"]')!;
    expect(codeInput).not.toBeNull();
    expect(container.querySelector('[data-testid="provider-sign-in-rows"]')).toBeNull();
    expect(container.querySelector("#email")).toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(codeInput, "123456");
      codeInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();
    console.info(`[${SUITE}] second step calls=${JSON.stringify(h.completeProviderSignIn.mock.calls)}`);
    expect(h.completeProviderSignIn.mock.calls[1]?.slice(0, 3)).toEqual(["one-time-code-0123456789", "kept-secret", "123456"]);
    expect(h.setSession).toHaveBeenCalledTimes(1);
  });

  // @req ACCT-SIGNIN-05[badger-desktop]
  it("@req ACCT-SIGNIN-05[badger-desktop] says why when the provider sign-in came back with an error", async () => {
    localStorage.setItem(PROVIDER_VERIFIER_KEY, "kept-secret");
    bridge.held = { error: "email_unverified" };
    await render(<Login />);
    expect(h.completeProviderSignIn).not.toHaveBeenCalled();
    expect(container.textContent).toContain("login.provider.errors.email_unverified");
    expect(localStorage.getItem(PROVIDER_VERIFIER_KEY)).toBeNull();
  });

  // @req ACCT-SIGNIN-05[badger-desktop]
  it("@req ACCT-SIGNIN-05[badger-desktop] the sign-up screen moves to sign-in when an outcome comes back, without taking it", async () => {
    h.providers = ["google"];
    await render(<Signup />, "/signup");
    const takenBefore = bridge.takeReturn.mock.calls.length;
    await act(async () => {
      for (const nudge of bridge.nudges) nudge();
    });
    expect(h.navigate).toHaveBeenCalledWith("/login");
    expect(bridge.takeReturn.mock.calls.length).toBe(takenBefore);
  });
});
