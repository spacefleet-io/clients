/**
 * @test-id PARROT-MOBILE-TAB-LABEL-FIT-001
 * @level unit
 * @req UX-PHONE-12[parrot]
 * @req UX-PHONE-11[parrot]
 * @why Main, 2026-11-20 (review of 9c1e5a5fe): with the Search circle in the bar, the tabs were sized by label width
 *   across the whole bar, so the circle drifted off centre per language (40 % to 51 % of the width) and Dutch labels
 *   almost touched. The circle now sits exactly in the centre and each half holds its two tabs, split by label width,
 *   with at least 8 pt between labels. This fails when a shipped Parrot tab label, in any of the five languages, would
 *   not fit its half on a 360 dp or 375 pt phone, or has no measured width yet.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: async () => null, setItem: async () => undefined } }));
vi.mock("@space/mobile-shell/i18n", () => ({ addAppTranslations: () => undefined, changeLanguage: async () => undefined, initI18n: async () => undefined, isMobileUiLanguage: () => true }));
vi.mock("@space/mobile-shell/i18n/deviceLanguage", () => ({ pickStartLanguage: () => "en", readDeviceLocale: () => "en" }));

import { tabBarHalfFits, tabBarHalfWidth } from "../../../../packages/mobile-shell/src/components/mobile-tab-bar-geometry";
import { PARROT_TRANSLATIONS } from "../src/lib/i18n";

/**
 * Each tab label's width in points as Parrot's bar draws it: capitals, weight 800, 11 pt, letter spacing 0, in the
 * phone's own font (Parrot ships no Inter). iOS: measured on a simulator with the real MobileTabBar (2026-11-20, San
 * Francisco). Android: Roboto at weight 800 from its font file. The fit check takes the wider of the two.
 */
const PARROT_TAB_LABEL_WIDTHS: Record<string, { ios: number; android: number }> = {
  HOME: { ios: 35.3, android: 31.1 },
  LIBRARY: { ios: 51.3, android: 44.6 },
  PLAYLISTS: { ios: 64.7, android: 56.4 },
  SETTINGS: { ios: 58.7, android: 52.3 },
  ACCUEIL: { ios: 51.7, android: 44.4 },
  BIBLIOTHÈQUE: { ios: 87.0, android: 75.7 },
  RÉGLAGES: { ios: 62.3, android: 54.7 },
  BIBLIOTHEEK: { ios: 78.0, android: 67.8 },
  OPTIES: { ios: 42.7, android: 37.9 },
  START: { ios: 39.3, android: 34.2 },
  BIBLIOTHEK: { ios: 71.0, android: 61.6 },
  OPTIONEN: { ios: 61.3, android: 54.1 },
  INICIO: { ios: 37.7, android: 32.4 },
  BIBLIOTECA: { ios: 70.7, android: 61.5 },
  AJUSTES: { ios: 54.3, android: 47.6 },
  // The words the tab bar no longer uses: kept to show why (UX-PHONE-12).
  INSTELLINGEN: { ios: 85.3, android: 75.2 },
  EINSTELLUNGEN: { ios: 97.0, android: 85.3 },
  AFSPEELLIJSTEN: { ios: 100.3, android: 88.7 },
};

const width = (label: string) => {
  const measured = PARROT_TAB_LABEL_WIDTHS[label];
  if (!measured) throw new Error(`no measured width for "${label}": measure it on a phone and add it to PARROT_TAB_LABEL_WIDTHS`);
  return Math.max(measured.ios, measured.android);
};

type Tree = { [key: string]: string | Tree };
const lookup = (tree: Tree, key: string): string => {
  const value = key.split(".").reduce<string | Tree | undefined>((node, part) => (typeof node === "object" ? node[part] : undefined), tree);
  if (typeof value !== "string") throw new Error(`missing translation ${key}`);
  return value;
};

// The tab keys, in order, as MainScreen gives them to the bar; the Search circle sits after Library.
const source = readFileSync(new URL("../src/screens/MainScreen.tsx", import.meta.url), "utf8");
const tabsBlock = source.slice(source.indexOf("export const MAIN_TABS"), source.indexOf("];", source.indexOf("export const MAIN_TABS")));
const TAB_KEYS = [...tabsBlock.matchAll(/id: "(\w+)", label: "([\w.]+)"/g)].map((m) => ({ id: m[1]!, key: m[2]! }));

describe("Parrot's tab labels fit their half of the bar (UX-PHONE-12)", () => {
  it("reads the four tabs, Search after Library", () => {
    expect(TAB_KEYS.map((tab) => tab.id)).toEqual(["home", "library", "playlists", "settings"]);
    expect(source).toMatch(/after: "library"/);
  });

  it.each(Object.keys(PARROT_TRANSLATIONS) as (keyof typeof PARROT_TRANSLATIONS)[])(
    "every %s label fits its half at 360 and 375 wide, 8 pt apart",
    (language) => {
      const labels = TAB_KEYS.map((tab) => lookup(PARROT_TRANSLATIONS[language] as Tree, tab.key).toUpperCase());
      for (const phone of [360, 375]) {
        for (const half of [labels.slice(0, 2), labels.slice(2)]) {
          const widths = half.map(width);
          console.info(`[PARROT-MOBILE-TAB-LABEL-FIT-001] ${language} ${phone}: ${half.join(" + ")} = ${widths.join(" + ")} in ${tabBarHalfWidth(phone)}`);
          expect(tabBarHalfFits(phone, widths), `${language} ${phone}: ${half.join(" + ")}`).toBe(true);
        }
      }
    },
  );

  it("the long words would not fit, which is why the bar uses OPTIES, OPTIONEN and PLAYLISTS", () => {
    expect(tabBarHalfFits(360, [width("PLAYLISTS"), width("INSTELLINGEN")])).toBe(false);
    expect(tabBarHalfFits(360, [width("PLAYLISTS"), width("EINSTELLUNGEN")])).toBe(false);
    expect(tabBarHalfFits(360, [width("AFSPEELLIJSTEN"), width("OPTIES")])).toBe(false);
    expect(tabBarHalfFits(360, [width("ACCUEIL"), width("BIBLIOTHÈQUE")])).toBe(true);
  });
});
