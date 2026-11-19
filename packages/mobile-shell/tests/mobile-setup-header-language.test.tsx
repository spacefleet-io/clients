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
import { Text, View } from "react-native";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
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

import {
  MobileChoiceMenu,
  MobileSetupHeader,
  MobileSetupStep,
  setupMascotOverlap,
  TV_SETUP_CARD_TOP,
  TV_SETUP_MASCOT_SIZE,
} from "../src/components/mobile-setup-step";

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

// Chris 2026-11-18: "you can drop the top left one when there's already one at the bottom besides the next one."
// @req UX-SETUP-08[badger-mobile,parrot]
describe("the phone setup's one Back (UX-SETUP-08)", () => {
  it("a step with the Back pill under its card shows no top ‹ Back link", async () => {
    const back = vi.fn();
    const root = await mount(<MobileSetupStep step={2} total={4} title="t" onBack={back} onNext={() => undefined} onLanguage={() => undefined} />);
    console.info(LOG, "pill", byTestID(root, "setup-footer-back").length, "top", byTestID(root, "setup-back").length);
    expect(byTestID(root, "setup-footer-back")).toHaveLength(1);
    expect(byTestID(root, "setup-back")).toHaveLength(0);
    // The count (inside the card) and the language button (on top) stay.
    expect(byTestID(root, "setup-step-indicator")).toHaveLength(1);
    expect(byTestID(root, "setup-language-menu")).toHaveLength(1);
    await act(async () => byTestID(root, "setup-footer-back")[0].props.onPress());
    expect(back).toHaveBeenCalledTimes(1);
  });

  // Main 2026-11-19 (Chris: "drop duplicate/useless back"): "Your profile" shown alone has no way back.
  // @req UX-SETUP-10[badger-mobile,parrot]
  it("noBack with no onBack draws no Back pill, so Next takes the footer alone; a numbered first step keeps it greyed", async () => {
    const alone = await mount(<MobileSetupStep step={0} total={0} title="t" header={null} noBack onNext={() => undefined} />);
    const pills = byTestID(alone, "setup-footer")[0].findAll((n) => String(n.type) === "Pressable").map((n) => n.props.testID);
    console.info(LOG, "alone pills", JSON.stringify(pills));
    expect(pills).toEqual(["setup-next"]);
    expect(flatStyle(byTestID(alone, "setup-next")[0].props.style).flex).toBe(1);
    const first = await mount(<MobileSetupStep step={1} total={3} title="t" onNext={() => undefined} />);
    expect(byTestID(first, "setup-footer-back")).toHaveLength(1);
    expect(byTestID(first, "setup-footer-back")[0].props.disabled).toBe(true);
  });

  it("a screen with no Back pill (the sign-in) keeps the top ‹ Back link", async () => {
    const back = vi.fn();
    const root = await mount(<MobileSetupHeader step={0} total={0} onBack={back} />);
    expect(byTestID(root, "setup-footer-back")).toHaveLength(0);
    expect(byTestID(root, "setup-back")).toHaveLength(1);
    await act(async () => byTestID(root, "setup-back")[0].props.onPress());
    expect(back).toHaveBeenCalledTimes(1);
  });
});

const LANGUAGES = [
  { value: "en", label: "English" },
  { value: "fr", label: "Français" },
  { value: "nl", label: "Nederlands" },
  { value: "de", label: "Deutsch" },
  { value: "es", label: "Español" },
] as const;

// Chris 2026-11-18: "Choose your language" shows all five languages, Español included, with no scroll inside the list.
// @req UX-SETUP-08[badger-mobile,parrot]
describe("the phone's language menu in a setup step (UX-SETUP-08)", () => {
  it("opens to all five languages with no inner scroll, and the step scrolls the open list into view", async () => {
    const scrolledToEnd: unknown[] = [];
    let root!: ReactTestRenderer;
    await act(async () => {
      root = create(
        <MobileSetupStep step={0} total={0} title="Choose your language" onNext={() => undefined}>
          <MobileChoiceMenu testID="setup-language-list" label="Language" choices={LANGUAGES} selected="en" onSelect={() => undefined} />
        </MobileSetupStep>,
        {
          createNodeMock: (element) =>
            String(element.type) === "ScrollView" ? { scrollTo: () => undefined, scrollToEnd: (options: unknown) => scrolledToEnd.push(options) } : null,
        },
      );
    });
    expect(byTestID(root, "setup-language-list")).toHaveLength(0);
    await act(async () => byTestID(root, "setup-language-list-field")[0].props.onPress());
    const [list] = byTestID(root, "setup-language-list");
    const rows = LANGUAGES.map(({ value }) => flatStyle(byTestID(root, `setup-choice-${value}`)[0].props.style));
    const needed = rows.reduce((sum, row) => sum + Number(row.height ?? row.minHeight), 0);
    const maxHeight = Number(flatStyle(list.props.style).maxHeight);
    console.info(LOG, "language menu", JSON.stringify({ rows: rows.length, needed, maxHeight }));
    expect(maxHeight).toBeGreaterThanOrEqual(needed);
    // Opening the list lays it out under the field: the step scrolls to its end, so Español is on screen too.
    const holders = root.root.findAll((n) => String(n.type) === "View" && typeof n.props.onLayout === "function");
    await act(async () => holders.forEach((n) => n.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 320, height: maxHeight } } })));
    expect(scrolledToEnd).toEqual([{ animated: true }]);
  });
});

