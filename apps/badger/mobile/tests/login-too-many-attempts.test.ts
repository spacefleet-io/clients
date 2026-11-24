/**
 * ACCT-AUTH-11: when the API refuses a sign-in or a reset-code request for now (429 `rate_limited`, OPS-LIMIT-02/03),
 * the phone sign-in screen says "Too many attempts. Try again in N minutes.", N being `retryAfterSeconds` rounded up,
 * never "the server ran into a problem". The real LoginScreen and the shared sentences run through a real i18next;
 * shell components and native modules are host elements, the API is replaced.
 */
import { createElement, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import i18next, { type i18n as I18n } from "i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type * as SignInForm from "../../../../packages/mobile-shell/src/components/mobile-password-sign-in-form";
import type * as PasswordReset from "../../../../packages/mobile-shell/src/components/mobile-password-reset";
import type * as SharedApi from "@space/shared/api";
import { withSignInErrorTexts } from "@space/shared/signInError";

const h = vi.hoisted(() => {
  // Metro turns `require("../assets/mascot.webp")` into an image reference; plain node would parse the bytes as JS.
  const { extensions } = process.getBuiltinModule("node:module").createRequire(import.meta.url);
  extensions[".webp"] = (m) => {
    m.exports = 1;
  };
  return { i18n: null as I18n | null, login: vi.fn(), requestPasswordReset: vi.fn() };
});

vi.mock("react-native", () => ({
  BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
  Pressable: "Pressable",
  Text: "Text",
  View: "View",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
}));
vi.mock("lucide-react-native", () => ({ ArrowRight: "Icon", ChevronRight: "Icon", Lock: "Icon", Mail: "Icon", QrCode: "Icon" }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: vi.fn() }) }));
// The shared form and reset card are real (their words are under test); their inputs and buttons are host elements.
vi.mock("../../../../packages/mobile-shell/src/components/mobile-auth-form", () => ({
  MobileAuthInput: "MobileAuthInput",
  MobileAuthButton: "MobileAuthButton",
  MobileAuthLink: "MobileAuthLink",
}));
vi.mock("@space/mobile-shell/components", async () => {
  const passthrough = (name: string) => (props: { children?: ReactNode }) => createElement(name, props, props.children);
  const form = await vi.importActual<typeof SignInForm>("../../../../packages/mobile-shell/src/components/mobile-password-sign-in-form");
  const reset = await vi.importActual<typeof PasswordReset>("../../../../packages/mobile-shell/src/components/mobile-password-reset");
  return {
    MobilePasswordSignInForm: form.MobilePasswordSignInForm,
    useMobilePasswordSignIn: form.useMobilePasswordSignIn,
    MobilePasswordReset: reset.MobilePasswordReset,
    MobileStartupPage: passthrough("MobileStartupPage"),
    MobileAuthBrand: "MobileAuthBrand",
    MobileAuthInput: "MobileAuthInput",
    MobileAuthButton: "MobileAuthButton",
    MobileAuthLink: "MobileAuthLink",
    MobileApiHostModal: "MobileApiHostModal",
    MobileLanguageMenu: "MobileLanguageMenu",
    MobileAuthSettingsBar: passthrough("MobileAuthSettingsBar"),
    MobilePhoneSignInCard: "MobilePhoneSignInCard",
    MobileOrDivider: "MobileOrDivider",
    MobileProviderSignInRows: "MobileProviderSignInRows",
  };
});
// The Google, Apple and Microsoft rows (ACCT-SIGNIN-05) are covered by login-provider-sign-in.test.ts; none listed here.
vi.mock("@space/mobile-shell/provider-sign-in", () => ({
  useMobileProviderSignIn: () => ({ providers: [], busy: null, finishing: false, secondStep: null, start: vi.fn(), submitSecondStep: vi.fn() }),
}));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {} }));
vi.mock("@space/mobile-shell/theme", () => ({
  useMobileShellTheme: () => ({ colors: { accent: "#ffb357", text: "#fff", textMuted: "#aaa", bg: "#000", border: "#333", danger: "#f00" } }),
}));
vi.mock("@space/mobile-shell/i18n", () => ({
  getCurrentLanguage: () => h.i18n!.language,
  isMobileUiLanguage: () => true,
  MOBILE_UI_LANGUAGES: [{ code: "en", nativeName: "English", flag: "" }],
  useTranslation: () => ({ t: h.i18n!.t.bind(h.i18n) }),
}));
vi.mock("@space/shared/api", async () => ({
  ApiError: (await vi.importActual<typeof SharedApi>("@space/shared/api")).ApiError,
  requestPasswordReset: (...a: unknown[]) => h.requestPasswordReset(...a),
  confirmPasswordReset: vi.fn(),
  // The screen's import chain reaches the profile store (#3594), which binds these at load; never called here.
  listProfiles: vi.fn(),
  createProfile: vi.fn(),
  updateProfile: vi.fn(),
  deleteProfile: vi.fn(),
}));
vi.mock("../src/lib/apiConfig", () => ({ getStoredApiHost: async () => null, serverPickerAllowed: () => false, setStoredApiHost: vi.fn() }));
vi.mock("../src/store/auth", () => ({ useAuth: () => ({ login: h.login }) }));
vi.mock("@space/mobile-shell/logger", () => ({ scopeLogger: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined }) }));
vi.mock("../src/lib/uiLanguage", () => ({ chooseUiLanguage: vi.fn(), ensureI18n: async () => undefined }));
vi.mock("../src/tv/lib/tvRuntime", () => ({ IS_TV: false }));
// The sign-in sends the device's name (ACCT-DEV-01); its native lookups are not under test here.
vi.mock("../src/lib/phonePairing", () => ({ currentPhoneDeviceName: () => "Badger (phone)" }));
vi.mock("../src/setup/BadgerSetupFlow", () => ({ SignInSetupBack: () => null }));

