/**
 * @test-id MOBILE-I18N-START-001
 * @level unit
 * @why The phone app opens in the device's language when it is English, French, Dutch or German, otherwise in
 *   English; a language the user picks is remembered and wins on later starts. Right after a sign-in or pairing the
 *   language chosen before signing in meets the account's one language: an account without one takes it, a
 *   different one asks "Which language do you want?" and the answer applies to the whole account. While signed in,
 *   the account's language wins unless the user picked one on this phone that has not reached the account yet,
 *   which is then pushed to the account, in pick order, unless another device changed the account since. All five
 *   languages reach the account, which writes its emails in them (UX-I18N-01, UX-I18N-07, ACCT-EMAIL-01).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCurrentLanguage } from "@space/mobile-shell/i18n";
import { pickStartLanguage, readDeviceLocale } from "@space/mobile-shell/i18n/deviceLanguage";
import { createFakeAsyncStorage } from "./harness";
import type { AccountLanguageInput, AccountLanguageStep, AccountLanguageSync } from "../src/lib/uiLanguage";
import {
  accountLanguageStep,
  chooseUiLanguage,
  ensureI18n,
  forgetAccountLanguage,
  reconcileSignedInLanguage,
  syncAccountLanguage,
  UI_LANGUAGE_KEY,
  UI_LANGUAGE_UNSYNCED_KEY,
} from "../src/lib/uiLanguage";

type Device = { os: "android" | "ios"; androidLocale: string | null; appleLanguages: unknown };
const device = vi.hoisted((): Device => ({ os: "android", androidLocale: "en_US", appleLanguages: undefined }));

const fakeStorage = createFakeAsyncStorage();

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: (key: string) => fakeStorage.getItem(key),
    setItem: (key: string, value: string) => fakeStorage.setItem(key, value),
    removeItem: (key: string) => fakeStorage.removeItem(key),
  },
}));

vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return device.os;
    },
  },
  I18nManager: { getConstants: () => ({ localeIdentifier: device.androidLocale }) },
  Settings: { get: (key: string) => (key === "AppleLanguages" ? device.appleLanguages : undefined) },
}));

/** The account on the API: what `/auth/me` answers, and the saves that reached it, in order. */
type AccountApi = { language: string | null; offline: boolean; holdSaves: boolean; held: Array<() => void>; saves: string[] };
const accountApi: AccountApi = { language: "en", offline: false, holdSaves: false, held: [], saves: [] };

/** A signed-in session whose app state shows the account in `cached`. */
const session = (cached: string | null): AccountLanguageSync => ({
  account: cached,
  cancelled: () => false,
  fetchAccountLanguage: async () => {
    if (accountApi.offline) throw new Error("offline");
    return accountApi.language;
  },
  saveAccountLanguage: (language) =>
    new Promise<void>((resolve, reject) => {
      if (accountApi.offline) {
        reject(new Error("offline"));
        return;
      }
      const land = () => {
        accountApi.language = language;
        accountApi.saves.push(language);
        resolve();
      };
      if (accountApi.holdSaves) accountApi.held.push(land);
      else land();
    }),
  onAccountLanguage: () => undefined,
});

/** Waits for every job already queued on the account chain (a skipped sync is queued behind them). */
const settle = (cached: string | null = null) => syncAccountLanguage({ ...session(cached), cancelled: () => true });

const marker = () => fakeStorage._backing.get(UI_LANGUAGE_UNSYNCED_KEY) ?? null;

beforeEach(async () => {
  fakeStorage._backing.clear();
  await forgetAccountLanguage();
  device.os = "android";
  device.androidLocale = "en_US";
  device.appleLanguages = undefined;
  Object.assign(accountApi, { language: "en", offline: false, holdSaves: false, held: [], saves: [] });
});

