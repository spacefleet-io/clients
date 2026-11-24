// The account's one language on Parrot's phone (UX-I18N-07, `@space/shared/accountLanguage`): every app, every
// profile and the emails. Before sign-in the language picked on the sign-in screen lives on this phone only; right
// after a fresh sign-in or pairing it is reconciled once with the account's (asking when they differ), by the first
// setup when it is open (UX-SETUP-08) and by the sign-in otherwise; while signed in, `/auth/me` brings the account's
// language at start and on coming back to the app, and a language picked in setup or Settings is saved to the account.
// The rules are the shared chain Badger's phone runs too (`@space/mobile-shell/account-language-sync`, REL-FAM-03): a
// pick the account could not save stays pending and is pushed by the next `/auth/me`, never reverted by it.
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { PhoneSetupProgress } from "@space/mobile-shell/setup";
import { changeLanguage, getCurrentLanguage, isMobileUiLanguage } from "@space/mobile-shell/i18n";
import { askAccountLanguage } from "@space/mobile-shell/account-language-prompt";
import { createAccountLanguageSync } from "@space/mobile-shell/account-language-sync";
import { accountLanguageOf } from "@space/shared/accountLanguage";
import { getMe, updateSettings, type User } from "@space/shared/api";
import type { AccountLanguage } from "@space/shared/i18n";
import { PARROT_LANGUAGE_KEY } from "./i18n";

const accountLanguage = createAccountLanguageSync({
  asyncStorage: AsyncStorage,
  languageKey: PARROT_LANGUAGE_KEY,
  unsyncedKey: "parrot.uiLanguageUnsynced",
  currentLanguage: getCurrentLanguage,
  showLanguage: changeLanguage,
});

/** Saves the account's language (`PATCH /account/settings`). */
const saveAccountLanguage = async (token: string, language: AccountLanguage): Promise<void> => {
  await updateSettings(token, { preferences: { uiLanguage: language } });
};

/**
 * True while the phone's first setup settles the language picked at its step 0 with the account's (UX-SETUP-08): it
 * asks right after the sign-in, before its first numbered step, so neither the sign-in nor `/auth/me` touch the
 * language until it has. A setup never started (no language picked: a phone set up before the walkthrough existed)
 * leaves it to the sign-in.
 */
export const setupSettlesLanguage = (setup: PhoneSetupProgress): boolean =>
  !setup.done && !setup.languageReconciled && !(setup.step === "language" && setup.language === null);

/**
 * Runs once right after a fresh sign-in or pairing, before setup's numbered steps (by the setup while it is open). A
 * failure is logged and never blocks the sign-in: the phone keeps its language and the next `/auth/me` settles it.
 */
export const reconcileAfterSignIn = (token: string): Promise<void> =>
  accountLanguage.reconcileAfterSignIn({
    fetchAccountLanguage: async () => accountLanguageOf((await getMe(token)).user),
    ask: askAccountLanguage,
    saveAccountLanguage: (language) => saveAccountLanguage(token, language),
  });

/**
 * A signed-in session's `/auth/me` answer (start, back to the front): the account's language wins over the phone's,
 * so another device's change shows here, unless this phone holds a pick the account has not saved yet, which is
 * pushed now.
 */
export const applyAccountLanguage = (token: string, user: Pick<User, "uiLanguage" | "preferences">): Promise<void> => {
  const account = accountLanguageOf(user);
  return accountLanguage.sync({
    account,
    fetchAccountLanguage: async () => account,
    saveAccountLanguage: (language) => saveAccountLanguage(token, language),
  });
};

/**
 * A language picked in setup or Settings: shown on this phone at once and, signed in (`token`), saved as the account's.
 * A save that fails stays pending on this phone and is retried by the next `/auth/me` (`applyAccountLanguage`). The
 * account's language at the pick is the one this phone last synced, which the phone shows until the pick (a pick
 * still pending keeps its own): it holds even when no `/auth/me` answered since the app started offline.
 */
export const pickSignedInLanguage = async (token: string | null, code: string): Promise<void> => {
  if (!isMobileUiLanguage(code)) return;
  const shownBefore = getCurrentLanguage();
  await accountLanguage.choose(code, { pushToAccount: token !== null, account: token ? shownBefore : undefined });
  if (!token) return;
  await accountLanguage.sync({
    account: null,
    fetchAccountLanguage: async () => accountLanguageOf((await getMe(token)).user),
    saveAccountLanguage: (language) => saveAccountLanguage(token, language),
  });
};

/** Signed out: a pick still waiting for the account belonged to the account that just left. */
export const forgetAccountLanguage = (): Promise<void> => accountLanguage.forget();
