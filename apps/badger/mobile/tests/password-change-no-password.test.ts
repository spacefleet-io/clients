/**
 * @test-id BADGER-MOBILE-PASSWORD-CHANGE-NO-PASSWORD-001
 * @level unit
 * @why An account without a password has `user.hasPassword` false. Its Settings password
 *   form must not ask a current password it does not have: it reads "Set a password", sends no current password,
 *   and shows the code field when the API asks for one (it emails it on the first try), then sends the code. An
 *   account with a password keeps the current-password field. The real form runs with the shell's English
 *   strings; the ui kit is host elements, the API is replaced with its contract.
 */
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import i18next, { type i18n as I18n } from "i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as SharedApi from "@space/shared/api";
import { withSignInErrorTexts } from "@space/shared/signInError";
import en from "../../../../packages/mobile-shell/src/i18n/en.json";

const h = vi.hoisted(() => ({ i18n: null as I18n | null, changePassword: vi.fn() }));

vi.mock("react-native", () => ({ Text: "Text", StyleSheet: { create: <T,>(s: T) => s } }));
vi.mock("../src/components/ui", () => ({ Button: "Button", Card: "Card", Input: "Input" }));
vi.mock("../src/theme/theme", () => ({
  theme: { colors: { text: "#fff", textMuted: "#aaa", danger: "#f00", success: "#0f0" }, font: { size: { sm: 13, md: 15 } } },
}));
vi.mock("@space/mobile-shell/i18n", () => ({ useTranslation: () => ({ t: h.i18n!.t.bind(h.i18n) }) }));
vi.mock("@space/shared/api", async () => ({
  ApiError: (await vi.importActual<typeof SharedApi>("@space/shared/api")).ApiError,
  changePassword: (...a: unknown[]) => h.changePassword(...a),
}));

import { ApiError } from "@space/shared/api";
import { PasswordChangeSection } from "../src/components/AccountSecurity";

const SUITE = "[BADGER-MOBILE-PASSWORD-CHANGE-NO-PASSWORD-001]";
const inputs = (tree: ReactTestRenderer) => tree.root.findAll((n) => (n.type as unknown) === "Input");
const texts = (tree: ReactTestRenderer) => tree.root.findAll((n) => (n.type as unknown) === "Text").map((n) => [n.props.children].flat().join(""));
const button = (tree: ReactTestRenderer) => tree.root.find((n) => (n.type as unknown) === "Button");
const field = (tree: ReactTestRenderer, label: string) => inputs(tree).find((n) => n.props.label === label)!;

const mount = async (hasPassword: boolean) => {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(createElement(PasswordChangeSection, { token: "tok", hasPassword }));
  });
  return tree;
};

describe(`${SUITE} Settings password form`, () => {
  beforeAll(async () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const i18n = i18next.createInstance();
    await i18n.init({
      lng: "en",
      interpolation: { escapeValue: false },
      resources: { en: { translation: withSignInErrorTexts(en as Record<string, unknown>, "en") } },
    });
    h.i18n = i18n;
  });

  beforeEach(() => h.changePassword.mockReset());

  it("without a password: sets a first one, asks no current password, and sends the emailed code", async () => {
    h.changePassword
      .mockRejectedValueOnce(new ApiError(401, { error: "two_factor_required", method: "email" }))
      .mockResolvedValueOnce({ ok: true });
    const tree = await mount(false);
    const labels = inputs(tree).map((n) => n.props.label);
    console.info(SUITE, "fields without a password", labels, texts(tree));
    expect(labels).toEqual(["New password"]);
    expect(texts(tree)).toContain("Set a password");
    expect(texts(tree)).toContain(en.login.code.recheckHint);
    expect(button(tree).props.label).toBe("Set password");

    await act(async () => {
      field(tree, "New password").props.onChangeText("a-long-new-one");
    });
    await act(async () => {
      await button(tree).props.onPress();
    });
    console.info(SUITE, "first try", h.changePassword.mock.calls, inputs(tree).map((n) => n.props.label));
    expect(h.changePassword).toHaveBeenLastCalledWith("tok", "", "a-long-new-one", undefined);
    const codeLabel = en.account.password.codeLabel;
    expect(inputs(tree).map((n) => n.props.label)).toContain(codeLabel);

    await act(async () => {
      field(tree, codeLabel).props.onChangeText(" 123456 ");
    });
    await act(async () => {
      await button(tree).props.onPress();
    });
    console.info(SUITE, "second try", h.changePassword.mock.calls, texts(tree));
    expect(h.changePassword).toHaveBeenLastCalledWith("tok", "", "a-long-new-one", "123456");
    expect(texts(tree)).toContain(en.account.password.success);
  });

  it("with a password: still asks the current one", async () => {
    const tree = await mount(true);
    const labels = inputs(tree).map((n) => n.props.label);
    console.info(SUITE, "fields with a password", labels);
    expect(labels).toEqual(["Current password", "New password"]);
    expect(button(tree).props.label).toBe("Change password");
    await act(async () => {
      field(tree, "New password").props.onChangeText("a-long-new-one");
    });
    await act(async () => {
      await button(tree).props.onPress();
    });
    expect(h.changePassword).not.toHaveBeenCalled();
    expect(texts(tree)).toContain(en.account.password.errors.required);
  });
});
