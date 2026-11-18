// @vitest-environment jsdom
/**
 * UX-I18N-07: the app language is the account's. Right after a sign-in (`setSession`: login, sign-up, pairing) this
 * computer's language is reconciled with the account's, asking which one when they differ; a restored session and
 * every `/auth/me` refresh show the account's language; a language picked while signed in is saved to the account.
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth, type AuthContextValue } from "../src/renderer/src/auth";
import { deviceUiLanguageNow, pickUiLanguage, showUiLanguage } from "../src/renderer/src/lib/accountUiLanguage";
import type { User } from "../src/renderer/src/api";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "auth-account-language";

const api = vi.hoisted(() => ({
  getMe: vi.fn(),
  updateSettings: vi.fn(),
  getSystemContract: vi.fn(async () => null),
  getSystemContractIssue: vi.fn(() => null),
  login: vi.fn(),
  logout: vi.fn(async () => undefined),
  setApiBaseUrl: vi.fn(),
}));

vi.mock("../src/renderer/src/api", () => api);
vi.mock("@space/desktop-shell/services/runtime-status", () => ({ useRuntimeInstanceId: () => 1 }));
vi.mock("@/lib/clientReset", () => ({ resetClientStorage: vi.fn(async () => undefined) }));
vi.mock("@/lib/routePersistence", () => ({ clearLastAuthenticatedRoute: vi.fn() }));
vi.mock("@/lib/metadataTickets", () => ({
  setMetadataUrlOverride: vi.fn(),
  startMetadataTicketsAfterKeyStep: vi.fn(() => () => undefined),
  stopMetadataTickets: vi.fn(async () => undefined),
}));
vi.mock("@/logger", () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { rendererLogger: { child: () => log, ...log } };
});

const settle = async (ms = 0) => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
};

describe("AuthProvider account language (UX-I18N-07)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let auth: AuthContextValue | null = null;

  const Capture = () => {
    auth = useAuth();
    return null;
  };

  const mount = async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <AuthProvider>
          <Capture />
        </AuthProvider>,
      );
    });
    await settle();
  };

  const signIn = async (user: Record<string, unknown>) => {
    await act(async () => {
      auth?.setSession("tok-new", user as unknown as User);
    });
    await settle();
  };

  const dialog = () => document.querySelector('[data-testid="account-language-dialog"]');
  const click = async (testId: string) => {
    const button = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    if (!button) throw new Error(`no ${testId}; body=${document.body.innerHTML.slice(0, 500)}`);
    await act(async () => {
      button.click();
    });
    await settle();
  };

  beforeEach(() => {
    localStorage.clear();
    showUiLanguage("en");
    api.getMe.mockReset();
    api.updateSettings.mockReset();
    api.updateSettings.mockResolvedValue({ user: {} });
    (window as unknown as { sf?: unknown }).sf = undefined;
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    auth = null;
    container?.remove();
    container = null;
  });

  it("a restored session shows the account's language, asks nothing and sends nothing", async () => {
    localStorage.setItem("sf_client_token", "tok-1");
    api.getMe.mockResolvedValue({ user: { id: "u1", email: "a@b.c", uiLanguage: "fr" } });
    await mount();
    console.info(`[${SUITE}:restored] shown=${deviceUiLanguageNow()} patches=${JSON.stringify(api.updateSettings.mock.calls)}`);
    expect(deviceUiLanguageNow()).toBe("fr");
    expect(dialog()).toBeNull();
    expect(api.updateSettings).not.toHaveBeenCalled();
  });

  it("a sign-in into an account without a language gives it this computer's", async () => {
    await mount();
    await signIn({ id: "u1", email: "a@b.c" });
    console.info(`[${SUITE}:adopt] patches=${JSON.stringify(api.updateSettings.mock.calls)}`);
    expect(dialog()).toBeNull();
    expect(api.updateSettings).toHaveBeenCalledWith("tok-new", { preferences: { uiLanguage: "en" } });
    expect(deviceUiLanguageNow()).toBe("en");
  });

  it("a sign-in into an account in another language asks which one; the computer's applies to the account", async () => {
    await mount();
    await signIn({ id: "u1", email: "a@b.c", uiLanguage: "de" });
    console.info(`[${SUITE}:ask-device] dialog=${dialog()?.textContent ?? "none"} shown=${deviceUiLanguageNow()}`);
    expect(dialog()?.textContent).toContain("Which language do you want?");
    expect(dialog()?.textContent).toContain("Deutsch");
    // Not switched to the account's language while the question is open.
    expect(deviceUiLanguageNow()).toBe("en");
    await click("account-language-device");
    expect(dialog()).toBeNull();
    expect(api.updateSettings).toHaveBeenCalledTimes(1);
    expect(api.updateSettings).toHaveBeenCalledWith("tok-new", { preferences: { uiLanguage: "en" } });
    expect(deviceUiLanguageNow()).toBe("en");
  });

  it("picking the account's language in the question shows it here and sends nothing", async () => {
    await mount();
    await signIn({ id: "u1", email: "a@b.c", uiLanguage: "de" });
    await click("account-language-account");
    console.info(`[${SUITE}:ask-account] shown=${deviceUiLanguageNow()} patches=${api.updateSettings.mock.calls.length}`);
    expect(dialog()).toBeNull();
    expect(api.updateSettings).not.toHaveBeenCalled();
    expect(deviceUiLanguageNow()).toBe("de");
  });

  it("a language picked while signed in goes to the account; one picked signed out stays on the computer", async () => {
    await mount();
    pickUiLanguage("nl");
    await settle();
    expect(api.updateSettings).not.toHaveBeenCalled();
    expect(deviceUiLanguageNow()).toBe("nl");

    await signIn({ id: "u1", email: "a@b.c", uiLanguage: "nl" });
    expect(api.updateSettings).not.toHaveBeenCalled();
    await act(async () => {
      pickUiLanguage("es");
    });
    await settle();
    console.info(`[${SUITE}:pick] patches=${JSON.stringify(api.updateSettings.mock.calls)}`);
    expect(api.updateSettings).toHaveBeenCalledTimes(1);
    expect(api.updateSettings).toHaveBeenCalledWith("tok-new", { preferences: { uiLanguage: "es" } });
    expect(deviceUiLanguageNow()).toBe("es");
  });
});
