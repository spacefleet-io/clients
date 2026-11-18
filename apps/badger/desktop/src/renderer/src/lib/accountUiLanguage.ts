/**
 * The app language is the account's (UX-I18N-07, ACCT-SQUAD-03): one language for every app, every profile and the
 * account's e-mails. This computer keeps the language it shows in its config (`ClientConfig.uiLanguage`, localStorage):
 *   - before sign-in it is the step-0 / Settings choice, stored here only;
 *   - while signed in it follows the account (`AuthProvider` applies `/auth/me`'s language on every refresh), and a
 *     language control's choice is sent to the account (`pickUiLanguage` announces it, `AuthProvider` PATCHes it).
 */
import type { ClientUiLanguage } from "@space/shared";
import { loadClientConfig, saveClientConfig } from "./config";

const PICKED_EVENT = "sf_ui_language_picked";

/** The language this computer shows. */
export const deviceUiLanguageNow = (): ClientUiLanguage => loadClientConfig().uiLanguage;

/** Shows `next` on this computer and remembers it here; nothing goes to the account. */
export const showUiLanguage = (next: ClientUiLanguage) => {
  const config = loadClientConfig();
  if (config.uiLanguage === next) return;
  saveClientConfig({ ...config, uiLanguage: next });
};

/** Tells the signed-in session a language control picked `next` (already shown), so it goes to the account. */
export const announceUiLanguagePick = (next: ClientUiLanguage) => {
  window.dispatchEvent(new CustomEvent<ClientUiLanguage>(PICKED_EVENT, { detail: next }));
};

/** A language control's choice: shown at once on this computer and, while signed in, saved to the account. */
export const pickUiLanguage = (next: ClientUiLanguage) => {
  showUiLanguage(next);
  announceUiLanguagePick(next);
};

export const subscribeUiLanguagePicks = (callback: (language: ClientUiLanguage) => void) => {
  const listener = (event: Event) => callback((event as CustomEvent<ClientUiLanguage>).detail);
  window.addEventListener(PICKED_EVENT, listener);
  return () => window.removeEventListener(PICKED_EVENT, listener);
};
