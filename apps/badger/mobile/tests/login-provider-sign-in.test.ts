/**
 * @test-id MOBILE-LOGIN-PROVIDER-SIGNIN-001
 * @level unit
 *
 * ACCT-SIGNIN-05 / ACCT-SIGNIN-07 on the Badger phone: under the email form, the sign-in screen draws an "or" line and
 * the Google, Apple and Microsoft buttons the server offers (none on the TV), a button opens the provider in the browser with the SHA-256 of a
 * stored secret, and the browser's way back (`spacebadger://auth/provider?...`, handed over by the navigator) trades the
 * code and the secret for a session, asks for the account's second step, or says why there is no sign-in.
 */
import { createHash } from "node:crypto";
import { createElement, type ReactNode } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import i18next, { type i18n as I18n } from "i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as SharedApi from "@space/shared/api";
import type * as ProviderRows from "../../../../packages/mobile-shell/src/components/mobile-provider-sign-in-rows";
import { withSignInErrorTexts } from "@space/shared/signInError";
import en from "../../../../packages/mobile-shell/src/i18n/en.json";

const h = vi.hoisted(() => {
  // Metro turns `require("../assets/mascot.webp")` into an image reference; plain node would parse the bytes as JS.
  const { extensions } = process.getBuiltinModule("node:module").createRequire(import.meta.url);
  extensions[".webp"] = (m) => {
    m.exports = 1;
  };
  return {
    i18n: null as I18n | null,
    isTv: false,
    store: new Map<string, string>(),
    openURL: vi.fn(),
    setSession: vi.fn(),
    listSignInProviders: vi.fn(),
    startProviderSignIn: vi.fn(),
    completeProviderSignIn: vi.fn(),
  };
});

// vi.mock factories are hoisted above static imports, so the shared stand-in is reached by import() (tests/setup).
vi.mock("react-native", async () => ({
  ...(await import("./setup/reactNativeMock")).reactNativeBase(),
  Linking: { openURL: (...a: unknown[]) => h.openURL(...a), addEventListener: () => ({ remove: () => undefined }), getInitialURL: async () => null },
}));
vi.mock("lucide-react-native", () => ({ ArrowRight: "Icon", ChevronRight: "Icon", Lock: "Icon", Mail: "Icon", QrCode: "Icon" }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: vi.fn() }) }));
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
    MobileApiHostModal: "MobileApiHostModal",
    MobileLanguageMenu: "MobileLanguageMenu",
    MobileAuthSettingsBar: passthrough("MobileAuthSettingsBar"),
    MobilePhoneSignInCard: "MobilePhoneSignInCard",
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
  requestPasswordReset: vi.fn(),
  confirmPasswordReset: vi.fn(),
  listSignInProviders: (...a: unknown[]) => h.listSignInProviders(...a),
  startProviderSignIn: (...a: unknown[]) => h.startProviderSignIn(...a),
  completeProviderSignIn: (...a: unknown[]) => h.completeProviderSignIn(...a),
}));
vi.mock("../src/lib/apiConfig", () => ({ getStoredApiHost: async () => null, serverPickerAllowed: () => false, setStoredApiHost: vi.fn() }));
vi.mock("../src/store/auth", () => ({ useAuth: () => ({ login: vi.fn(), setSession: h.setSession }) }));
vi.mock("@space/mobile-shell/logger", () => ({
  scopeLogger: (scope: string) => ({
    info: (event: string, data?: unknown) => console.info(`[${scope}] ${event}`, data ?? ""),
    warn: (event: string, data?: unknown) => console.info(`[${scope}] WARN ${event}`, data ?? ""),
    error: (event: string, data?: unknown) => console.info(`[${scope}] ERROR ${event}`, data ?? ""),
  }),
}));
vi.mock("../src/lib/uiLanguage", () => ({ chooseUiLanguage: vi.fn(), ensureI18n: async () => undefined }));
vi.mock("../src/tv/lib/tvRuntime", () => ({
  get IS_TV() {
    return h.isTv;
  },
}));
vi.mock("../src/lib/phonePairing", () => ({ currentPhoneDeviceName: () => "Badger (Pixel 8)" }));
vi.mock("../src/tv/lib/pairingRuntime", () => ({ tvDeviceName: () => "TV" }));
vi.mock("../src/setup/BadgerSetupFlow", () => ({ SignInSetupBack: () => null }));

import { ApiError } from "@space/shared/api";
import { handOffProviderReturn, PROVIDER_VERIFIER_KEY } from "@space/mobile-shell/provider-sign-in";
import { LoginScreen } from "../src/screens/LoginScreen";

const SUITE = "MOBILE-LOGIN-PROVIDER-SIGNIN";
const CODE = "handoffCode_0123456789abcdef";
const USER = { id: "u1", email: "pilot@example.test" };

const texts = (tree: ReactTestRenderer) =>
  tree.root.findAll((n) => (n.type as unknown) === "Text").map((n) => [n.props.children].flat().join(""));
