/**
 * @test-id TV-SETUP-TITLE-LANGUAGE-001
 * @level component
 * @why Badger TV's "How should titles appear?" (UX-SETUP-08, ACCT-PROF-03) drew each option as a fixed 42 dp row, so
 *   the description and its two examples under the label were cut off, worst in French ("Version originale" runs to
 *   four lines; Salon, 2026-11-18). The rows now grow with their text and the list may take what both need, still
 *   inside the 540 dp screen. Rendered in French with react-test-renderer: react-native is replaced by host-element
 *   stand-ins, the profile's settings by stubs.
 *
 * @req UX-SETUP-08[badger-tv]
 */
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n } from "@space/mobile-shell/i18n";
import { TitleLanguageScreen } from "../../setup/TitleLanguageQuestion";

vi.hoisted(() => {
  // Metro turns `require("../assets/mascot.webp")` into an image reference; plain node would parse the bytes as JS.
  const { extensions } = process.getBuiltinModule("node:module").createRequire(import.meta.url);
  extensions[".webp"] = (m: { exports: unknown }) => {
    m.exports = 1;
  };
});

vi.mock("react-native", async () => {
  const host = (name: string) => name;
  return {
    ...(await import("../../../tests/setup/reactNativeMock")).reactNativeBase(),
    View: host("View"),
    Text: host("Text"),
    Pressable: host("Pressable"),
    Image: host("Image"),
    ScrollView: host("ScrollView"),
    StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1, absoluteFillObject: {}, flatten: (s: unknown) => s },
    Platform: { isTV: true, OS: "android", constants: {}, select: (o: Record<string, unknown>) => o.android ?? o.default },
    useWindowDimensions: () => ({ width: 960, height: 540 }),
  };
});
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));
vi.mock("@space/mobile-shell/theme", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@space/mobile-shell/theme")>();
  return { ...actual, useMobileShellTheme: () => actual.mergeMobileShellTheme(null) };
});
vi.mock("@space/mobile-shell/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@space/mobile-shell/i18n")>();
  return { ...actual, useTranslation: () => ({ t: actual.translate, i18n: { language: "fr" } }), getCurrentLanguage: () => "fr" };
});
vi.mock("@space/mobile-shell/components", () => ({ MobileAppBackdrop: "MobileAppBackdrop" }));
vi.mock("lucide-react-native", () => ({ Check: "Check", ChevronRight: "ChevronRight" }));
vi.mock("../../lib/profileSettings", () => ({ useActiveTitleLanguageAnswer: () => false }));
vi.mock("../../lib/titleLanguageQuestion", () => ({ answerTitleLanguage: () => undefined }));

let renderer: ReactTestRenderer | null = null;

const one = (id: string): ReactTestInstance => {
  const found = renderer!.root.findAll((node) => typeof (node.type as unknown) === "string" && node.props.testID === id);
  if (found.length !== 1) throw new Error(`expected one ${id}, found ${found.length}`);
  return found[0];
};
const flat = (node: ReactTestInstance, key = "style"): Record<string, unknown> =>
  Object.assign({}, ...[node.props[key]].flat(Infinity).filter(Boolean)) as Record<string, unknown>;
const texts = (node: ReactTestInstance) =>
  node.findAll((n) => (n.type as unknown) === "Text").map((n) => ({ text: [n.props.children].flat().join(""), style: flat(n) }));

describe("Badger TV title language question", () => {
  beforeAll(async () => {
    await initI18n("fr");
  });
  beforeEach(async () => {
    await act(async () => {
      renderer = create(<TitleLanguageScreen />);
    });
  });
  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = null;
  });

  it("@req UX-SETUP-08[badger-tv] each row grows with its description and examples: none is clipped to a fixed height", () => {
    for (const value of ["app", "original"]) {
      const row = one(`setup-choice-${value}`);
      const style = flat(row);
      const lines = texts(row);
      console.info("[TV-SETUP-TITLE-LANGUAGE-001] row", value, JSON.stringify({ style, lines: lines.map((line) => line.text) }));
      expect(style.height).toBeUndefined();
      expect(Number(style.minHeight)).toBeGreaterThan(0);
      expect(Number(style.paddingVertical)).toBeGreaterThan(0);
      expect(row.props.numberOfLines).toBeUndefined();
      // The label, then the description over its two examples, in French, no line limit.
      expect(lines).toHaveLength(2);
      expect(lines[1]!.text).toContain("\n");
      expect(lines[1]!.text).toContain(" · ");
      expect(lines.every((line) => line.style.height === undefined)).toBe(true);
      // The detail sits under the label at the TV's size, smaller than the label.
      expect(Number(lines[1]!.style.fontSize)).toBeLessThan(Number(lines[0]!.style.fontSize));
    }
    expect(texts(one("setup-choice-original"))[0]!.text).toBe("Version originale");
  });

  it("@req UX-SETUP-08[badger-tv] the list may take both grown rows, and the screen still fits 540 dp", () => {
    const scroll = one("title-language-list");
    const maxHeight = Number(flat(scroll).maxHeight);
    const content = flat(scroll, "contentContainerStyle");
    // The French "Version originale": label, a 3-line description and the examples, at 15 dp a line, with the row's padding.
    const original = 18 + 2 + 4 * 15 + 2 * 8;
    const app = 18 + 2 + 2 * 15 + 2 * 8;
    const needed = original + app + Number(content.gap) + 2 * Number(content.padding);
    console.info("[TV-SETUP-TITLE-LANGUAGE-001] list", JSON.stringify({ maxHeight, needed, content }));
    expect(maxHeight).toBeGreaterThanOrEqual(needed);
    // Mascot above the card, the card's padding, title, line, list and Next: under the screen's 540 dp.
    expect(maxHeight + 80 + 40 + 30 + 30 + 20 + 36 + 20).toBeLessThan(540);
  });
});
