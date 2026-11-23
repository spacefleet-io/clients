/**
 * @test-id PARROT-MOBILE-SETTINGS-PLAN-ADMIN-001
 * @level unit
 * @req ACCT-PLAN-14[parrot]
 * @why An admin has no plan and unlimited storage (ACCT-PLAN-14): the phone's plan row reads "Admin: unlimited
 *   storage", never a plan name and paid state, while a normal account still shows its plan. The API marks an admin
 *   with a null `storageLimitGb`. The row is called as a function against a mocked React Native, with translation keys
 *   standing for texts and `useState` fed from a queue.
 */
import { describe, expect, it, vi } from "vitest";

const stateQueue: unknown[] = [];
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  const useEffect = () => undefined;
  const useState = <T,>(initial: T | (() => T)) => [
    stateQueue.length > 0 ? stateQueue.shift() : typeof initial === "function" ? (initial as () => T)() : initial,
    () => undefined,
  ];
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
vi.mock("@space/shared/api", () => ({ getSubscription: async () => null }));
vi.mock("@space/mobile-shell/components", () => ({ MobileCreditsPanel: "MobileCreditsPanel", MobileFounderBadge: "MobileFounderBadge", MobileOpenSourceNotice: "MobileOpenSourceNotice", SkyCover: "SkyCover", useSkyScroll: () => ({}) }));
vi.mock("@space/mobile-shell/feedback-form", () => ({ MobileFeedbackForm: "MobileFeedbackForm" }));
vi.mock("@space/mobile-shell/i18n", () => ({
  getCurrentLanguage: () => "en",
  MOBILE_UI_LANGUAGES: [],
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@space/mobile-shell/setup-step", () => ({ MobileChoiceList: "MobileChoiceList" }));
vi.mock("@space/mobile-shell/flag", () => ({ MobileFlag: "MobileFlag" }));
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
vi.mock("../src/screens/ui", () => ({ Body: "Body", Button: "Button" }));

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

/** Renders the Settings tab, finds its plan row and calls it with `plan` as the loaded subscription. */
const planRowText = (plan: Record<string, unknown>): string => {
  const screen = SettingsScreen() as unknown as Element;
  const row = flatten(screen).find((el) => typeof el.type === "function" && (el.type as { name: string }).name === "PlanRow")!;
  expect(row).toBeDefined();
  stateQueue.push(plan, false);
  const rendered = (row.type as (props: unknown) => unknown)(row.props) as Element;
  const value = flatten(rendered).find((el) => el.type === "Text")!;
  return [value.props.children].flat().join("");
};

describe("the phone's plan row", () => {
  it("reads 'Admin: unlimited storage' for an admin, with no plan name", () => {
    const text = planRowText({ plan: "free", storageLimitGb: null, storageUsedGb: 0, storageAddonCount: 0, access: { state: "free" } });
    console.info("[PARROT-MOBILE-SETTINGS-PLAN-ADMIN-001] admin row", text);
    expect(text).toBe("subscription.plan.adminUnlimited");
    expect(text).not.toContain("subscription.planName");
  });

  it("still reads the plan and its state for a normal account", () => {
    const text = planRowText({ plan: "tier2", storageLimitGb: 1000, storageUsedGb: 3, storageAddonCount: 0, access: { state: "paid" } });
    console.info("[PARROT-MOBILE-SETTINGS-PLAN-ADMIN-001] paid row", text);
    expect(text).toBe("subscription.planName.tier2 · subscription.status.active");
  });
});
