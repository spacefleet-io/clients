/**
 * The storage plans the desktop apps sell (Badger and Parrot): sizes, prices and the billing period
 * the user last picked. One copy for every client, so Badger's Settings → Account, its import upgrade
 * offer (spec INGS-QUOTA-01, INGS-QUOTA-02) and Parrot's plan screen always quote the same plan at the
 * same price.
 *
 * Prices are a copy of the catalog the API charges (ACCT-PLAN-04). The catalog lives in the closed
 * server code, which a client app never depends on (REL-LIC-03), so the copy is held here
 * and a server-side test fails the moment it differs from the catalog: the price
 * shown before checkout is the price Stancer's page asks for.
 * `annualPerMonth` is the yearly price / 12, unrounded: × 12 gives the yearly price back.
 *
 * Sizes are in GB the way the API counts them: `storageGb × 1024³` bytes
 * (the API's storage quota).
 */
import type { BillingPeriod } from "./accountAccess";

export type { BillingPeriod };

type PlanPrice = { monthlyCents: number; annualCents: number };

/** Per paid plan, in cents, taxes included; mirrors the API's catalog (checked by `client_prices.test.ts`). */
export const PLAN_PRICES = {
  tier1: { monthlyCents: 299, annualCents: 2990 },
  tier2: { monthlyCents: 599, annualCents: 5990 },
  tier3: { monthlyCents: 1399, annualCents: 13188 },
} as const satisfies Record<string, PlanPrice>;

/** One extra 500 GB block on Scale (ACCT-PLAN-03), in the plan's period. */
export const ADDON_PRICE = { monthlyCents: 649, annualCents: 6490 } as const satisfies PlanPrice;

/**
 * The founder discount (WAIT-FOUND-01): a founder pays 30% less on the plan price, for life; the extra 500 GB blocks
 * stay at full price. A copy of the API's `FOUNDER_DISCOUNT_PERCENT`, checked
 * by the same server-side test as the prices.
 */
export const FOUNDER_DISCOUNT_PERCENT = 30;

/** What a founder pays for a plan price in cents, rounded the way the API charges it (`computeCharge`). */
export const founderPlanCents = (planCents: number): number =>
  planCents - Math.round((planCents * FOUNDER_DISCOUNT_PERCENT) / 100);

const euros = (cents: number) => cents / 100;

export const PLAN_CONFIG = {
  free: { title: "Free", storageGb: 20, monthly: 0, annualPerMonth: 0 },
  tier1: {
    title: "Starter",
    storageGb: 100,
    monthly: euros(PLAN_PRICES.tier1.monthlyCents),
    annualPerMonth: euros(PLAN_PRICES.tier1.annualCents) / 12,
  },
  tier2: {
    title: "Standard",
    storageGb: 400,
    monthly: euros(PLAN_PRICES.tier2.monthlyCents),
    annualPerMonth: euros(PLAN_PRICES.tier2.annualCents) / 12,
  },
  tier3: {
    title: "Scale",
    storageGb: 1000,
    monthly: euros(PLAN_PRICES.tier3.monthlyCents),
    annualPerMonth: euros(PLAN_PRICES.tier3.annualCents) / 12,
    addon: {
      stepGb: 500,
      monthly: euros(ADDON_PRICE.monthlyCents),
      annualPerStep: euros(ADDON_PRICE.annualCents),
    },
  },
} as const;

export type PlanId = keyof typeof PLAN_CONFIG;

/** Smallest to largest; Scale then grows by add-on blocks. */
export const PLAN_ORDER: readonly PlanId[] = ["free", "tier1", "tier2", "tier3"];

export const isPlanId = (value: unknown): value is PlanId =>
  typeof value === "string" && (PLAN_ORDER as readonly string[]).includes(value);

const GIB = 1024 ** 3;

/** One concrete plan: an id plus the add-on blocks (always 0 below Scale). */
export type PlanChoice = { plan: PlanId; addonCount: number };

export const planStorageGb = ({ plan, addonCount }: PlanChoice): number =>
  PLAN_CONFIG[plan].storageGb + (plan === "tier3" ? addonCount * PLAN_CONFIG.tier3.addon.stepGb : 0);

export const planLimitBytes = (choice: PlanChoice): number => planStorageGb(choice) * GIB;

/**
 * What the plan costs per month in the given billing period (annual = yearly price / 12), in cents-rounded euros.
 * `founder` (`billing.founder`, WAIT-FOUND-01) takes the founder discount off the plan price, never off the blocks.
 */
