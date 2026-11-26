// @vitest-environment jsdom
/**
 * @req UX-NOTICE-08[badger-desktop] @req ACCT-UNPAID-05[badger-desktop] @req ACCT-UNPAID-03[badger-desktop]
 * @why Chris 2026-11-26: an unpaid account is a lasting state, said by a small sign in the top bar plus one heads-up
 *   in the notice history, never by a strip that pushes the page down. The full explanation stays where the state
 *   blocks something (Settings, upload), so the sign leads to Settings → Account.
 */

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountAccess } from "@space/shared/accountAccess";
import { createDesktopNoticeHistory, type NoticeHistory } from "@space/desktop-shell/services/notifications";
import {
  UNPAID_ACCOUNT_SETTINGS,
  UnpaidAccessSign,
  unpaidHeadsUpKey,
  useUnpaidHeadsUp,
} from "../src/renderer/src/components/UnpaidAccessSign";
import UnpaidUploadsNotice, { isSubscriptionUnpaidJobError } from "../src/renderer/src/components/UnpaidUploadsNotice";
import { getUnpaidAccessInfo } from "../src/renderer/src/lib/unpaidAccess";
import en from "../src/renderer/src/i18n/en.json";
import fr from "../src/renderer/src/i18n/fr.json";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const authState = vi.hoisted(() => ({ user: null as { access?: AccountAccess } | null }));

vi.mock("@/auth", () => ({
  useAuth: () => ({ user: authState.user, token: "tok" }),
}));

const SUITE = "[unpaid-access-sign]";
const DAY = 24 * 60 * 60 * 1000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();
const USER_ID = "user-unpaid-1";

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

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{`${location.pathname}${location.search}`}</span>;
}

function HeadsUpHost({ store }: { store: NoticeHistory }) {
  useUnpaidHeadsUp(store, USER_ID);
  return null;
}

