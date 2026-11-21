/**
 * @test-id MOBILE-SHELL-DELETE-ACCOUNT-001
 * @level unit
 * @req ACCT-DEL-01[badger-mobile,parrot]
 * @req ACCT-DEL-03[badger-mobile,parrot]
 * @why The phones now create accounts (ACCT-AUTH-10, Chris 2026-11-19), so both delete them in the app (Apple
 *   5.1.1(v), Google Play's account deletion requirement). The shared form asks the password and the typed DELETE,
 *   deletes at once (the app then clears the phone and signs out), or books the deletion for the end of a paid year
 *   when the API offers it. An account without a password is asked a code instead (read from the API when the app
 *   does not know). The real form runs through i18next with the English texts; the API is replaced.
 */
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import i18next, { type i18n as I18n } from "i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as SharedApi from "@space/shared/api";
import { withSignInErrorTexts } from "@space/shared/signInError";
import en from "../src/i18n/en.json";

const h = vi.hoisted(() => ({
  i18n: null as I18n | null,
  deleteAccount: vi.fn(),
  getDeletionOptions: vi.fn(),
  cancelScheduledDeletion: vi.fn(),
  getMe: vi.fn(),
}));

vi.mock("react-native", () => ({ Pressable: "Pressable", Text: "Text", View: "View", StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 } }));
vi.mock("../src/components/mobile-auth-form", () => ({ MobileAuthButton: "MobileAuthButton", MobileAuthInput: "MobileAuthInput" }));
vi.mock("../src/theme", () => ({
  useMobileShellTheme: () => ({ colors: { accent: "#3ddc84", text: "#fff", textMuted: "#aaa", surface: "#111", border: "#333", danger: "#f00" } }),
}));
vi.mock("../src/i18n", () => ({ getCurrentLanguage: () => "en", useTranslation: () => ({ t: h.i18n!.t.bind(h.i18n) }) }));
vi.mock("../src/logger", () => ({ scopeLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
vi.mock("@space/shared/api", async () => ({
  ApiError: (await vi.importActual<typeof SharedApi>("@space/shared/api")).ApiError,
  deleteAccount: (...a: unknown[]) => h.deleteAccount(...a),
  getDeletionOptions: (...a: unknown[]) => h.getDeletionOptions(...a),
  cancelScheduledDeletion: (...a: unknown[]) => h.cancelScheduledDeletion(...a),
  getMe: (...a: unknown[]) => h.getMe(...a),
}));

import { MobileDeleteAccount } from "../src/components/mobile-delete-account";

const SUITE = "MOBILE-SHELL-DELETE-ACCOUNT-001";
const byTestId = (tree: ReactTestRenderer, id: string) => tree.root.findAll((n) => n.props.testID === id && typeof n.type === "string");
const change = async (tree: ReactTestRenderer, id: string, value: string) =>
  act(async () => {
    byTestId(tree, id)[0]!.props.onChangeText(value);
  });
const press = async (tree: ReactTestRenderer, id: string) =>
  act(async () => {
    byTestId(tree, id)[0]!.props.onPress();
  });
const render = async (props: { hasPassword?: boolean; onDeleted: () => Promise<void>; onBooked?: () => void }) => {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(createElement(MobileDeleteAccount, { token: "tok", ...props }));
  });
  return tree;
};

describe("phone delete-account form (ACCT-DEL-01, ACCT-DEL-03)", () => {
  beforeAll(async () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const i18n = i18next.createInstance();
    await i18n.init({ lng: "en", interpolation: { escapeValue: false }, resources: { en: { translation: withSignInErrorTexts(en, "en") } } });
    h.i18n = i18n;
  });
  beforeEach(() => {
    h.deleteAccount.mockReset();
    h.getMe.mockReset();
    h.getDeletionOptions.mockReset().mockResolvedValue({ periodEndDeleteAt: null, scheduledFor: null });
  });

  // @req ACCT-DEL-02[badger-mobile,parrot]
  it("ACCT-DEL-02: says everything goes and to download the files first", async () => {
    const tree = await render({ hasPassword: true, onDeleted: vi.fn().mockResolvedValue(undefined) });
    const shown = tree.root.findAll((n) => String(n.type) === "Text").map((n) => [n.props.children].flat().join(""));
    console.info(`[${SUITE}] warning texts`, shown);
    expect(shown).toContain(en.deleteAccount.warning);
    expect(shown).toContain(en.deleteAccount.keepFiles);
  });

  // @req ACCT-DEL-01[badger-mobile,parrot]
  it("ACCT-DEL-01: deletes with the password and the typed DELETE, then hands over to the app", async () => {
    h.deleteAccount.mockResolvedValueOnce({ status: "deleted" });
    const onDeleted = vi.fn().mockResolvedValue(undefined);
    const tree = await render({ hasPassword: true, onDeleted });
    expect(byTestId(tree, "delete-account-submit")[0]!.props.disabled).toBe(true);
    await change(tree, "delete-account-password", "secret-pass");
    await change(tree, "delete-account-confirm", "DELETE");
    await press(tree, "delete-account-submit");
    console.info(`[${SUITE}] delete args`, h.deleteAccount.mock.calls[0]);
    expect(h.deleteAccount).toHaveBeenCalledWith("tok", { password: "secret-pass", confirm: "DELETE" });
    expect(onDeleted).toHaveBeenCalledTimes(1);
  });

  // @req ACCT-DEL-03[badger-mobile,parrot]
  it("ACCT-DEL-03: books the deletion for the end of the paid year when the API offers it", async () => {
    h.getDeletionOptions.mockResolvedValue({ periodEndDeleteAt: "2027-03-01T00:00:00.000Z", scheduledFor: null });
    h.deleteAccount.mockResolvedValueOnce({ status: "deletion_scheduled_for_period_end", deleteAt: "2027-03-01T00:00:00.000Z" });
    const onDeleted = vi.fn().mockResolvedValue(undefined);
    const onBooked = vi.fn();
    const tree = await render({ hasPassword: true, onDeleted, onBooked });
    expect(byTestId(tree, "delete-account-mode-end_of_period")).toHaveLength(1);
    await change(tree, "delete-account-password", "secret-pass");
    await change(tree, "delete-account-confirm", "DELETE");
    await press(tree, "delete-account-submit");
    console.info(`[${SUITE}] booked args`, h.deleteAccount.mock.calls[0]);
    expect(h.deleteAccount.mock.calls[0]![1]).toMatchObject({ mode: "end_of_period" });
    expect(onBooked).toHaveBeenCalledTimes(1);
    expect(onDeleted).not.toHaveBeenCalled();
    expect(byTestId(tree, "delete-account-scheduled")).toHaveLength(1);
  });

  // @req ACCT-DEL-01[badger-mobile,parrot]
  it("ACCT-DEL-01: an account without a password (read from the API) is asked no password", async () => {
    h.getMe.mockResolvedValueOnce({ user: { id: "u1", email: "a@example.test", hasPassword: false } });
    const tree = await render({ onDeleted: vi.fn().mockResolvedValue(undefined) });
    console.info(`[${SUITE}] password field shown`, byTestId(tree, "delete-account-password").length);
    expect(byTestId(tree, "delete-account-password")).toHaveLength(0);
    expect(byTestId(tree, "delete-account-recheck-hint")).toHaveLength(1);
  });
});
