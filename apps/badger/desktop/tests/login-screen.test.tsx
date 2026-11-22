// @vitest-environment jsdom
/**
 * The Badger desktop sign-in screen (ACCT-SIGNIN-01..04): the language button is always at the top right, the server
 * picker only in a development build, and the screen always opens on the email form with a highlighted "Sign in with
 * another device" card under an "or" line that opens the shared PairWithPhone flow.
 *
 * @req ACCT-SIGNIN-01[badger-desktop]
 * @req ACCT-SIGNIN-02[badger-desktop]
 * @req ACCT-SIGNIN-03[badger-desktop]
 * @req ACCT-SIGNIN-04[badger-desktop]
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Login from "../src/renderer/src/pages/Login";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "login-screen";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
vi.mock("../src/renderer/src/auth", () => ({
  useAuth: () => ({ login: vi.fn(), systemIssue: null, setSession: vi.fn() }),
}));
vi.mock("@space/ui", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  LanguageMenu: ({ ariaLabel }: { ariaLabel?: string }) => <button data-testid="language-menu">{ariaLabel}</button>,
}));
vi.mock("@space/desktop-shell/components", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  PairWithPhone: ({ onBack }: { onBack: () => void }) => (
    <div data-testid="pair-with-phone">
      <button data-testid="use-email" onClick={onBack}>
        email
      </button>
    </div>
  ),
  ApiHostSettingsButton: () => <button data-testid="server-picker">server</button>,
}));

/** The preload bridge the Login page reads (`window.sf`); jsdom has none. */
const setSf = (value: unknown) => Object.assign(window, { sf: value });

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  setSf({ pairing: {} });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllEnvs();
  Reflect.deleteProperty(window, "sf");
});

const q = (testId: string) => container.querySelector(`[data-testid="${testId}"]`);

const renderLogin = (label: string) => {
  act(() =>
    root.render(
      <MemoryRouter initialEntries={["/login"]}>
        <Login />
      </MemoryRouter>,
    ),
  );
  console.info(
    `[${SUITE}:${label}] language=${q("language-menu") !== null} picker=${q("server-picker") !== null} card=${q("phone-sign-in-card") !== null} pair=${q("pair-with-phone") !== null} email=${container.querySelector("#email") !== null}`,
  );
};

describe("Badger desktop sign-in screen", () => {
  it("a release build: language button, no server picker", () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_SF_DEV_TICKET_KEY", "");
    renderLogin("release");
    expect(q("language-menu")).not.toBeNull();
    expect(q("server-picker")).toBeNull();
  });

  it("a dev build: language button and the server picker", () => {
    vi.stubEnv("DEV", true);
    renderLogin("dev");
    expect(q("language-menu")).not.toBeNull();
    expect(q("server-picker")).not.toBeNull();
  });

  it("opens on the email form, with the highlighted phone card under an 'or' line", () => {
    renderLogin("default");
    expect(container.querySelector("#email")).not.toBeNull();
    expect(container.querySelector("#password")).not.toBeNull();
    expect(q("pair-with-phone")).toBeNull();
    expect(q("sign-in-divider")?.textContent).toBe("or");
    const card = q("phone-sign-in-card");
    expect(card?.tagName).toBe("BUTTON");
    expect(card?.textContent).toContain("Sign in with another device");
    expect(card?.textContent).toContain("Scan a QR code with Badger or Parrot on another signed-in device. Nothing to type.");
    // The card comes after the password form's Sign in button.
    const submit = container.querySelector('button[type="submit"], form button:not([type])');
    expect(submit?.compareDocumentPosition(card!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("the card opens the phone sign-in, and 'use email' comes back to the form", () => {
    renderLogin("card");
    act(() => (q("phone-sign-in-card") as HTMLButtonElement).click());
    expect(q("pair-with-phone")).not.toBeNull();
    expect(container.querySelector("#email")).toBeNull();
    expect(q("language-menu")).not.toBeNull();
    act(() => (q("use-email") as HTMLButtonElement).click());
    console.info(`[${SUITE}:card] back email=${container.querySelector("#email") !== null}`);
    expect(container.querySelector("#email")).not.toBeNull();
    expect(q("phone-sign-in-card")).not.toBeNull();
  });

  it("a leftover SF_LOGIN_METHOD=pair or loginMethod on the bridge no longer opens on the QR code", () => {
    vi.stubEnv("SF_LOGIN_METHOD", "pair");
    setSf({ pairing: {}, loginMethod: "pair" });
    renderLogin("pair-method");
    expect(q("pair-with-phone")).toBeNull();
    expect(container.querySelector("#email")).not.toBeNull();
  });

  it("without the pairing bridge there is no phone card", () => {
    setSf({});
    renderLogin("no-bridge");
    expect(q("phone-sign-in-card")).toBeNull();
    expect(q("sign-in-divider")).toBeNull();
  });

  /** @req ACCT-PAIR-07 Parrot signed in on this computer: "Continue with your Parrot account" above the email form. */
  it("Parrot signed in on this computer: the same-device card sits above the email form", async () => {
    const sibling = {
      offer: vi.fn(async () => ({ app: "parrot", email: "lane@example.test" })),
      signIn: vi.fn(async () => ({ status: "cancelled" })),
      cancel: vi.fn(async () => undefined),
    };
    setSf({ pairing: {}, sibling });
    renderLogin("sibling");
    await act(async () => {
      await Promise.resolve();
    });
    const card = q("same-device-sign-in-card");
    console.info(`[${SUITE}:sibling] card=${card !== null} text=${card?.textContent ?? ""}`);
    expect(card?.textContent).toContain("Continue with your Parrot account");
    expect(q("same-device-sign-in-icon")?.getAttribute("src")).toContain("parrot-app-icon");
    expect(card?.compareDocumentPosition(container.querySelector("#email")!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  /** @req ACCT-PAIR-07 Without the bridge (an older preload) nothing is offered. */
  it("without the sibling bridge there is no same-device card", () => {
    renderLogin("no-sibling");
    expect(q("same-device-sign-in-card")).toBeNull();
  });
});
