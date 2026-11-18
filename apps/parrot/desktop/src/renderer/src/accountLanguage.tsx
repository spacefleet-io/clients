/**
 * UX-I18N-07 on Parrot desktop: the account has one language, for every app, every profile and the emails
 * (`@space/shared/accountLanguage`). Before sign-in the language picked on the sign-in screen lives on this computer
 * only; right after a sign-in (email or phone) it is reconciled once with the account's, asking when they differ.
 * While signed in, a language picked here is shown at once and saved to the account; main applies the account's
 * language on its `/auth/me` check at start, so a change made on another device shows here.
 */
import { useCallback, useState, type ReactElement } from "react";
import { AccountLanguageDialog } from "@space/ui";
import { reconcileAccountLanguage } from "@space/shared/accountLanguage";
import type { AccountLanguage } from "@space/shared/i18n";
import type { ParrotBridge, ParrotLanguage, ParrotState } from "../../shared/ipc";

type AccountLanguageBridge = Pick<ParrotBridge, "getAccountLanguage" | "saveAccountLanguage" | "saveSetup">;
type AskOptions = { device: AccountLanguage; account: AccountLanguage };
export type AskAccountLanguage = (options: AskOptions) => Promise<AccountLanguage>;

/** "Which language do you want?" with both languages; closing it keeps the account's. */
export function useAccountLanguagePrompt(): { ask: AskAccountLanguage; dialog: ReactElement | null } {
  const [asking, setAsking] = useState<(AskOptions & { resolve: (language: AccountLanguage) => void }) | null>(null);
  const ask = useCallback<AskAccountLanguage>((options) => {
    const { promise, resolve } = Promise.withResolvers<AccountLanguage>();
    setAsking({ ...options, resolve });
    return promise;
  }, []);
  if (!asking) return { ask, dialog: null };
  const answer = (language: AccountLanguage) => {
    asking.resolve(language);
    setAsking(null);
  };
  // Shown in the language this computer shows: the one the user just picked before signing in.
  const dialog = <AccountLanguageDialog question={asking} onPick={answer} />;
  return { ask, dialog };
}

/**
 * Runs once right after a fresh sign-in or phone pairing, before setup. A failure is logged and never blocks the
 * sign-in: the computer keeps its language and the next start's `/auth/me` check settles it.
 */
export const reconcileAfterSignIn = async (bridge: AccountLanguageBridge, device: ParrotLanguage, ask: AskAccountLanguage): Promise<void> => {
  try {
    const read = await bridge.getAccountLanguage();
    if (!read.ok) {
      console.warn("account_language.reconcile_skipped", JSON.stringify({ reason: "account_unreadable", device }));
      return;
    }
    await reconcileAccountLanguage({
      device,
      account: read.language,
      ask,
      saveAccount: async (language) => {
        if (!(await bridge.saveAccountLanguage(language))) throw new Error("the account language was not saved");
      },
      applyDevice: async (language) => {
        await bridge.saveSetup({ language });
      },
    });
  } catch (error) {
    console.warn("account_language.reconcile_failed", JSON.stringify({ device, error: String(error) }));
  }
};

/**
 * A picked language: shown on this computer at once and, while signed in, saved as the account's. Signed out (step 0
 * before sign-in, UX-SETUP-08) it stays on this computer until the sign-in check.
 */
export const pickLanguage = async (bridge: AccountLanguageBridge, language: ParrotLanguage): Promise<ParrotState> => {
  const state = await bridge.saveSetup({ language });
  if (!state.user) return state;
  void bridge.saveAccountLanguage(language).then((saved) => {
    if (!saved) console.warn("account_language.pick_not_saved", JSON.stringify({ language }));
  });
  return state;
};
