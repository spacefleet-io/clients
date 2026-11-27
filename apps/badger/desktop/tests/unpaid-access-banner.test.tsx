// @vitest-environment jsdom

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountAccess } from "@space/shared/accountAccess";
import { UnpaidAccessBanner } from "../src/renderer/src/components/UnpaidAccessBanner";
import UnpaidUploadsNotice, { isSubscriptionUnpaidJobError } from "../src/renderer/src/components/UnpaidUploadsNotice";
import { getUnpaidAccessInfo } from "../src/renderer/src/lib/unpaidAccess";
import en from "../src/renderer/src/i18n/en.json";
import fr from "../src/renderer/src/i18n/fr.json";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const authState = vi.hoisted(() => ({ user: null as { access?: AccountAccess } | null }));

vi.mock("@/auth", () => ({
  useAuth: () => ({ user: authState.user, token: "tok" }),
}));

const DAY = 24 * 60 * 60 * 1000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();

const accessOf = (overrides: Partial<AccountAccess>): AccountAccess => ({
  state: "free",
  paidUntil: null,
  billingPeriod: null,
  wipeAt: null,
  qosTier: "free",
  ...overrides,
});

const makeI18n = async (lng: "en" | "fr") => {
  const instance = createInstance();
  await instance.init({
    lng,
    fallbackLng: "en",
    resources: { en: { translation: en }, fr: { translation: fr } },
    interpolation: { escapeValue: false },
  });
  return instance;
};

describe("UnpaidAccessBanner (#145)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  const render = async (node: React.ReactElement, lng: "en" | "fr" = "en") => {
    const i18n = await makeI18n(lng);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
      await Promise.resolve();
    });
    return container;
  };

  const dump = (label: string) => {
    console.error(`=== [unpaid-access-banner:${label}] snapshot ===`);
    console.error(`user=${JSON.stringify(authState.user)}`);
    console.error(`container.innerHTML:\n${container?.innerHTML ?? "(none)"}`);
  };

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    root = null;
    container?.remove();
    container = null;
    authState.user = null;
  });

  it("renders the plain-language message with the wipe date for an unpaid account", async () => {
    const wipeAt = iso(40);
    authState.user = { access: accessOf({ state: "unpaid", paidUntil: iso(-20), billingPeriod: "monthly", wipeAt }) };
    const el = await render(<UnpaidAccessBanner />);
    const banner = el.querySelector('[data-testid="unpaid-access-banner"]');
    console.info(`[unpaid-access-banner:unpaid] text=${JSON.stringify(banner?.textContent)} wipeAt=${wipeAt}`);
    try {
      expect(banner).not.toBeNull();
      expect(banner?.textContent).toContain("Your subscription ended. You can still download your files until");
      expect(banner?.textContent).toContain("after that they're deleted.");
      expect(banner?.textContent).toContain(String(new Date(wipeAt).getFullYear()));
      expect(banner?.getAttribute("data-wipe-at")).toBe(wipeAt);
      expect(banner?.textContent).toContain("Save offline");
    } catch (err) {
      dump("unpaid");
      throw err;
    }
  });

  it("renders in French", async () => {
    authState.user = { access: accessOf({ state: "unpaid", paidUntil: iso(-20), wipeAt: iso(40) }) };
    const el = await render(<UnpaidAccessBanner />, "fr");
    const text = el.querySelector('[data-testid="unpaid-access-banner"]')?.textContent ?? "";
    console.info(`[unpaid-access-banner:fr] text=${JSON.stringify(text)}`);
    try {
      expect(text).toContain("Votre abonnement est terminé.");
      expect(text).toContain("vos fichiers");
    } catch (err) {
      dump("fr");
      throw err;
    }
  });

  it("flips a stored 'paid' access to unpaid once paidUntil has passed (no refresh needed)", async () => {
    authState.user = { access: accessOf({ state: "paid", paidUntil: iso(-1), billingPeriod: "annual", qosTier: "paid" }) };
    const el = await render(<UnpaidAccessBanner />);
    const banner = el.querySelector('[data-testid="unpaid-access-banner"]');
    try {
      expect(banner).not.toBeNull();
      // wipe date derived locally: paidUntil + 60 days
      expect(Date.parse(banner?.getAttribute("data-wipe-at") ?? "")).toBeGreaterThan(Date.now());
    } catch (err) {
      dump("stale-paid");
      throw err;
    }
  });

  it.each([
    ["paid", accessOf({ state: "paid", paidUntil: iso(10), billingPeriod: "monthly", qosTier: "paid" })],
    ["free", accessOf({ state: "free" })],
    ["missing", undefined],
  ])("renders nothing for a %s account", async (_label, access) => {
    authState.user = { access };
    const el = await render(<UnpaidAccessBanner />);
    try {
      expect(el.querySelector('[data-testid="unpaid-access-banner"]')).toBeNull();
    } catch (err) {
      dump(`hidden-${_label}`);
      throw err;
    }
  });

  it("renders nothing when logged out", async () => {
    authState.user = null;
    const el = await render(<UnpaidAccessBanner />);
    expect(el.querySelector('[data-testid="unpaid-access-banner"]')).toBeNull();
  });

  it("shows the upload-blocked notice with the wipe date, and detects the 402 code in job errors", async () => {
    const wipeAt = iso(30);
    authState.user = { access: accessOf({ state: "unpaid", wipeAt }) };
    const el = await render(<UnpaidUploadsNotice />);
    const text = el.querySelector('[data-testid="unpaid-uploads-notice"]')?.textContent ?? "";
    console.info(`[unpaid-access-banner:uploads] text=${JSON.stringify(text)}`);
    try {
      expect(text).toContain("Uploads are paused because your subscription ended.");
      expect(isSubscriptionUnpaidJobError("STEP_UPLOAD_FAILED: subscription_unpaid")).toBe(true);
      expect(isSubscriptionUnpaidJobError("network_error")).toBe(false);
      expect(isSubscriptionUnpaidJobError(null)).toBe(false);
    } catch (err) {
      dump("uploads");
      throw err;
    }
  });

  it("getUnpaidAccessInfo reports wipeAt only while unpaid", () => {
    expect(getUnpaidAccessInfo(undefined)).toEqual({ unpaid: false, wipeAt: null });
    expect(getUnpaidAccessInfo(accessOf({ state: "free" }))).toEqual({ unpaid: false, wipeAt: null });
    const wipeAt = iso(5);
    expect(getUnpaidAccessInfo(accessOf({ state: "unpaid", wipeAt }))).toEqual({ unpaid: true, wipeAt });
  });
});