export const planMonthlyPrice = ({ plan, addonCount }: PlanChoice, period: BillingPeriod, founder = false): number => {
  const config = PLAN_CONFIG[plan];
  const base =
    founder && plan !== "free"
      ? period === "annual"
        ? euros(founderPlanCents(PLAN_PRICES[plan].annualCents)) / 12
        : euros(founderPlanCents(PLAN_PRICES[plan].monthlyCents))
      : period === "annual"
        ? config.annualPerMonth
        : config.monthly;
  const addon = PLAN_CONFIG.tier3.addon;
  const perStep = period === "annual" ? addon.annualPerStep / 12 : addon.monthly;
  const blocks = plan === "tier3" ? Math.max(0, addonCount) : 0;
  return Math.round((base + blocks * perStep) * 100) / 100;
};

/**
 * What a yearly plan charges once a year, in euros: the catalog's exact yearly amount, the one Stancer's page asks for.
 * `founder` takes the founder discount off the plan price (the blocks stay at full price).
 */
export const planYearlyPrice = ({ plan, addonCount }: PlanChoice, founder = false): number => {
  if (plan === "free") return 0;
  const blocks = plan === "tier3" ? Math.max(0, addonCount) : 0;
  const planCents = founder ? founderPlanCents(PLAN_PRICES[plan].annualCents) : PLAN_PRICES[plan].annualCents;
  return euros(planCents + blocks * ADDON_PRICE.annualCents);
};

/** The base plans, smallest first; Scale then grows by add-on blocks without limit (ACCT-PLAN-03). */
const BASE_PLANS: PlanChoice[] = PLAN_ORDER.map((plan) => ({ plan, addonCount: 0 }));

/** The smallest plan bigger than `current` whose size is at least `requiredBytes`: Scale with enough blocks when no base plan is. */
export const smallestPlanFitting = (requiredBytes: number, current: PlanChoice): PlanChoice => {
  const currentGb = planStorageGb(current);
  const base = BASE_PLANS.find((choice) => planStorageGb(choice) > currentGb && planLimitBytes(choice) >= requiredBytes);
  if (base) return base;
  const step = PLAN_CONFIG.tier3.addon.stepGb;
  const neededGb = Math.max(requiredBytes / GIB, currentGb + 1);
  return { plan: "tier3", addonCount: Math.max(1, Math.ceil((neededGb - PLAN_CONFIG.tier3.storageGb) / step)) };
};

/** The next plan up from `current`: the next base plan, then one more block on Scale. */
export const nextPlanUp = (current: PlanChoice): PlanChoice => {
  const currentGb = planStorageGb(current);
  return BASE_PLANS.find((choice) => planStorageGb(choice) > currentGb) ?? { plan: "tier3", addonCount: current.addonCount + 1 };
};

/**
 * Auto-scale's fit (ACCT-SCALE-01): the cheapest mix of a plan and its 500 GB blocks that holds `usageBytes`,
 * billed in `period`. Scale takes any number of blocks (ACCT-PLAN-03), so something always fits. Every plan is tried, and a plan that takes blocks is tried
 * with the fewest blocks that fit (only Scale does today, so above 1000 GB this is Scale plus the fewest blocks).
 * Equal prices go to the smaller storage.
 */
export const cheapestFittingPlan = (usageBytes: number, period: BillingPeriod): PlanChoice => {
  let best: { choice: PlanChoice; cents: number } | null = null;
  for (const plan of PLAN_ORDER) {
    const config = PLAN_CONFIG[plan];
    const shortGb = Math.max(0, usageBytes / GIB - config.storageGb);
    if (!("addon" in config) && shortGb > 0) continue;
    const addonCount = "addon" in config ? Math.ceil(shortGb / config.addon.stepGb) : 0;
    const cents =
      plan === "free"
        ? 0
        : (period === "annual" ? PLAN_PRICES[plan].annualCents : PLAN_PRICES[plan].monthlyCents) +
          addonCount * (period === "annual" ? ADDON_PRICE.annualCents : ADDON_PRICE.monthlyCents);
    if (best === null || cents < best.cents) best = { choice: { plan, addonCount }, cents };
  }
  return best!.choice;
};

const BILLING_PERIOD_KEY = "sf_billing_period";

type BrowserGlobal = { window?: { localStorage: { getItem(key: string): string | null; setItem(key: string, value: string): void } } };
/** `window` is absent off a browser, and the server tsconfigs have no DOM lib to declare it, so the global is typed here. */
const browserGlobal: BrowserGlobal = globalThis as BrowserGlobal;
const browserStorage = () => browserGlobal.window?.localStorage;

/** The billing period the user last picked in Settings → Account; annual until they choose. */
export const loadBillingPeriod = (): BillingPeriod => {
  const stored = browserStorage()?.getItem(BILLING_PERIOD_KEY);
  return stored === "monthly" || stored === "annual" ? stored : "annual";
};

export const persistBillingPeriod = (value: BillingPeriod): void => {
  browserStorage()?.setItem(BILLING_PERIOD_KEY, value);
};
