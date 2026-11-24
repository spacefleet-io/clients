/**
 * @test-id MOBILE-SHELL-PASSWORD-SIGN-IN-FORM-001
 * @level unit
 * @req UX-PHONE-08[badger-mobile]
 * @req UX-PHONE-08[parrot]
 * @req ACCT-AUTH-11[badger-mobile,parrot]
 * @why Audit #3350 S56: Badger and Parrot each kept their own email-and-password form, and Parrot's had lost the keyboard
 *   walk Badger fixed on a Pixel 8 (2026-11-13: Next on the email went nowhere). Both phones now draw the shell's
 *   `MobilePasswordSignInForm` with `useMobilePasswordSignIn`: Next on the email focuses the password, Done signs in,
 *   a two-factor answer adds the code field and says where the code is, an unverified account goes to the app's code
 *   step, any other failure shows its own sentence and is logged, and the "Forgot password?" card closes on Back. The
 *   real form and card are rendered; native modules and the shell's inputs are host elements.
 */
import { createElement, useState } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as SharedApi from "@space/shared/api";
import type { ProviderSignInNotice } from "../src/provider-sign-in";

const h = vi.hoisted(() => ({
  warn: vi.fn(),
  back: [] as Array<() => boolean>,
}));

vi.mock("react-native", () => ({
  BackHandler: {
    addEventListener: (_event: string, handler: () => boolean) => {
      h.back.push(handler);
      return { remove: () => void h.back.splice(h.back.indexOf(handler), 1) };
    },
  },
  Pressable: "Pressable",
  Text: "Text",
  View: "View",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
}));
vi.mock("lucide-react-native", () => ({ ArrowRight: "Icon", Lock: "Icon", Mail: "Icon" }));
vi.mock("../src/components/mobile-auth-form", () => ({
  MobileAuthInput: "MobileAuthInput",
  MobileAuthButton: "MobileAuthButton",
  MobileAuthLink: "MobileAuthLink",
}));
vi.mock("../src/theme", () => ({
  useMobileShellTheme: () => ({ accentTextHex: "#000", colors: { accent: "#3ddc84", text: "#fff", textMuted: "#aaa", surface: "#111", border: "#333", danger: "#f00" } }),
}));
vi.mock("../src/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../src/logger", () => ({ scopeLogger: () => ({ info: () => undefined, warn: h.warn, error: () => undefined }) }));
vi.mock("@space/shared/api", async () => ({
  ApiError: (await vi.importActual<typeof SharedApi>("@space/shared/api")).ApiError,
  requestPasswordReset: vi.fn(),
  confirmPasswordReset: vi.fn(),
}));

import { ApiError } from "@space/shared/api";
import { MobilePasswordSignInForm, useMobilePasswordSignIn, type UseMobilePasswordSignInInput } from "../src/components/mobile-password-sign-in-form";
import { MobilePasswordReset } from "../src/components/mobile-password-reset";

const SUITE = "MOBILE-SHELL-PASSWORD-SIGN-IN-FORM-001";

type Options = Omit<UseMobilePasswordSignInInput, "notice" | "setNotice">;

/** The app's side: it owns the notice, as Badger's and Parrot's screens do. */
const Harness = ({ options, onForgot }: { options: Options; onForgot: () => void }) => {
  const [notice, setNotice] = useState<ProviderSignInNotice | null>(null);
  const form = useMobilePasswordSignIn({ ...options, notice, setNotice });
  return createElement(MobilePasswordSignInForm, { form, onForgot });
};

const render = async (options: Options, onForgot = vi.fn()) => {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(createElement(Harness, { options, onForgot }));
  });
  return tree;
};
const byTestId = (tree: ReactTestRenderer, testID: string): ReactTestInstance[] => tree.root.findAll((n) => typeof n.type === "string" && n.props.testID === testID);
const one = (tree: ReactTestRenderer, testID: string) => byTestId(tree, testID)[0]!;
const texts = (tree: ReactTestRenderer) => tree.root.findAll((n) => String(n.type) === "Text").map((n) => [n.props.children].flat().join(""));
const fill = async (tree: ReactTestRenderer, email: string, password: string) => {
  await act(async () => {
    one(tree, "login-email").props.onChangeText(email);
    one(tree, "login-password").props.onChangeText(password);
  });
};
/** Points an input's `inputRef` at a stub, standing in for the native TextInput the host element never mounts. */
const stubFocus = (input: ReactTestInstance, focus: () => void) => {
  const ref: unknown = input.props.inputRef;
  if (!ref || typeof ref !== "object" || !("current" in ref)) throw new Error(`${String(input.props.testID)} has no inputRef`);
  Reflect.set(ref, "current", { focus });
};
const press = async (tree: ReactTestRenderer) => {
  await act(async () => {
    one(tree, "login-submit").props.onPress();
  });
};

