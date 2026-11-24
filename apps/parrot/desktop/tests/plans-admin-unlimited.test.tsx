// @vitest-environment jsdom
// @req ACCT-PLAN-14
/**
 * Parrot's plan screen for an admin account (ACCT-PLAN-14): `storageLimitGb` is null, so the screen says
 * "Admin: unlimited storage" with the space used, and shows no plan, price, period or checkout. A limited
 * account keeps its plans. `window.parrot` (main) is mocked; everything else is the real code.
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setStorageUnitBase } from "@space/shared/format";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "parrot-plans-admin-unlimited";

vi.mock("@space/ui", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { size?: string; variant?: string }) => {
    const { size: _size, variant: _variant, ...rest } = props;
    return <button {...rest}>{children}</button>;
  },
  Spinner: () => <span />,
}));

import Plans from "../src/renderer/src/Plans";
import { translator } from "../src/renderer/src/i18n";
import type { ParrotLanguage } from "../src/shared/ipc";

const ok = <T,>(value: T) => ({ ok: true as const, value });
const STATUS_FREE = { provider: "stancer", checkoutAllowed: true, checkoutBlockedReason: null, subscription: null };
const subscription = (storageLimitGb: number | null) =>
  ok({
    plan: "free",
    storageLimitGb,
    storageUsedGb: 12,
    storageAddonCount: 0,
    paidUntil: null,
    billingPeriod: null,
    scheduledChange: null,
    renewalHold: null,
  });

const parrot = {
  getSubscription: vi.fn(),
  getBillingStatus: vi.fn(),
  updateSubscription: vi.fn(),
  startCheckout: vi.fn(),
  completePayment: vi.fn(),
  onPaymentReturn: vi.fn((_listener: (paymentId: string) => void) => () => {}),
};

describe("Parrot plan screen for an unlimited (admin) account (ACCT-PLAN-14)", () => {
  let container: HTMLDivElement;
  let root: Root;

  const flush = async () => {
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  };
  const mount = async (language: ParrotLanguage) => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<Plans t={translator(language)} language={language} onClose={() => {}} />);
    });
    await flush();
  };
  const chooseButtons = () => Array.from(container.querySelectorAll<HTMLElement>("[data-testid^='plan-choose-']"));
  const dump = (label: string) => {
    console.info(`[${SUITE}:${label}] text=${container.textContent}`);
    console.info(
      `[${SUITE}:${label}] buttons`,
      Array.from(container.querySelectorAll("button")).map((b) => `${b.dataset.testid ?? "?"}=${b.textContent}`),
    );
    console.info(`[${SUITE}:${label}] calls`, Object.fromEntries(Object.entries(parrot).map(([k, fn]) => [k, fn.mock.calls])));
  };

  beforeEach(() => {
    Object.values(parrot).forEach((fn) => fn.mockReset());
    (window as unknown as { parrot: typeof parrot }).parrot = parrot;
    parrot.getBillingStatus.mockResolvedValue(ok(STATUS_FREE));
    // Plan sizes are GiB, so on a 1024-based computer (Windows, KDE) 12 GB used reads "12.0 GB" (STOR-UNIT-01).
    setStorageUnitBase(1024);
  });
  afterEach((context) => {
    if (context.task.result?.state === "fail") dump("failure");
    act(() => root.unmount());
    container.remove();
    setStorageUnitBase(1000);
  });

  // The used figure is written in the interface language: "12,0 Go" in French.
  // @req STOR-UNIT-02[parrot]
  for (const [language, expected] of [
    ["en", "Admin: unlimited storage, 12.0 GB used"],
    ["fr", "Admin\u202f: stockage illimité, 12,0 Go utilisés"],
  ] as const) {
    it(`[ACCT-PLAN-14-PARROT-01] ${language}: shows "${expected}" and no plan, price or checkout`, async () => {
      parrot.getSubscription.mockResolvedValue(subscription(null));
      await mount(language);
      const label = container.querySelector("[data-testid='plan-unlimited']")?.textContent;
      console.info(`[${SUITE}:unlimited-${language}] label=${label} choose=${chooseButtons().length}`);
      dump(`unlimited-${language}`);
      expect(label).toBe(expected);
      expect(chooseButtons()).toEqual([]);
      expect(container.querySelector("[role='radiogroup']")).toBeNull();
      expect(container.querySelector("[data-testid='plan-confirm']")).toBeNull();
      expect(parrot.startCheckout).not.toHaveBeenCalled();
    });
  }

  it("[ACCT-PLAN-14-PARROT-02] a limited account still sees its plan with 'used of limit' and the plans", async () => {
    parrot.getSubscription.mockResolvedValue(subscription(20));
    await mount("en");
    dump("limited");
    expect(container.querySelector("[data-testid='plan-unlimited']")).toBeNull();
    expect(container.querySelector("[data-testid='plan-current']")?.textContent).toContain("12.0 GB of 20.0 GB used");
    expect(chooseButtons().length).toBeGreaterThan(0);
  });
});
