/**
 * UX-PHONE-05, ACCT-SIGNIN-04: the phone sign-in page opens on the email form, and the shared "Sign in with another
 * device" card under it opens the code sign-in screen. The real LoginScreen is rendered (shell components and native
 * modules stubbed as host elements) and the card is pressed.
 */
import { createElement, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeAll, describe, expect, it, vi } from "vitest";

const navigate = vi.hoisted(() => {
  // Metro turns `require("../assets/mascot.webp")` into an image reference; plain node would parse the bytes as JS.
  const { extensions } = process.getBuiltinModule("node:module").createRequire(import.meta.url);
  extensions[".webp"] = (m) => {
    m.exports = 1;
  };
  return vi.fn();
});

vi.mock("react-native", () => ({
  BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
  Pressable: "Pressable",
  Text: "Text",
  View: "View",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
}));
vi.mock("lucide-react-native", () => ({ ArrowRight: "Icon", ChevronRight: "Icon", Lock: "Icon", Mail: "Icon", QrCode: "Icon" }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate }) }));
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
vi.mock("../src/lib/phonePairing", () => ({ currentPhoneDeviceName: () => "Badger (phone)" }));
vi.mock("../src/tv/lib/pairingRuntime", () => ({ tvDeviceName: () => "TV" }));
// The setup step bar (UX-SETUP-03) has its own test (phone-setup-gate.test.ts).
vi.mock("../src/setup/BadgerSetupFlow", () => ({ SetupStepBar: () => null }));

import { LoginScreen } from "../src/screens/LoginScreen";

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
});