describe("start language", () => {
  /** @req UX-I18N-01[badger-mobile] */
  it("picks the device's language when the app has it, else English, and a remembered choice wins", () => {
    const cases: Array<[string | null, string | null, string]> = [
      [null, "nl-NL", "nl"],
      [null, "nl_BE", "nl"],
      [null, "de_AT", "de"],
      [null, "de-DE", "de"],
      [null, "fr-CA", "fr"],
      [null, "es-ES", "es"],
      [null, "es_MX", "es"],
      [null, "ja-JP", "en"],
      [null, "pt_BR", "en"],
      [null, null, "en"],
      ["de", "nl-NL", "de"],
      ["fr", "es-ES", "fr"],
      ["es", "de-DE", "es"],
      ["xx", "nl-NL", "nl"],
    ];
    for (const [saved, locale, expected] of cases) {
      const picked = pickStartLanguage(saved, locale);
      console.info(`[MOBILE-I18N-START-001] saved=${saved} device=${locale} -> ${picked}`);
      expect(picked).toBe(expected);
    }
  });

  /** @req UX-I18N-01[badger-mobile] */
  it("reads the first preferred language on iOS and the app locale on Android", () => {
    device.os = "ios";
    device.appleLanguages = ["de-AT", "en-US"];
    device.androidLocale = "en_US";
    const ios = readDeviceLocale();
    device.os = "android";
    device.androidLocale = "nl_NL";
    const android = readDeviceLocale();
    console.info(`[MOBILE-I18N-START-001] ios=${ios} android=${android}`);
    expect(ios).toBe("de-AT");
    expect(android).toBe("nl_NL");
  });

  /** @req UX-I18N-01[badger-mobile] */
  it("starts a fresh install in the device's language, then keeps a picked language across starts", async () => {
    device.androidLocale = "de_DE";
    await ensureI18n();
    console.info(`[MOBILE-I18N-START-001] fresh install on de_DE -> ${getCurrentLanguage()}`);
    expect(getCurrentLanguage()).toBe("de");

    await chooseUiLanguage("nl", { pushToAccount: false });
    expect(fakeStorage._backing.get(UI_LANGUAGE_KEY)).toBe("nl");

    device.androidLocale = "fr_FR";
    await ensureI18n();
    console.info(`[MOBILE-I18N-START-001] restart on fr_FR with nl picked -> ${getCurrentLanguage()}`);
    expect(getCurrentLanguage()).toBe("nl");
  });
});

