/**
 * @test-id MOBILE-SHELL-SIGN-UP-001
 * @level unit
 * @req ACCT-AUTH-10[badger-mobile,parrot]
 * @why Chris 2026-11-19 (chat): "users can signup on mobile, they just can't pay, signing up only creates a free
 *   account. But they should be able to sign up". The Badger and Parrot phones share this create-account card: the
 *   desktop's checks (8+ characters, the two passwords match), the unticked News box, the "By creating an account,
 *   you accept…" line, a `signup` call marked `mobile`, then the emailed code, which signs the phone in with its device
 *   name. Nothing on it names a price or a way to pay. The real card and the real English texts run through i18next;
 *   native modules are host elements, the API is replaced.
 */
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import i18next, { type i18n as I18n } from "i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as SharedApi from "@space/shared/api";
import { withSignInErrorTexts } from "@space/shared/signInError";
import en from "../src/i18n/en.json";

const h = vi.hoisted(() => ({ i18n: null as I18n | null, signup: vi.fn(), verifyEmail: vi.fn(), resendVerification: vi.fn(), openURL: vi.fn() }));

vi.mock("react-native", () => ({
  Linking: { openURL: (url: string) => h.openURL(url) },
  Pressable: "Pressable",
  Text: "Text",
  View: "View",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
}));
vi.mock("lucide-react-native", () => ({ Check: "Icon", Lock: "Icon", Mail: "Icon" }));
vi.mock("../src/components/mobile-auth-form", () => ({
  MobileAuthButton: "MobileAuthButton",
  MobileAuthInput: "MobileAuthInput",
  MobileAuthLink: "MobileAuthLink",
}));
vi.mock("../src/theme", () => ({
  useMobileShellTheme: () => ({
    accentTextHex: "#000",
    colors: { accent: "#3ddc84", text: "#fff", textMuted: "#aaa", surface: "#111", border: "#333", danger: "#f00" },
  }),
}));
vi.mock("../src/i18n", () => ({ useTranslation: () => ({ t: h.i18n!.t.bind(h.i18n) }) }));
vi.mock("../src/logger", () => ({ scopeLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
vi.mock("@space/shared/api", async () => ({
  ApiError: (await vi.importActual<typeof SharedApi>("@space/shared/api")).ApiError,
  signup: (...a: unknown[]) => h.signup(...a),
  verifyEmail: (...a: unknown[]) => h.verifyEmail(...a),
  resendVerification: (...a: unknown[]) => h.resendVerification(...a),
}));

import { ApiError } from "@space/shared/api";
import { MobileSignUp, type MobileSignUpProps } from "../src/components/mobile-sign-up";

const SUITE = "MOBILE-SHELL-SIGN-UP-001";
const DEVICE = { deviceName: "OnePlus 9", deviceType: "phone" as const };
const USER = { id: "u1", email: "new@example.test" };

const textOf = (node: { props: { children?: unknown } }): string =>
  [node.props.children]
    .flat()
    .map((child) => (typeof child === "string" ? child : child && typeof child === "object" && "props" in child ? textOf(child as never) : ""))
    .join("");
const texts = (tree: ReactTestRenderer) => tree.root.findAll((n) => String(n.type) === "Text").map(textOf);
const byTestId = (tree: ReactTestRenderer, id: string) => tree.root.findAll((n) => n.props.testID === id && typeof n.type === "string");
const type = async (tree: ReactTestRenderer, id: string, value: string) =>
  act(async () => {
    byTestId(tree, id)[0]!.props.onChangeText(value);
  });
const press = async (tree: ReactTestRenderer, id: string) =>
  act(async () => {
    byTestId(tree, id)[0]!.props.onPress();
  });

const render = async (props: Partial<MobileSignUpProps> = {}) => {
  const onSignedIn = vi.fn().mockResolvedValue(undefined);
  const onSignIn = vi.fn();
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      createElement(MobileSignUp, { initialEmail: "", language: "en", uiLanguage: "en", device: DEVICE, onSignedIn, onSignIn, ...props }),
    );
  });
  return { tree, onSignedIn, onSignIn };
};

