/**
 * @test-id MOBILE-SHELL-ACCOUNT-PLAN-PANEL-001
 * @level unit
 * @req ACCT-PLAN-14[parrot]
 * @req ACCT-PLAN-14[badger-mobile]
 * @why The phones' one plan panel (REL-FAM-03, used by Badger's Subscription screen and Parrot's Settings): an admin
 *   reads "Admin: unlimited storage" with no plan name or state (ACCT-PLAN-14); a paid account reads its plan and
 *   renewal date; an unpaid one its wipe date; storage shows the total and one line per app (STOR-USE-01); a failed
 *   load offers a retry that loads again. Renders the real panel with react-test-renderer against the English
 *   dictionary; React Native host components are plain strings.
 */
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18next from "i18next";
import type { AccountStorageSummary, SubscriptionSummary } from "@space/shared/api";

const api = vi.hoisted(() => ({
  getSubscription: vi.fn<(token: string) => Promise<SubscriptionSummary>>(),
  getAccountStorage: vi.fn<(token: string) => Promise<AccountStorageSummary>>(),
}));
vi.mock("@space/shared/api", () => api);
vi.mock("react-native", () => ({
  StyleSheet: { create: <T,>(styles: T) => styles },
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
}));
// vi.mock factories are hoisted above every import, so this one loads the dictionary itself.
vi.mock("../src/i18n", async () => {
  const enDict = (await import("../src/i18n/en.json")).default;
  await i18next.init({
    resources: { en: { translation: enDict } },
    lng: "en",
    fallbackLng: "en",
    interpolation: { escapeValue: false },
  });
  const translate = (key: string, options?: Record<string, unknown>) => i18next.t(key, options);
  return { getCurrentLanguage: () => "en", useTranslation: () => ({ t: translate }) };
});
vi.mock("../src/theme", () => {
  const colors = new Proxy({}, { get: () => "#888" });
  return { useMobileShellTheme: () => ({ colors }) };
});
vi.mock("../src/components/mobile-founder", () => ({ MobileFounderBadge: "MobileFounderBadge" }));

import { MobileAccountPlanPanel } from "../src/components/mobile-account-plan-panel";

const Group = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <>
    {"Group"}
    {title}
    {children}
  </>
);

const STORAGE: AccountStorageSummary = {
  plan: "tier2",
  storageAddonCount: 0,
  limitBytes: 1_000_000_000_000,
  usedBytes: 3_000_000_000,
  reservedBytes: 0,
  usageRatio: 0.003,
  warningLevel: "ok",
  apps: [{ appId: "parrot", label: "Parrot", usedBytes: 3_000_000_000 }] as AccountStorageSummary["apps"],
  lastReconciledAt: null,
};

let renderer: ReactTestRenderer | null = null;
const mount = async () => {
  await act(async () => {
    renderer = create(<MobileAccountPlanPanel token="tok" Group={Group} />);
  });
  return renderer!;
};
const texts = (root: ReactTestInstance) =>
  root.findAll((node) => (node.type as unknown) === "Text").map((node) => [node.props.children].flat().join(""));
const planTexts = (r: ReactTestRenderer) => texts(r.root.find((node) => node.props.testID === "account-plan"));

beforeEach(() => {
  api.getSubscription.mockReset();
  api.getAccountStorage.mockReset();
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
});

describe("the phones' plan panel", () => {
  it("reads 'Admin: unlimited storage' for an admin, with no plan name or state", async () => {
    api.getSubscription.mockResolvedValue({ plan: "free", storageLimitGb: null, storageUsedGb: 0, storageAddonCount: 0, access: { state: "free" } } as SubscriptionSummary);
    api.getAccountStorage.mockResolvedValue({ ...STORAGE, limitBytes: null, usageRatio: 0 });
    const r = await mount();
    const plan = planTexts(r);
    console.info("[MOBILE-SHELL-ACCOUNT-PLAN-PANEL-001] admin", plan);
    expect(plan).toContain("Admin: unlimited storage");
    expect(plan.join(" ")).not.toMatch(/Free|Status/);
    expect(r.root.findAll((node) => (node.type as unknown) === "MobileFounderBadge")).toHaveLength(0);
    expect(r.root.findAll((node) => node.props.accessibilityRole === "progressbar")).toHaveLength(0);
    expect(api.getSubscription).toHaveBeenCalledWith("tok");
  });

  it("reads the plan, its state and its renewal date for a paid account, and storage per app", async () => {
    api.getSubscription.mockResolvedValue({ plan: "tier2", storageLimitGb: 1000, storageUsedGb: 3, storageAddonCount: 0, paidUntil: "2099-01-01T00:00:00.000Z", access: { state: "paid" } } as SubscriptionSummary);
    api.getAccountStorage.mockResolvedValue(STORAGE);
    const r = await mount();
    const plan = planTexts(r);
    console.info("[MOBILE-SHELL-ACCOUNT-PLAN-PANEL-001] paid", plan);
    expect(plan).toContain("Active");
    expect(plan).toContain("Renews on");
    expect(r.root.findAll((node) => (node.type as unknown) === "MobileFounderBadge")).toHaveLength(1);
    const storage = texts(r.root.find((node) => node.props.testID === "account-storage"));
    expect(storage).toContain("Parrot");
    expect(r.root.findAll((node) => node.props.accessibilityRole === "progressbar")).toHaveLength(1);
  });

  it("warns an unpaid account of the wipe date", async () => {
    api.getSubscription.mockResolvedValue({ plan: "tier1", storageLimitGb: 100, storageUsedGb: 3, storageAddonCount: 0, paidUntil: "2020-01-01T00:00:00.000Z", access: { state: "unpaid", wipeAt: "2099-12-16T12:00:00.000Z" } } as SubscriptionSummary);
    api.getAccountStorage.mockResolvedValue(STORAGE);
    const plan = planTexts(await mount());
    console.info("[MOBILE-SHELL-ACCOUNT-PLAN-PANEL-001] unpaid", plan);
    expect(plan).toContain("Ended on");
    expect(plan.some((line) => line.startsWith("Files are deleted on "))).toBe(true);
  });

  it("offers a retry after a failed load, and the retry loads again", async () => {
    api.getSubscription.mockRejectedValueOnce(new Error("offline"));
    api.getAccountStorage.mockResolvedValue(STORAGE);
    const r = await mount();
    const retry = r.root.find((node) => (node.type as unknown) === "Pressable");
    expect(r.root.findAll((node) => node.props.testID === "account-plan")).toHaveLength(0);
    api.getSubscription.mockResolvedValue({ plan: "tier2", storageLimitGb: 1000, storageUsedGb: 3, storageAddonCount: 0, access: { state: "paid" } } as SubscriptionSummary);
    await act(async () => {
      retry.props.onPress();
    });
    expect(api.getSubscription).toHaveBeenCalledTimes(2);
    expect(r.root.findAll((node) => (node.type as unknown) === "Pressable")).toHaveLength(0);
    expect(planTexts(r)).toContain("Active");
  });
});
