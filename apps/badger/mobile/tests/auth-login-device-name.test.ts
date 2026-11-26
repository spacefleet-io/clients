/**
 * @test-id MOBILE-AUTH-LOGIN-DEVICE-NAME-001
 * @level component
 * @why Phone walk 2026-11-12: after an email and password sign-in, the account's device list called the phone "Phone"
 *   instead of its model, because the sign-in sent no device name. It now sends the name and type the QR sign-in gives
 *   ("Badger (ONEPLUS A6003)", mobile). The real LoginScreen and phone naming; the auth store's login is a spy.
 */
// @req ACCT-DEV-01[badger-mobile]
import { createElement, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import i18next, { type i18n as I18n } from "i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";
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
  Platform: { OS: "android", isTV: false, constants: { Model: "ONEPLUS A6003" } },
}));
vi.mock("@space/mobile-shell/pairing", () => ({ createPairingCompletionDeps: () => ({}) }));
vi.mock("../src/lib/crypto", () => ({ decryptBase64ToBytes: () => new Uint8Array() }));
vi.mock("../src/lib/onboarding", () => ({ setLibraryKeyAcknowledged: async () => undefined, setStoredLibraryKey: async () => undefined }));
vi.mock("lucide-react-native", () => ({ ArrowRight: "Icon", ChevronRight: "Icon", Lock: "Icon", Mail: "Icon", QrCode: "Icon" }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: vi.fn() }) }));
vi.mock("@space/mobile-shell/components", () => {
  const passthrough = (name: string) => (props: { children?: ReactNode }) => createElement(name, props, props.children);
  return {
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
vi.mock("../src/setup/BadgerSetupFlow", () => ({ SignInSetupBack: () => null }));

import { LoginScreen } from "../src/screens/LoginScreen";

const byType = (tree: ReactTestRenderer, type: string) => tree.root.findAll((n) => n.type === type);

describe("phone email sign-in", () => {
  beforeAll(async () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const i18n = i18next.createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: withSignInErrorTexts({}, "en") } } });
    h.i18n = i18n;
  });

  it("@req ACCT-DEV-01 names the phone by its model in the account's device list", async () => {
    h.login.mockResolvedValueOnce(undefined);
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(createElement(LoginScreen));
    });
    await act(async () => {
      byType(tree, "MobileAuthInput")[0]!.props.onChangeText("pilot@example.test");
      byType(tree, "MobileAuthInput")[1]!.props.onChangeText("pw");
    });
    await act(async () => {
      byType(tree, "MobileAuthButton")[0]!.props.onPress();
    });
    console.info("[MOBILE-AUTH-LOGIN-DEVICE-NAME-001] login args", JSON.stringify(h.login.mock.calls));
    expect(h.login).toHaveBeenCalledWith("pilot@example.test", "pw", undefined, { deviceType: "mobile", deviceName: "Badger (ONEPLUS A6003)" });
  });
});
