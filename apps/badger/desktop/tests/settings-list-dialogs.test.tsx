// @vitest-environment jsdom
/**
 * UX-LIST-01: on a settings page a long or data-driven list (trailer language picker, sponsorships)
 * shows as one short row/button; the full list opens in a dialog that scrolls on its own.
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MEDIA_LANGUAGE_OPTIONS } from "@space/shared";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  getSubscription: vi.fn(),
  getAccountStorage: vi.fn(),
  getSponsorships: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  updateSubscription: vi.fn(),
  getBillingStatus: vi.fn(async () => ({ provider: "standin", checkoutAllowed: false, checkoutBlockedReason: "billing_provider_standin", subscription: null })),
}));
const settings = vi.hoisted(() => ({
  config: {
    trailerSource: { provider: "youtube", invidiousUrl: "", validated: false },
    trailerLanguages: { extras: [] as string[] },
  },
  setConfig: vi.fn(),
  updateSetting: vi.fn(),
  updateNestedSetting: vi.fn(),
}));

vi.mock("@/api", () => api);
vi.mock("@/auth", () => ({
  useAuth: () => ({ token: "tok-1", user: { id: "u1", preferences: {} }, setUser: vi.fn() }),
}));
// `t` must be referentially stable: the account section re-fetches whenever `t` changes.
const i18n = vi.hoisted(() => ({
  t: (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}|${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(",")}` : key,
  i18n: { language: "en" },
}));
vi.mock("react-i18next", () => ({ useTranslation: () => i18n }));
vi.mock("@space/ui", async (importOriginal) => ({ ...(await importOriginal<typeof import("@space/ui")>()), toast: vi.fn() }));
vi.mock("@space/desktop-shell/components", () => ({ AccountStorageCard: () => <div /> }));
vi.mock("@/lib/settings/useClientSettings", () => ({ useClientSettings: () => settings }));
vi.mock("@/lib/libraryContext", () => ({ useLibraryActions: () => ({ setSharedSetting: vi.fn(async () => undefined) }) }));

import TrailersSection from "../src/renderer/src/components/settings/sections/TrailersSection";
import AccountSection from "../src/renderer/src/components/settings/sections/AccountSection";

let container: HTMLDivElement;
let root: Root;

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};
const mount = async (node: React.ReactNode) => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(node));
  await flush();
};
const pageButton = (label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(label)) as HTMLButtonElement | undefined;
const scroller = () => document.body.querySelector<HTMLElement>('[data-testid="setting-list-scroll"]');

beforeEach(() => {
  vi.clearAllMocks();
  settings.config.trailerLanguages.extras = [];
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

describe("trailer language picker", () => {
  // @req UX-LIST-01[badger-desktop]
  it("shows no language list on the page; the dialog scrolls through every language and picking one adds it", async () => {
    await mount(<TrailersSection />);
    const languageCount = MEDIA_LANGUAGE_OPTIONS.length;
    expect(languageCount).toBeGreaterThan(6);

    expect(scroller()).toBeNull();
    expect(container.querySelector("#trailerLanguageSearch")).toBeNull();
    const add = pageButton("settings.trailerLanguages.add");
    expect(add).toBeDefined();

    await act(async () => add!.click());
    await flush();
    expect(scroller()?.className).toContain("overflow-y-auto");
    expect(scroller()?.querySelectorAll("button")).toHaveLength(languageCount);

    // Searching narrows the scrolling list.
    const search = document.body.querySelector<HTMLInputElement>("#trailerLanguageSearch")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(search, "french");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const matches = [...scroller()!.querySelectorAll("button")];
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.length).toBeLessThan(languageCount);

    await act(async () => matches[0]!.click());
    await flush();
    expect(settings.updateNestedSetting).toHaveBeenCalledWith({ trailerLanguages: { extras: [expect.any(String)] } });
    expect(scroller()).toBeNull();
  });
});

describe("sponsorships", () => {
  // @req UX-LIST-01[badger-desktop]
  it("shows a count on the page and every referral inside the dialog", async () => {
    api.getSubscription.mockResolvedValue({
      plan: "tier1",
      storageLimitGb: 100,
      storageUsedGb: 1,
      storageAddonCount: 0,
      access: { state: "paid", paidUntil: "2099-01-01T00:00:00.000Z", billingPeriod: "monthly", wipeAt: null, qosTier: "paid" },
    });
    api.getAccountStorage.mockResolvedValue(null);
    api.getSettings.mockResolvedValue({ preferences: {} });
    api.getSponsorships.mockResolvedValue({
      sponsorCode: "CODE",
      sponsorships: Array.from({ length: 8 }, (_, i) => ({
        id: `s${i}`,
        referredEmailMasked: `f***${i}@example.com`,
        eligibleAt: "2099-01-01T00:00:00.000Z",
        status: i < 3 ? "validated" : "pending",
        daysRemaining: 4,
      })),
    });
    await mount(<AccountSection />);
    await flush();

    expect(container.textContent).toContain("account.sponsorships.summary|count=8,validated=3");
    expect(container.textContent).not.toContain("example.com");

    await act(async () => pageButton("account.sponsorships.viewAll")!.click());
    await flush();
    expect(scroller()?.textContent?.match(/@example\.com/g)).toHaveLength(8);
  });
});
