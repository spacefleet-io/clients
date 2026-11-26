/**
 * @test-id BADGER-LOGIN-PHONE-KEYBOARD-001
 * @level unit
 * @bugfix @regression-proof
 * @why On a Pixel 8 (2026-11-13) the phone sign-in form gave the keyboard no way from the email to the password: the
 *   email's action key was Done (it closed the keyboard and the focus jumped to Back), so the password could only be
 *   reached by touch. Tapping it at its keyboard-down spot after the form had lifted for the keyboard hit "Forgot
 *   password?" and the password was typed on into the email field. On the phone, as on TV, the email's Next moves the
 *   keyboard to the password and the password's Done signs in. The real LoginScreen is rendered (shell components
 *   stubbed as host elements) and the keyboard's action keys are pressed.
 * @req UX-PHONE-08[badger-mobile]
 */
import { createElement, type ReactNode } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type * as SignInForm from "@space/mobile-shell/password-sign-in-form";

const login = vi.hoisted(() => {
  // Metro turns `require("../assets/mascot.webp")` into an image reference; plain node would parse the bytes as JS.
  const { extensions } = process.getBuiltinModule("node:module").createRequire(import.meta.url);
  extensions[".webp"] = (m) => {
    m.exports = 1;
  };
  return vi.fn(async () => undefined);
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
    MobilePhoneSignInCard: "MobilePhoneSignInCard",
  };
});
vi.mock("@space/mobile-shell/theme", () => ({
  useMobileShellTheme: () => ({ colors: { accent: "#ffb357", text: "#fff", textMuted: "#aaa", bg: "#000", border: "#333", danger: "#f00" } }),
}));
vi.mock("@space/mobile-shell/i18n", () => ({
  getCurrentLanguage: () => "en",
  isMobileUiLanguage: () => true,
  MOBILE_UI_LANGUAGES: [{ code: "en", nativeName: "English" }],
  useTranslation: () => ({ t: (k: string) => k }),
}));
// listSignInProviders: the provider rows (#2437) ask for the enabled providers on mount; none here.
// listProfiles, createProfile, updateProfile, deleteProfile: the screen's import chain reaches the profile store (#3594),
// which binds them at load; never called here.
vi.mock("@space/shared/api", () => ({
  ApiError: class extends Error {},
  requestPasswordReset: vi.fn(),
  confirmPasswordReset: vi.fn(),
  listSignInProviders: async () => ({ providers: [] }),
  listProfiles: vi.fn(),
  createProfile: vi.fn(),
  updateProfile: vi.fn(),
  deleteProfile: vi.fn(),
}));
vi.mock("@space/shared/signInError", () => ({
  classifySignInError: vi.fn(),
  signInErrorDetails: vi.fn(),
  signInErrorMessageKey: vi.fn(),
  signInErrorValues: () => ({ count: 15, minutes: 15 }),
  isRateLimited: () => false,
  TOO_MANY_ATTEMPTS_KEY: "login.errors.tooManyAttempts",
}));
vi.mock("../src/lib/apiConfig", () => ({ getStoredApiHost: async () => null, serverPickerAllowed: () => false, setStoredApiHost: vi.fn() }));
vi.mock("../src/store/auth", () => ({ useAuth: () => ({ login }) }));
vi.mock("@space/mobile-shell/logger", () => ({ scopeLogger: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined }) }));
vi.mock("../src/lib/uiLanguage", () => ({ chooseUiLanguage: vi.fn(), ensureI18n: async () => undefined }));
vi.mock("../src/tv/lib/tvRuntime", () => ({ IS_TV: false }));
vi.mock("../src/lib/phonePairing", () => ({ currentPhoneDeviceName: () => "Badger (phone)" }));
vi.mock("../src/setup/BadgerSetupFlow", () => ({ SignInSetupBack: () => null }));

import { LoginScreen } from "../src/screens/LoginScreen";

const field = (tree: ReactTestRenderer, testID: string): ReactTestInstance =>
  tree.root.find((n) => String(n.type) === "MobileAuthInput" && n.props.testID === testID);

describe("phone sign-in: the keyboard walks the form", () => {
  beforeAll(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  });

  /** @req UX-PHONE-08[badger-mobile] */
  it("moves from the email to the password with Next, and signs in with Done on the password", async () => {
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(createElement(LoginScreen));
    });
    const email = field(tree, "login-email");
    const password = field(tree, "login-password");
    for (const n of [email, password]) {
      console.log(`[login-phone-keyboard] field ${String(n.props.testID)} returnKeyType=${String(n.props.returnKeyType)} onSubmitEditing=${typeof n.props.onSubmitEditing} inputRef=${n.props.inputRef ? "set" : "none"}`);
    }

    expect(email.props.returnKeyType).toBe("next");
    expect(email.props.onSubmitEditing).toBeTypeOf("function");
    const focus = vi.fn();
    const passwordRef = password.props.inputRef as { current: unknown } | undefined;
    expect(passwordRef).toBeDefined();
    if (passwordRef) passwordRef.current = { focus };
    await act(async () => {
      email.props.onChangeText("pilot@example.test");
      email.props.onSubmitEditing();
    });
    console.log("[login-phone-keyboard] password focus() calls after Next on the email:", focus.mock.calls.length);
    expect(focus).toHaveBeenCalledTimes(1);

    expect(password.props.returnKeyType).toBe("done");
    await act(async () => {
      field(tree, "login-password").props.onChangeText("pw");
    });
    await act(async () => {
      field(tree, "login-password").props.onSubmitEditing();
    });
    console.log("[login-phone-keyboard] login calls after Done on the password:", JSON.stringify(login.mock.calls.map((c) => c.slice(0, 2))));
    expect(login).toHaveBeenCalledTimes(1);
    expect(login.mock.calls[0]?.slice(0, 2)).toEqual(["pilot@example.test", "pw"]);
  });
});
