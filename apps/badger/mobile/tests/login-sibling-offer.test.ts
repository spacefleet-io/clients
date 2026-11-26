/**
 * @test-id MOBILE-LOGIN-SIBLING-OFFER-001
 * @level unit
 * @req ACCT-PAIR-07[badger-mobile]
 * @why When Parrot is signed in on the same phone, Badger's sign-in page offers "Continue with your Parrot account"
 *   ABOVE the email form, and that sign-in ends exactly like "Sign in with another device": the same pairing client,
 *   the same completion (key check, library unlock), and the setup's key step marked done. The real LoginScreen is
 *   rendered; the offer is a host element whose props are checked and driven.
 */
import { createElement, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type * as SignInForm from "@space/mobile-shell/password-sign-in-form";

const SUITE = "[login-sibling-offer]";

const ctl = vi.hoisted(() => ({
  setSession: vi.fn(),
  createClient: vi.fn(),
  completePairing: vi.fn(),
  markPaired: vi.fn(),
}));

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
// The shared form is real (its fields are what the screen shows); its inputs and buttons are host elements.
vi.mock("@space/mobile-shell/auth-form", () => ({
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
vi.mock("../src/store/auth", () => ({ useAuth: () => ({ login: async () => undefined, setSession: ctl.setSession }) }));
vi.mock("@space/mobile-shell/logger", () => ({ scopeLogger: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined }) }));
vi.mock("../src/lib/uiLanguage", () => ({ chooseUiLanguage: vi.fn(), ensureI18n: async () => undefined }));
vi.mock("../src/tv/lib/tvRuntime", () => ({ IS_TV: false }));
// The sign-in sends the device's name (ACCT-DEV-01); its native lookups are not under test here.
vi.mock("../src/lib/phonePairing", () => ({
  currentPhoneDeviceName: () => "Badger (phone)",
  createPhonePairingClient: ctl.createClient,
  createPhoneCompletionDeps: (setSession: unknown) => ({ setSession }),
  PHONE_PAIRING_LOG_TAG: "phone.pairing",
}));
vi.mock("@space/mobile-shell/pairing", () => ({ completePairing: ctl.completePairing }));
vi.mock("../src/setup/phoneSetupStore", () => ({ markPhoneSetupPaired: ctl.markPaired }));
// The offer itself has its own tests in mobile-shell: here, only how the sign-in page wires it.
vi.mock("@space/mobile-shell/sibling-ui", () => ({ MobileSiblingOffer: "MobileSiblingOffer" }));
// The shared "Sign in with another device" page is covered by packages/mobile-shell/tests/mobile-pair-sign-in.test.tsx.
vi.mock("@space/mobile-shell/pair-sign-in", () => ({ MobilePairSignIn: "MobilePairSignIn" }));
// The setup's Back footer (UX-SETUP-03) has its own test (phone-setup-gate.test.ts).
vi.mock("../src/setup/BadgerSetupFlow", () => ({ SignInSetupBack: () => null }));

import { LoginScreen } from "../src/screens/LoginScreen";

type Offer = {
  app: string;
  enabled: boolean;
  createClient: () => unknown;
  complete: (approved: unknown) => Promise<{ ok: boolean }>;
};

const render = async () => {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(createElement(LoginScreen));
  });
  return tree;
};

describe("Badger phone sign-in: continue with the Parrot account", () => {
  beforeAll(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  });

  it("shows the offer above the email form, for Badger, with the phone pairing client", async () => {
    const tree = await render();
    const offer = tree.root.find((n) => String(n.type) === "MobileSiblingOffer");
    const props = offer.props as Offer;
    console.info(SUITE, { app: props.app, enabled: props.enabled });
    expect(props.app).toBe("badger");
    expect(props.enabled).toBe(true);
    ctl.createClient.mockReturnValue("phone-client");
    expect(props.createClient()).toBe("phone-client");
    const order = tree.root.findAll((n) => String(n.type) === "MobileSiblingOffer" || String(n.type) === "MobileAuthInput").map((n) => String(n.type));
    expect(order[0]).toBe("MobileSiblingOffer");
  });

  it("finishes like a paired sign-in and marks the setup's key step done", async () => {
    ctl.completePairing.mockResolvedValue({ ok: true });
    const tree = await render();
    const props = tree.root.find((n) => String(n.type) === "MobileSiblingOffer").props as Offer;
    const approved = { status: "approved", token: "t", user: { id: "u1", email: "ada@example.com" }, libraryKey: "k" };
    const result = await props.complete(approved);
    console.info(SUITE, "complete", result);
    expect(result).toEqual({ ok: true });
    expect(ctl.completePairing).toHaveBeenCalledWith({ setSession: ctl.setSession }, approved);
    expect(ctl.markPaired).toHaveBeenCalledTimes(1);
  });

  it("leaves the setup untouched when the completion fails", async () => {
    ctl.completePairing.mockResolvedValue({ ok: false, reason: "key_mismatch" });
    const tree = await render();
    const props = tree.root.find((n) => String(n.type) === "MobileSiblingOffer").props as Offer;
    await props.complete({ status: "approved" });
    expect(ctl.markPaired).not.toHaveBeenCalled();
  });
});