// Chris 2026-11-18: the phone's mascot over every TV setup card too, about half over its top border.
// @req UX-SETUP-08[badger-tv]
describe("the TV setup step's mascot (UX-SETUP-08)", () => {
  it("draws the mascot before the card, its lower part over the card's top border, the card padded under it", async () => {
    platform.isTV = true;
    const root = await mount(<MobileSetupStep step={1} total={2} title="Your library key" onNext={() => undefined} />);
    const order = root.root.findAll((n) => typeof n.type === "string" && typeof n.props.testID === "string").map((n) => String(n.props.testID));
    const mascot = flatStyle(byTestID(root, "setup-mascot")[0].props.style);
    const card = flatStyle(byTestID(root, "setup-card")[0].props.style);
    console.info(LOG, "tv mascot", JSON.stringify({ order: order.slice(0, 3), mascot, cardTop: card.paddingTop }));
    expect(order.indexOf("setup-mascot")).toBe(order.indexOf("setup-card") - 1);
    expect(mascot.height).toBe(TV_SETUP_MASCOT_SIZE);
    expect(Number(mascot.marginBottom)).toBeCloseTo(-setupMascotOverlap(TV_SETUP_MASCOT_SIZE));
    // The card's text clears the mascot; the key step's card is a little closer under it than the other TV cards, so
    // its 12 boxes fit 540 dp (UX-SETUP-08, as the desktop's `LIBRARY_KEY_STEP_FIT`).
    expect(Number(card.paddingTop)).toBeGreaterThan(setupMascotOverlap(TV_SETUP_MASCOT_SIZE));
    expect(Number(card.paddingTop)).toBeLessThan(TV_SETUP_CARD_TOP);
  });
});

// Chris 2026-11-18 (relayed by Main): build the approved phone design exactly, "STEP 3 OF 5" inside the card at its
// top-left above the title (`/tmp/sf-gallery/profile-setup/phone-step.png`), the segmented bar under it as on the
// computer, the language button alone at the screen's top right.
// @req UX-SETUP-08[badger-mobile,parrot]
describe("the phone step's label inside the card (UX-SETUP-08)", () => {
  const isInside = (node: ReactTestInstance, ancestor: ReactTestInstance) => {
    for (let n = node.parent; n; n = n.parent) if (n === ancestor) return true;
    return false;
  };
  const cardOrder = (root: ReactTestRenderer) => {
    const [card] = byTestID(root, "setup-card");
    // The card's own drawn children in order: the count and bar, then the title.
    const order = card.findAll((n) => typeof n.type === "string" && (n.props.testID === "setup-step-bar" || n.props.accessibilityRole === "header")).map((n) => n.props.testID ?? "title");
    return { card, order };
  };

  it("draws STEP N OF M and the bar at the card's top, above the title, and the language button outside it", async () => {
    const root = await mount(<MobileSetupStep step={3} total={5} title="Your profile" onBack={() => undefined} onNext={() => undefined} onLanguage={() => undefined} />);
    const { card, order } = cardOrder(root);
    const [indicator] = byTestID(root, "setup-step-indicator");
    const [menu] = byTestID(root, "setup-language-menu");
    console.info(LOG, "label-in-card order", order, "indicator", indicator.props.children, "menu in card", isInside(menu, card));
    // The label is upper case, as on the approved design ("STEP 3 OF 5").
    expect(indicator.props.children).toBe("SETUP.STEPOF(3/5)");
    expect(isInside(indicator, card)).toBe(true);
    expect(order).toEqual(["setup-step-bar", "title"]);
    // The bar: one segment per step under the label, in the same block.
    const [bar] = byTestID(root, "setup-step-bar");
    expect(isInside(bar, card)).toBe(true);
    expect(bar.children[0]).toBe(indicator);
    const segments = bar.children.filter((child): child is ReactTestInstance => typeof child !== "string")[1]!;
    expect(segments.children).toHaveLength(5);
    // The language button stays at the screen's top right, alone, and no top Back next to the pill.
    expect(isInside(menu, card)).toBe(false);
    const [top] = byTestID(root, "setup-top");
    expect(top.children.at(-1)).toBe(menu);
    expect(byTestID(root, "setup-back")).toHaveLength(0);
    expect(byTestID(root, "setup-step-indicator")).toHaveLength(1);
  });

  it("splits a screen's own header the same way (Badger's key screen passes MobileSetupHeader)", async () => {
    const root = await mount(
      <MobileSetupStep step={1} total={4} title="Your library key" onNext={() => undefined} header={<MobileSetupHeader step={1} total={4} onLanguage={() => undefined} />} />,
    );
    const { card, order } = cardOrder(root);
    const [menu] = byTestID(root, "setup-language-menu");
    console.info(LOG, "own header order", order, "menu in card", isInside(menu, card));
    expect(order).toEqual(["setup-step-bar", "title"]);
    expect(isInside(byTestID(root, "setup-step-indicator")[0], card)).toBe(true);
    expect(isInside(menu, card)).toBe(false);
    expect(byTestID(root, "setup-language-menu")).toHaveLength(1);
  });

  it("draws no count in the card when the screen has none (header null, or step 0)", async () => {
    const none = await mount(<MobileSetupStep step={2} total={3} title="t" onNext={() => undefined} header={null} />);
    expect(byTestID(none, "setup-step-bar")).toHaveLength(0);
    expect(byTestID(none, "setup-top")).toHaveLength(0);
    const zero = await mount(<MobileSetupStep step={0} total={0} title="t" onNext={() => undefined} onLanguage={() => undefined} />);
    expect(byTestID(zero, "setup-step-indicator")).toHaveLength(0);
    expect(byTestID(zero, "setup-language-menu")).toHaveLength(1);
  });
});

