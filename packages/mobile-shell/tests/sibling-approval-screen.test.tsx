/**
 * @test-id MOBILE-SHELL-SIBLING-APPROVAL-SCREEN-001
 * @level unit
 * @req ACCT-PAIR-07[badger-mobile,parrot]
 * @why The signed-in app's question when its sister asks to sign in on the same phone: the asking app's real icon, an
 *   arrow, this app's real icon, then "Let {App} use your SpaceFleet account?", the body naming the account, and only
 *   Allow and Cancel (no biometric or passcode step, Chris's decision). Both buttons lock while the answer is sent.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Image: "Image",
  Pressable: "Pressable",
  StyleSheet: { create: <T,>(styles: T) => styles },
  NativeModules: {},
}));
vi.mock("lucide-react-native", () => ({ ArrowRight: "ArrowRight" }));
vi.mock("../src/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) => (values ? `${key}(${Object.values(values).join(",")})` : key),
  }),
}));
vi.mock("../src/theme", () => ({
  useMobileShellTheme: () => ({ colors: { accent: "#22d3ee", text: "#fff", textMuted: "#999", border: "#333" }, accentTextHex: "#000" }),
}));
vi.mock("../src/components/mobile-startup-page", () => ({ MobileStartupPage: "MobileStartupPage" }));
vi.mock("../src/sibling/icons", () => ({
  SIBLING_APP_NAMES: { badger: "Badger", parrot: "Parrot" },
  SIBLING_APP_ICONS: { badger: "badger-icon", parrot: "parrot-icon" },
}));

import { SiblingApprovalView } from "../src/sibling/SiblingApprovalScreen";

const SUITE = "[sibling-approval-screen]";
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

const render = (busy: boolean) => {
  const onAllow = vi.fn();
  const onCancel = vi.fn();
  const elements = all(SiblingApprovalView({ self: "badger", email: "ada@example.com", busy, onAllow, onCancel }));
  const texts = elements.filter((e) => e.type === "Text").map((e) => e.props.children);
  console.info(SUITE, { busy, texts });
  return { elements, texts, onAllow, onCancel, byId: (id: string) => elements.find((e) => e.props.testID === id) };
};

describe("SiblingApprovalView", () => {
  it("shows the asking app's icon, then this app's, the question and only Allow and Cancel", () => {
    const { elements, texts, byId, onAllow, onCancel } = render(false);
    expect(elements.filter((e) => e.type === "Image").map((e) => e.props.source)).toEqual(["parrot-icon", "badger-icon"]);
    expect(texts).toEqual([
      "sibling.askTitle(Parrot)",
      "sibling.askBody(Parrot,ada@example.com)",
      "sibling.allow",
      "sibling.cancel",
    ]);
    (byId("sibling-allow")?.props.onPress as () => void)();
    (byId("sibling-deny")?.props.onPress as () => void)();
    expect(onAllow).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("locks both buttons while the answer is sent", () => {
    const { byId } = render(true);
    expect(byId("sibling-allow")?.props.disabled).toBe(true);
    expect(byId("sibling-deny")?.props.disabled).toBe(true);
  });
});
