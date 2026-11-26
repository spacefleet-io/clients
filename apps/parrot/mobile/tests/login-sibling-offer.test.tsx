/**
 * @test-id PARROT-MOBILE-LOGIN-SIBLING-OFFER-001
 * @level unit
 * @req ACCT-PAIR-07[parrot]
 * @why When Badger is signed in on the same phone, Parrot's sign-in page offers "Continue with your Badger account"
 *   ABOVE the email form, and that sign-in ends exactly like "Sign in with another device": the same pairing client,
 *   the same completion (key check, key stored), the key step skipped, then the session. The real LoginScreen and
 *   SiblingOffer are rendered; the shared offer is a host element whose props are checked and driven.
 */
import { createElement, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type * as SignInForm from "@space/mobile-shell/password-sign-in-form";

const SUITE = "[PARROT-MOBILE-LOGIN-SIBLING-OFFER-001]";

const ctl = vi.hoisted(() => ({
  signIn: vi.fn(),
  createClient: vi.fn(),
  completePairing: vi.fn(),
}));

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  Text: "Text",
  View: "View",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
}));
vi.mock("lucide-react-native", () => ({ ArrowRight: "Icon", Lock: "Icon", Mail: "Icon" }));
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
vi.mock("@space/mobile-shell/setup-step", () => ({ MobileSetupBackFooter: "MobileSetupBackFooter" }));
vi.mock("@space/mobile-shell/logger", () => ({ scopeLogger: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined }) }));
vi.mock("@space/mobile-shell/pairing-device", () => ({ currentPhoneDeviceName: (app: string) => `${app} (test)` }));
vi.mock("@space/shared/api", () => ({ ApiError: class extends Error {}, login: vi.fn() }));
vi.mock("@space/shared/signInError", () => ({
  classifySignInError: vi.fn(),
  signInErrorDetails: vi.fn(),
  signInErrorMessageKey: vi.fn(),
  signInErrorValues: vi.fn(),
}));
vi.mock("../src/state/session", () => ({ useSession: () => ({ signIn: ctl.signIn, signInNotice: null }) }));
vi.mock("../src/lib/i18n", () => ({ setParrotLanguage: async () => undefined }));
vi.mock("../src/brand", () => ({ PARROT_MASCOT: 1 }));
vi.mock("@space/mobile-shell/pair-sign-in", () => ({ MobilePairSignIn: "MobilePairSignIn" }));
// LoginScreen's half: the offer is a host element here; SiblingOffer's own wiring is checked below with the real one.
vi.mock("@space/mobile-shell/sibling-ui", () => ({ MobileSiblingOffer: "MobileSiblingOffer" }));
vi.mock("@space/mobile-shell/pairing", () => ({ completePairing: ctl.completePairing }));
vi.mock("../src/setup/pairing", () => ({
  createParrotPairingClient: ctl.createClient,
  createParrotCompletionDeps: (setSession: unknown) => ({ setSession }),
  PARROT_PAIRING_LOG_TAG: "parrot.pairing",
}));

import { LoginScreen } from "../src/screens/LoginScreen";

type Offer = {
  app: string;
  createClient: () => unknown;
  complete: (approved: unknown) => Promise<unknown>;
};

const render = async (onPaired?: () => Promise<void>) => {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(createElement(LoginScreen, { onPaired }));
  });
  return tree;
};

describe("Parrot phone sign-in: continue with the Badger account", () => {
  beforeAll(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  });

  it("shows the offer above the email form, for Parrot, with Parrot's pairing client", async () => {
    const tree = await render();
    const props = tree.root.find((n) => String(n.type) === "MobileSiblingOffer").props as Offer;
    const order = tree.root.findAll((n) => String(n.type) === "MobileSiblingOffer" || String(n.type) === "MobileAuthInput").map((n) => String(n.type));
    console.info(SUITE, { app: props.app, order });
    expect(props.app).toBe("parrot");
    expect(order[0]).toBe("MobileSiblingOffer");
    ctl.createClient.mockReturnValue("parrot-client");
    expect(props.createClient()).toBe("parrot-client");
  });

  it("finishes like a paired sign-in: the key step marked done, then the session", async () => {
    const steps: string[] = [];
    const onPaired = async () => void steps.push("paired");
    ctl.signIn.mockImplementation(async () => void steps.push("signIn"));
    ctl.completePairing.mockImplementation(async (deps: { setSession: (token: string, user: unknown) => Promise<void> }) => {
      await deps.setSession("t", { id: "u1", email: "ada@example.com", emailVerified: true });
      return { ok: true };
    });
    const tree = await render(onPaired);
    const props = tree.root.find((n) => String(n.type) === "MobileSiblingOffer").props as Offer;
    const result = await props.complete({ status: "approved" });
    console.info(SUITE, "complete", { result, steps });
    expect(result).toEqual({ ok: true });
    expect(steps).toEqual(["paired", "signIn"]);
    expect(ctl.signIn).toHaveBeenCalledWith({ token: "t", user: { id: "u1", email: "ada@example.com", emailVerified: true } });
  });

  it("hides with the form when the QR sign-in is open", async () => {
    const tree = await render();
    await act(async () => {
      tree.root.find((n) => n.props.testID === "login-qr-card" && typeof n.type === "string").props.onPress();
    });
    expect(tree.root.findAll((n) => String(n.type) === "MobileSiblingOffer")).toHaveLength(0);
  });
});
