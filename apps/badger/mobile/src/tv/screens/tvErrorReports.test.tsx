/**
 * @test-id TV-ERROR-REPORTS-001
 * @level component
 * @why The "Send error reports?" setup step is the first question a TV asks after sign-in. On a real TV (SDMC QS02,
 *   2026-10-26) the remote moved focus between its two answers but neither one looked different while focused, so the
 *   user could not tell what OK would pick and was stuck. On TV each answer must show it has the remote's focus, and
 *   neither may be styled as the preferred one (REL-LOG-06); the remote starts on "No" so a screen never opens with
 *   nothing focused (UX-TV-15, Google TV "Salon", 2026-11-08). Rendered with react-test-renderer:
 *   react-native is replaced by host-element stand-ins and the stored settings by an in-memory store.
 *
 * @req REL-LOG-06[badger-tv]
 * @req UX-TV-15
 * @req UX-TV-04
 * @req UX-SETUP-08[badger-tv]
 * @req UX-TV-34[badger-tv]
 * @req UX-TV-35[badger-tv]
 */
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n } from "@space/mobile-shell/i18n";
import { ErrorReportsScreen } from "../../screens/ErrorReportsScreen";
import { setupMascotOverlap, TV_SETUP_MASCOT_SIZE } from "@space/mobile-shell/setup-step";

const ctl = vi.hoisted(() => {
  // Metro turns `require("../assets/mascot.webp")` into an image reference; plain node would parse the bytes as JS.
  const { extensions } = process.getBuiltinModule("node:module").createRequire(import.meta.url);
  extensions[".webp"] = (m: { exports: unknown }) => {
    m.exports = 1;
  };
  return {
    patches: [] as Array<Record<string, unknown>>,
    // The TV's setup progress (UX-SETUP-08): a password sign-in by default, so error reports is step 2 of 2.
    progress: { step: "signIn", pairedKey: false } as { step: "signIn"; pairedKey: boolean },
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
  return { ...actual, useTranslation: () => ({ t: actual.translate, i18n: { language: "en" } }) };
});
vi.mock("@space/mobile-shell/components", () => ({
  MobileButton: "MobileButton",
  MobileInput: "MobileInput",
  MobileCard: "MobileCard",
  SkyCover: "SkyCover",
  MobileAppBackdrop: "MobileAppBackdrop",
  MobileScreen: ({ children }: { children: React.ReactNode }) => children,
  useSkyScroll: () => ({}),
}));
vi.mock("lucide-react-native", () => ({ Check: "Check", Globe: "Globe" }));
vi.mock("../../lib/appSettings", () => ({
  useAppSettings: () => [{}, (patch: Record<string, unknown>) => ctl.patches.push(patch)],
}));
vi.mock("../lib/tvSetupStore", () => ({ useTvSetupProgress: () => ctl.progress }));

let renderer: ReactTestRenderer | null = null;

const one = (id: string): ReactTestInstance => {
  const found = renderer!.root.findAll((node) => typeof (node.type as unknown) === "string" && node.props.testID === id);
  if (found.length !== 1) throw new Error(`expected one ${id}, found ${found.length}`);
  return found[0];
};
const flat = (style: unknown): Record<string, unknown> =>
  Array.isArray(style) ? Object.assign({}, ...style.flat(Infinity).filter(Boolean)) : ((style ?? {}) as Record<string, unknown>);
const looks = (id: string) => {
  const node = one(id);
  const s = flat(node.props.style);
  return { borderColor: s.borderColor, outlineWidth: s.outlineWidth, transform: JSON.stringify(s.transform ?? null), backgroundColor: s.backgroundColor };
};

describe("TV error reports question", () => {
  beforeAll(async () => {
    await initI18n("en");
  });
  beforeEach(async () => {
    ctl.patches = [];
    await act(async () => {
      renderer = create(<ErrorReportsScreen />);
    });
  });
  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = null;
  });

  it("@req REL-LOG-06 shows which answer has the remote's focus", async () => {
    for (const id of ["error-reports-send", "error-reports-decline"]) {
      const node = one(id);
      expect(node.props.focusable).toBe(true);
      const idle = looks(id);
      await act(async () => node.props.onFocus());
      const focused = looks(id);
      expect(focused).not.toEqual(idle);
      await act(async () => one(id).props.onBlur());
      expect(looks(id)).toEqual(idle);
    }
  });

  it("@req REL-LOG-06 styles both answers alike", () => {
    expect(looks("error-reports-send")).toEqual(looks("error-reports-decline"));
  });

  // @bugfix: on the real Google TV "Salon" (2026-11-08) no answer had the focus until a direction was pressed.
  it("@req UX-TV-15 the remote starts on No, so OK never turns sending on by itself", () => {
    console.log("[tvErrorReports] preferred focus", {
      send: one("error-reports-send").props.hasTVPreferredFocus,
      decline: one("error-reports-decline").props.hasTVPreferredFocus,
    });
    expect(one("error-reports-send").props.hasTVPreferredFocus).toBeFalsy();
    expect(one("error-reports-decline").props.hasTVPreferredFocus).toBe(true);
  });

  it("@req REL-LOG-06 saves the answer picked with OK", async () => {
    await act(async () => one("error-reports-decline").props.onPress());
    await act(async () => one("error-reports-send").props.onPress());
    expect(ctl.patches).toEqual([{ errorReports: false }, { errorReports: true }]);
  });

  it("@req UX-TV-04 asks as the approved TV design: the astronaut badger, the one line and the footer, over the sky", () => {
    const texts = renderer!.root
      .findAll((node) => (node.type as unknown) === "Text")
      .map((node) => [node.props.children].flat().join(""));
    console.info("[TV-ERROR-REPORTS-001] texts", JSON.stringify(texts));
    expect(texts).toEqual(
      expect.arrayContaining([
        "Help us fix problems?",
        // REL-LOG-06 (Chris 2026-11-11): one friendly line replaces the two promises; no link, a TV has no browser.
        "Reports are anonymous and help us a lot to fix bugs 🙂",
        "Send reports",
        "Don't send",
        "You can change this any time in Settings.",
      ]),
    );
    expect(renderer!.root.findAll((node) => (node.type as unknown) === "Image")).toHaveLength(1);
    expect(renderer!.root.findAll((node) => (node.type as unknown) === "MobileAppBackdrop")).toHaveLength(1);
    // The family's pill answers (approved TV design, Chris 2026-11-12 (chat)).
    expect(flat(one("error-reports-send").props.style).borderRadius).toBe(999);
  });

  it("@req UX-SETUP-08[badger-tv] the setup mascot sits half over the panel's top border, the panel padded under it", () => {
    const mascot = one("error-reports-mascot");
    const panel = one("error-reports-panel");
    const order = renderer!.root
      .findAll((node) => typeof (node.type as unknown) === "string" && typeof node.props.testID === "string")
      .map((node) => node.props.testID as string);
    console.info("[TV-ERROR-REPORTS-001] mascot", { order, wrap: flat(mascot.props.style), panelTop: flat(panel.props.style).paddingTop });
    // Outside the panel, drawn before it: its negative margin pulls the panel up under its lower part.
    expect(order.indexOf("error-reports-mascot")).toBe(order.indexOf("error-reports-panel") - 1);
    expect(panel.findAll((node) => node.props.testID === "error-reports-mascot")).toHaveLength(0);
    expect(Number(flat(mascot.props.style).marginBottom)).toBeCloseTo(-setupMascotOverlap(TV_SETUP_MASCOT_SIZE));
    expect(flat(mascot.props.style).height).toBe(TV_SETUP_MASCOT_SIZE);
    expect(Number(flat(panel.props.style).paddingTop)).toBeGreaterThan(setupMascotOverlap(TV_SETUP_MASCOT_SIZE));
  });

  it("@req UX-TV-35 the focused answer takes the amber ring outside its edge, with a gap", async () => {
    await act(async () => one("error-reports-send").props.onFocus());
    const focused = flat(one("error-reports-send").props.style);
    expect(Number(focused.outlineWidth)).toBeGreaterThan(0);
    expect(Number(focused.outlineOffset)).toBeGreaterThan(0);
    expect(flat(one("error-reports-decline").props.style).outlineWidth).toBeUndefined();
  });
});

