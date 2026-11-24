/**
 * @test-id MOBILE-SHELL-PASSWORD-RESET-TOO-MANY-ATTEMPTS-001
 * @level unit
 * @req ACCT-AUTH-11
 * @why The phone "Forgot password?" card (Parrot phone) asks the API for a reset code and then sets the new password.
 *   When the API refuses either for now (429 `rate_limited`, OPS-LIMIT-03) the card says "Too many attempts. Try
 *   again in N minutes." (N = `retryAfterSeconds` rounded up); other failures keep their own sentence. The real card
 *   and the shared sentences run through a real i18next; native modules are host elements, the API is replaced.
 */
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import i18next, { type i18n as I18n } from "i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type * as SharedApi from "@space/shared/api";
import { withSignInErrorTexts } from "@space/shared/signInError";

const h = vi.hoisted(() => ({ i18n: null as I18n | null, requestPasswordReset: vi.fn(), confirmPasswordReset: vi.fn() }));

vi.mock("react-native", () => ({
  BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
  Pressable: "Pressable",
  Text: "Text",
  View: "View",
  StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
}));
vi.mock("lucide-react-native", () => ({ Lock: "Icon", Mail: "Icon" }));
vi.mock("../src/components/mobile-auth-form", () => ({ MobileAuthButton: "MobileAuthButton", MobileAuthInput: "MobileAuthInput" }));
vi.mock("../src/theme", () => ({
  useMobileShellTheme: () => ({ colors: { accent: "#3ddc84", text: "#fff", textMuted: "#aaa", surface: "#111", border: "#333", danger: "#f00" } }),
}));
vi.mock("../src/i18n", () => ({ useTranslation: () => ({ t: h.i18n!.t.bind(h.i18n) }) }));
vi.mock("@space/shared/api", async () => ({
  ApiError: (await vi.importActual<typeof SharedApi>("@space/shared/api")).ApiError,
  requestPasswordReset: (...a: unknown[]) => h.requestPasswordReset(...a),
  confirmPasswordReset: (...a: unknown[]) => h.confirmPasswordReset(...a),
}));

import { ApiError } from "@space/shared/api";
import { MobilePasswordReset } from "../src/components/mobile-password-reset";

const say = (line: string, extra?: unknown) => console.info(`[MOBILE-SHELL-PASSWORD-RESET-TOO-MANY-ATTEMPTS-001] ${line}`, extra ?? "");
const texts = (tree: ReactTestRenderer) =>
  tree.root.findAll((n) => String(n.type) === "Text").map((n) => [n.props.children].flat().join(""));
const buttons = (tree: ReactTestRenderer) => tree.root.findAll((n) => String(n.type) === "MobileAuthButton");
const limited = (retryAfterSeconds: number) => new ApiError(429, { error: "rate_limited", retryAfterSeconds });

describe("phone password reset card on a 429", () => {
  beforeAll(async () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const i18n = i18next.createInstance();
    await i18n.init({
      lng: "nl",
      fallbackLng: "en",
      interpolation: { escapeValue: false },
      resources: {
        en: { translation: withSignInErrorTexts({}, "en") },
        nl: { translation: withSignInErrorTexts({}, "nl") },
      },
    });
    h.i18n = i18n;
  });

  it("the code request and the new password both say how long to wait", async () => {
    h.requestPasswordReset.mockRejectedValueOnce(limited(1200)).mockResolvedValueOnce(undefined);
    h.confirmPasswordReset.mockRejectedValueOnce(limited(50));
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(createElement(MobilePasswordReset, { initialEmail: "pilot@example.test", onDone: vi.fn() }));
    });

    await act(async () => {
      buttons(tree)[0]!.props.onPress();
    });
    say("after refused request", texts(tree));
    expect(texts(tree)).toContain("Te veel pogingen. Probeer het over 20 minuten opnieuw.");

    await act(async () => {
      buttons(tree)[0]!.props.onPress();
    });
    await act(async () => {
      buttons(tree).at(-1)!.props.onPress();
    });
    say("after refused confirm", texts(tree));
    expect(texts(tree)).toContain("Te veel pogingen. Probeer het over 1 minuut opnieuw.");
  });

  it("a wrong code keeps its own sentence", async () => {
    h.requestPasswordReset.mockResolvedValueOnce(undefined);
    h.confirmPasswordReset.mockRejectedValueOnce(new ApiError(400, { error: "invalid_code" }));
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(createElement(MobilePasswordReset, { initialEmail: "pilot@example.test", onDone: vi.fn() }));
    });
    await act(async () => {
      buttons(tree)[0]!.props.onPress();
    });
    await act(async () => {
      buttons(tree).at(-1)!.props.onPress();
    });
    say("after wrong code", texts(tree));
    expect(texts(tree)).toContain("login.reset.errorInvalidCode");
  });
});
