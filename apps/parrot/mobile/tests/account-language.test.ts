/**
 * @test-id PARROT-MOBILE-ACCOUNT-LANGUAGE-001
 * @level unit
 * @req UX-I18N-07
 * @why Chris 2026-11-11: one account has one language, shared across apps, profiles and emails. Right after a fresh
 *   sign-in or pairing Parrot's phone reconciles the language picked before sign-in with the account's (asking with
 *   the shared prompt when they differ, never blocking the sign-in); a restored session's `/auth/me` makes the phone
 *   show the account's language; a language picked while signed in is saved to the account.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const phone = vi.hoisted(() => ({
  shown: "en",
  account: null as string | null,
  meFails: false,
  pick: "en",
  asked: [] as unknown[],
  saved: [] as unknown[],
  applied: [] as string[],
}));

vi.mock("@space/mobile-shell/i18n", () => ({ getCurrentLanguage: () => phone.shown }));
vi.mock("@space/mobile-shell/logger", () => ({ scopeLogger: () => ({ info: () => undefined, warn: () => undefined }) }));
vi.mock("@space/mobile-shell/account-language-prompt", () => ({
  askAccountLanguage: async (choice: unknown) => {
    phone.asked.push(choice);
    return phone.pick;
  },
}));
vi.mock("@space/shared/api", () => ({
  getMe: async (token: string) => {
    if (phone.meFails) throw new TypeError("Network request failed");
    return { user: { id: "u1", email: "a@b.c", uiLanguage: phone.account ?? undefined, preferences: {}, token } };
  },
  updateSettings: async (token: string, input: unknown) => {
    phone.saved.push({ token, input });
    return { user: {} };
  },
}));
vi.mock("../src/lib/i18n", () => ({
  setParrotLanguage: async (code: string) => {
    phone.applied.push(code);
    phone.shown = code;
  },
}));

import { applyAccountLanguageFromServer, pickSignedInLanguage, reconcileAfterSignIn } from "../src/lib/accountLanguage";

const SUITE = "[PARROT-MOBILE-ACCOUNT-LANGUAGE-001]";
const dump = (label: string) => console.info(`${SUITE} ${label}`, JSON.stringify(phone));

beforeEach(() => {
  Object.assign(phone, { shown: "en", account: null, meFails: false, pick: "en", asked: [], saved: [], applied: [] });
});

describe("@req UX-I18N-07 Parrot phone: the account's one language", () => {
  it("asks which language after a sign-in when the account's differs, and applies the account's pick to the phone", async () => {
    phone.account = "fr";
    phone.pick = "fr";
    await reconcileAfterSignIn("tok");
    dump("picked the account's");
    expect(phone.asked).toEqual([{ device: "en", account: "fr" }]);
    expect(phone.applied).toEqual(["fr"]);
    expect(phone.saved).toEqual([]);
  });

  it("saves the phone's language to the account when that one is picked", async () => {
    phone.account = "de";
    phone.pick = "en";
    await reconcileAfterSignIn("tok");
    dump("picked the phone's");
    expect(phone.saved).toEqual([{ token: "tok", input: { preferences: { uiLanguage: "en" } } }]);
    expect(phone.applied).toEqual([]);
  });

  it("gives an account without a language the phone's, without asking; a matching one changes nothing", async () => {
    phone.shown = "nl";
    await reconcileAfterSignIn("tok");
    expect(phone.asked).toEqual([]);
    expect(phone.saved).toEqual([{ token: "tok", input: { preferences: { uiLanguage: "nl" } } }]);

    phone.saved = [];
    phone.account = "nl";
    await reconcileAfterSignIn("tok");
    dump("same");
    expect(phone.asked).toEqual([]);
    expect(phone.saved).toEqual([]);
    expect(phone.applied).toEqual([]);
  });

  it("never blocks the sign-in when the account cannot be read", async () => {
    phone.meFails = true;
    await expect(reconcileAfterSignIn("tok")).resolves.toBeUndefined();
    expect(phone.saved).toEqual([]);
    expect(phone.applied).toEqual([]);
  });

  it("shows the account's language when a restored session's /auth/me brings another one", async () => {
    phone.account = "es";
    await applyAccountLanguageFromServer("tok");
    dump("auth/me");
    expect(phone.applied).toEqual(["es"]);
    expect(phone.saved).toEqual([]);
    await applyAccountLanguageFromServer("tok");
    expect(phone.applied).toEqual(["es"]);
  });

  it("saves a language picked while signed in to the account, and only on the phone before sign-in", async () => {
    await pickSignedInLanguage("tok", "de");
    expect(phone.applied).toEqual(["de"]);
    expect(phone.saved).toEqual([{ token: "tok", input: { preferences: { uiLanguage: "de" } } }]);
    await pickSignedInLanguage(null, "fr");
    dump("picked");
    expect(phone.applied).toEqual(["de", "fr"]);
    expect(phone.saved).toHaveLength(1);
  });
});