describe("TV error reports as a numbered setup step", () => {
  beforeAll(async () => {
    await initI18n("en");
  });
  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = null;
    ctl.progress = { step: "signIn", pairedKey: false };
  });

  const indicator = async (pairedKey: boolean) => {
    ctl.progress = { step: "signIn", pairedKey };
    await act(async () => {
      renderer = create(<ErrorReportsScreen />);
    });
    const text = [one("setup-step-indicator").props.children].flat().join("");
    console.info("[TV-ERROR-REPORTS-001] step", { pairedKey, text });
    return text;
  };

  it("@req UX-SETUP-08[badger-tv] after a password sign-in it is step 2 of 2 (the key was step 1)", async () => {
    expect(await indicator(false)).toBe("STEP 2 OF 2");
  });

  it("@req UX-SETUP-08[badger-tv] after pairing (the key came with it) it is step 1 of 1", async () => {
    expect(await indicator(true)).toBe("STEP 1 OF 1");
  });

  it("@req UX-SETUP-08[badger-tv] the count and the bar sit inside the card at its top, above the title; the language button stays in the screen's corner", async () => {
    ctl.progress = { step: "signIn", pairedKey: false };
    await act(async () => {
      renderer = create(<ErrorReportsScreen />);
    });
    const panel = one("error-reports-panel");
    const inPanel = panel
      .findAll((node) => typeof (node.type as unknown) === "string" && (typeof node.props.testID === "string" || node.props.accessibilityRole === "header"))
      .map((node) => (node.props.accessibilityRole === "header" ? "title" : (node.props.testID as string)))
      .filter((id) => id !== "error-reports-panel");
    console.info("[TV-ERROR-REPORTS-001] panel order", inPanel);
    // Approved `tv-step.png`: "STEP N OF M" at the card's top left, the bar under it (as on the desktop's card), then the title.
    expect(inPanel.slice(0, 3)).toEqual(["setup-step-bar", "setup-step-indicator", "title"]);
    expect(flat(one("setup-step-indicator").props.style).textAlign).toBeUndefined();
    expect(panel.findAll((node) => node.props.testID === "setup-language-menu")).toHaveLength(0);
    expect(one("setup-language-menu")).toBeTruthy();
  });
});
