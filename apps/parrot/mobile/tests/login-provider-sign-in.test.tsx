/**
 * @test-id PARROT-MOBILE-LOGIN-PROVIDER-SIGNIN-001
 * @level unit
 * @req ACCT-SIGNIN-05[parrot]
 * @req ACCT-SIGNIN-07[parrot]
 * @why ACCT-SIGNIN-05 / ACCT-SIGNIN-07 on the Parrot phone: under the email form, the sign-in screen draws an "or" line
 *   and the Google, Apple and Microsoft buttons the server offers, each a 54 square named "Sign in with …" with the
 *   provider's name captioned under it; a button opens the provider in the browser with the SHA-256 of a stored secret,
 *   and the browser's way back (`parrot://auth/provider?...`, handed over by App.tsx) trades the code and the secret for
 *   a session, asks for the account's second step, or says why there is no sign-in. The real LoginScreen and the real
 *   buttons are rendered; native modules are host stand-ins.
 */
import { createHash } from "node:crypto";
import { createElement } from "react";
import type { ReactNode } from "react";
import { act, create } from "react-test-renderer";
import type { ReactTestInstance, ReactTestRenderer } from "react-test-renderer";
import i18next from "i18next";
import type { i18n as I18n } from "i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as SharedApi from "@space/shared/api";
import type * as ProviderRows from "../../../../packages/mobile-shell/src/components/mobile-provider-sign-in-rows";
import { withSignInErrorTexts } from "@space/shared/signInError";
import en from "../../../../packages/mobile-shell/src/i18n/en.json";
import parrotEn from "../src/i18n/en.json";

const h = vi.hoisted(() => ({
  i18n: null as I18n | null,
  store: new Map<string, string>(),
  openURL: vi.fn(),
  signIn: vi.fn(),
  listSignInProviders: vi.fn(),
  startProviderSignIn: vi.fn(),
  completeProviderSignIn: vi.fn(),
}));

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  Text: "Text",
  View: "View",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
  Linking: { openURL: (...a: unknown[]) => h.openURL(...a), addEventListener: () => ({ remove: () => undefined }), getInitialURL: async () => null },
}));
vi.mock("react-native-svg", () => ({ default: "Svg", Path: "Path", Rect: "Rect" }));
vi.mock("lucide-react-native", () => ({ ArrowRight: "Icon", Lock: "Icon", Mail: "Icon" }));
vi.mock("@space/mobile-shell/components", async () => {
  const passthrough = (name: string) => (props: { children?: ReactNode }) => createElement(name, props, props.children);
  // The real rows: their order, testIDs and sizes are what is under test (ACCT-SIGNIN-07).
  const rows = await vi.importActual<typeof ProviderRows>("../../../../packages/mobile-shell/src/components/mobile-provider-sign-in-rows");
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
    MobileProviderSignInRows: rows.MobileProviderSignInRows,
  };
});
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => h.store.get(key) ?? null,
    setItem: async (key: string, value: string) => void h.store.set(key, value),
    removeItem: async (key: string) => void h.store.delete(key),
  },
}));
vi.mock("@space/mobile-shell/theme", () => ({
  useMobileShellTheme: () => ({ colors: { accent: "#3ddc84", text: "#fff", textMuted: "#aaa", bg: "#000", border: "#333", danger: "#f00" } }),
}));
vi.mock("@space/mobile-shell/i18n", () => ({
  getCurrentLanguage: () => h.i18n!.language,
  isMobileUiLanguage: () => true,
  MOBILE_UI_LANGUAGES: [{ code: "en", nativeName: "English", flag: "" }],
  useTranslation: () => ({ t: h.i18n!.t.bind(h.i18n) }),
}));
vi.mock("@space/mobile-shell/setup-step", () => ({ MobileSetupBackFooter: "MobileSetupBackFooter" }));
vi.mock("@space/mobile-shell/logger", () => ({
  scopeLogger: (scope: string) => ({
    info: (event: string, data?: unknown) => console.info(`[${scope}] ${event}`, data ?? ""),
    warn: (event: string, data?: unknown) => console.info(`[${scope}] WARN ${event}`, data ?? ""),
    error: (event: string, data?: unknown) => console.info(`[${scope}] ERROR ${event}`, data ?? ""),
  }),
}));
vi.mock("@space/mobile-shell/pairing-device", () => ({ currentPhoneDeviceName: (app: string) => `${app} (Pixel 8)` }));
vi.mock("@space/shared/api", async () => ({
  ApiError: (await vi.importActual<typeof SharedApi>("@space/shared/api")).ApiError,
  login: vi.fn(),
  listSignInProviders: (...a: unknown[]) => h.listSignInProviders(...a),
  startProviderSignIn: (...a: unknown[]) => h.startProviderSignIn(...a),
  completeProviderSignIn: (...a: unknown[]) => h.completeProviderSignIn(...a),
}));
vi.mock("../src/state/session", () => ({ useSession: () => ({ signIn: h.signIn, signInNotice: null }) }));
vi.mock("../src/lib/i18n", () => ({ setParrotLanguage: async () => undefined }));
vi.mock("../src/brand", () => ({ PARROT_MASCOT: 1 }));
// The shared "Sign in with another device" page (UX-PHONE-10) is covered by packages/mobile-shell/tests/mobile-pair-sign-in.test.tsx.
vi.mock("@space/mobile-shell/pair-sign-in", () => ({ MobilePairSignIn: "MobilePairSignIn" }));
vi.mock("@space/mobile-shell/pairing", () => ({ completePairing: vi.fn() }));
vi.mock("../src/setup/pairing", () => ({
  createParrotCompletionDeps: vi.fn(),
  createParrotPairingClient: vi.fn(),
  PARROT_PAIRING_LOG_TAG: "parrot.pairing",
}));

