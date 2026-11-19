/**
 * @test-id TV-SETUP-LANGUAGE-001
 * @level component
 * @why Badger TV's step 0 (UX-SETUP-08, Chris 2026-11-11): "Choose your language" before the sign-in, with no
 *   "step N of M" (the language and the sign-in are not counted). The phone's scrolling language list, moved through
 *   with the remote: every row takes the D-pad focus and shows it, the remote starts on the TV's current language. A
 *   pick switches the app at once (kept on this TV: no account yet); Next marks the language as chosen so the
 *   navigator moves on to the sign-in. Rendered with react-test-renderer: react-native is replaced by host-element
 *   stand-ins, the language switch and the TV's progress store by spies.
 *
 * @req UX-SETUP-08[badger-tv]
 * @req UX-SETUP-04[badger-tv]
 * @req UX-TV-20[badger-tv]
 * @req UX-TV-32[badger-tv]
 */
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n, MOBILE_UI_LANGUAGES } from "@space/mobile-shell/i18n";
import { setupMascotOverlap, TV_SETUP_MASCOT_SIZE } from "@space/mobile-shell/setup-step";
import { TvLanguageScreen } from "./TvLanguageScreen";

const ctl = vi.hoisted(() => {
  // Metro turns `require("../../assets/mascot.webp")` into an image reference; plain node would parse the bytes as JS.
  const { extensions } = process.getBuiltinModule("node:module").createRequire(import.meta.url);
  extensions[".webp"] = (m: { exports: unknown }) => {
    m.exports = 1;
  };
  return {
    picks: [] as Array<[string, unknown]>,
    saved: [] as Array<Record<string, unknown>>,
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
  return { ...actual, useTranslation: () => ({ t: actual.translate, i18n: { language: "en" } }), getCurrentLanguage: () => "en" };
});
vi.mock("@space/mobile-shell/components", () => ({ MobileAppBackdrop: "MobileAppBackdrop" }));
vi.mock("lucide-react-native", () => ({ Check: "Check", ChevronRight: "ChevronRight" }));
vi.mock("../../lib/uiLanguage", () => ({
  chooseUiLanguage: async (code: string, options: unknown) => {
    ctl.picks.push([code, options]);
  },
}));
vi.mock("../lib/tvSetupStore", () => ({
  getTvSetup: () => ({ step: "language", pairedKey: false }),
  saveTvSetup: async (next: Record<string, unknown>) => {
    ctl.saved.push(next);
  },
}));

let renderer: ReactTestRenderer | null = null;

const all = (id: string): ReactTestInstance[] =>
  renderer!.root.findAll((node) => typeof (node.type as unknown) === "string" && node.props.testID === id);
const one = (id: string): ReactTestInstance => {
  const found = all(id);
  if (found.length !== 1) throw new Error(`expected one ${id}, found ${found.length}`);
  return found[0];
};

describe("Badger TV language step", () => {
  beforeAll(async () => {
    await initI18n("en");
  });
  beforeEach(async () => {
    ctl.picks = [];
    ctl.saved = [];
    await act(async () => {
      renderer = create(<TvLanguageScreen />);
    });
  });
  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = null;
  });

  it("@req UX-SETUP-08[badger-tv] asks 'Choose your language' with no step count", () => {
    const texts = renderer!.root
      .findAll((node) => (node.type as unknown) === "Text")
      .map((node) => [node.props.children].flat().join(""));
    console.info("[TV-SETUP-LANGUAGE-001] texts", JSON.stringify(texts));
    expect(texts).toContain("Choose your language");
    expect(all("setup-step-indicator")).toHaveLength(0);
    expect(texts.some((text) => /step \d+ of \d+/i.test(text))).toBe(false);
  });

  it("@req UX-SETUP-08[badger-tv] lists every app language, each row reachable with the remote, starting on the current one", async () => {
    const rows = MOBILE_UI_LANGUAGES.map((option) => one(`setup-choice-${option.code}`));
    console.info("[TV-SETUP-LANGUAGE-001] rows", rows.map((row) => ({ id: row.props.testID, focusable: row.props.focusable, preferred: row.props.hasTVPreferredFocus })));
    expect(rows.every((row) => row.props.focusable === true)).toBe(true);
    expect(one("setup-choice-en").props.hasTVPreferredFocus).toBe(true);
    expect(rows.filter((row) => row.props.hasTVPreferredFocus)).toHaveLength(1);
    // The row with the remote's focus shows it; the ring goes when the focus moves on.
    expect(all("setup-choice-fr-focus")).toHaveLength(0);
    await act(async () => one("setup-choice-fr").props.onFocus());
    expect(all("setup-choice-fr-focus")).toHaveLength(1);
    await act(async () => one("setup-choice-fr").props.onBlur());
    expect(all("setup-choice-fr-focus")).toHaveLength(0);
  });

  it("@req UX-SETUP-08[badger-tv] a pick switches the app's language at once, kept on this TV", async () => {
    await act(async () => one("setup-choice-fr").props.onPress());
    console.info("[TV-SETUP-LANGUAGE-001] picks", JSON.stringify(ctl.picks));
    expect(ctl.picks).toEqual([["fr", { pushToAccount: false }]]);
    expect(one("setup-choice-fr").props.hasTVPreferredFocus).toBe(true);
  });

  it("@req UX-TV-20[badger-tv] @bugfix the list's scrolling view has no border or padding, so Down from the last row reaches Next", () => {
    // Android's ScrollView hands Down on to the next control only once its own sums say the list is at its end. A
    // border on the scrolling view itself shifted its rows by the border's width, so those sums always wanted 2 more
    // pixels than React Native lets it scroll: Down at the last row "scrolled" by nothing forever and never reached
    // Next (Google TV "Salon", 2026-11-12). The border is drawn by a plain view around the list instead.
    const scroll = one("setup-language-list");
    const style = Object.assign({}, ...[scroll.props.style].flat(Infinity).filter(Boolean)) as Record<string, unknown>;
    const frame = Object.assign({}, ...[scroll.parent!.props.style].flat(Infinity).filter(Boolean)) as Record<string, unknown>;
    console.info("[TV-SETUP-LANGUAGE-001] list style", JSON.stringify(style), "frame style", JSON.stringify(frame));
    expect(scroll.type).toBe("ScrollView");
    const offsets = ["borderWidth", "borderTopWidth", "borderBottomWidth", "padding", "paddingTop", "paddingBottom", "paddingVertical"];
    expect(offsets.filter((key) => Number(style[key] ?? 0) !== 0)).toEqual([]);
    // On TV the rows are cards of their own (UX-TV-32): the frame around the list draws no border either.
    expect(frame.borderWidth ?? 0).toBe(0);
    expect(frame.overflow).toBe("hidden");
  });

  const flat = (node: ReactTestInstance): Record<string, unknown> =>
    Object.assign({}, ...[node.props.style].flat(Infinity).filter(Boolean)) as Record<string, unknown>;

  it("@req UX-TV-32[badger-tv] shows the badger over one card: title, line, language rows, then Next at the bottom right", () => {
    const card = one("tv-language-card");
    // The badger sits above the card, not in it.
    expect(card.findAll((node) => node.props.testID === "tv-language-mascot")).toHaveLength(0);
    expect(all("tv-language-mascot")).toHaveLength(1);
    const ids = card.findAll((node) => typeof node.props.testID === "string").map((node) => String(node.props.testID));
    expect(ids.indexOf("setup-language-list")).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf("setup-next")).toBeGreaterThan(ids.indexOf("setup-language-list"));
    const foot = one("tv-language-foot");
    expect(flat(foot).justifyContent).toBe("flex-end");
    expect(foot.findAll((node) => node.props.testID === "setup-next" && (node.type as unknown) === "Pressable")).toHaveLength(1);
    expect(one("setup-next").findAll((node) => (node.type as unknown) === "ChevronRight")).toHaveLength(1);
  });

  it("@req UX-SETUP-08[badger-tv] all five languages fit the list at once: Español is in view with no scroll", () => {
    const scroll = one("setup-language-list");
    const content = Object.assign({}, ...[scroll.props.contentContainerStyle].flat(Infinity).filter(Boolean)) as Record<string, unknown>;
    const rows = MOBILE_UI_LANGUAGES.map((option) => flat(one(`setup-choice-${option.code}`)));
    const needed =
      rows.reduce((sum, row) => sum + Number(row.height ?? row.minHeight), 0) + (rows.length - 1) * Number(content.gap ?? 0) + 2 * Number(content.padding ?? 0);
    const maxHeight = Number(flat(scroll).maxHeight);
    console.info("[TV-SETUP-LANGUAGE-001] list fit", { languages: rows.length, needed, maxHeight });
    expect(MOBILE_UI_LANGUAGES.map((option) => option.code)).toEqual(["en", "fr", "nl", "de", "es"]);
    expect(maxHeight).toBeGreaterThanOrEqual(needed);
  });

  it("@req UX-SETUP-08[badger-tv] the setup mascot sits half over the card's top border, the card padded under it", () => {
    const mascot = one("tv-language-mascot");
    const card = one("tv-language-card");
    const order = renderer!.root
      .findAll((node) => typeof (node.type as unknown) === "string" && typeof node.props.testID === "string")
      .map((node) => String(node.props.testID));
    console.info("[TV-SETUP-LANGUAGE-001] mascot", { order: order.slice(0, 3), wrap: flat(mascot), cardTop: flat(card).paddingTop });
    expect(order.indexOf("tv-language-mascot")).toBe(order.indexOf("tv-language-card") - 1);
    expect(flat(mascot).height).toBe(TV_SETUP_MASCOT_SIZE);
    expect(Number(flat(mascot).marginBottom)).toBeCloseTo(-setupMascotOverlap(TV_SETUP_MASCOT_SIZE));
    expect(Number(flat(card).paddingTop)).toBeGreaterThan(setupMascotOverlap(TV_SETUP_MASCOT_SIZE));
  });

  it("@req UX-TV-32[badger-tv] each language is a card of its own; the picked one is outlined in amber with a check", () => {
    const en = one("setup-choice-en");
    const fr = one("setup-choice-fr");
    expect(flat(en).borderRadius).toBe(8);
    expect(String(flat(en).borderColor).toLowerCase()).toMatch(/^#ffb357/);
    expect(String(flat(fr).borderColor).toLowerCase()).not.toMatch(/^#ffb357/);
    expect(en.findAll((node) => (node.type as unknown) === "Check")).toHaveLength(1);
    expect(fr.findAll((node) => (node.type as unknown) === "Check")).toHaveLength(0);
  });

  it("@req UX-SETUP-04[badger-tv] Next marks the language as chosen, so the sign-in shows", async () => {
    await act(async () => one("setup-choice-de").props.onPress());
    await act(async () => one("setup-next").props.onPress());
    console.info("[TV-SETUP-LANGUAGE-001] saved", JSON.stringify(ctl.saved));
    expect(ctl.saved).toEqual([{ step: "signIn", pairedKey: false, language: "de" }]);
  });
});
