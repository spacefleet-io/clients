import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18next from "i18next";
import { changeLanguage } from "@space/mobile-shell/i18n";
import { getStorageUnitBase, setStorageUnitBase } from "@space/shared/format";
import en from "../../../../packages/mobile-shell/src/i18n/en.json";
import fr from "../../../../packages/mobile-shell/src/i18n/fr.json";
import { SubscriptionScreen } from "../src/screens/SubscriptionScreen";

const ctl = vi.hoisted(() => ({
  platform: "android" as "android" | "ios",
  openURL: [] as string[],
  goBack: 0,
  subscription: null as unknown,
  storage: null as unknown,
  failLoad: false,
}));

vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return ctl.platform;
    },
  },
  Linking: {
    openURL: async (url: string) => {
      ctl.openURL.push(url);
    },
  },
  StyleSheet: { create: <T>(styles: T) => styles },
  View: "View",
  Text: "Text",
  ScrollView: "ScrollView",
  Pressable: "Pressable",
}));
// The real i18n module wires react-i18next, which resolves a second copy of React under bun's layout and cannot
// run next to react-test-renderer. Same dictionaries and the same i18next lookups, minus the React binding.
vi.mock("@space/mobile-shell/i18n", async () => {
  const enDict = (await import("../../../../packages/mobile-shell/src/i18n/en.json")).default;
  const frDict = (await import("../../../../packages/mobile-shell/src/i18n/fr.json")).default;
  await i18next.init({
    resources: { en: { translation: enDict }, fr: { translation: frDict } },
    lng: "en",
    fallbackLng: "en",
    interpolation: { escapeValue: false },
  });
  const translate = (key: string, options?: Record<string, unknown>) => i18next.t(key, options);
  return {
    translate,
    getCurrentLanguage: () => i18next.language,
    changeLanguage: (code: string) => i18next.changeLanguage(code),
    useTranslation: () => ({ t: translate }),
  };
});
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: "SafeAreaView" }));
vi.mock("lucide-react-native", () => ({ ArrowLeft: () => null }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => navigationStub,
}));
// The founder badge (WAIT-FOUND-04) has its own test in mobile-shell; the shared plan panel imports it from its own
// folder. Leaf UI components pull in native-only modules (SVG sky, Animated), so stand-ins keep their labels and children.
vi.mock("../../../../packages/mobile-shell/src/components/mobile-founder", () => ({ MobileFounderBadge: () => null }));
vi.mock("@space/mobile-shell/components", () => ({
  MobileIconButton: ({ label, onPress }: { label: string; onPress: () => void }) =>
    React.createElement("Pressable", { accessibilityLabel: label, onPress }),
  MobileSkeletonBlock: () => null,
  MobileSkeletonPulse: ({ children }: { children: React.ReactNode }) => React.createElement("View", null, children),
}));
vi.mock("../src/store/auth", () => ({ useAuth: () => authStub }));
vi.mock("@space/shared/api", () => ({
  getSubscription: async () => {
    if (ctl.failLoad) throw new Error("offline");
    return ctl.subscription;
  },
  getAccountStorage: async () => ctl.storage,
}));
vi.mock("../src/components/PosterCard", () => ({ RIPPLE: {} }));
vi.mock("../src/components/SettingsRows", () => ({
  SettingsGroup: ({ title, children }: { title: string; children: React.ReactNode }) =>
    React.createElement("View", null, React.createElement("Text", null, title), children),
}));

const navigationStub = {
  goBack: () => {
    ctl.goBack += 1;
  },
};
const authStub = { token: "token" };

type Tree = { [key: string]: string | Tree };

const flatten = (tree: Tree, prefix = ""): Array<[string, string]> =>
  Object.entries(tree).flatMap(([key, value]) =>
    typeof value === "string" ? [[`${prefix}${key}`, value] as [string, string]] : flatten(value, `${prefix}${key}.`)
  );

/** Library-key rotation ("Renouveler la clé") is unrelated to the subscription; "Web browser" names a kind of device
 * to pair, not a prompt to go to the web. */
