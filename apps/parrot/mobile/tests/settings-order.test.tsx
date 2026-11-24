/**
 * @test-id PARROT-MOBILE-SETTINGS-ORDER-001
 * @level unit
 * @req PAR-NAV-02[parrot]
 * @req PAR-NAV-04[parrot]
 * @why The phone's Settings tab lists, in this order: Account (signed in as, the plan, pair a device), Language, Even
 *   out volume, Feedback, Library (refresh, error reports), then Sign out. Where profiles (ACCT-PROF-01) and the
 *   credits (UX-SET-02) sit among them is open (PAR-NAV-03); this pins today's place, after Account and before Sign
 *   out. The page has no title: the tab bar names it (PAR-NAV-04), so Account comes first. The screen is called as a
 *   function against a mocked React Native, with translation keys standing for texts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { setErrorReportsOffered } from "@space/mobile-shell/error-reports-offered";

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  const useEffect = () => undefined;
  const useState = <T,>(initial: T | (() => T)) => [typeof initial === "function" ? (initial as () => T)() : initial, () => undefined];
  return { ...actual, default: { ...actual, useEffect, useState }, useEffect, useState };
});
vi.mock("react-native", () => ({
  ScrollView: "ScrollView",
  StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles, hairlineWidth: 1 },
  Switch: "Switch",
  Text: "Text",
  View: "View",
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: () => undefined }) }));
vi.mock("@space/mobile-shell/account-plan-panel", () => ({ MobileAccountPlanPanel: "MobileAccountPlanPanel" }));
vi.mock("@space/mobile-shell/components", () => ({ MobileButton: "Button", MobileCreditsPanel: "MobileCreditsPanel", MobileOpenSourceNotice: "MobileOpenSourceNotice", SkyCover: "SkyCover", useSkyScroll: () => ({}) }));
vi.mock("@space/mobile-shell/feedback-form", () => ({ MobileFeedbackForm: "MobileFeedbackForm" }));
vi.mock("@space/mobile-shell/i18n", () => ({
  getCurrentLanguage: () => "en",
  MOBILE_UI_LANGUAGES: [],
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@space/mobile-shell/setup-step", () => ({ MobileChoiceList: "MobileChoiceList" }));
vi.mock("@space/mobile-shell/flag", () => ({ MobileFlag: "MobileFlag" }));
// The self-update block (REL-UPD-06) pulls in the real render boundary and its star sky, whose react-native-svg
// require()s the untransformed react-native entry (Flow) past the mock, so it stands in as a tag like the other parts.
vi.mock("@space/mobile-self-update", () => ({ SelfUpdateSettings: "SelfUpdateSettings" }));
vi.mock("@space/mobile-shell/logger", () => ({ readErrorLog: async () => "", scopeLogger: () => ({ info: () => undefined, warn: () => undefined }) }));
vi.mock("../src/lib/accountLanguage", () => ({ pickSignedInLanguage: async () => undefined }));
vi.mock("../src/lib/errorReports", () => ({ getErrorReportsSetting: () => ({ errorReports: false }), setErrorReports: async () => undefined, subscribeErrorReportsSetting: () => () => undefined }));
vi.mock("../src/lib/evenVolume", () => ({ getEvenVolume: () => ({ on: false, level: "normal" }), setEvenVolume: async () => undefined, subscribeEvenVolume: () => () => undefined }));
vi.mock("../src/lib/feedback", () => ({ parrotFeedbackDevice: () => ({}), sendParrotFeedback: async () => undefined }));
vi.mock("../src/lib/profiles", () => ({ useProfiles: () => ({ profiles: [], activeId: null }) }));
vi.mock("../src/lib/lookup", () => ({ parrotCreditsSource: { load: null, store: null } }));
vi.mock("../src/state/session", () => ({
  useSession: () => ({ session: { token: "t", user: { email: "celeste@spacefleet.test" } }, reloadLibrary: async () => undefined }),
}));
vi.mock("../src/state/useSignOut", () => ({ useSignOut: () => async () => undefined }));
vi.mock("../src/screens/ui", () => ({ Body: "Body" }));

import { SettingsScreen } from "../src/screens/SettingsScreen";

type Element = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
const flatten = (node: unknown, out: Element[] = []): Element[] => {
  if (Array.isArray(node)) node.forEach((child) => flatten(child, out));
  else if (node && typeof node === "object" && "props" in node) {
    out.push(node as Element);
    flatten((node as Element).props.children, out);
  }
  return out;
};

describe("the phone's Settings tab", () => {
  it("reads Account, Language, Even out volume, Feedback, Library, then Sign out", () => {
    const screen = SettingsScreen() as unknown as Element;
    // Each section is a `Section` with a title, the profiles card is its own component, and Sign out is the last button.
    const order = flatten(screen).flatMap((el) => {
      if (typeof el.props.title === "string") return [el.props.title];
      if (typeof el.type === "function" && el.type.name === "ProfilesSection") return ["profiles"];
      if (el.type === "Button" && el.props.label === "parrot.settings.signOut") return ["signOut"];
      return [];
    });
    console.info("[PARROT-MOBILE-SETTINGS-ORDER-001] order", JSON.stringify(order));
    // No page title (PAR-NAV-04): the page's first child is the Account section, and nothing on it is a heading.
    const first = [screen.props.children].flat().find((child) => child !== null && child !== undefined && child !== false) as Element;
    expect(first.props.title).toBe("shell.settings.section.account");
    expect(flatten(screen).filter((el) => el.props.accessibilityRole === "header")).toHaveLength(0);
    expect(order).toEqual([
      "shell.settings.section.account",
      "profiles",
      "parrot.settings.language",
      "shell.settings.evenVolume",
      "feedback.entry",
      "parrot.settings.library",
      "parrot.settings.openSource",
      "signOut",
    ]);
    // Library holds refresh and the error reports switch.
    const library = flatten(screen).find((el) => el.props.title === "parrot.settings.library")!;
    const inside = flatten(library.props.children);
    expect(inside.some((el) => el.props.testID === "settings-refresh")).toBe(true);
    expect(inside.some((el) => typeof el.type === "function" && el.type.name === "ErrorReportsSwitch")).toBe(true);
  });

  // @req REL-LOG-06[parrot]
  it("a build with no reporting address has no error reports switch (#2570)", () => {
    setErrorReportsOffered("");
    const library = flatten(SettingsScreen() as unknown as Element).find((el) => el.props.title === "parrot.settings.library")!;
    const inside = flatten(library.props.children);
    console.info("[PARROT-MOBILE-SETTINGS-ORDER-001] foss library", JSON.stringify(inside.map((el) => el.props.testID ?? (typeof el.type === "function" ? el.type.name : el.type))));
    expect(inside.some((el) => el.props.testID === "settings-refresh")).toBe(true);
    expect(inside.some((el) => typeof el.type === "function" && el.type.name === "ErrorReportsSwitch")).toBe(false);
  });

  afterEach(() => setErrorReportsOffered("https://key@errors.example.test/9"));
});
