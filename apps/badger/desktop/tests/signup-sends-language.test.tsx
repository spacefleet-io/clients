// @vitest-environment jsdom
/**
 * ACCT-EMAIL-01: the first email (the verification code) is written in the language the user registers in, so the
 * desktop sign-up page sends its current language with the sign-up. The page renders for real; the API is replaced.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "desktop-signup-sends-language";

const api = vi.hoisted(() => ({
  signup: vi.fn(async (..._args: unknown[]) => ({})),
  // Signup renders the provider sign-in rows (ProviderSignIn), which list the enabled providers.
  listSignInProviders: vi.fn(async () => ({ providers: [] as string[] })),
  ApiError: class ApiError extends Error {
    payload: { error?: string } = {};
  },
}));

vi.mock("../src/renderer/src/api", () => api);
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "fr" } }) }));

import Signup from "../src/renderer/src/pages/Signup";
import { showUiLanguage } from "../src/renderer/src/lib/accountUiLanguage";

const setValue = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

describe(`[${SUITE}] sign-up`, () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    api.signup.mockClear();
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const submit = async (tickNews: boolean) => {
    await act(async () => {
      root.render(
        <MemoryRouter>
          <Signup />
        </MemoryRouter>
      );
    });
    const email = container.querySelector<HTMLInputElement>('input[type="email"]')!;
    const passwords = container.querySelectorAll<HTMLInputElement>('input[type="password"]');
    const news = container.querySelector<HTMLInputElement>('[data-testid="signup-news-opt-in"]')!;
    console.info(`[${SUITE}] inputs: email=${Boolean(email)} passwords=${passwords.length} news=${news?.checked}`);
    expect(passwords).toHaveLength(2);
    // ACCT-NEWS-01: the News box starts unticked.
    expect(news.checked).toBe(false);
    await act(async () => {
      setValue(email, "new.user@example.com");
      setValue(passwords[0]!, "password123");
      setValue(passwords[1]!, "password123");
      if (tickNews) news.click();
    });
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    console.info(`[${SUITE}] signup calls: ${JSON.stringify(api.signup.mock.calls)}`);
  };

  // @req ACCT-EMAIL-01
  // @req ACCT-NEWS-01[badger-desktop]
  it("@req ACCT-EMAIL-01 sends the language the user registers in, and no News opt-in unless ticked", async () => {
    // The user picked French on this computer before signing up.
    showUiLanguage("fr");
    await submit(false);
    expect(api.signup).toHaveBeenCalledWith("new.user@example.com", "password123", "fr", false);
  });

  // @req ACCT-NEWS-01[badger-desktop]
  it("@req ACCT-NEWS-01 sends the News opt-in when the box is ticked", async () => {
    showUiLanguage("fr");
    await submit(true);
    expect(api.signup).toHaveBeenCalledWith("new.user@example.com", "password123", "fr", true);
  });
});
