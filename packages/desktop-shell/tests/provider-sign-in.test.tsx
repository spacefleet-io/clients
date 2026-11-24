// @vitest-environment jsdom
/**
 * @req ACCT-SIGNIN-05 @req REL-FAM-03
 * The Google, Apple and Microsoft rows both desktop apps draw under the email form (`DesktopProviderSignIn`): only the
 * providers the app lists, an "or" line above them, titles in the window's language, a fresh secret kept under the key
 * both apps have always used, and the app's own refusal sentence or else the shared "could not start" one.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SignInProvider } from "@space/shared/api";
import { providerSignInTexts } from "@space/shared/providerSignIn";
import {
  DesktopProviderSignIn,
  PROVIDER_VERIFIER_KEY,
  providerVerifier,
  type DesktopProviderSignInProps,
  type ProviderSignInStart,
} from "../src/providerSignIn";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "[desktop-shell provider-sign-in.test]";
const log = (message: string, extra?: unknown) => console.info(SUITE, message, extra ?? "");
const sha256Base64url = (text: string) => createHash("sha256").update(text).digest("base64url");

describe("DesktopProviderSignIn", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onStarted = vi.fn();
  const onError = vi.fn();
  const start = vi.fn(async (_provider: SignInProvider, _challenge: string): Promise<ProviderSignInStart> => ({ ok: true }));

  beforeEach(() => {
    localStorage.clear();
    onStarted.mockClear();
    onError.mockClear();
    start.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  /** A fresh screen each time: the rows read the list once per mount. */
  const mount = async (props: Partial<DesktopProviderSignInProps> & { list: DesktopProviderSignInProps["list"] }) => {
    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => {
      root.render(<DesktopProviderSignIn language="en" mode="signIn" start={start} onStarted={onStarted} onError={onError} {...props} />);
    });
  };
  const rows = () => [...container.querySelectorAll<HTMLButtonElement>('[data-testid^="provider-sign-in-"][aria-label]')];
  const press = async (testId: string) => {
    await act(async () => {
      container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click();
    });
  };

  it("draws the listed providers in Google, Apple, Microsoft order under an 'or' line, titled in the window's language", async () => {
    const list = vi.fn(async (): Promise<SignInProvider[]> => ["microsoft", "google"]);
    await mount({ list, language: "fr" });
    const labels = rows().map((row) => row.getAttribute("aria-label"));
    log("rows", labels);
    expect(list).toHaveBeenCalledTimes(1);
    expect(labels).toEqual(["Se connecter avec Google", "Se connecter avec Microsoft"]);
    expect(container.querySelector('[data-testid="provider-sign-in-divider"]')?.textContent).toBe("ou");
  });

  it("titles the rows 'Sign up with …' on the sign-up screen and falls back to English for an unknown language", async () => {
    await mount({ list: async () => ["apple"], mode: "signUp", language: "pt" });
    expect(rows().map((row) => row.getAttribute("aria-label"))).toEqual(["Sign up with Apple"]);
  });

  it("draws nothing while no provider is listed, the list fails, or the app cannot sign in", async () => {
    await mount({ list: async () => [] });
    expect(container.querySelector('[data-testid="provider-sign-in"]')).toBeNull();
    await mount({ list: () => Promise.reject(new Error("offline")) });
    expect(container.querySelector('[data-testid="provider-sign-in"]')).toBeNull();
    await mount({ list: async () => ["google"], disabled: true });
    log("disabled html", container.innerHTML);
    expect(container.querySelector('[data-testid="provider-sign-in"]')).toBeNull();
  });

  it("keeps a fresh secret under the shared key and starts with its hash", async () => {
    await mount({ list: async () => ["apple"] });
    await press("provider-sign-in-apple");
    const kept = localStorage.getItem(PROVIDER_VERIFIER_KEY);
    log("start call", start.mock.calls[0]);
    expect(PROVIDER_VERIFIER_KEY).toBe("sf_provider_sign_in_verifier");
    expect(kept?.length).toBeGreaterThanOrEqual(43);
    expect(start).toHaveBeenCalledWith("apple", sha256Base64url(kept!));
    expect(onStarted).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(providerVerifier.read()).toBe(kept);
    providerVerifier.drop();
    expect(localStorage.getItem(PROVIDER_VERIFIER_KEY)).toBeNull();
  });

  it("shows the app's own refusal sentence, else the shared one, also when starting throws", async () => {
    await mount({ list: async () => ["google"], language: "de" });
    start.mockResolvedValueOnce({ ok: false, message: "Too many attempts." });
    await press("provider-sign-in-google");
    start.mockResolvedValueOnce({ ok: false });
    await press("provider-sign-in-google");
    start.mockRejectedValueOnce(new Error("bridge gone"));
    await press("provider-sign-in-google");
    log("errors", onError.mock.calls);
    expect(onError.mock.calls).toEqual([["Too many attempts."], [providerSignInTexts.de.errorStart], [providerSignInTexts.de.errorStart]]);
    expect(onStarted).not.toHaveBeenCalled();
  });
});