const NOT_ABOUT_PAYMENT = /^(resetKey\.|settings\.advanced\.resetKey\.|pairing\.deviceType\.web$)/;

const FORBIDDEN = {
  en: /\b(renew|upgrade|subscribe|checkout|pricing|billing|payments?|pay|website|web)\b/i,
  fr: /\b(renouvelez|renouveler|mettre à niveau|passez|forfait|offre supérieure|facturation|paiement|payer|paye|site web|web)\b/i,
} as const;

/**
 * ACCT-DEL-03: a yearly account booked for deletion is told, in the same words as web and desktop, that its plan
 * "will not renew". That informs (ACCT-PAY-02 allows showing the renewal state); it sends nobody to renew. Only that
 * exact phrase, only in those two strings, is taken out before the scan: any other forbidden word in them still fails.
 */
const INFORMS_ONLY: Record<string, RegExp> = {
  "deleteAccount.modeEndOfPeriod": /\bwill not renew\b/g,
  "deleteAccount.scheduled": /\bwill not renew\b/g,
};

// The plan figures below are GiB bytes and the expectations read them in 1024-based units ("100.0 GB"); a phone's
// default 1000-based reading is covered by the shared formatter's own tests (STOR-UNIT-01).
beforeEach(() => {
  setStorageUnitBase(1024);
  console.info("[billing-copy] storage unit base", getStorageUnitBase());
});

