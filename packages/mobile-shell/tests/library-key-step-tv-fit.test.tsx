/**
 * @test-id MOBILE-SHELL-LIBRARY-KEY-TV-FIT-001
 * @level component
 * @why Badger TV's key step (UX-SETUP-08, Chris 2026-11-18): with the mascot over the card, the 12 boxes, the "Get
 *   the key from another device" card and Back/Continue ran past the bottom of a 1080p TV (Salon). Like the desktop's
 *   `LIBRARY_KEY_STEP_FIT`, the TV's boxes are 28 dp (56 px), closer together, and the other-device card is its title
 *   on one line; a phone keeps its taller boxes and the card's line. Rendered with react-test-renderer: react-native
 *   is replaced by host-element stand-ins.
 *
 * @req UX-SETUP-08[badger-tv]
 */
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ isTV: true, OS: "android" }));
vi.mock("react-native", () => ({
  Clipboard: { setString: () => undefined },
  Platform: platform,
  Pressable: "Pressable",
  StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles },
  Text: "Text",
  TextInput: "TextInput",
  View: "View",
}));
vi.mock("lucide-react-native", () => ({ ChevronRight: "ChevronRight", QrCode: "QrCode" }));
vi.mock("../src/components/mobile-button-face", () => ({ MobileButtonFace: "MobileButtonFace" }));
vi.mock("../src/logger", () => ({ scopeLogger: () => ({ info: () => undefined }) }));
vi.mock("../src/theme", () => ({
  useMobileShellTheme: () => ({
    colors: { accent: "#f4a261", bg: "#000000", border: "#333333", text: "#fff", textMuted: "#999", controlBorder: "#333", surfaceRaised: "#222", danger: "#e00", success: "#0c0" },
    accentTextHex: "#000",
  }),
}));
vi.mock("../src/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }) }));

import { LibraryKeyWordsGrid, LibraryKeyWordsInput } from "../src/libraryKeyWords";
import { MobilePhoneSignInCard } from "../src/components/mobile-phone-sign-in-card";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const SUITE = "[MOBILE-SHELL-LIBRARY-KEY-TV-FIT-001]";
let tree: ReactTestRenderer | null = null;

const mount = (element: React.ReactElement) => {
  act(() => {
    tree = create(element, { createNodeMock: () => ({ focus: () => undefined, setSelection: () => undefined }) });
  });
  return tree!;
};
const flat = (node: ReactTestInstance): Record<string, unknown> =>
  Object.assign({}, ...[node.props.style].flat(Infinity).filter(Boolean)) as Record<string, unknown>;
const byId = (root: ReactTestRenderer, id: string) => root.root.find((n) => typeof n.type === "string" && n.props.testID === id);

afterEach(() => {
  platform.isTV = true;
  act(() => tree?.unmount());
  tree = null;
});

describe("the key step's boxes and other-device card fit a TV (UX-SETUP-08)", () => {
  it("@req UX-SETUP-08[badger-tv] the typed boxes are 28 dp on TV, 7 dp apart; a phone keeps its 44 dp", () => {
    const tv = mount(<LibraryKeyWordsInput tv onChangeText={() => undefined} />);
    const box = flat(byId(tv, "library-key-word-1"));
    const grid = flat(byId(tv, "library-key-words-input"));
    console.info(SUITE, "tv boxes", JSON.stringify({ height: box.height, rowGap: grid.rowGap }));
    expect(box.height).toBe(28);
    expect(grid.rowGap).toBe(7);
    // 3 rows of 4 boxes: 98 dp, as the desktop's 56 px boxes.
    expect(3 * Number(box.height) + 2 * Number(grid.rowGap)).toBeLessThanOrEqual(98);
    act(() => tree?.unmount());
    const phone = mount(<LibraryKeyWordsInput tv={false} onChangeText={() => undefined} />);
    expect(flat(byId(phone, "library-key-word-1")).height).toBe(44);
    expect(flat(byId(phone, "library-key-words-input")).rowGap).toBe(10);
  });

  it("@req UX-SETUP-08[badger-tv] the shown key's boxes on TV are as tight as the typed ones", () => {
    const root = mount(<LibraryKeyWordsGrid words={Array.from({ length: 12 }, (_, i) => `w${i + 1}`)} />);
    const box = flat(byId(root, "library-key-words-box-1"));
    const grid = flat(byId(root, "library-key-words-grid"));
    console.info(SUITE, "tv shown", JSON.stringify({ height: box.height, rowGap: grid.rowGap, keybox: flat(byId(root, "library-key-words-keybox")).padding }));
    expect(box.height).toBe(28);
    expect(grid.rowGap).toBe(6);
  });

  it("@req UX-SETUP-08[badger-tv] compact: the other-device card is its title on one line, the line kept as the hint", () => {
    const root = mount(<MobilePhoneSignInCard compact testID="key-from-another-device" title="Get the key from another device" body="Scan a code" onPress={() => undefined} />);
    const card = byId(root, "key-from-another-device");
    const texts = card.findAll((n) => (n.type as unknown) === "Text");
    console.info(SUITE, "compact card", JSON.stringify({ texts: texts.map((n) => n.props.children), style: flat(card) }));
    expect(texts.map((n) => n.props.children)).toEqual(["Get the key from another device"]);
    expect(texts[0]!.props.numberOfLines).toBe(1);
    expect(card.props.accessibilityHint).toBe("Scan a code");
    expect(flat(card).paddingVertical).toBe(7);
    act(() => tree?.unmount());
    const full = mount(<MobilePhoneSignInCard testID="key-from-another-device" title="Get the key from another device" body="Scan a code" onPress={() => undefined} />);
    const fullTexts = byId(full, "key-from-another-device").findAll((n) => (n.type as unknown) === "Text");
    expect(fullTexts.map((n) => n.props.children)).toEqual(["Get the key from another device", "Scan a code"]);
  });
});
