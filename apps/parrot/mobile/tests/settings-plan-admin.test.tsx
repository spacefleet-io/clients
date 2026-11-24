/**
 * @test-id PARROT-MOBILE-SETTINGS-PLAN-ADMIN-001
 * @level unit
 * @req ACCT-PLAN-14[parrot]
 * @why Parrot's Settings shows the phones' shared plan panel (REL-FAM-03) with the signed-in token, drawn in its own
 *   Settings cards, so an admin reads "Admin: unlimited storage" there exactly as on Badger (ACCT-PLAN-14; the panel's
 *   own cases are in packages/mobile-shell/tests/account-plan-panel.test.tsx). The screen is called as a function
 *   against a mocked React Native, the panel standing in as a tag.
 */
import { describe, expect, it, vi } from "vitest";

// The screen is called as a plain function, so its hooks hold their first value.
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
vi.mock("@space/mobile-shell/components", () => ({ MobileButton: "Button", MobileCreditsPanel: "MobileCreditsPanel", MobileErrorReportsLink: "MobileErrorReportsLink", MobileOpenSourceNotice: "MobileOpenSourceNotice", SkyCover: "SkyCover", useSkyScroll: () => ({}) }));
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

describe("Parrot's Settings plan", () => {
  it("shows the shared plan panel with the session's token, in Settings cards, right after Account", () => {
    const all = flatten(SettingsScreen() as unknown as Element);
    const panels = all.filter((el) => el.type === "MobileAccountPlanPanel");
    console.info("[PARROT-MOBILE-SETTINGS-PLAN-ADMIN-001] panels", panels.map((el) => el.props.token));
    expect(panels).toHaveLength(1);
    expect(panels[0]!.props.token).toBe("t");
    const Group = panels[0]!.props.Group as (props: { title: string; children: unknown }) => unknown;
    expect(typeof Group).toBe("function");
    const card = flatten(Group({ title: "subscription.plan.group", children: "x" }));
    expect(card.some((el) => el.type === "Text" && el.props.children === "SUBSCRIPTION.PLAN.GROUP")).toBe(true);
    const tops = (SettingsScreen() as unknown as Element).props.children as unknown[];
    const titles = flatten(tops).filter((el) => el.type === Group).map((el) => el.props.title);
    expect(titles[0]).toBe("shell.settings.section.account");
  });

  it("no longer carries its own plan row", () => {
    const names = flatten(SettingsScreen() as unknown as Element)
      .map((el) => (typeof el.type === "function" ? (el.type as { name: string }).name : el.type));
    expect(names).not.toContain("PlanRow");
    expect(names).not.toContain("MobileFounderBadge");
  });
});