// Device shots 2026-11-18: the card read as running under Back / Next, and Parrot's "I've written it down" filled its
// pill to the edges. The scroll view ends where the footer starts; a Next label that would wrap widens its pill.
// @req UX-SETUP-08[badger-mobile,parrot]
describe("the phone step's footer (UX-SETUP-08)", () => {
  it("ends the scroll above Back and Next, so the card's bottom edge shows once scrolled to the end", async () => {
    const root = await mount(
      <MobileSetupStep step={3} total={5} title="Your profile" onBack={() => undefined} onNext={() => undefined} onLanguage={() => undefined}>
        <View testID="last-row" />
      </MobileSetupStep>,
    );
    const [scroll] = byTestID(root, "setup-scroll");
    const [card] = byTestID(root, "setup-card");
    const [back] = byTestID(root, "setup-footer-back");
    const [next] = byTestID(root, "setup-next");
    const [footer] = byTestID(root, "setup-footer");
    const form = scroll.parent!;
    const padding = flatStyle(scroll.props.contentContainerStyle);
    console.info(LOG, "footer", form.type, form.children.length, "scroll padding", JSON.stringify(padding));
    // The form is a column of two: the scroll view, then the footer. The footer is never inside the scroll view,
    // so the scroll view's frame ends where the footer starts and nothing in it is drawn under the pills.
    expect(form.children).toEqual([scroll, footer]);
    expect(footer.findAll((n) => n === back || n === next)).toHaveLength(2);
    expect(card.findAll((n) => n.props.testID === "last-row" && typeof n.type === "string")).toHaveLength(1);
    expect(scroll.findAll((n) => n === card)).toHaveLength(1);
    expect(footer.findAll((n) => n === card)).toHaveLength(0);
    // Room under the card at the end of the scroll: its bottom edge is never flush with the footer.
    expect(Number(padding.padding)).toBeGreaterThan(0);
    expect(padding.paddingBottom).toBeUndefined();
  });

  it("gives Next its side padding, and a label too long for half the row widens its pill instead of wrapping", async () => {
    const root = await mount(<MobileSetupStep step={1} total={4} title="Your library key" onBack={() => undefined} onNext={() => undefined} nextLabel="I've written it down" />);
    const pill = (id: string) => flatStyle(byTestID(root, id)[0].props.style);
    const [label] = byTestID(root, "setup-next-label");
    console.info(LOG, "pills before", JSON.stringify(pill("setup-next")), JSON.stringify(pill("setup-footer-back")));
    expect(pill("setup-next").paddingHorizontal).toBe(20);
    expect(pill("setup-next").flex).toBe(1);
    expect(pill("setup-footer-back").flex).toBe(1);
    // A label that fits keeps the two pills equal; one that wraps widens Next to its label, on one line.
    await act(async () => {
      label.props.onTextLayout({ nativeEvent: { lines: [{ text: "I've written it" }] } });
    });
    expect(pill("setup-next").flex).toBe(1);
    await act(async () => {
      label.props.onTextLayout({ nativeEvent: { lines: [{ text: "I've written" }, { text: "it down" }] } });
    });
    console.info(LOG, "pills after", JSON.stringify(pill("setup-next")), JSON.stringify(pill("setup-footer-back")));
    expect(pill("setup-next").flex).toBeUndefined();
    expect(pill("setup-next").flexBasis).toBe("auto");
    expect(pill("setup-next").paddingHorizontal).toBe(20);
    expect(pill("setup-footer-back").flexBasis).toBe("auto");
    expect(byTestID(root, "setup-next-label")[0].props.numberOfLines).toBe(1);
  });
});
