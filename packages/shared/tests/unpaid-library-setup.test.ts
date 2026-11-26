import { describe, expect, it } from "vitest";
import type { AccountAccess } from "../src/accountAccess";
import { CLIENT_UI_LANGUAGES } from "../src/i18n";
import { LIBRARY_NOUN } from "../src/keySavedWarning";
import { unpaidAccessSignText } from "../src/unpaidAccessSign";
import { isUnpaidLibrarySetupRefusal, unpaidLibrarySetupText } from "../src/unpaidLibrarySetup";

/**
 * @req ACCT-UNPAID-06
 * @req ACCT-UNPAID-05
 * @level unit
 * @why An unpaid account's first library is refused with 402 `subscription_unpaid`; every app's setup must recognise
 *   that refusal in each shape it arrives in (an API error with its status, a bare message after Electron's IPC, or an
 *   unpaid `access`) and show one screen in five languages, whose phone and TV words point to no payment (ACCT-PAY-02).
 *   The unpaid sign's words for the apps without i18next catalogues come from the same package.
 */
const NOW = Date.parse("2026-11-26T12:00:00Z");
const unpaid: AccountAccess = { state: "unpaid", paidUntil: "2026-11-23T00:00:00Z", billingPeriod: "monthly", wipeAt: "2027-01-22T00:00:00Z", qosTier: "free" };
const paid: AccountAccess = { state: "paid", paidUntil: "2026-12-23T00:00:00Z", billingPeriod: "monthly", wipeAt: null, qosTier: "paid" };
const lapsed: AccountAccess = { ...paid, paidUntil: "2026-11-20T00:00:00Z" };
const PAYMENT_WORDS = /\b(pay|payment|buy|price|card|paiement|payer|carte|betal|kaart|zahl|karte|pago|pagar|tarjeta)\w*|€|\$/i;
const LANGUAGES = CLIENT_UI_LANGUAGES.map((option) => option.code);

describe("ACCT-UNPAID-06: recognising the unpaid refusal at the library step", () => {
  it("reads the API error, the message that crossed IPC and an unpaid access", () => {
    const apiError = Object.assign(new Error("subscription_unpaid"), { status: 402, payload: { error: "subscription_unpaid", wipeAt: unpaid.wipeAt } });
    const cases: [string, unknown, AccountAccess | null][] = [
      ["api error", apiError, null],
      ["ipc message", new Error("Error invoking remote method 'sf-library-db-open': Error: subscription_unpaid"), null],
      ["plain string", "subscription_unpaid", null],
      ["unpaid access", new Error("network down"), unpaid],
      ["paid period ended", new Error("network down"), lapsed],
    ];
    for (const [name, err, access] of cases) {
      console.info("[unpaid-library-setup] refusal", name);
      expect(isUnpaidLibrarySetupRefusal(err, access, NOW), name).toBe(true);
    }
  });

  it("leaves every other failure to the step's own error", () => {
    expect(isUnpaidLibrarySetupRefusal(Object.assign(new Error("payment_required"), { status: 402 }), paid, NOW)).toBe(false);
    expect(isUnpaidLibrarySetupRefusal(new Error("subscription_unpaid_soon"), null, NOW)).toBe(false);
    expect(isUnpaidLibrarySetupRefusal(new Error("timeout"), undefined, NOW)).toBe(false);
  });

  it("says the plan ended in five languages, with Renew on a computer and no payment pointer on a phone", () => {
    for (const language of LANGUAGES) {
      for (const app of ["badger", "parrot"] as const) {
        const computer = unpaidLibrarySetupText(language, app, "computer");
        const phone = unpaidLibrarySetupText(language, app, "phone");
        console.info("[unpaid-library-setup] text", { language, app, title: computer.title, phone: phone.body });
        for (const text of [computer, phone]) {
          expect(text.title).not.toBe("");
          expect(text.body).toContain(LIBRARY_NOUN[app][language]);
          expect(text.tryAgain).not.toBe("");
          expect(text.notRenewed).not.toBe("");
        }
        expect(computer.renew).not.toBe("");
        expect(phone.body).not.toBe(computer.body);
        expect(phone.body).not.toMatch(PAYMENT_WORDS);
      }
    }
    expect(unpaidLibrarySetupText("fr", "parrot", "phone").title).toBe("Votre abonnement est terminé");
  });
});

describe("ACCT-UNPAID-05: the unpaid sign's words", () => {
  it("shows nothing while the account is paid or its access is unknown", () => {
    expect(unpaidAccessSignText(paid, "en", NOW)).toBeNull();
    expect(unpaidAccessSignText(null, "en", NOW)).toBeNull();
  });

  it("names the wipe date in each language and points to no payment", () => {
    for (const language of LANGUAGES) {
      const text = unpaidAccessSignText(unpaid, language, NOW);
      console.info("[unpaid-access-sign] text", { language, text });
      expect(text?.sign).not.toBe("");
      expect(text?.wipeAt).toBe(unpaid.wipeAt);
      expect(text?.message).toMatch(/2027/);
      expect(text?.message).not.toMatch(PAYMENT_WORDS);
    }
    expect(unpaidAccessSignText({ ...unpaid, wipeAt: null }, "en", NOW)?.message).toContain("after a limited time");
  });

  it("shows the sign once the paid period ends, before the API says so", () => {
    expect(unpaidAccessSignText(lapsed, "en", NOW)?.sign).toBe("Plan ended");
  });
});