describe("phone create-account card (ACCT-AUTH-10)", () => {
  beforeAll(async () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const i18n = i18next.createInstance();
    await i18n.init({ lng: "en", interpolation: { escapeValue: false }, resources: { en: { translation: withSignInErrorTexts(en, "en") } } });
    h.i18n = i18n;
  });
  beforeEach(() => {
    h.signup.mockReset();
    h.verifyEmail.mockReset();
    h.resendVerification.mockReset();
    h.openURL.mockReset();
  });

  it("ACCT-AUTH-10: checks the password like the desktop before calling the API", async () => {
    const { tree } = await render();
    await type(tree, "signup-email", "new@example.test");
    await type(tree, "signup-password", "short");
    await type(tree, "signup-confirm", "short");
    await press(tree, "signup-submit");
    console.info(`[${SUITE}] short password`, texts(tree));
    expect(texts(tree)).toContain(en.signup.errors.passwordLength);

    await type(tree, "signup-password", "long-enough-1");
    await type(tree, "signup-confirm", "long-enough-2");
    await press(tree, "signup-submit");
    console.info(`[${SUITE}] mismatch`, texts(tree));
    expect(texts(tree)).toContain(en.signup.errors.passwordMismatch);
    expect(h.signup).not.toHaveBeenCalled();
  });

  it("ACCT-AUTH-10: shows the legal line and an unticked News box, and names no price", async () => {
    const { tree } = await render();
    const all = texts(tree).join("\n");
    console.info(`[${SUITE}] form texts`, texts(tree));
    expect(byTestId(tree, "signup-terms-notice")).toHaveLength(1);
    expect(all).toMatch(/By creating an account/i);
    expect(byTestId(tree, "signup-news")[0]!.props.accessibilityState).toEqual({ checked: false });
    expect(all).not.toMatch(/€|\$|price|subscribe|pay/i);
  });

  it("ACCT-AUTH-10: creates the account as a phone, then the emailed code signs this phone in", async () => {
    h.signup.mockResolvedValueOnce({ ok: true });
    h.verifyEmail.mockResolvedValueOnce({ token: "session-token", user: USER });
    const { tree, onSignedIn } = await render();
    await type(tree, "signup-email", "  new@example.test ");
    await type(tree, "signup-password", "long-enough-1");
    await type(tree, "signup-confirm", "long-enough-1");
    await press(tree, "signup-news");
    await press(tree, "signup-submit");
    console.info(`[${SUITE}] signup args`, h.signup.mock.calls[0]);
    expect(h.signup).toHaveBeenCalledWith("new@example.test", "long-enough-1", "en", true, "mobile");
    expect(byTestId(tree, "verify-email")).toHaveLength(1);
    expect(texts(tree)).toContain(en.verifyEmail.sent);

    await type(tree, "verify-code", " 123456 ");
    await press(tree, "verify-submit");
    console.info(`[${SUITE}] verify args`, h.verifyEmail.mock.calls[0]);
    expect(h.verifyEmail).toHaveBeenCalledWith("new@example.test", "123456", DEVICE);
    expect(onSignedIn).toHaveBeenCalledWith("session-token", USER);
  });

  it("ACCT-AUTH-10: opens on the code step for an unverified sign-in, and a wrong code says so", async () => {
    h.verifyEmail.mockRejectedValueOnce(new ApiError(400, { error: "invalid_code" }));
    const { tree, onSignedIn } = await render({ initialEmail: "new@example.test", initialStep: "verify" });
    expect(byTestId(tree, "verify-email")).toHaveLength(1);
    await type(tree, "verify-code", "000000");
    await press(tree, "verify-submit");
    console.info(`[${SUITE}] wrong code`, texts(tree));
    expect(texts(tree)).toContain(en.verifyEmail.errors.invalidCode);
    expect(onSignedIn).not.toHaveBeenCalled();
  });
});