describe("language and the account", () => {
  /** @req UX-I18N-07[badger-mobile] */
  it("marks every language picked while signed in, with the account's language seen at the first pick", async () => {
    await settle("en");
    await chooseUiLanguage("fr", { pushToAccount: true });
    await settle();
    const afterFrench = marker();
    await chooseUiLanguage("de", { pushToAccount: true });
    await settle();
    const afterGerman = marker();
    await chooseUiLanguage("en", { pushToAccount: true });
    await chooseUiLanguage("en", { pushToAccount: false });
    await settle();
    const afterSignedOutPick = marker();
    console.info(`[MOBILE-I18N-START-001] marker afterFrench=${afterFrench} afterGerman=${afterGerman} afterSignedOutPick=${afterSignedOutPick}`);
    expect(afterFrench).toBe("en");
    expect(afterGerman).toBe("en");
    expect(afterSignedOutPick).toBeNull();
    expect(fakeStorage._backing.get(UI_LANGUAGE_KEY)).toBe("en");
    expect(getCurrentLanguage()).toBe("en");
  });

  /** @req UX-I18N-01[badger-mobile] @req UX-I18N-07[badger-mobile] */
  it("applies the account's language after sign-in and pushes a pick made here, Dutch and German included", () => {
    const cases: Array<[AccountLanguageInput, AccountLanguageStep]> = [
      [{ current: "en", account: "fr", marker: null }, { kind: "apply", language: "fr" }],
      [{ current: "fr", account: "fr", marker: null }, { kind: "none", reason: "same" }],
      [{ current: "en", account: null, marker: null }, { kind: "none", reason: "account_has_none" }],
      [{ current: "fr", account: "en", marker: "en" }, { kind: "push", language: "fr" }],
      // The account already shows the pick, maybe from an earlier pick of this phone: push anyway.
      [{ current: "fr", account: "fr", marker: "fr" }, { kind: "push", language: "fr" }],
      [{ current: "fr", account: null, marker: "" }, { kind: "push", language: "fr" }],
      // The account moved since the pick: another device chose later, and wins.
      [{ current: "en", account: "fr", marker: "en" }, { kind: "apply", language: "fr" }],
      [{ current: "nl", account: "en", marker: null }, { kind: "apply", language: "en" }],
      [{ current: "en", account: "nl", marker: null }, { kind: "apply", language: "nl" }],
      [{ current: "de", account: "fr", marker: "fr" }, { kind: "push", language: "de" }],
    ];
    for (const [input, expected] of cases) {
      const step = accountLanguageStep(input);
      console.info(`[MOBILE-I18N-START-001] ${JSON.stringify(input)} -> ${JSON.stringify(step)}`);
      expect(step).toEqual(expected);
    }
  });

  /** @req UX-I18N-07[badger-mobile] */
  it("saves picks in pick order, so a save that lands late never leaves the account on an abandoned pick", async () => {
    await chooseUiLanguage("en", { pushToAccount: false });
    await syncAccountLanguage(session("en"));
    accountApi.holdSaves = true;

    await chooseUiLanguage("fr", { pushToAccount: true });
    const frenchSync = syncAccountLanguage(session("en"));
    await vi.waitFor(() => expect(accountApi.held).toHaveLength(1));
    console.info(`[MOBILE-I18N-START-001] French save in flight, marker=${marker()}`);

    // Back to English while the French save is still on its way; the app state still shows the account in English.
    await chooseUiLanguage("en", { pushToAccount: true });
    const englishSync = syncAccountLanguage(session("en"));
    accountApi.holdSaves = false;
    accountApi.held.shift()?.();
    await Promise.all([frenchSync, englishSync]);
    // A later sync from state that still shows the French save must not switch the phone back.
    await syncAccountLanguage(session("fr"));
    await settle();

    console.info(
      `[MOBILE-I18N-START-001] saves=${JSON.stringify(accountApi.saves)} account=${accountApi.language} phone=${getCurrentLanguage()} marker=${marker()}`
    );
    expect(accountApi.saves).toEqual(["fr", "en"]);
    expect(accountApi.language).toBe("en");
    expect(getCurrentLanguage()).toBe("en");
    expect(marker()).toBeNull();
  });

  /** @req UX-I18N-07[badger-mobile] */
  it("retries a failed push on the next start, unless another device changed the account since the pick", async () => {
    await chooseUiLanguage("en", { pushToAccount: false });
    await syncAccountLanguage(session("en"));

    // Offline: French, then back to English; neither reaches the account.
    accountApi.offline = true;
    await chooseUiLanguage("fr", { pushToAccount: true });
    await syncAccountLanguage(session("en"));
    await chooseUiLanguage("en", { pushToAccount: true });
    await syncAccountLanguage(session("en"));
    const pending = marker();

    // Meanwhile the desktop app switches the account to French; the phone starts again, online.
    accountApi.offline = false;
    accountApi.language = "fr";
    await syncAccountLanguage(session("en"));
    await settle();
    console.info(
      `[MOBILE-I18N-START-001] changed elsewhere: pending=${pending} saves=${JSON.stringify(accountApi.saves)} account=${accountApi.language} phone=${getCurrentLanguage()} marker=${marker()}`
    );
    expect(pending).toBe("en");
    expect(accountApi.saves).toEqual([]);
    expect(accountApi.language).toBe("fr");
    expect(getCurrentLanguage()).toBe("fr");
    expect(fakeStorage._backing.get(UI_LANGUAGE_KEY)).toBe("fr");
    expect(marker()).toBeNull();

    // Same story, but nothing changed the account: the pending pick is pushed on the next start.
    accountApi.offline = true;
    await chooseUiLanguage("en", { pushToAccount: true });
    await syncAccountLanguage(session("fr"));
    accountApi.offline = false;
    await syncAccountLanguage(session("fr"));
    await settle();
    console.info(
      `[MOBILE-I18N-START-001] unchanged: saves=${JSON.stringify(accountApi.saves)} account=${accountApi.language} phone=${getCurrentLanguage()} marker=${marker()}`
    );
    expect(accountApi.saves).toEqual(["en"]);
    expect(accountApi.language).toBe("en");
    expect(getCurrentLanguage()).toBe("en");
    expect(marker()).toBeNull();
  });

  /** @req UX-I18N-07[badger-mobile] */
  it("a German pick reaches the account, and a signed-in phone still in German takes the account's language from /auth/me", async () => {
    // The phone is in German; the account is French (chosen on the desktop app): the account's language wins.
    await chooseUiLanguage("de", { pushToAccount: false });
    accountApi.language = "fr";
    await syncAccountLanguage(session("fr"));
    await settle();
    const afterSignIn = getCurrentLanguage();

    // The user now picks German again on this phone: the account takes it (its emails go out in German).
    await chooseUiLanguage("de", { pushToAccount: true });
    await settle();
    const pending = marker();
    await syncAccountLanguage(session("fr"));
    await settle();
    console.info(
      `[MOBILE-I18N-START-001] German: afterSignIn=${afterSignIn} pending=${pending} saves=${JSON.stringify(accountApi.saves)} account=${accountApi.language} phone=${getCurrentLanguage()} marker=${marker()}`
    );
    expect(afterSignIn).toBe("fr");
    expect(pending).toBe("fr");
    expect(accountApi.saves).toEqual(["de"]);
    expect(accountApi.language).toBe("de");
    expect(getCurrentLanguage()).toBe("de");
    expect(marker()).toBeNull();
  });
});