const byType = (tree: ReactTestRenderer, type: string) => tree.root.findAll((n) => n.type === type);
const byTestId = (tree: ReactTestRenderer, testID: string) => tree.root.findAll((n) => typeof n.type === "string" && n.props.testID === testID);
const rowIds = (tree: ReactTestRenderer) =>
  tree.root
    .findAll((n) => (n.type as unknown) === "Pressable" && typeof n.props.testID === "string" && n.props.testID.startsWith("provider-sign-in-"))
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

/** The navigator's link handler, as AppNavigator calls it for every link it receives. */
const deliver = async (url: string) => {
  let handled = false;
  await act(async () => {
    handled = handOffProviderReturn("spacebadger", url);
  });
  return handled;
};

describe(`[${SUITE}] Google, Apple and Microsoft on the Badger phone`, () => {
  beforeAll(async () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const i18n = i18next.createInstance();
    await i18n.init({
      lng: "en",
      fallbackLng: "en",
      interpolation: { escapeValue: false },
      resources: { en: { translation: withSignInErrorTexts(en, "en") } },
    });
    h.i18n = i18n;
  });

  beforeEach(() => {
    h.isTv = false;
    h.store.clear();
    h.listSignInProviders.mockResolvedValue({ providers: ["microsoft", "apple", "google"] });
    h.startProviderSignIn.mockResolvedValue({ url: "https://accounts.google.test/o/oauth2/auth?state=s" });
    h.openURL.mockResolvedValue(undefined);
    h.setSession.mockResolvedValue(undefined);
  });

  afterEach(() => {
    console.info(`[${SUITE}] verifier stored after test:`, h.store.has(PROVIDER_VERIFIER_KEY));
  });

  // @req ACCT-SIGNIN-05[badger-mobile]
  it("ACCT-SIGNIN-05[badger-mobile]: draws no rows and no divider when the server offers no provider", async () => {
    h.listSignInProviders.mockResolvedValue({ providers: [] });
    const tree = await render();
    console.info(`[${SUITE}] rows (none listed)`, rowIds(tree));
    expect(rowIds(tree)).toEqual([]);
    expect(byTestId(tree, "provider-sign-in-divider")).toHaveLength(0);
  });

  // @req ACCT-SIGNIN-05[badger-mobile]
  it("ACCT-SIGNIN-05[badger-mobile]: the form's button, then the divider, then buttons in Google, Apple, Microsoft order", async () => {
    const tree = await render();
    console.info(`[${SUITE}] rows`, rowIds(tree), texts(tree));
    expect(rowIds(tree)).toEqual(["provider-sign-in-google", "provider-sign-in-apple", "provider-sign-in-microsoft"]);
    expect(rowIds(tree).map((id) => byTestId(tree, id)[0]!.props.accessibilityLabel)).toEqual([
      "Sign in with Google",
      "Sign in with Apple",
      "Sign in with Microsoft",
    ]);
    expect(texts(tree)).toEqual(expect.arrayContaining(["Google", "Apple", "Microsoft"]));
    expect(byType(tree, "MobileOrDivider")[0]!.props.label).toBe("or");
    const order = tree.root
      .findAll((n) => typeof n.type === "string" && (String(n.type) === "MobileAuthButton" || String(n.type) === "MobileOrDivider" || n.props.testID === "provider-sign-in-rows"))
      .map((n) => (String(n.type) === "MobileAuthButton" || String(n.type) === "MobileOrDivider" ? String(n.type) : "rows"));
    console.info(`[${SUITE}] order`, order);
    expect(order.indexOf("MobileAuthButton")).toBeLessThan(order.indexOf("MobileOrDivider"));
    expect(order.indexOf("MobileOrDivider")).toBeLessThan(order.indexOf("rows"));
  });

  // @req ACCT-SIGNIN-05[badger-mobile]
  it("ACCT-SIGNIN-05[badger-mobile]: 'Forgot password?' sits with the form, under its button and before the divider", async () => {
    const tree = await render();
    const order = tree.root
      .findAll((n) => String(n.type) === "MobileAuthButton" || String(n.type) === "MobileOrDivider" || (String(n.type) === "MobileAuthLink" && /forgot/i.test(String(n.props.label))))
      .map((n) => (String(n.type) === "MobileAuthLink" ? `forgot:${n.props.label}` : String(n.type)));
    console.info(`[${SUITE}] forgot order`, order);
    expect(order).toEqual(["MobileAuthButton", expect.stringMatching(/^forgot:/), "MobileOrDivider"]);
  });

  // @req ACCT-SIGNIN-07[badger-mobile]
  it("ACCT-SIGNIN-07[badger-mobile]: each button is a 54 square with radius 13, the name captioned under it", async () => {
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

  // @req ACCT-SIGNIN-05[badger-mobile]
  it("ACCT-SIGNIN-05[badger-mobile]: a row starts at spacebadger://auth/provider with the hash of a stored secret and opens the browser", async () => {
    const tree = await render();
    await act(async () => {
      byTestId(tree, "provider-sign-in-google")[0]!.props.onPress();
    });
    const [provider, body] = h.startProviderSignIn.mock.calls[0]!;
    const verifier = h.store.get(PROVIDER_VERIFIER_KEY);
    console.info(`[${SUITE}] start`, provider, { ...body, clientChallenge: "<hash>" }, "verifier stored:", Boolean(verifier));
    expect(provider).toBe("google");
    expect(body).toMatchObject({ returnTo: "spacebadger://auth/provider", surface: "phone", uiLanguage: "en" });
    expect(verifier).toBeTruthy();
    expect(body.clientChallenge).toBe(sha256url(verifier!));
    expect(h.openURL).toHaveBeenCalledWith("https://accounts.google.test/o/oauth2/auth?state=s");
    expect(texts(tree)).toContain(en.login.provider.continueInBrowser);
  });

  // @req ACCT-SIGNIN-05[badger-mobile]
  it("ACCT-SIGNIN-05[badger-mobile]: the way back trades the code and the secret for a session", async () => {
    h.completeProviderSignIn.mockResolvedValue({ token: "session-token", user: USER });
    await render();
    h.store.set(PROVIDER_VERIFIER_KEY, "stored-verifier");
    expect(await deliver(`spacebadger://auth/provider?signinCode=${CODE}`)).toBe(true);
    console.info(`[${SUITE}] complete args`, h.completeProviderSignIn.mock.calls[0]?.slice(2));
    expect(h.completeProviderSignIn).toHaveBeenCalledWith(CODE, "stored-verifier", undefined, undefined, {
      deviceType: "mobile",
      deviceName: "Badger (Pixel 8)",
    });
    expect(h.setSession).toHaveBeenCalledWith("session-token", USER);
    expect(h.store.has(PROVIDER_VERIFIER_KEY)).toBe(false);
  });

  // @req ACCT-SIGNIN-05[badger-mobile]
  it("ACCT-SIGNIN-05[badger-mobile]: a link that came before the screen (cold start) is finished once it mounts", async () => {
    h.completeProviderSignIn.mockResolvedValue({ token: "session-token", user: USER });
    h.store.set(PROVIDER_VERIFIER_KEY, "stored-verifier");
    expect(handOffProviderReturn("spacebadger", `spacebadger://auth/provider?signinCode=${CODE}`)).toBe(true);
    await render();
    expect(h.setSession).toHaveBeenCalledWith("session-token", USER);
    expect(handOffProviderReturn("spacebadger", "https://spacefleet.io/pair/badger?code=ABCD-EFGH")).toBe(false);
  });

  // @req ACCT-SIGNIN-05[badger-mobile]
  it("ACCT-SIGNIN-05[badger-mobile]: an account with a second step asks for it and sends the same code with it", async () => {
    h.completeProviderSignIn
      .mockRejectedValueOnce(new ApiError(401, { error: "two_factor_required", method: "totp" }))
      .mockResolvedValueOnce({ token: "session-token", user: USER });
    const tree = await render();
    h.store.set(PROVIDER_VERIFIER_KEY, "stored-verifier");
    await deliver(`spacebadger://auth/provider?signinCode=${CODE}`);
    console.info(`[${SUITE}] after two_factor_required`, texts(tree));
    expect(texts(tree)).toContain(en.login.infoTotp);
    const field = byTestId(tree, "login-two-factor")[0]!;
    await act(async () => {
      field.props.onChangeText(" 123456 ");
    });
    await act(async () => {
      byTestId(tree, "login-submit")[0]!.props.onPress();
    });
    console.info(`[${SUITE}] second completion args`, h.completeProviderSignIn.mock.calls[1]?.slice(2));
    expect(h.completeProviderSignIn).toHaveBeenLastCalledWith(CODE, "stored-verifier", "123456", undefined, expect.anything());
    expect(h.setSession).toHaveBeenCalledWith("session-token", USER);
  });

  // @req ACCT-SIGNIN-05[badger-mobile]
  it("ACCT-SIGNIN-05[badger-mobile]: an email with no account says to create one elsewhere, and drops the secret", async () => {
    const tree = await render();
    h.store.set(PROVIDER_VERIFIER_KEY, "stored-verifier");
    await deliver("spacebadger://auth/provider?signinError=no_account");
    console.info(`[${SUITE}] no_account texts`, texts(tree));
    expect(texts(tree)).toContain(en.login.provider.errors.no_account);
    expect(h.completeProviderSignIn).not.toHaveBeenCalled();
    expect(h.store.has(PROVIDER_VERIFIER_KEY)).toBe(false);
  });

  // @req ACCT-SIGNIN-05[badger-mobile]
  it("ACCT-SIGNIN-05[badger-mobile]: the TV build draws no rows", async () => {
    h.isTv = true;
    const tree = await render();
    console.info(`[${SUITE}] TV rows`, rowIds(tree));
    expect(rowIds(tree)).toEqual([]);
    expect(byTestId(tree, "provider-sign-in-divider")).toHaveLength(0);
    expect(h.listSignInProviders).not.toHaveBeenCalled();
  });
});