import { ApiError } from "@space/shared/api";
import { handOffProviderReturn, PROVIDER_VERIFIER_KEY } from "@space/mobile-shell/provider-sign-in";
import { LoginScreen } from "../src/screens/LoginScreen";

const SUITE = "PARROT-MOBILE-LOGIN-PROVIDER-SIGNIN";
const CODE = "handoffCode_0123456789abcdef";
const USER = { id: "u1", email: "listener@example.test" };
const SESSION = { token: "session-token", user: { id: "u1", email: "listener@example.test", emailVerified: false } };

const texts = (tree: ReactTestRenderer) =>
  tree.root.findAll((n) => String(n.type) === "Text").map((n) => [n.props.children].flat().join(""));
const byType = (tree: ReactTestRenderer, type: string) => tree.root.findAll((n) => n.type === type);
const byTestId = (tree: ReactTestRenderer, testID: string) => tree.root.findAll((n) => n.props.testID === testID && typeof n.type === "string");
const rowIds = (tree: ReactTestRenderer) =>
  tree.root
    .findAll((n) => String(n.type) === "Pressable" && typeof n.props.testID === "string" && n.props.testID.startsWith("provider-sign-in-"))
    .map((n: ReactTestInstance) => n.props.testID as string);
const flat = (style: unknown) => Object.assign({}, ...[style].flat(Infinity).filter(Boolean)) as Record<string, unknown>;
const sha256url = (value: string) => createHash("sha256").update(value).digest("base64url");

const render = async () => {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(createElement(LoginScreen));
  });
  return tree;
};

/** App.tsx's link handler, as it runs for every link Parrot receives. */
const deliver = async (url: string) => {
  let handled = false;
  await act(async () => {
    handled = handOffProviderReturn("parrot", url);
  });
  return handled;
};