describe("phone app wording about plans and payment", () => {
  for (const [lng, dict] of [
    ["en", en],
    ["fr", fr],
  ] as const) {
    /** @req ACCT-PAY-02[badger-mobile] */
    it(`${lng}: no text tells the user to renew, upgrade, pay or go to the web`, () => {
      const entries = flatten(dict as Tree).filter(([key]) => !NOT_ABOUT_PAYMENT.test(key));
      const offenders = entries.filter(([key, value]) => FORBIDDEN[lng].test(INFORMS_ONLY[key] ? value.replace(INFORMS_ONLY[key]!, "") : value));
      console.log("billing wording scan", { lng, scanned: entries.length, offenders });
      expect(offenders, `${lng} strings that point to payment`).toEqual([]);
    });
  }

  /** @req ACCT-PAY-02[badger-mobile] */
  it("the subscription strings only describe the account, with no web link or read-only-because-web text", () => {
    for (const dict of [en, fr]) {
      const keys = Object.keys(dict.subscription);
      console.log("subscription keys", keys);
      expect(keys).not.toContain("webLink");
      expect(keys).not.toContain("webLinkLabel");
      expect(keys).not.toContain("readOnly");
      expect(Object.keys(dict.subscription.plan)).not.toContain("wipeWarningNeutral");
      expect(Object.keys(dict.subscription.storage)).not.toContain("fullNeutral");
    }
  });

  describe("the Subscription screen, rendered", () => {
    const paidUntil = "2026-11-30T00:00:00.000Z";
    const wipeAt = "2027-01-29T00:00:00.000Z";
    const storage = (warningLevel: "ok" | "warning" | "blocked") => ({
      plan: "plus",
      storageAddonCount: 2,
      limitBytes: 100 * 1024 ** 3,
      usedBytes: (warningLevel === "ok" ? 10 : 99) * 1024 ** 3,
      reservedBytes: 512 * 1024 ** 2,
      usageRatio: warningLevel === "ok" ? 0.1 : warningLevel === "warning" ? 0.9 : 1,
      warningLevel,
      apps: [{ appId: "badger", label: "SpaceBadger", usedBytes: 5 * 1024 ** 3 }],
      lastReconciledAt: null,
    });
    const scenarios = {
      "unpaid, files about to be wiped, storage full": {
        subscription: { plan: "plus", paidUntil, access: { state: "unpaid", paidUntil, billingPeriod: "monthly", wipeAt, qosTier: "free" } },
        storage: storage("blocked"),
      },
      "paid, storage getting full": {
        subscription: { plan: "plus", paidUntil, access: { state: "paid", paidUntil, billingPeriod: "annual", wipeAt: null, qosTier: "paid" } },
        storage: storage("warning"),
      },
      "free plan": {
        subscription: { plan: "free", paidUntil: null, access: { state: "free", paidUntil: null, billingPeriod: null, wipeAt: null, qosTier: "free" } },
        storage: storage("ok"),
      },
      "account could not be loaded": { subscription: null, storage: null, failLoad: true },
    } as const;

    let renderer: ReactTestRenderer | null = null;

    beforeEach(() => {
      // React's act() reads this flag off the global; the global type has no such field.
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
      ctl.openURL = [];
      ctl.goBack = 0;
      ctl.failLoad = false;
    });

    afterEach(async () => {
      await act(async () => {
        renderer?.unmount();
      });
      renderer = null;
    });

    const mountScreen = async (): Promise<ReactTestRenderer> => {
      await act(async () => {
        renderer = create(React.createElement(SubscriptionScreen));
      });
      if (!renderer) throw new Error("SubscriptionScreen did not mount");
      return renderer;
    };

    const collectText = (node: ReactTestInstance): string[] => {
      const out: string[] = [];
      const visit = (n: ReactTestInstance | string) => {
        if (typeof n === "string") {
          out.push(n);
          return;
        }
        const label = n.props.accessibilityLabel;
        if (typeof label === "string") out.push(label);
        n.children.forEach(visit);
      };
      visit(node);
      return out;
    };

    const pressables = (root: ReactTestInstance) =>
      root.findAll((n) => typeof n.type === "string" && typeof n.props.onPress === "function");

    for (const lng of ["en", "fr"] as const) {
      for (const platform of ["android", "ios"] as const) {
        for (const [name, scenario] of Object.entries(scenarios)) {
          /** @req ACCT-PAY-02[badger-mobile] */
          it(`${lng}/${platform}, ${name}: shows only the account, with no renew/upgrade/pay wording and nothing that opens a link`, async () => {
            await changeLanguage(lng);
            ctl.platform = platform;
            ctl.subscription = scenario.subscription;
            ctl.storage = scenario.storage;
            ctl.failLoad = "failLoad" in scenario;

            const tree = await mountScreen();
            const text = collectText(tree.root);
            console.log("subscription screen text", { lng, platform, name, text });
            expect(text.length).toBeGreaterThan(2);
            expect(text.filter((t) => FORBIDDEN[lng].test(t))).toEqual([]);

            // No link-shaped element, and pressing everything that can be pressed never opens a URL.
            expect(tree.root.findAll((n) => n.props.href !== undefined || n.props.accessibilityRole === "link")).toEqual([]);
            const targets = pressables(tree.root);
            const labels = targets.map((n) => n.props.accessibilityLabel);
            expect(labels.every((label) => label === en.subscription.back || label === fr.subscription.back || label === en.subscription.retry || label === fr.subscription.retry)).toBe(true);
            for (const target of targets) {
              await act(async () => {
                target.props.onPress();
              });
            }
            expect(ctl.openURL).toEqual([]);
            expect(ctl.goBack).toBe(1);
          });
        }
      }
    }

    for (const lng of ["en", "fr"] as const) {
      /** @req STOR-USE-01[badger-mobile] */
      it(`${lng}: storage use is one total plus one line per app, never split by kind of file`, async () => {
        await changeLanguage(lng);
        ctl.platform = "android";
        ctl.subscription = scenarios["free plan"].subscription;
        ctl.storage = {
          ...storage("ok"),
          apps: [
            { appId: "badger", label: "SpaceBadger", usedBytes: 7 * 1024 ** 3 },
            { appId: "parrot", label: "Parrot", usedBytes: 3 * 1024 ** 3 },
          ],
        };

        const tree = await mountScreen();
        const text = collectText(tree.root);
        console.log("subscription storage text", { lng, text });

        // The total against the plan's size, once.
        const dict = lng === "en" ? en : fr;
        expect(text.filter((t) => t === dict.subscription.storage.used)).toHaveLength(1);
        // Each app's use is a single line: its label once, nothing nested under it.
        expect(text.filter((t) => t === "SpaceBadger")).toHaveLength(1);
        expect(text.filter((t) => t === "Parrot")).toHaveLength(1);
        // No word for a kind of file anywhere on the screen.
        const KIND_OF_FILE = /subtit|sous-titre|preview|aper[cç]u|vignette|thumbnail|qualit|version|1080|720|4k|poster|affiche/i;
        expect(text.filter((t) => KIND_OF_FILE.test(t))).toEqual([]);
      });
    }

    // @bugfix @regression-proof — the Plan row showed the raw plan id ("free", "tier2") instead of its name.
    const PLAN_NAMES = {
      en: { free: "Free", tier1: "Starter", tier2: "Standard", tier3: "Scale" },
      fr: { free: "Gratuit", tier1: "Starter", tier2: "Standard", tier3: "Scale" },
    } as const;
    for (const lng of ["en", "fr"] as const) {
      for (const [plan, name] of Object.entries(PLAN_NAMES[lng])) {
        it(`[MOBILE-PLAN-NAME-001] ${lng}: plan "${plan}" shows as "${name}", never as its raw id`, async () => {
          await changeLanguage(lng);
          ctl.platform = "android";
          ctl.subscription = { ...scenarios["free plan"].subscription, plan };
          ctl.storage = storage("ok");

          const tree = await mountScreen();
          const text = collectText(tree.root);
          const dict = lng === "en" ? en : fr;
          const planValue = text[text.lastIndexOf(dict.subscription.plan.plan) + 1];
          console.log("[MOBILE-PLAN-NAME-001] plan row", { lng, plan, planValue, text });
          expect(planValue).toBe(name);
          if (plan !== name) expect(text).not.toContain(plan);
        });
      }
    }

    it("[MOBILE-PLAN-NAME-001] a plan id the app does not know yet still shows, as is", async () => {
      await changeLanguage("en");
      ctl.subscription = { ...scenarios["free plan"].subscription, plan: "tier9" };
      ctl.storage = storage("ok");
      const text = collectText((await mountScreen()).root);
      console.log("[MOBILE-PLAN-NAME-001] unknown plan", { text });
      expect(text[text.lastIndexOf(en.subscription.plan.plan) + 1]).toBe("tier9");
    });

    // @bugfix @regression-proof — French showed "67 Mo sur 20.0 Go": the size used a dot whatever the language.
    for (const [lng, expected] of [
      ["en", "10.0 GB of 100.0 GB"],
      ["fr", "10,0 Go sur 100,0 Go"],
    ] as const) {
      it(`[MOBILE-STORAGE-DECIMAL-001] ${lng}: storage sizes use the language's decimal mark ("${expected}")`, async () => {
        await changeLanguage(lng);
        ctl.platform = "android";
        ctl.subscription = scenarios["free plan"].subscription;
        ctl.storage = storage("ok");
        const text = collectText((await mountScreen()).root);
        console.log("[MOBILE-STORAGE-DECIMAL-001] storage text", { lng, text });
        expect(text).toContain(expected);
      });
    }

    // @req STOR-UNIT-02[badger-mobile]
    for (const [lng, usage, app, reserved] of [
      ["fr", "10,0 Go sur 100,0 Go", "5,0 Go", "512 Mo réservés pour les envois en cours"],
      ["en", "10.0 GB of 100.0 GB", "5.0 GB", "512 MB"],
    ] as const) {
      it(`[STOR-UNIT-02-MOBILE-01] ${lng}: every storage figure is written in the interface language ("${usage}", "${app}")`, async () => {
        await changeLanguage(lng);
        ctl.platform = "android";
        ctl.subscription = scenarios["free plan"].subscription;
        ctl.storage = storage("ok");
        const text = collectText((await mountScreen()).root);
        const appValue = text[text.lastIndexOf("SpaceBadger") + 1];
        console.log("[STOR-UNIT-02-MOBILE-01] storage text", { lng, appValue, text });
        expect(text).toContain(usage);
        expect(appValue).toBe(app);
        expect(text.some((t) => t.includes(reserved))).toBe(true);
        if (lng === "fr") expect(text.filter((t) => /\d(\.\d)? ?(GB|MB)\b/.test(t))).toEqual([]);
      });
    }

    // @req ACCT-PLAN-14
    for (const lng of ["en", "fr"] as const) {
      it(`[ACCT-PLAN-14-MOBILE-01] ${lng}: an unlimited (admin) account shows the admin label and its use, never a plan, a limit or a warning`, async () => {
        await changeLanguage(lng);
        ctl.platform = "android";
        ctl.subscription = { plan: "free", storageLimitGb: null, paidUntil: null, access: scenarios["free plan"].subscription.access };
        ctl.storage = { ...storage("blocked"), limitBytes: null, usageRatio: 0, warningLevel: "ok" };
        const tree = await mountScreen();
        const text = collectText(tree.root);
        const dict = lng === "en" ? en : fr;
        const planValue = text[text.lastIndexOf(dict.subscription.plan.plan) + 1];
        const usedValue = text[text.lastIndexOf(dict.subscription.storage.used) + 1];
        const progressbars = tree.root.findAll((n) => n.props.accessibilityRole === "progressbar");
        console.log("[ACCT-PLAN-14-MOBILE-01] unlimited", { lng, planValue, usedValue, progressbars: progressbars.length, text });
        expect(planValue).toBe(dict.subscription.plan.adminUnlimited);
        expect(usedValue).toBe(lng === "en" ? "99.0 GB" : "99,0 Go");
        expect(progressbars).toHaveLength(0);
        expect(text).not.toContain(dict.subscription.plan.status);
        expect(text).not.toContain(dict.subscription.storage.full);
        expect(text).not.toContain(dict.subscription.storage.gettingFull);
        expect(text).not.toContain(dict.subscription.planName.free);
        expect(text.filter((t) => FORBIDDEN[lng].test(t))).toEqual([]);
      });
    }

    it("[ACCT-PLAN-14-MOBILE-02] a limited account keeps its plan, its limit and its full warning", async () => {
      await changeLanguage("en");
      ctl.platform = "android";
      ctl.subscription = { ...scenarios["free plan"].subscription, storageLimitGb: 100 };
      ctl.storage = storage("blocked");
      const tree = await mountScreen();
      const text = collectText(tree.root);
      console.log("[ACCT-PLAN-14-MOBILE-02] limited", { text });
      expect(text[text.lastIndexOf(en.subscription.plan.plan) + 1]).toBe(en.subscription.planName.free);
      expect(text).toContain("99.0 GB of 100.0 GB");
      expect(text).toContain(en.subscription.storage.full);
      expect(text).not.toContain(en.subscription.plan.adminUnlimited);
    });

    // @req STOR-UNIT-01
    for (const base of [1000, 1024] as const) {
      for (const lng of ["en", "fr"] as const) {
        it(`[STOR-UNIT-01-MOBILE-01] base ${base}, ${lng}: 1 MB short of a 100 GB limit never reads as the limit`, async () => {
          await changeLanguage(lng);
          setStorageUnitBase(base);
          ctl.platform = "android";
          ctl.subscription = { ...scenarios["free plan"].subscription, storageLimitGb: 100 };
          const limitBytes = 100 * base ** 3;
          ctl.storage = { ...storage("warning"), limitBytes, usedBytes: limitBytes - base ** 2, usageRatio: 0.99999 };
          const text = collectText((await mountScreen()).root);
          const of = lng === "en" ? " of " : " sur ";
          const line = text.find((t) => /^\S+ (GB|Go|MB|Mo)( of | sur )\S+ (GB|Go|MB|Mo)$/.test(t)) ?? "";
          const [used, limit] = line.split(of);
          console.log("[STOR-UNIT-01-MOBILE-01] usage line", { base, lng, line, used, limit, base_now: getStorageUnitBase(), text });
          expect(line).not.toBe("");
          expect(used).not.toBe(limit);
          expect(limit).toMatch(lng === "en" ? /^100\.0+ GB$/ : /^100,0+ Go$/);
          expect(used).toMatch(lng === "en" ? /^99\.9+\d* GB$/ : /^99,9+\d* Go$/);
        });
      }
    }
  });
});
