/**
 * @test-id PARROT-MOBILE-LOGIN-DEFAULT-001
 * @level unit
 * @req ACCT-SIGNIN-04[parrot]
 * @why Chris 2026-11-12: every client but the TV defaults to "the login/password screen with the option to use the qr
 *   code to log in with an already logged in device, not the other way around". The real LoginScreen is rendered
 *   (shell components and native modules stubbed as host elements): it opens on the email form with the shared
 *   highlighted card under it; the card swaps in the pairing panel, and "Sign in with email and password" comes back.
 */
import { createElement, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeAll, describe, expect, it, vi } from "vitest";

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
    MobilePhoneSignInCard: ({ onPress, testID = "login-qr-card" }: { onPress: () => void; testID?: string }) =>
      createElement("Pressable", { testID, onPress }),
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
  getCurrentLanguage: () => "en",
  isMobileUiLanguage: () => true,
  MOBILE_UI_LANGUAGES: [{ code: "en", nativeName: "English" }],
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock("@space/mobile-shell/setup-step", () => ({ MobileSetupHeader: "MobileSetupHeader" }));
vi.mock("@space/mobile-shell/logger", () => ({ scopeLogger: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined }) }));
vi.mock("@space/mobile-shell/pairing-device", () => ({ currentPhoneDeviceName: (app: string) => `${app} (test)` }));
vi.mock("@space/shared/api", () => ({ ApiError: class extends Error {}, login: vi.fn() }));
vi.mock("@space/shared/signInError", () => ({
  classifySignInError: vi.fn(),
  signInErrorDetails: vi.fn(),
  signInErrorMessageKey: vi.fn(),
  signInErrorValues: vi.fn(),
}));
vi.mock("../src/state/session", () => ({ useSession: () => ({ signIn: async () => undefined, signInNotice: null }) }));
vi.mock("../src/lib/i18n", () => ({ setParrotLanguage: async () => undefined }));
vi.mock("../src/brand", () => ({ PARROT_MASCOT: 1 }));
vi.mock("../src/screens/PairingPanel", () => ({ PairingPanel: "PairingPanel" }));

import { LoginScreen } from "../src/screens/LoginScreen";

const say = (line: string, extra?: unknown) => console.info(`[PARROT-MOBILE-LOGIN-DEFAULT-001] ${line}`, extra ?? "");

describe("Parrot phone sign-in: the form first, the QR card second", () => {
  beforeAll(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  });

  const host = (tree: ReactTestRenderer, testID: string) => tree.root.findAll((n) => n.props.testID === testID && typeof n.type === "string");
  const panels = (tree: ReactTestRenderer) => tree.root.findAll((n) => String(n.type) === "PairingPanel");

  it("opens on the email form with the highlighted card; the card shows the QR and 'use password' comes back", async () => {
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(createElement(LoginScreen));
    });
    const inputs = tree.root.findAll((n) => String(n.type) === "MobileAuthInput");
    say("first view", { inputs: inputs.length, card: host(tree, "login-qr-card").length, panel: panels(tree).length });
    expect(inputs.length).toBeGreaterThanOrEqual(2);
    expect(host(tree, "login-qr-card")).toHaveLength(1);
    expect(panels(tree)).toHaveLength(0);

    await act(async () => {
      host(tree, "login-qr-card")[0].props.onPress();
    });
    expect(panels(tree)).toHaveLength(1);
    expect(tree.root.findAll((n) => String(n.type) === "MobileAuthInput")).toHaveLength(0);

    await act(async () => {
      host(tree, "sign-in-use-password")[0].props.onPress();
    });
    expect(panels(tree)).toHaveLength(0);
    expect(host(tree, "login-qr-card")).toHaveLength(1);
  });
});