describe(`[${SUITE}] Google, Apple and Microsoft on the Parrot phone`, () => {
  beforeAll(async () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const i18n = i18next.createInstance();
    await i18n.init({
      lng: "en",
      fallbackLng: "en",
      interpolation: { escapeValue: false },
      resources: { en: { translation: { ...withSignInErrorTexts(en, "en"), ...parrotEn } } },
    });
    h.i18n = i18n;
  });

  beforeEach(() => {
    h.store.clear();
    h.signIn.mockReset();
    h.completeProviderSignIn.mockReset();
    h.startProviderSignIn.mockReset();
    h.listSignInProviders.mockResolvedValue({ providers: ["microsoft", "apple", "google"] });
    h.startProviderSignIn.mockResolvedValue({ url: "https://accounts.google.test/o/oauth2/auth?state=s" });
    h.openURL.mockResolvedValue(undefined);
    h.signIn.mockResolvedValue(undefined);
  });

  afterEach(() => {
    console.info(`[${SUITE}] verifier stored after test:`, h.store.has(PROVIDER_VERIFIER_KEY));
  });

  // @req ACCT-SIGNIN-05[parrot]
  it("@req ACCT-SIGNIN-05[parrot] draws no rows and no divider when the server offers no provider", async () => {
    h.listSignInProviders.mockResolvedValue({ providers: [] });
    const tree = await render();
    console.info(`[${SUITE}] rows (none listed)`, rowIds(tree));
    expect(rowIds(tree)).toEqual([]);
    expect(byType(tree, "MobileOrDivider")).toHaveLength(0);
    expect(byType(tree, "MobileAuthInput").length).toBeGreaterThanOrEqual(2);
  });

  // @req ACCT-SIGNIN-05[parrot]
  it("@req ACCT-SIGNIN-05[parrot] the email form, then the 'or' line, then buttons in Google, Apple, Microsoft order", async () => {
    const tree = await render();
    console.info(`[${SUITE}] rows`, rowIds(tree), texts(tree));
    expect(rowIds(tree)).toEqual(["provider-sign-in-google", "provider-sign-in-apple", "provider-sign-in-microsoft"]);
    expect(rowIds(tree).map((id) => byTestId(tree, id)[0]!.props.accessibilityLabel)).toEqual([
      "Sign in with Google",
      "Sign in with Apple",
      "Sign in with Microsoft",
    ]);
    expect(texts(tree)).toEqual(expect.arrayContaining(["Google", "Apple", "Microsoft"]));
    const divider = byType(tree, "MobileOrDivider")[0]!;
    expect(divider.props).toMatchObject({ label: "or", testID: "provider-sign-in-divider" });
    // Document order: the email fields, the divider, then the buttons.
    const order = tree.root
      .findAll((n) => ["MobileOrDivider", "MobileAuthInput"].includes(String(n.type)) || (String(n.type) === "Pressable" && n.props.testID === "provider-sign-in-google"))
      .map((n) => (String(n.type) === "Pressable" ? "rows" : String(n.type)));
    console.info(`[${SUITE}] order`, order);
    expect(order.slice(0, 4)).toEqual(["MobileAuthInput", "MobileAuthInput", "MobileOrDivider", "rows"]);
  });

  // @req ACCT-SIGNIN-05[parrot]
  it("@req ACCT-SIGNIN-05[parrot] 'Forgot password?' sits with the email form, under its button and before the 'or' line", async () => {
    const tree = await render();
    const order = tree.root
      .findAll((n) => ["MobileAuthButton", "MobileOrDivider"].includes(String(n.type)) || (String(n.type) === "MobileAuthLink" && /forgot/i.test(String(n.props.label))))
      .map((n) => (String(n.type) === "MobileAuthLink" ? `forgot:${n.props.label}` : String(n.type)));
    console.info(`[${SUITE}] forgot order`, order);
    expect(order).toEqual(["MobileAuthButton", expect.stringMatching(/^forgot:/), "MobileOrDivider"]);
  });

  // @req ACCT-SIGNIN-07[parrot]
  it("@req ACCT-SIGNIN-07[parrot] each button is a 54 square with radius 13, the name captioned under it; Apple's is black", async () => {
    const tree = await render();
    for (const id of rowIds(tree)) {
      const style = flat(byTestId(tree, id)[0]!.props.style);
      const caption = byTestId(tree, `${id}-caption`)[0]!;
      console.info(`[${SUITE}] ${id} button`, style, "caption", flat(caption.props.style));
      expect(style).toMatchObject({ width: 54, height: 54, borderRadius: 13, borderColor: "#444a5b" });
      expect(flat(caption.props.style)).toMatchObject({ fontSize: 13 });
    }
    expect(flat(byTestId(tree, "provider-sign-in-apple")[0]!.props.style).backgroundColor).toBe("#000000");
  });

  // @req ACCT-SIGNIN-05[parrot]
  it("@req ACCT-SIGNIN-05[parrot] a row starts at parrot://auth/provider with the hash of a stored secret and opens the browser", async () => {
    const tree = await render();
    await act(async () => {
      byTestId(tree, "provider-sign-in-google")[0]!.props.onPress();
    });
    const [provider, body] = h.startProviderSignIn.mock.calls[0]!;
    const verifier = h.store.get(PROVIDER_VERIFIER_KEY);
    console.info(`[${SUITE}] start`, provider, { ...body, clientChallenge: "<hash>" }, "verifier stored:", Boolean(verifier));
    expect(provider).toBe("google");
    expect(body).toMatchObject({ returnTo: "parrot://auth/provider", surface: "phone", uiLanguage: "en" });
    expect(verifier).toBeTruthy();
    expect(body.clientChallenge).toBe(sha256url(verifier!));
    expect(h.openURL).toHaveBeenCalledWith("https://accounts.google.test/o/oauth2/auth?state=s");
    expect(texts(tree)).toContain(en.login.provider.continueInBrowser);
  });

  // @req ACCT-SIGNIN-05[parrot]
  it("@req ACCT-SIGNIN-05[parrot] the way back trades the code and the secret for a Parrot session", async () => {
    h.completeProviderSignIn.mockResolvedValue({ token: "session-token", user: USER });
    await render();
    h.store.set(PROVIDER_VERIFIER_KEY, "stored-verifier");
    expect(await deliver(`parrot://auth/provider?signinCode=${CODE}`)).toBe(true);
    console.info(`[${SUITE}] complete args`, h.completeProviderSignIn.mock.calls[0]?.slice(2));
    expect(h.completeProviderSignIn).toHaveBeenCalledWith(CODE, "stored-verifier", undefined, undefined, {
      deviceType: "mobile",
      deviceName: "Parrot (Pixel 8)",
    });
    expect(h.signIn).toHaveBeenCalledWith(SESSION);
    expect(h.store.has(PROVIDER_VERIFIER_KEY)).toBe(false);
  });

  // @req ACCT-SIGNIN-05[parrot]
  it("@req ACCT-SIGNIN-05[parrot] a link that came before the screen (cold start) is finished once it mounts", async () => {
    h.completeProviderSignIn.mockResolvedValue({ token: "session-token", user: USER });
    h.store.set(PROVIDER_VERIFIER_KEY, "stored-verifier");
    expect(handOffProviderReturn("parrot", `parrot://auth/provider?signinCode=${CODE}`)).toBe(true);
    await render();
    expect(h.signIn).toHaveBeenCalledWith(SESSION);
    expect(handOffProviderReturn("parrot", "spacebadger://auth/provider?signinCode=" + CODE)).toBe(false);
  });

  // @req ACCT-SIGNIN-05[parrot]
  it("@req ACCT-SIGNIN-05[parrot] an account with a second step asks for it and sends the same code with it", async () => {
    h.completeProviderSignIn
      .mockRejectedValueOnce(new ApiError(401, { error: "two_factor_required", method: "email" }))
      .mockResolvedValueOnce({ token: "session-token", user: USER });
    const tree = await render();
    h.store.set(PROVIDER_VERIFIER_KEY, "stored-verifier");
    await deliver(`parrot://auth/provider?signinCode=${CODE}`);
    console.info(`[${SUITE}] after two_factor_required`, texts(tree));
    expect(texts(tree)).toContain(en.login.infoEmail);
    const field = byTestId(tree, "login-two-factor")[0]!;
    expect(field.props.placeholder).toBe(parrotEn.parrot.login.codeEmail);
    await act(async () => {
      field.props.onChangeText(" 123456 ");
    });
    await act(async () => {
      byTestId(tree, "login-submit")[0]!.props.onPress();
    });
    console.info(`[${SUITE}] second completion args`, h.completeProviderSignIn.mock.calls[1]?.slice(2));
    expect(h.completeProviderSignIn).toHaveBeenLastCalledWith(CODE, "stored-verifier", "123456", undefined, expect.anything());
    expect(h.signIn).toHaveBeenCalledWith(SESSION);
  });

  // @req ACCT-SIGNIN-05[parrot]
  it("@req ACCT-SIGNIN-05[parrot] an email with no account says so in words (the phone creates none) and drops the secret", async () => {
    const tree = await render();
    // Even with the pairing panel open, the answer brings the form back with the words.
    await act(async () => {
      byTestId(tree, "login-qr-card")[0]!.props.onPress();
    });
    h.store.set(PROVIDER_VERIFIER_KEY, "stored-verifier");
    await deliver("parrot://auth/provider?signinError=no_account");
    console.info(`[${SUITE}] no_account texts`, texts(tree));
    expect(texts(tree)).toContain(en.login.provider.errors.no_account);
    expect(byType(tree, "MobilePairSignIn")).toHaveLength(0);
    expect(h.completeProviderSignIn).not.toHaveBeenCalled();
    expect(h.store.has(PROVIDER_VERIFIER_KEY)).toBe(false);
  });
});