describe("UnpaidAccessSign (UX-NOTICE-08, ACCT-UNPAID-05)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  const render = async (node: React.ReactElement, lng: "en" | "fr" = "en") => {
    const i18n = await makeI18n(lng);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <I18nextProvider i18n={i18n}>
          <MemoryRouter initialEntries={["/home"]}>
            <Routes>
              <Route path="*" element={<>{node}<LocationProbe /></>} />
            </Routes>
          </MemoryRouter>
        </I18nextProvider>,
      );
      await Promise.resolve();
    });
    return container;
  };

  const unmount = () => {
    if (root) act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
  };

  const dump = (label: string) => {
    console.error(`=== ${SUITE}:${label} snapshot ===`);
    console.error(`user=${JSON.stringify(authState.user)}`);
    console.error(`container.innerHTML:\n${container?.innerHTML ?? "(none)"}`);
  };

  const sign = () => container?.querySelector<HTMLButtonElement>('[data-testid="unpaid-access-sign"]') ?? null;

  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    unmount();
    authState.user = null;
  });

  it("shows a one-word chip whose label carries the whole notice with the wipe date", async () => {
    console.info(`${SUITE}:unpaid phase=render`);
    const wipeAt = iso(40);
    authState.user = { access: accessOf({ state: "unpaid", paidUntil: iso(-20), billingPeriod: "monthly", wipeAt }) };
    await render(<UnpaidAccessSign />);
    const el = sign();
    console.info(`${SUITE}:unpaid text=${JSON.stringify(el?.textContent)} label=${JSON.stringify(el?.getAttribute("aria-label"))}`);
    try {
      expect(el).not.toBeNull();
      expect(el?.tagName).toBe("BUTTON");
      expect(el?.textContent).toBe("Plan ended");
      const label = el?.getAttribute("aria-label") ?? "";
      expect(label).toContain("Your subscription ended. You can still download your files until");
      expect(label).toContain(String(new Date(wipeAt).getFullYear()));
      expect(el?.getAttribute("title")).toBe(label);
      expect(el?.getAttribute("data-wipe-at")).toBe(wipeAt);
      // No strip: the old full-width banner is gone.
      expect(container?.querySelector('[data-testid="unpaid-access-banner"]')).toBeNull();
    } catch (err) {
      dump("unpaid");
      throw err;
    }
  });

  it("renders in French", async () => {
    authState.user = { access: accessOf({ state: "unpaid", paidUntil: iso(-20), wipeAt: iso(40) }) };
    await render(<UnpaidAccessSign />, "fr");
    const el = sign();
    console.info(`${SUITE}:fr text=${JSON.stringify(el?.textContent)}`);
    try {
      expect(el?.textContent).toBe("Abonnement terminé");
      expect(el?.getAttribute("aria-label")).toContain("Votre abonnement est terminé.");
    } catch (err) {
      dump("fr");
      throw err;
    }
  });

  it("flips a stored 'paid' access to unpaid once paidUntil has passed (no refresh needed)", async () => {
    authState.user = { access: accessOf({ state: "paid", paidUntil: iso(-1), billingPeriod: "annual", qosTier: "paid" }) };
    await render(<UnpaidAccessSign />);
    const el = sign();
    try {
      expect(el).not.toBeNull();
      expect(Date.parse(el?.getAttribute("data-wipe-at") ?? "")).toBeGreaterThan(Date.now());
    } catch (err) {
      dump("stale-paid");
      throw err;
    }
  });

  it.each([
    ["paid", accessOf({ state: "paid", paidUntil: iso(10), billingPeriod: "monthly", qosTier: "paid" })],
    ["free", accessOf({ state: "free" })],
    ["missing", undefined],
  ])("renders nothing for a %s account", async (label, access) => {
    authState.user = { access };
    await render(<UnpaidAccessSign />);
    try {
      expect(sign()).toBeNull();
    } catch (err) {
      dump(`hidden-${label}`);
      throw err;
    }
  });

  it("renders nothing when logged out", async () => {
    authState.user = null;
    await render(<UnpaidAccessSign />);
    expect(sign()).toBeNull();
  });

  it("opens Settings → Account, where the full explanation and the fix live", async () => {
    authState.user = { access: accessOf({ state: "unpaid", paidUntil: iso(-3), wipeAt: iso(57) }) };
    await render(<UnpaidAccessSign />);
    console.info(`${SUITE}:click phase=before location=${container?.querySelector('[data-testid="location"]')?.textContent}`);
    await act(async () => {
      sign()?.click();
    });
    const location = container?.querySelector('[data-testid="location"]')?.textContent;
    console.info(`${SUITE}:click phase=after location=${location}`);
    try {
      expect(location).toBe(UNPAID_ACCOUNT_SETTINGS);
      expect(UNPAID_ACCOUNT_SETTINGS).toBe("/settings?section=account");
    } catch (err) {
      dump("click");
      throw err;
    }
  });

  it("adds one heads-up to the notice history per unpaid period, not again after a remount", async () => {
    const paidUntil = iso(-3);
    const wipeAt = iso(57);
    authState.user = { access: accessOf({ state: "unpaid", paidUntil, wipeAt }) };
    const store = createDesktopNoticeHistory(`sf.notifications.${USER_ID}`);

    console.info(`${SUITE}:heads-up phase=first-mount`);
    await render(<HeadsUpHost store={store} />);
    const first = store.getAll();
    console.info(`${SUITE}:heads-up entries=${JSON.stringify(first.map((n) => ({ key: n.key, kind: n.kind, title: n.title, level: n.level, target: n.target })))}`);
    try {
      expect(first).toHaveLength(1);
      expect(first[0]?.title).toEqual({ key: "account.access.unpaidHeadsUpTitle" });
      expect(en.account.access.unpaidHeadsUpTitle).toBe("Your subscription ended");
      expect(first[0]?.level).toBe("warning");
      expect(first[0]?.kind).toBe("lasting");
      expect(first[0]?.key).toBe(`account-unpaid:${paidUntil}`);
      expect(first[0]?.target).toBe(UNPAID_ACCOUNT_SETTINGS);
      expect(first[0]?.message).toContain("You can still download your files until");
      expect(window.localStorage.getItem(unpaidHeadsUpKey(USER_ID))).toBe(paidUntil);
    } catch (err) {
      dump("heads-up-first");
      throw err;
    }

    console.info(`${SUITE}:heads-up phase=remount`);
    unmount();
    await render(<HeadsUpHost store={store} />);
    expect(store.getAll()).toHaveLength(1);

    console.info(`${SUITE}:heads-up phase=dismissed-then-remount`);
    store.clearAll();
    unmount();
    await render(<HeadsUpHost store={store} />);
    expect(store.getAll()).toHaveLength(0);

    console.info(`${SUITE}:heads-up phase=new-period`);
    authState.user = { access: accessOf({ state: "unpaid", paidUntil: iso(-1), wipeAt: iso(59) }) };
    unmount();
    await render(<HeadsUpHost store={store} />);
    expect(store.getAll()).toHaveLength(1);
  });

  it("adds no heads-up for a paid account", async () => {
    authState.user = { access: accessOf({ state: "paid", paidUntil: iso(10), qosTier: "paid" }) };
    const store = createDesktopNoticeHistory(`sf.notifications.${USER_ID}`);
    await render(<HeadsUpHost store={store} />);
    expect(store.getAll()).toHaveLength(0);
  });

  it("shows the upload-blocked notice with the wipe date, and detects the 402 code in job errors", async () => {
    const wipeAt = iso(30);
    authState.user = { access: accessOf({ state: "unpaid", wipeAt }) };
    await render(<UnpaidUploadsNotice />);
    const text = container?.querySelector('[data-testid="unpaid-uploads-notice"]')?.textContent ?? "";
    console.info(`${SUITE}:uploads text=${JSON.stringify(text)}`);
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
