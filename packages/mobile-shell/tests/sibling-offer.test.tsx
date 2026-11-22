/**
 * @test-id MOBILE-SHELL-SIBLING-OFFER-001
 * @level unit
 * @req ACCT-PAIR-07[badger-mobile,parrot]
 * @why Above a phone's sign-in form, the sister app's offer: its real icon, "Continue with your {Other} account", the
 *   phone body, "Continue as {email}" and "Use another account"; then the waiting card with Cancel while the sister app
 *   asks; then, if it fails, only the one failure line. The same shared card in Badger and Parrot.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Image: "Image",
  Pressable: "Pressable",
  StyleSheet: { create: <T,>(styles: T) => styles },
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
  NativeModules: {},
}));
vi.mock("../src/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) => (values ? `${key}(${Object.values(values).join(",")})` : key),
  }),
}));
vi.mock("../src/theme", () => ({
  useMobileShellTheme: () => ({ colors: { accent: "#22d3ee", text: "#fff", textMuted: "#999", danger: "#f87171" }, accentTextHex: "#000" }),
}));
vi.mock("../src/sibling/icons", () => ({
  // The real names (never translated); the pictures stand in as strings outside Metro.
  SIBLING_APP_NAMES: { badger: "Badger", parrot: "Parrot" },
  SIBLING_APP_ICONS: { badger: "badger-icon", parrot: "parrot-icon" },
}));

import { MobileSiblingOfferView } from "../src/sibling/MobileSiblingOffer";
import type { SiblingSignInState } from "../src/sibling/controller";

const SUITE = "[sibling-offer]";
type Element = { type: unknown; props: Record<string, unknown> & { children?: unknown } };

const all = (node: unknown, out: Element[] = []): Element[] => {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) all(child, out);
    return out;
  }
  const element = node as Element;
  out.push(element);
  all(element.props?.children, out);
  return out;
};

const render = (state: SiblingSignInState) => {
  const handlers = { onContinue: vi.fn(), onCancel: vi.fn(), onOtherAccount: vi.fn() };
  const tree = MobileSiblingOfferView({ other: "badger", email: "ada@example.com", state, ...handlers });
  const elements = all(tree);
  const texts = elements.filter((e) => e.type === "Text").map((e) => e.props.children);
  const byId = (id: string) => elements.find((e) => e.props.testID === id);
  console.info(SUITE, state.phase, texts);
  return { elements, texts, byId, handlers };
};

describe("MobileSiblingOffer", () => {
  it("offers the sister account with its real icon, the email button and the other-account link", () => {
    const { elements, texts, byId, handlers } = render({ phase: "idle" });
    expect(elements.find((e) => e.type === "Image")?.props.source).toBe("badger-icon");
    expect(texts).toEqual(["sibling.title(Badger)", "sibling.body(Badger)", "sibling.button(ada@example.com)", "sibling.otherAccount"]);
    const button = byId("sibling-continue");
    (button?.props.onPress as () => void)();
    expect(handlers.onContinue).toHaveBeenCalled();
    (byId("sibling-other-account")?.props.onPress as () => void)();
    expect(handlers.onOtherAccount).toHaveBeenCalled();
    // One line whatever the email's length: it is cut with an ellipsis rather than wrapping.
    const label = elements.find((e) => e.props.children === "sibling.button(ada@example.com)");
    expect(label?.props.numberOfLines).toBe(1);
  });

  it("shows the waiting card with Cancel while the sister app asks", () => {
    const { texts, byId, handlers } = render({ phase: "waiting" });
    expect(texts).toEqual(["sibling.waiting(Badger)", "sibling.waitingNote(Badger)", "sibling.cancel"]);
    (byId("sibling-cancel")?.props.onPress as () => void)();
    expect(handlers.onCancel).toHaveBeenCalled();
  });

  it("keeps the waiting card, without Cancel, while the sign-in completes", () => {
    const { texts, byId } = render({ phase: "completing" });
    expect(texts).toEqual(["sibling.waiting(Badger)", "sibling.waitingNote(Badger)"]);
    expect(byId("sibling-cancel")).toBeUndefined();
  });

  it("shows only the one failure line when the sister app could not sign in", () => {
    const { texts, elements } = render({ phase: "failed", reason: "timeout" });
    expect(texts).toEqual(["sibling.failure(Badger)"]);
    expect(elements.find((e) => e.type === "Image")).toBeUndefined();
  });

  it("shows nothing once signed in", () => {
    const { elements } = render({ phase: "done" });
    expect(elements).toEqual([]);
  });
});
