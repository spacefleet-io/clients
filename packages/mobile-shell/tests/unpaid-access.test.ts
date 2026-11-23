import { describe, expect, it } from "vitest";
import type { AccountAccess } from "@space/shared/accountAccess";
import en from "../src/i18n/en.json";
import fr from "../src/i18n/fr.json";
import { getUnpaidAccessInfo, isGenericPlayerFailure, playerFailureMessage, unpaidMessage } from "../src/unpaidAccess";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-20T12:00:00Z");
const iso = (offsetDays: number) => new Date(NOW + offsetDays * DAY).toISOString();

const access = (overrides: Partial<AccountAccess>): AccountAccess => ({
  state: "free",
  paidUntil: null,
  billingPeriod: null,
  wipeAt: null,
  qosTier: "free",
  ...overrides,
});

/** The string at dotted `key` in a dictionary, or undefined when the path is missing or not a string. */
const lookup = (dict: unknown, key: string): string | undefined => {
  const value = key
    .split(".")
    .reduce<unknown>((node, part) => (typeof node === "object" && node !== null && part in node ? Reflect.get(node, part) : undefined), dict);
  return typeof value === "string" ? value : undefined;
};

/** Minimal i18next-like translator over a dictionary with `{{var}}` interpolation. */
const translator =
  (dict: unknown) =>
  (key: string, options?: Record<string, unknown>): string => {
    const raw = lookup(dict, key);
    if (typeof raw !== "string") throw new Error(`missing key ${key}`);
    return raw.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options?.[name] ?? ""));
  };

const tEn = translator(en);
const tFr = translator(fr);

const unpaid = access({ state: "unpaid", paidUntil: iso(-3), wipeAt: iso(57), qosTier: "free" });

describe("unpaid access info", () => {
  /** @req ACCT-UNPAID-03[badger-mobile] */
  it("is unpaid with the wipe date for an unpaid account", () => {
    const info = getUnpaidAccessInfo(unpaid, NOW);
    console.log("unpaid info", info);
    expect(info).toEqual({ unpaid: true, wipeAt: unpaid.wipeAt });
  });

  /** @req ACCT-UNPAID-03[badger-mobile] */
  it("is not unpaid for free, paid, missing access", () => {
    expect(getUnpaidAccessInfo(access({}), NOW).unpaid).toBe(false);
    expect(getUnpaidAccessInfo(access({ state: "paid", paidUntil: iso(10), qosTier: "paid" }), NOW).unpaid).toBe(false);
    expect(getUnpaidAccessInfo(undefined, NOW)).toEqual({ unpaid: false, wipeAt: null });
    expect(getUnpaidAccessInfo(null, NOW)).toEqual({ unpaid: false, wipeAt: null });
  });

  /** @req ACCT-UNPAID-03[badger-mobile] */
  it("turns a paid account whose period ran out while the app was open into unpaid, with a computed wipe date", () => {
    const info = getUnpaidAccessInfo(access({ state: "paid", paidUntil: iso(-1), qosTier: "paid" }), NOW);
    console.log("expired-while-open info", info);
    expect(info.unpaid).toBe(true);
    expect(info.wipeAt).toBe(iso(59));
  });
});

describe("unpaid messages", () => {
  /** @req ACCT-UNPAID-03[badger-mobile] */
  it("banner names the wipe date and says playback and uploads are stopped (en)", () => {
    const text = unpaidMessage(tEn, "unpaidBanner", unpaid.wipeAt, "en");
    console.log("banner en", text);
    expect(text).toContain("2026");
    expect(text).toMatch(/playback and uploads are stopped/i);
    expect(text).not.toContain("{{");
  });

  /** @req ACCT-UNPAID-03[badger-mobile] */
  it("banner names the wipe date and says playback and uploads are stopped (fr)", () => {
    const text = unpaidMessage(tFr, "unpaidBanner", unpaid.wipeAt, "fr");
    console.log("banner fr", text);
    expect(text).toContain("2026");
    expect(text).toMatch(/lecture et les envois sont arrêtés/i);
    expect(text).not.toContain("{{");
  });

  /** @req ACCT-UNPAID-03[badger-mobile] */
  it("falls back to the undated wording without a wipe date", () => {
    const text = unpaidMessage(tEn, "unpaidBanner", null, "en");
    expect(text).toMatch(/playback and uploads are stopped/i);
    expect(text).not.toMatch(/\{\{|undefined/);
  });

  /** @req ACCT-UNPAID-03[badger-mobile] @req ACCT-PAY-02[badger-mobile] */
  it("only informs: no link, button or instruction to pay in any unpaid string", () => {
    for (const dict of [en, fr]) {
      for (const [key, value] of Object.entries(dict.account.access)) {
        console.log("unpaid string", key, value);
        expect(value, key).not.toMatch(/renew|renouvel|pay|paie|upgrade|web|https?:/i);
      }
    }
  });
});

describe("player failure message", () => {
  /** @req ACCT-UNPAID-03[badger-mobile] */
  it("replaces the generic open failure with the unpaid message for an unpaid account", () => {
    for (const code of ["openFailed", "startTimeout", "stoppedUnexpectedly", "gatewayUnavailable", "startFailed"]) {
      const text = playerFailureMessage(tEn, code, unpaid, "en", NOW);
      console.log("player failure", code, text);
      expect(text, code).toMatch(/Playback is stopped because your subscription ended/);
      expect(text, code).toContain("2026");
    }
  });

  /** @req ACCT-UNPAID-03[badger-mobile] */
  it("keeps the generic text when the account is not unpaid", () => {
    expect(playerFailureMessage(tEn, "openFailed", access({}), "en", NOW)).toBe(en.player.error.openFailed);
    expect(playerFailureMessage(tEn, "openFailed", undefined, "en", NOW)).toBe(en.player.error.openFailed);
  });

  /** @req ACCT-UNPAID-03[badger-mobile] */
  it("keeps specific causes (saturated silo, missing key, title gone, no video) even for an unpaid account", () => {
    for (const code of ["playbackStopped", "freePlaybackRefused", "missingLibraryKey", "titleMissing", "noPlayableFile", "notAvailable"]) {
      expect(isGenericPlayerFailure(code), code).toBe(false);
      expect(playerFailureMessage(tEn, code, unpaid, "en", NOW), code).toBe(lookup(en, `player.error.${code}`));
    }
  });

  /** @req ACCT-UNPAID-03[badger-mobile] */
  it("keeps the real cause when a downloaded title fails: offline playback never reaches the gateway's 402", () => {
    for (const code of ["openFailed", "startTimeout", "stoppedUnexpectedly"]) {
      expect(playerFailureMessage(tEn, code, unpaid, "en", NOW, { offline: true }), code).toBe(lookup(en, `player.error.${code}`));
    }
  });
});