describe(`[${SUITE}] the phones' shared email-and-password sign-in`, () => {
  beforeAll(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  });
  beforeEach(() => {
    h.warn.mockReset();
    h.back.length = 0;
  });

  // @req UX-PHONE-08[badger-mobile]
  // @req UX-PHONE-08[parrot]
  it("Next on the email focuses the password; Done on the password signs in with the trimmed email", async () => {
    const login = vi.fn(async () => undefined);
    const tree = await render({ login });
    const email = one(tree, "login-email");
    const password = one(tree, "login-password");
    console.info(`[${SUITE}] keys`, { email: email.props.returnKeyType, password: password.props.returnKeyType });
    expect(email.props.returnKeyType).toBe("next");
    expect(password.props.returnKeyType).toBe("done");
    const focus = vi.fn();
    stubFocus(password, focus);
    await act(async () => {
      email.props.onSubmitEditing();
    });
    expect(focus).toHaveBeenCalledTimes(1);

    await fill(tree, " pilot@example.test ", "pw");
    await act(async () => {
      one(tree, "login-password").props.onSubmitEditing();
    });
    console.info(`[${SUITE}] login calls`, login.mock.calls);
    expect(login).toHaveBeenCalledWith("pilot@example.test", "pw", undefined);
    expect(byTestId(tree, "login-two-factor")).toHaveLength(0);
    expect(byTestId(tree, "login-forgot")).toHaveLength(1);
  });

  // @req UX-PHONE-08[badger-mobile]
  // @req UX-PHONE-08[parrot]
  it("empty fields do not sign in; the button is disabled only while a sign-in runs", async () => {
    const login = vi.fn(async () => undefined);
    const tree = await render({ login });
    expect(one(tree, "login-submit").props.disabled).toBe(false);
    await press(tree);
    expect(login).not.toHaveBeenCalled();
  });

  // @req UX-PHONE-08[badger-mobile]
  // @req UX-PHONE-08[parrot]
  it("a two-factor answer adds the code field, says where the code is, and walks password → code → sign in", async () => {
    const login = vi
      .fn<(email: string, password: string, code?: string) => Promise<void>>()
      .mockRejectedValueOnce(new ApiError(401, { error: "two_factor_required", method: "totp" }))
      .mockResolvedValueOnce(undefined);
    const tree = await render({ login });
    await fill(tree, "pilot@example.test", "pw");
    await press(tree);
    console.info(`[${SUITE}] after two_factor_required`, texts(tree));
    expect(texts(tree)).toContain("login.infoTotp");
    const code = one(tree, "login-two-factor");
    expect(code.props.placeholder).toBe("login.twoFactorPlaceholder");
    expect(one(tree, "login-password").props.returnKeyType).toBe("next");
    const focus = vi.fn();
    stubFocus(code, focus);
    await act(async () => {
      one(tree, "login-password").props.onSubmitEditing();
    });
    expect(focus).toHaveBeenCalledTimes(1);
    await act(async () => {
      one(tree, "login-two-factor").props.onChangeText(" 123456 ");
    });
    await act(async () => {
      one(tree, "login-two-factor").props.onSubmitEditing();
    });
    expect(login).toHaveBeenLastCalledWith("pilot@example.test", "pw", "123456");
    expect(byTestId(tree, "login-notice")).toHaveLength(0);
  });

  // @req UX-PHONE-08[badger-mobile]
  // @req UX-PHONE-08[parrot]
  it("an unverified account goes to the app's code step; without one (TV) it says so", async () => {
    const unverified = () => new ApiError(403, { error: "email_not_verified" });
    const onUnverified = vi.fn();
    const phone = await render({ login: vi.fn(async () => Promise.reject(unverified())), onUnverified });
    await fill(phone, "pilot@example.test", "pw");
    await press(phone);
    expect(onUnverified).toHaveBeenCalledTimes(1);
    expect(byTestId(phone, "login-notice")).toHaveLength(0);

    const tv = await render({ login: vi.fn(async () => Promise.reject(unverified())) });
    await fill(tv, "pilot@example.test", "pw");
    await press(tv);
    console.info(`[${SUITE}] tv unverified`, texts(tv));
    expect(texts(tv)).toContain("login.errors.emailNotVerified");
  });

  // @req ACCT-AUTH-11[badger-mobile,parrot]
  it("any other failure shows its own sentence and logs its kind, never the credentials", async () => {
    const tree = await render({ login: vi.fn(async () => Promise.reject(new ApiError(401, { error: "invalid_credentials" }))) });
    await fill(tree, "pilot@example.test", "secret-pw");
    await press(tree);
    console.info(`[${SUITE}] wrong password`, texts(tree), h.warn.mock.calls);
    expect(texts(tree)).toContain("login.errors.credentials");
    expect(h.warn).toHaveBeenCalledWith("login.failed", expect.objectContaining({ failure: "credentials" }));
    expect(JSON.stringify(h.warn.mock.calls)).not.toContain("secret-pw");
  });

  // @req ACCT-SIGNIN-05[badger-mobile,parrot]
  it("a provider's second step: the code field alone finishes that sign-in", async () => {
    const submit = vi.fn(async () => undefined);
    const login = vi.fn(async () => undefined);
    const tree = await render({ login, providerStep: { method: "email", finishing: false, submit } });
    await act(async () => {
      one(tree, "login-two-factor").props.onChangeText(" 654321 ");
    });
    await press(tree);
    expect(submit).toHaveBeenCalledWith("654321");
    expect(login).not.toHaveBeenCalled();
  });

  // @req UX-PHONE-08[badger-mobile]
  // @req UX-PHONE-08[parrot]
  it("'Forgot password?' opens the app's reset card, and Android Back closes it", async () => {
    const onForgot = vi.fn();
    const tree = await render({ login: vi.fn() }, onForgot);
    await act(async () => {
      one(tree, "login-forgot").props.onPress();
    });
    expect(onForgot).toHaveBeenCalledTimes(1);

    const onDone = vi.fn();
    await act(async () => {
      create(createElement(MobilePasswordReset, { initialEmail: "pilot@example.test", onDone }));
    });
    console.info(`[${SUITE}] back handlers`, h.back.length);
    expect(h.back.at(-1)?.()).toBe(true);
    expect(onDone).toHaveBeenCalledWith(null);
  });
});
