/**
 * @test-id PARROT-MOBILE-LOGIN-TOO-MANY-ATTEMPTS-001
 * @level unit
 * @req ACCT-AUTH-11
 * @why When the API refuses a sign-in for now (429 `rate_limited`, OPS-LIMIT-02), the Parrot phone sign-in says "Too
 *   many attempts. Try again in N minutes." (N = `retryAfterSeconds` rounded up), not "the server ran into a problem".
 *   The real LoginScreen and the shared sentences run through a real i18next; shell components and native modules are
 *   host elements, the API is replaced.
 */
import { createElement, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import i18next, { type i18n as I18n } from "i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type * as SharedApi from "@space/shared/api";
import { withSignInErrorTexts } from "@space/shared/signInError";

const h = vi.hoisted(() => ({ i18n: null as I18n | null, login: vi.fn() }));

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  Text: "Text",
  View: "View",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
}));
vi.mock("lucide-react-native", () => ({ ArrowRight: "Icon", Lock: "Icon", Mail: "Icon" }));
vi.mock("@space/mobile-shell/components", () => {
  const passthrough = (name: string) => (props: { children?: ReactNode }) => createElement(name, props, props.children);
  return {
    MobileStartupPage: passthrough("MobileStartupPage"),
    MobileAuthBrand: "MobileAuthBrand",
    MobileAuthInput: "MobileAuthInput",
    MobileAuthButton: "MobileAuthButton",
    MobileAuthLink: "MobileAuthLink",
    MobileAuthSettingsBar: passthrough("MobileAuthSettingsBar"),
    MobileLanguageMenu: "MobileLanguageMenu",
    MobilePasswordReset: "MobilePasswordReset",
    MobilePhoneSignInCard: "MobilePhoneSignInCard",
    MobileOrDivider: "MobileOrDivider",
    MobileProviderSignInRows: "MobileProviderSignInRows",
  };
});
vi.mock("@space/mobile-shell/provider-sign-in", () => ({
  useMobileProviderSignIn: () => ({ providers: [], busy: null, finishing: false, secondStep: null, start: vi.fn(), submitSecondStep: vi.fn() }),
}));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {} }));
vi.mock("@space/mobile-shell/theme", () => ({
  useMobileShellTheme: () => ({ colors: { accent: "#3ddc84", text: "#fff", textMuted: "#aaa", bg: "#000", border: "#333", danger: "#f00" } }),
}));
vi.mock("@space/mobile-shell/i18n", () => ({
  getCurrentLanguage: () => h.i18n!.language,
  isMobileUiLanguage: () => true,
  MOBILE_UI_LANGUAGES: [{ code: "en", nativeName: "English", flag: "" }],
  useTranslation: () => ({ t: h.i18n!.t.bind(h.i18n) }),
}));
vi.mock("@space/mobile-shell/setup-step", () => ({ MobileSetupHeader: "MobileSetupHeader" }));
vi.mock("@space/mobile-shell/logger", () => ({ scopeLogger: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined }) }));
vi.mock("@space/mobile-shell/pairing-device", () => ({ currentPhoneDeviceName: (app: string) => `${app} (test)` }));
vi.mock("@space/shared/api", async () => ({
  ApiError: (await vi.importActual<typeof SharedApi>("@space/shared/api")).ApiError,
  login: (...a: unknown[]) => h.login(...a),
}));
vi.mock("../src/state/session", () => ({ useSession: () => ({ signIn: async () => undefined, signInNotice: null }) }));
vi.mock("../src/lib/i18n", () => ({ setParrotLanguage: async () => undefined }));
vi.mock("../src/brand", () => ({ PARROT_MASCOT: 1 }));
vi.mock("../src/screens/PairingPanel", () => ({ PairingPanel: "PairingPanel" }));

import { ApiError } from "@space/shared/api";
import { LoginScreen } from "../src/screens/LoginScreen";

const say = (line: string, extra?: unknown) => console.info(`[PARROT-MOBILE-LOGIN-TOO-MANY-ATTEMPTS-001] ${line}`, extra ?? "");
// The mocks render shell components as host elements named by a string; the renderer types `type` as an ElementType.
const hosts = (tree: ReactTestRenderer, name: string) => tree.root.findAll((n) => String(n.type) === name);
const texts = (tree: ReactTestRenderer) => hosts(tree, "Text").map((n) => [n.props.children].flat().join(""));

describe("Parrot phone sign-in on a 429", () => {
  beforeAll(async () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const i18n = i18next.createInstance();
    await i18n.init({
      lng: "es",
      fallbackLng: "en",
      interpolation: { escapeValue: false },
      resources: { en: { translation: withSignInErrorTexts({}, "en") }, es: { translation: withSignInErrorTexts({}, "es") } },
    });
    h.i18n = i18n;
  });

  it("says how many minutes to wait, in the app language", async () => {
    h.login.mockRejectedValueOnce(new ApiError(429, { error: "rate_limited", retryAfterSeconds: 420 }));
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(createElement(LoginScreen));
    });
    const inputs = hosts(tree, "MobileAuthInput");
    await act(async () => {
      inputs[0]!.props.onChangeText("pilot@example.test");
      inputs[1]!.props.onChangeText("secret-password");
    });
    await act(async () => {
      hosts(tree, "MobileAuthButton")[0]!.props.onPress();
    });
    say("texts", texts(tree));
    expect(h.login).toHaveBeenCalledTimes(1);
    expect(texts(tree)).toContain("Demasiados intentos. Vuelve a intentarlo en 7 minutos.");
  });
});
