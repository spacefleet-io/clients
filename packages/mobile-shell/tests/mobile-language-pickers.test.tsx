/**
 * @test-id MOBILE-SHELL-LANGUAGE-PICKERS-001
 * @level unit
 * @why Chris 2026-11-12 (chat): "The language picker menus should be coherent everywhere: (1) they should always have
 *   flags (I think the mobile app doesn't show flags in its opening list) (2) either all the language names are shown in
 *   the current language, or they are shown in their respective language." The phone's first-run list (Badger and
 *   Parrot setup, Badger TV's language screen) and the sign-in screen's language menu show each language's SVG flag and
 *   its own name, in the shared order.
 */
// @req UX-I18N-10[badger-mobile,badger-tv,parrot]
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { CLIENT_UI_LANGUAGES } from "@space/shared/i18n";
import { FLAG_SVGS } from "@space/shared/languageFlags";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  // The phone list here; the TV list is checked by Badger TV's language step test (UX-TV-32).
  Platform: { isTV: false },
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
vi.mock("lucide-react-native", () => ({ Check: "Check", ChevronDown: "ChevronDown", ChevronUp: "ChevronUp", Globe: "Globe" }));
vi.mock("../src/keyboard", () => ({ KeyboardAvoidingForm: "KeyboardAvoidingForm" }));
vi.mock("../src/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../src/components/mobile-render-boundary", () => ({
  MobileRenderBoundary: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("../src/theme", () => ({
  useMobileShellTheme: () => ({
    colors: { accent: "#ffb357", text: "#fff", textMuted: "#aaa", border: "#333", surface: "#111", controlBorder: "#444" },
    radius: { md: 12 },
    spacing: { sm: 8, md: 12 },
    font: { size: { md: 16, sm: 13 }, family: { sans: "Inter" } },
  }),
}));

import { MobileFlag } from "../src/components/mobile-flag";
import { MobileChoiceList } from "../src/components/mobile-setup-step";
import { MobileLanguageMenu } from "../src/components/mobile-language-menu";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const LOG = "[MOBILE-SHELL-LANGUAGE-PICKERS-001]";
const SHARED = CLIENT_UI_LANGUAGES.map((language) => `${language.code}:${language.nativeName}`);

type Node = ReactTestRenderer["root"];
const hostRows = (renderer: ReactTestRenderer, prefix: string) =>
  renderer.root.findAll((node: Node) => String(node.type) === "Pressable" && String(node.props.testID ?? "").startsWith(prefix));
const flagOf = (row: Node) => {
  const [flag] = row.findAll((node: Node) => String(node.type) === "View" && String(node.props.testID ?? "").startsWith("flag-"));
  return flag ? String(flag.props.testID).slice("flag-".length) : "-";
};

describe("phone and TV language pickers", () => {
  it("the setup's language list shows each language's flag and its own name, in the shared order", () => {
    let renderer!: ReactTestRenderer;
    const onSelect = vi.fn();
    act(() => {
      renderer = create(
        <MobileChoiceList
          choices={CLIENT_UI_LANGUAGES.map((language) => ({ value: language.code, label: language.nativeName, lead: <MobileFlag code={language.code} /> }))}
          selected="nl"
          onSelect={onSelect}
        />,
      );
    });
    const rows = hostRows(renderer, "setup-choice-");
    const seen = rows.map((row) => `${flagOf(row)}:${row.props.accessibilityLabel}`);
    console.info(LOG, "setup list", JSON.stringify(seen));
    expect(seen).toEqual(SHARED);
    // Each flag is the Noto emoji artwork drawn from its SVG, not emoji text: one SvgXml inside the flag's box.
    expect(rows.map((row) => row.findAll((node: Node) => String(node.type) === "SvgXml").map((node: Node) => node.props.xml))).toEqual(
      CLIENT_UI_LANGUAGES.map((language) => [FLAG_SVGS[language.code]]),
    );
    act(() => rows[3]?.props.onPress());
    expect(onSelect).toHaveBeenCalledWith("de");
  });

  it("the sign-in screen's language menu shows the same flags and names", () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<MobileLanguageMenu current="fr" onSelect={() => undefined} languages={CLIENT_UI_LANGUAGES} />);
    });
    const rows = hostRows(renderer, "language-option-");
    const seen = rows.map((row) => `${flagOf(row)}:${row.props.accessibilityLabel}`);
    console.info(LOG, "sign-in menu", JSON.stringify(seen));
    expect(seen).toEqual(SHARED);
  });

  it("draws no flag for a code that is not a language", () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<MobileFlag code="auto" />);
    });
    expect(renderer.toJSON()).toBeNull();
  });
});