import { ApiError } from "@space/shared/api";
import { LoginScreen } from "../src/screens/LoginScreen";

const SUITE = "MOBILE-LOGIN-TOO-MANY-ATTEMPTS";
const limited = (retryAfterSeconds: number) => new ApiError(429, { error: "rate_limited", retryAfterSeconds });
const texts = (tree: ReactTestRenderer) =>
  tree.root.findAll((n) => (n.type as unknown) === "Text").map((n) => [n.props.children].flat().join(""));
const byType = (tree: ReactTestRenderer, type: string) => tree.root.findAll((n) => n.type === type);

const render = async () => {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(createElement(LoginScreen));
  });
  return tree;
};

describe(`[${SUITE}] phone sign-in on a 429`, () => {
  beforeAll(async () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const i18n = i18next.createInstance();
    await i18n.init({
      lng: "en",
      fallbackLng: "en",
      interpolation: { escapeValue: false },
      resources: {
        en: { translation: withSignInErrorTexts({}, "en") },
        de: { translation: withSignInErrorTexts({}, "de") },
      },
    });
    h.i18n = i18n;
  });

  // @req ACCT-AUTH-11
  it("sign-in shows the wait in minutes, singular for one minute", async () => {
    h.login.mockRejectedValueOnce(limited(840));
    const tree = await render();
    // The shared form signs in only with both fields filled.
    await act(async () => {
      byType(tree, "MobileAuthInput")[0]!.props.onChangeText("pilot@example.test");
      byType(tree, "MobileAuthInput")[1]!.props.onChangeText("pw");
    });
    await act(async () => {
      byType(tree, "MobileAuthButton")[0]!.props.onPress();
    });
    console.info(`[${SUITE}] sign-in texts`, texts(tree));
    expect(texts(tree)).toContain("Too many attempts. Try again in 14 minutes.");

    await act(async () => {
      await h.i18n!.changeLanguage("de");
    });
    h.login.mockRejectedValueOnce(limited(30));
    await act(async () => {
      byType(tree, "MobileAuthButton")[0]!.props.onPress();
    });
    console.info(`[${SUITE}] sign-in texts (de, 30 s)`, texts(tree));
    expect(texts(tree)).toContain("Zu viele Versuche. Versuch es in 1 Minute nochmal.");
    await h.i18n!.changeLanguage("en");
  });

  // @req ACCT-AUTH-11
  it("the reset-code request says so too", async () => {
    h.requestPasswordReset.mockRejectedValueOnce(limited(600));
    const tree = await render();
    await act(async () => {
      byType(tree, "MobileAuthInput")[0]!.props.onChangeText("pilot@example.test");
    });
    await act(async () => {
      byType(tree, "MobileAuthLink")[0]!.props.onPress();
    });
    const resetButton = byType(tree, "MobileAuthButton").at(-1)!;
    await act(async () => {
      resetButton.props.onPress();
    });
    console.info(`[${SUITE}] reset texts`, texts(tree));
    expect(h.requestPasswordReset).toHaveBeenCalledWith("pilot@example.test");
    expect(texts(tree)).toContain("Too many attempts. Try again in 10 minutes.");
  });
});