describe("right after a sign-in or pairing", () => {
  /** A fresh session asking "Which language do you want?" with `answer` (null: it must not ask). */
  const signIn = async (answer: "device" | "account" | null) => {
    const asked: Array<{ device: string; account: string }> = [];
    const mirrored: string[] = [];
    await reconcileSignedInLanguage({
      fetchAccountLanguage: session(null).fetchAccountLanguage,
      saveAccountLanguage: session(null).saveAccountLanguage,
      onAccountLanguage: (language) => mirrored.push(language),
      ask: async (options) => {
        asked.push(options);
        if (answer === null) throw new Error("asked without a difference");
        return options[answer];
      },
    });
    await settle();
    console.info(
      `[MOBILE-I18N-START-001] sign-in answer=${answer} asked=${JSON.stringify(asked)} saves=${JSON.stringify(accountApi.saves)} account=${accountApi.language} phone=${getCurrentLanguage()} marker=${marker()}`
    );
    return { asked, mirrored };
  };

  /** @req UX-I18N-07[badger-mobile,badger-tv] */
  it("an account without a language takes the one chosen before signing in, without asking", async () => {
    await chooseUiLanguage("nl", { pushToAccount: false });
    accountApi.language = null;
    const { asked, mirrored } = await signIn(null);
    expect(asked).toEqual([]);
    expect(accountApi.saves).toEqual(["nl"]);
    expect(mirrored).toEqual(["nl"]);
    expect(getCurrentLanguage()).toBe("nl");
  });

  /** @req UX-I18N-07[badger-mobile,badger-tv] */
  it("the same language on both sides changes nothing", async () => {
    await chooseUiLanguage("fr", { pushToAccount: false });
    accountApi.language = "fr";
    const { asked } = await signIn(null);
    expect(asked).toEqual([]);
    expect(accountApi.saves).toEqual([]);
    expect(getCurrentLanguage()).toBe("fr");
  });

  /** @req UX-I18N-07[badger-mobile,badger-tv] */
  it("two languages ask which one; this device's pick goes to the account, the account's pick to this device", async () => {
    await chooseUiLanguage("de", { pushToAccount: false });
    accountApi.language = "fr";
    const kept = await signIn("device");
    expect(kept.asked).toEqual([{ device: "de", account: "fr" }]);
    expect(accountApi.saves).toEqual(["de"]);
    expect(getCurrentLanguage()).toBe("de");

    await forgetAccountLanguage();
    accountApi.language = "es";
    accountApi.saves = [];
    const taken = await signIn("account");
    expect(taken.asked).toEqual([{ device: "de", account: "es" }]);
    expect(accountApi.saves, "the account already holds its own language").toEqual([]);
    expect(getCurrentLanguage()).toBe("es");
    expect(fakeStorage._backing.get(UI_LANGUAGE_KEY), "remembered on this device").toBe("es");
    expect(marker()).toBeNull();
  });

  /** @req UX-I18N-07[badger-mobile,badger-tv] */
  it("a pick the account could not save never blocks the sign-in and is pushed by the next sync", async () => {
    await chooseUiLanguage("de", { pushToAccount: false });
    accountApi.language = "fr";
    await reconcileSignedInLanguage({
      fetchAccountLanguage: session(null).fetchAccountLanguage,
      saveAccountLanguage: async () => {
        throw new Error("offline");
      },
      onAccountLanguage: () => undefined,
      ask: async (options) => options.device,
    });
    await settle();
    const pending = marker();
    await syncAccountLanguage(session("fr"));
    await settle();
    console.info(`[MOBILE-I18N-START-001] failed sign-in save: pending=${pending} saves=${JSON.stringify(accountApi.saves)} phone=${getCurrentLanguage()}`);
    expect(pending).toBe("fr");
    expect(accountApi.saves).toEqual(["de"]);
    expect(getCurrentLanguage()).toBe("de");
    expect(marker()).toBeNull();
  });
});
