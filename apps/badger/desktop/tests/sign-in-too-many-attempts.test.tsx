// @vitest-environment jsdom
/**
 * ACCT-AUTH-11: when the API refuses a sign-in, sign-up or code email for now (429 `rate_limited`, OPS-LIMIT-02/03),
 * the Badger desktop account screens say "Too many attempts. Try again in N minutes." (N = `retryAfterSeconds`
 * rounded up), never "the server ran into a problem". The real pages and the shared sentences run through a real
 * i18next; the API is replaced.
 *
 * @req ACCT-AUTH-11
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import i18next, { type i18n as I18n } from "i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@space/shared/api";
import { withSignInErrorTexts } from "@space/shared/signInError";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "badger-desktop-too-many-attempts";

const h = vi.hoisted(() => ({
  i18n: null as I18n | null,
  login: vi.fn(),
  signup: vi.fn(),
  resendVerification: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: h.i18n!.t.bind(h.i18n), i18n: h.i18n }),
}));
vi.mock("../src/renderer/src/auth", () => ({
  useAuth: () => ({ login: h.login, systemIssue: null, setSession: vi.fn() }),
}));
vi.mock("../src/renderer/src/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  signup: (...a: unknown[]) => h.signup(...a),
  resendVerification: (...a: unknown[]) => h.resendVerification(...a),
}));
vi.mock("@space/ui", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  LanguageMenu: () => null,
}));
vi.mock("@space/desktop-shell/components", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  PairWithPhone: () => null,
  ApiHostSettingsButton: () => null,
}));

import Login from "../src/renderer/src/pages/Login";
import Signup from "../src/renderer/src/pages/Signup";
import VerifyEmail from "../src/renderer/src/pages/VerifyEmail";

const limited = (retryAfterSeconds: number) => new ApiError(429, { error: "rate_limited", retryAfterSeconds });

const setValue = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

let container: HTMLDivElement;
let root: Root;

const render = async (node: React.ReactNode, path: string) => {
  await act(async () => {
    root.render(
      <MemoryRouter key={path} initialEntries={[path]}>
        {node}
      </MemoryRouter>,
    );
  });
};
const submitForm = async () => {
  await act(async () => {
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
};
const shown = (screen: string) => {
  const text = container.textContent ?? "";
  console.info(`[${SUITE}] ${screen} lang=${h.i18n!.language} text=${JSON.stringify(text.slice(0, 400))}`);
  return text;
};

beforeAll(async () => {
  const i18n = i18next.createInstance();
  await i18n.init({
    lng: "en",
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    resources: {
      en: { translation: withSignInErrorTexts({}, "en") },
      fr: { translation: withSignInErrorTexts({}, "fr") },
    },
  });
  h.i18n = i18n;
});

beforeEach(async () => {
  for (const fn of [h.login, h.signup, h.resendVerification]) fn.mockReset();
  await h.i18n!.changeLanguage("en");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  Object.assign(window, { sf: { pairing: {} } });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  Reflect.deleteProperty(window, "sf");
});

describe(`[${SUITE}] Badger desktop account screens on a 429`, () => {
  it("sign-in says how many minutes to wait, singular for one minute", async () => {
    h.login.mockRejectedValueOnce(limited(840));
    await render(<Login />, "/login");
    await submitForm();
    expect(shown("login")).toContain("Too many attempts. Try again in 14 minutes.");

    await h.i18n!.changeLanguage("fr");
    h.login.mockRejectedValueOnce(limited(12));
    await render(<Login />, "/login?fr");
    await submitForm();
    expect(shown("login-fr")).toContain("Trop de tentatives. Réessayez dans 1 minute.");
  });

  it("sign-up says so too", async () => {
    h.signup.mockRejectedValueOnce(limited(3000));
    await render(<Signup />, "/signup");
    const email = container.querySelector<HTMLInputElement>('input[type="email"]')!;
    const passwords = container.querySelectorAll<HTMLInputElement>('input[type="password"]');
    await act(async () => {
      setValue(email, "new.user@example.com");
      setValue(passwords[0]!, "password123!A");
      setValue(passwords[1]!, "password123!A");
    });
    await submitForm();
    expect(h.signup).toHaveBeenCalledTimes(1);
    expect(shown("signup")).toContain("Too many attempts. Try again in 50 minutes.");
  });

  it("the verification code resend says so too", async () => {
    h.resendVerification.mockRejectedValueOnce(limited(600));
    await render(<VerifyEmail />, "/verify?email=pilot%40example.test");
    const resend = [...container.querySelectorAll("button")].find((b) => b.textContent === "verifyEmail.resend")!;
    await act(async () => {
      resend.click();
      await Promise.resolve();
    });
    expect(shown("verify-resend")).toContain("Too many attempts. Try again in 10 minutes.");
  });
});
