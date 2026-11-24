/**
 * @test-id PARROT-MOBILE-ACCOUNT-LANGUAGE-001
 * @level unit
 * @req UX-I18N-07
 * @why Chris 2026-11-11: one account has one language, shared across apps, profiles and emails. Right after a fresh
 *   sign-in or pairing Parrot's phone reconciles the language picked before sign-in with the account's (asking with
 *   the shared prompt when they differ, never blocking the sign-in); a restored session's `/auth/me` makes the phone
 *   show the account's language; a language picked while signed in is saved to the account, and a save that failed
 *   is retried on the next `/auth/me` instead of being reverted by it (the shared `createAccountLanguageSync`, the
 *   same chain as Badger's phone, REL-FAM-03).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const phone = vi.hoisted(() => ({
  shown: "en",
  account: null as string | null,
  meFails: false,
  saveFails: false,
  pick: "en",
  asked: [] as unknown[],
  saved: [] as unknown[],
  applied: [] as string[],
  storage: new Map<string, string>(),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => phone.storage.get(key) ?? null,
    setItem: async (key: string, value: string) => void phone.storage.set(key, value),
    removeItem: async (key: string) => void phone.storage.delete(key),
  },
}));
vi.mock("@space/mobile-shell/i18n", () => ({
  getCurrentLanguage: () => phone.shown,
  isMobileUiLanguage: (code: unknown) => typeof code === "string" && ["en", "fr", "nl", "de", "es"].includes(code),
  changeLanguage: async (code: string) => {
    phone.applied.push(code);
    phone.shown = code;
  },
}));
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
  updateSettings: async (token: string, input: { preferences: { uiLanguage: string } }) => {
    if (phone.saveFails) throw new TypeError("Network request failed");
    phone.saved.push({ token, input });
    phone.account = input.preferences.uiLanguage;
    return { user: {} };
  },
}));
vi.mock("../src/lib/i18n", () => ({ PARROT_LANGUAGE_KEY: "parrot.uiLanguage" }));

import type { User } from "@space/shared/api";
import {
  applyAccountLanguage,
  forgetAccountLanguage,
  pickSignedInLanguage,
  reconcileAfterSignIn,
} from "../src/lib/accountLanguage";

const SUITE = "[PARROT-MOBILE-ACCOUNT-LANGUAGE-001]";
const dump = (label: string) =>
  console.info(`${SUITE} ${label}`, JSON.stringify({ ...phone, storage: Object.fromEntries(phone.storage) }));

const me = (uiLanguage: string | null) => ({ uiLanguage: uiLanguage ?? undefined, preferences: {} }) as Pick<User, "uiLanguage" | "preferences">;

beforeEach(async () => {
  await forgetAccountLanguage();
  Object.assign(phone, { shown: "en", account: null, meFails: false, saveFails: false, pick: "en", asked: [], saved: [], applied: [] });
  phone.storage.clear();
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
    await applyAccountLanguage("tok", me("es"));
    dump("auth/me");
    expect(phone.applied).toEqual(["es"]);
    expect(phone.saved).toEqual([]);
    await applyAccountLanguage("tok", me("es"));
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

  // @bugfix @regression-proof (audit #3350 S51): the pick was logged `pick_not_saved` and dropped, so the next
  // `/auth/me` (start, back to the front) put the account's old language back over the user's pick.
  it("keeps a pick whose save failed and pushes it on the next /auth/me instead of reverting it", async () => {
    phone.account = "en";
    phone.saveFails = true;
    await pickSignedInLanguage("tok", "de");
    dump("pick, save failed");
    expect(phone.applied).toEqual(["de"]);
    expect(phone.saved).toEqual([]);

    phone.saveFails = false;
    await applyAccountLanguage("tok", me("en"));
    dump("next auth/me");
    expect(phone.shown).toBe("de");
    expect(phone.applied).toEqual(["de"]);
    expect(phone.saved).toEqual([{ token: "tok", input: { preferences: { uiLanguage: "de" } } }]);

    await applyAccountLanguage("tok", me("de"));
    dump("auth/me after the push");
    expect(phone.saved).toHaveLength(1);
    expect(phone.shown).toBe("de");
  });

  // @bugfix @regression-proof (audit #3350 S51): the phone started offline, so no `/auth/me` told it the account's
  // language before the pick; the pick still waits for the account and is pushed once the network is back.
  it("pushes a pick made offline before any /auth/me answered, once the network is back", async () => {
    phone.account = "en";
    phone.meFails = true;
    phone.saveFails = true;
    await pickSignedInLanguage("tok", "nl");
    dump("offline pick");
    expect(phone.shown).toBe("nl");
    expect(phone.saved).toEqual([]);

    phone.meFails = false;
    phone.saveFails = false;
    await applyAccountLanguage("tok", me("en"));
    dump("back online");
    expect(phone.shown).toBe("nl");
    expect(phone.saved).toEqual([{ token: "tok", input: { preferences: { uiLanguage: "nl" } } }]);
  });

  it("lets a later change made on another device win over a pick that never reached the account", async () => {
    phone.account = "en";
    phone.saveFails = true;
    await pickSignedInLanguage("tok", "de");
    phone.saveFails = false;
    await applyAccountLanguage("tok", me("fr"));
    dump("another device chose fr");
    expect(phone.shown).toBe("fr");
    expect(phone.saved).toEqual([]);
  });

  it("forgets a pending pick on sign-out: the next account's language is not overwritten", async () => {
    phone.account = "en";
    phone.saveFails = true;
    await pickSignedInLanguage("tok", "de");
    phone.saveFails = false;
    await forgetAccountLanguage();
    await applyAccountLanguage("tok", me("es"));
    dump("after sign-out");
    expect(phone.shown).toBe("es");
    expect(phone.saved).toEqual([]);
  });
});
