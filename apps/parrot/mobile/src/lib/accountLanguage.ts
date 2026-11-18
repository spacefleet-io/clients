// The account's one language on Parrot's phone (UX-I18N-07, `@space/shared/accountLanguage`): every app, every
// profile and the emails. Before sign-in the language picked on the sign-in screen lives on this phone only; right
// after a fresh sign-in or pairing it is reconciled once with the account's (asking when they differ), by the first
// setup when it is open (UX-SETUP-08) and by the sign-in otherwise; while signed in, `/auth/me` brings the account's
// language at start and on coming back to the app, and a language picked in setup or Settings is saved to the account.
import type { PhoneSetupProgress } from "@space/mobile-shell/setup";
import { getCurrentLanguage } from "@space/mobile-shell/i18n";
import { askAccountLanguage } from "@space/mobile-shell/account-language-prompt";
import { scopeLogger } from "@space/mobile-shell/logger";
import { accountLanguageOf, reconcileAccountLanguage } from "@space/shared/accountLanguage";
import { getMe, updateSettings } from "@space/shared/api";
import { isAccountLanguage, type AccountLanguage } from "@space/shared/i18n";
import { setParrotLanguage } from "./i18n";

const log = scopeLogger("account_language");

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Saves the account's language (`PATCH /account/settings`). */
export const saveAccountLanguage = async (token: string, language: AccountLanguage): Promise<void> => {
  await updateSettings(token, { preferences: { uiLanguage: language } });
  log.info("saved", { language });
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
export const reconcileAfterSignIn = async (token: string): Promise<void> => {
  const shown = getCurrentLanguage();
  const device: AccountLanguage = isAccountLanguage(shown) ? shown : "en";
  try {
    const { user } = await getMe(token);
    await reconcileAccountLanguage({
      device,
      account: accountLanguageOf(user),
      ask: askAccountLanguage,
      saveAccount: (language) => saveAccountLanguage(token, language),
      applyDevice: setParrotLanguage,
    });
  } catch (error) {
    log.warn("reconcile_failed", { device, message: message(error) });
  }
};

/** A restored session's `/auth/me`: the account's language wins over the phone's, so another device's change shows here. */
export const applyAccountLanguageFromServer = async (token: string): Promise<void> => {
  try {
    const account = accountLanguageOf((await getMe(token)).user);
    const shown = getCurrentLanguage();
    if (!account || account === shown) return;
    log.info("applied", { from: shown, to: account, source: "auth_me" });
    await setParrotLanguage(account);
  } catch (error) {
    log.warn("refresh_failed", { message: message(error) });
  }
};

/** A language picked while signed in (setup, Settings): shown on this phone at once, then saved as the account's. */
export const pickSignedInLanguage = async (token: string | null, code: string): Promise<void> => {
  await setParrotLanguage(code);
  if (!token || !isAccountLanguage(code)) return;
  await saveAccountLanguage(token, code).catch((error: unknown) => log.warn("pick_not_saved", { language: code, message: message(error) }));
};
