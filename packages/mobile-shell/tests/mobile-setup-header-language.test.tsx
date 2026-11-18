/**
 * @test-id MOBILE-SHELL-SETUP-HEADER-LANGUAGE-001
 * @level unit
 * @why Chris 2026-11-12 (chat): the language button stays top-right "during the entire setup". The phone's numbered
 *   key step had none while the sign-in had one. Every phone and TV setup screen's header (Back, "STEP N OF M") now
 *   ends with the language button in its top-right corner, which switches the language at once; the sign-in screens,
 *   whose own corner already holds one, pass no handler and show none.
 */
// @req UX-SETUP-08[badger-mobile,badger-tv,parrot]
import React from "react";
import { Text } from "react-native";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ isTV: false }));
vi.mock("react-native", () => ({
  Platform: platform,
  ActivityIndicator: "ActivityIndicator",
  Image: "Image",
  Modal: "Modal",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles, hairlineWidth: 1 },
  Text: "Text",
  View: "View",
}));
vi.mock("react-native-svg", () => ({ SvgXml: "SvgXml" }));
vi.mock("lucide-react-native", () => ({ ArrowLeft: "ArrowLeft", Check: "Check", ChevronDown: "ChevronDown", ChevronRight: "ChevronRight", ChevronUp: "ChevronUp", Globe: "Globe" }));
vi.mock("../src/keyboard", () => ({ KeyboardAvoidingForm: "KeyboardAvoidingForm" }));
vi.mock("../src/i18n", () => ({
  useTranslation: () => ({ t: (key: string, values?: Record<string, number>) => (values ? `${key}(${values.step}/${values.total})` : key) }),
  getCurrentLanguage: () => "en",
  isMobileUiLanguage: (code: string) => ["en", "fr", "de", "nl", "es"].includes(code),
  MOBILE_UI_LANGUAGES: [
    { code: "en", nativeName: "English" },
    { code: "fr", nativeName: "Français" },
  ],
}));
vi.mock("../src/components/mobile-render-boundary", () => ({
  MobileRenderBoundary: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("../src/theme", () => ({
  useMobileShellTheme: () => ({
    colors: { accent: "#ffb357", text: "#fff", textMuted: "#aaa", border: "#333", surface: "#111", surfaceRaised: "#222", controlBorder: "#444" },
    radius: { md: 12 },
    spacing: { sm: 8, md: 12, lg: 16 },
    font: { size: { md: 16, sm: 13 }, family: { sans: "Inter", display: "Inter" } },
    mascotSource: 1,
    accentTextHex: "#000",
  }),
}));

import { MobileSetupHeader, MobileSetupStep } from "../src/components/mobile-setup-step";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

beforeEach(() => {
  platform.isTV = false;
});

const LOG = "[MOBILE-SHELL-SETUP-HEADER-LANGUAGE-001]";

const mount = async (element: React.ReactElement) => {
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(element);
  });
  return root;
};

const byTestID = (root: ReactTestRenderer, testID: string) => root.root.findAll((n) => n.props.testID === testID && typeof n.type === "string");

describe("the setup header's language button", () => {
  it("sits after STEP N OF M at the end of the header row and switches the language", async () => {
    const picked: string[] = [];
    const root = await mount(<MobileSetupHeader step={1} total={3} onBack={() => undefined} onLanguage={(code) => picked.push(code)} />);
    const [menu] = byTestID(root, "setup-language-menu");
    const [indicator] = byTestID(root, "setup-step-indicator");
    const row = menu.parent!.parent!;
    console.info(LOG, "row children", row.children.length, "indicator", indicator.props.children);
    expect(menu.parent).toBe(indicator.parent);
    expect(menu.parent!.children.at(-1)).toBe(menu);
    expect(row.children.at(-1)).toBe(menu.parent);
    // The globe opens the list; a language in it switches at once.
    await act(async () => menu.findAll((n) => (n.type as unknown) === "Pressable")[0].props.onPress());
    const french = root.root.findAll((n) => (n.type as unknown) === "Pressable" && n.findAll((t) => t.props.children === "Français").length > 0).at(-1)!;
    await act(async () => french.props.onPress());
    expect(picked).toEqual(["fr"]);
  });

  it("shows none where the screen passes no handler (the sign-in's own corner holds it)", async () => {
    const root = await mount(<MobileSetupHeader step={0} total={0} onBack={() => undefined} />);
    expect(byTestID(root, "setup-language-menu")).toHaveLength(0);
  });

  it("is on every walkthrough step that passes it on", async () => {
    const root = await mount(<MobileSetupStep step={2} total={3} title="t" onLanguage={() => undefined} onNext={() => undefined} />);
    expect(byTestID(root, "setup-language-menu")).toHaveLength(1);
  });
});

// @req UX-TV-17[badger-tv]
describe("the setup footer on TV (key step, UX-TV-17)", () => {
  it("starts the remote on the main button when asked, rings the pill it is on, and can leave the mascot out", async () => {
    platform.isTV = true;
    const root = await mount(<MobileSetupStep step={2} total={3} title="t" onNext={() => undefined} onBack={() => undefined} nextPreferredFocus mascot={false} />);
    const [next] = byTestID(root, "setup-next");
    const [back] = byTestID(root, "setup-footer-back");
    const rings = () => root.root.findAll((n) => String(n.type) === "View" && n.props.pointerEvents === "none");
    console.info(LOG, "footer", JSON.stringify({ next: next.props.hasTVPreferredFocus, back: back.props.hasTVPreferredFocus, mascots: root.root.findAll((n) => String(n.type) === "Image").length }));
    expect(next.props.hasTVPreferredFocus).toBe(true);
    expect(back.props.hasTVPreferredFocus).toBeUndefined();
    expect(root.root.findAll((n) => String(n.type) === "Image")).toHaveLength(0);
    expect(rings()).toHaveLength(0);
    await act(async () => next.props.onFocus());
    expect(rings()).toHaveLength(1);
    expect(byTestID(root, "setup-next")[0].findAll((n) => String(n.type) === "View" && n.props.pointerEvents === "none")).toHaveLength(1);
    // UX-TV-33: the ring is the app's amber.
    expect([byTestID(root, "setup-next-focus")[0].props.style].flat().find((s: { borderColor?: string }) => s?.borderColor)?.borderColor).toBe("#ffb357");
    await act(async () => next.props.onBlur());
    expect(rings()).toHaveLength(0);
  });

  it("keeps the mascot and no preferred focus by default (every other setup screen, phones)", async () => {
    const root = await mount(<MobileSetupStep step={2} total={3} title="t" onNext={() => undefined} />);
    expect(byTestID(root, "setup-next")[0].props.hasTVPreferredFocus).toBeUndefined();
    expect(root.root.findAll((n) => String(n.type) === "Image")).toHaveLength(1);
  });
});

const flatStyle = (style: unknown): Record<string, unknown> => Object.assign({}, ...[style].flat(Infinity).filter(Boolean)) as Record<string, unknown>;

// @req UX-TV-33[badger-tv]
describe("the TV setup step's one card (UX-TV-33)", () => {
  it("holds STEP N OF M and the bar, the title, the content, then Back and the main button; the language button stays outside, top right", async () => {
    platform.isTV = true;
    const root = await mount(
      <MobileSetupStep step={2} total={3} title="Your library key" body="lead" onBack={() => undefined} onNext={() => undefined} onLanguage={() => undefined} nextLabel="Written down">
        <Text testID="content">words</Text>
      </MobileSetupStep>,
    );
    const [card] = byTestID(root, "setup-card");
    const inCard = card.findAll((n) => typeof n.props.testID === "string" && typeof n.type === "string").map((n) => String(n.props.testID));
    console.info(LOG, "card", JSON.stringify(inCard));
    expect(inCard.slice(0, 2)).toEqual(["setup-card", "setup-step-bar"]);
    expect(inCard.indexOf("setup-step-indicator")).toBeGreaterThan(1);
    expect(inCard.indexOf("content")).toBeGreaterThan(inCard.indexOf("setup-step-indicator"));
    expect(inCard.indexOf("setup-footer")).toBeGreaterThan(inCard.indexOf("content"));
    // The remote reads the footer left to right: Back, then the main button.
    const footer = byTestID(root, "setup-footer")[0].findAll((n) => String(n.type) === "Pressable").map((n) => n.props.testID);
    expect(footer).toEqual(["setup-footer-back", "setup-next"]);
    expect(byTestID(root, "setup-step-indicator")[0].props.children).toBe("SETUP.STEPOF(2/3)");
    // No phone header row (its "‹ Back" link) on TV: Back is the card's pill.
    expect(byTestID(root, "setup-back")).toHaveLength(0);
    expect(inCard).not.toContain("setup-language-menu");
    expect(byTestID(root, "setup-language-menu")).toHaveLength(1);
    const [corner] = byTestID(root, "setup-corner");
    expect(flatStyle(corner.props.style).position).toBe("absolute");
    expect(corner.findAll((n) => n.props.testID === "setup-language-menu" && typeof n.type === "string")).toHaveLength(1);
    expect(byTestID(root, "setup-next")[0].findAll((n) => (n.type as unknown) === "ChevronRight")).toHaveLength(1);
    expect(byTestID(root, "setup-footer-back")[0].findAll((n) => (n.type as unknown) === "ArrowLeft")).toHaveLength(1);
  });

  it("leaves Back out on the first step and keeps the main button at the right", async () => {
    platform.isTV = true;
    const root = await mount(<MobileSetupStep step={1} total={3} title="t" onNext={() => undefined} />);
    expect(byTestID(root, "setup-footer-back")).toHaveLength(0);
    expect(flatStyle(byTestID(root, "setup-footer")[0].props.style).justifyContent).toBe("space-between");
    expect(byTestID(root, "setup-footer")[0].findAll((n) => String(n.type) === "Pressable").map((n) => n.props.testID)).toEqual(["setup-next"]);
  });

  it("takes a screen's own header: none at all once the setup is over", async () => {
    platform.isTV = true;
    const root = await mount(<MobileSetupStep step={2} total={3} title="t" onNext={() => undefined} header={null} />);
    expect(byTestID(root, "setup-step-bar")).toHaveLength(0);
    expect(byTestID(root, "setup-card")).toHaveLength(1);
  });
});
