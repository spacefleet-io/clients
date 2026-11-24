/**
 * UX-PHONE-05, UX-PHONE-10, ACCT-SIGNIN-04: the phone sign-in page opens on the email form, and the shared "Sign in with
 * another device" card under it opens the code sign-in screen, which is the shared page (`MobilePairSignIn`) Parrot's
 * phone shows too. The real LoginScreen and PairSignInScreen are rendered (shell components and native modules stubbed
 * as host elements).
 */
import { createElement, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type * as SignInForm from "../../../../packages/mobile-shell/src/components/mobile-password-sign-in-form";

const { navigate, goBack } = vi.hoisted(() => {
  // Metro turns `require("../assets/mascot.webp")` into an image reference; plain node would parse the bytes as JS.
  const { extensions } = process.getBuiltinModule("node:module").createRequire(import.meta.url);
  extensions[".webp"] = (m) => {
    m.exports = 1;
  };
  return { navigate: vi.fn(), goBack: vi.fn() };
});

vi.mock("react-native", () => ({
  BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
  Pressable: "Pressable",
  Text: "Text",
  View: "View",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
}));
vi.mock("lucide-react-native", () => ({ ArrowRight: "Icon", ChevronRight: "Icon", Lock: "Icon", Mail: "Icon", QrCode: "Icon" }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate, goBack }) }));
// The shared form is real (its fields are what the screen shows); its inputs and buttons are host elements.
vi.mock("../../../../packages/mobile-shell/src/components/mobile-auth-form", () => ({
  MobileAuthInput: "MobileAuthInput",
  MobileAuthButton: "MobileAuthButton",
  MobileAuthLink: "MobileAuthLink",
}));
vi.mock("@space/mobile-shell/components", async () => {
  const passthrough = (name: string) => (props: { children?: ReactNode }) => createElement(name, props, props.children);
  const form = await vi.importActual<typeof SignInForm>("../../../../packages/mobile-shell/src/components/mobile-password-sign-in-form");
  return {
    MobilePasswordSignInForm: form.MobilePasswordSignInForm,
    useMobilePasswordSignIn: form.useMobilePasswordSignIn,
    MobileStartupPage: passthrough("MobileStartupPage"),
    MobileAuthBrand: "MobileAuthBrand",
    MobileAuthInput: "MobileAuthInput",
    MobileAuthButton: "MobileAuthButton",
    MobileAuthLink: "MobileAuthLink",
    MobileApiHostModal: "MobileApiHostModal",
    MobileLanguageMenu: "MobileLanguageMenu",
    MobileAuthSettingsBar: passthrough("MobileAuthSettingsBar"),
    MobilePhoneSignInCard: ({ onPress, testID = "login-qr-card" }: { onPress: () => void; testID?: string }) =>
      createElement("Pressable", { testID, onPress }),
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
  getCurrentLanguage: () => "en",
  isMobileUiLanguage: () => true,
  MOBILE_UI_LANGUAGES: [{ code: "en", nativeName: "English" }],
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock("@space/shared/api", () => ({ ApiError: class extends Error {}, requestPasswordReset: vi.fn(), confirmPasswordReset: vi.fn() }));
vi.mock("@space/shared/signInError", () => ({
  classifySignInError: vi.fn(),
  signInErrorDetails: vi.fn(),
  signInErrorMessageKey: vi.fn(),
  signInErrorValues: () => ({ count: 15, minutes: 15 }),
  isRateLimited: () => false,
  TOO_MANY_ATTEMPTS_KEY: "login.errors.tooManyAttempts",
}));
vi.mock("../src/lib/apiConfig", () => ({ getStoredApiHost: async () => null, serverPickerAllowed: () => false, setStoredApiHost: vi.fn() }));
vi.mock("../src/store/auth", () => ({ useAuth: () => ({ login: async () => undefined }) }));
vi.mock("@space/mobile-shell/logger", () => ({ scopeLogger: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined }) }));
vi.mock("../src/lib/uiLanguage", () => ({ chooseUiLanguage: vi.fn(), ensureI18n: async () => undefined }));
vi.mock("../src/tv/lib/tvRuntime", () => ({ IS_TV: false }));
// The sign-in sends the device's name (ACCT-DEV-01); its native lookups are not under test here.
vi.mock("../src/lib/phonePairing", () => ({
  currentPhoneDeviceName: () => "Badger (phone)",
  createPhonePairingClient: vi.fn(),
  createPhoneCompletionDeps: vi.fn(),
  PHONE_PAIRING_LOG_TAG: "phone.pairing",
}));
// The shared page itself is covered by packages/mobile-shell/tests/mobile-pair-sign-in.test.tsx.
vi.mock("@space/mobile-shell/pair-sign-in", () => ({ MobilePairSignIn: "MobilePairSignIn" }));
vi.mock("@space/mobile-shell/pairing", () => ({ completePairing: vi.fn() }));
vi.mock("../src/setup/phoneSetupStore", () => ({ markPhoneSetupPaired: vi.fn() }));
// The setup step bar (UX-SETUP-03) has its own test (phone-setup-gate.test.ts).
vi.mock("../src/setup/BadgerSetupFlow", () => ({ SignInSetupBack: () => null }));

import { LoginScreen } from "../src/screens/LoginScreen";
import { PairSignInScreen } from "../src/screens/PairSignInScreen";

describe("phone sign-in: sign in with a code", () => {
  beforeAll(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  });

  /** @req UX-PHONE-05 @req ACCT-SIGNIN-04[badger-mobile] */
  it("opens on the email form, and pressing the QR card opens the code sign-in screen", async () => {
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(createElement(LoginScreen));
    });
    expect(tree.root.findAll((n) => String(n.type) === "MobileAuthInput").length).toBeGreaterThanOrEqual(2);
    const card = tree.root.find((n) => n.props.testID === "login-qr-card" && typeof n.type === "string");
    await act(async () => {
      card.props.onPress();
    });
    expect(navigate).toHaveBeenCalledWith("PairSignIn");
  });

  /**
   * @req UX-PHONE-10[badger-mobile]
   * @bugfix @regression-proof Chris 2026-11-18: Badger's and Parrot's phones showed different "Sign in with another
   * device" pages; Badger's screen is now the shared page, whose Back goes back to the form.
   */
  it("the code sign-in screen is the shared page", async () => {
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(createElement(PairSignInScreen));
    });
    const page = tree.root.find((n) => String(n.type) === "MobilePairSignIn");
    expect(page.props.app).toBe("badger");
    expect(page.props.deviceName).toBe("Badger (phone)");
    expect(page.props.onUsePassword).toBeUndefined();
    page.props.onBack();
    expect(goBack).toHaveBeenCalled();
  });
});
