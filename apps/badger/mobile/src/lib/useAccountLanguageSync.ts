import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import { getCurrentLanguage, useTranslation } from "@space/mobile-shell/i18n";
import { askAccountLanguage } from "@space/mobile-shell/account-language-prompt";
import { accountLanguageOf } from "@space/shared/accountLanguage";
import { getMe, updateSettings, type User } from "@space/shared/api";
import type { AccountLanguage } from "@space/shared/i18n";
import { useAuth } from "../store/auth";
import { phoneSetupSignedOut } from "@space/mobile-shell/setup";
import { savePhoneSetup, usePhoneSetup } from "../setup/phoneSetupStore";
import { IS_TV } from "../tv/lib/tvRuntime";
import type { SignedInLanguageReconcile } from "@space/mobile-shell/account-language-sync";
import { forgetAccountLanguage, reconcileSignedInLanguage, syncAccountLanguage } from "./uiLanguage";

type SetUser = (user: User) => void;

type AccountLanguageIo = {
  readAccount: () => Promise<string | null>;
  saveAccount: (language: AccountLanguage) => Promise<void>;
  mirrorAccount: (language: AccountLanguage) => void;
};

/** How the session reads, saves and mirrors the account's language (`GET /auth/me`, `PATCH /account/settings`). */
const accountLanguageIo = (token: string, userId: string, userRef: MutableRefObject<User | null>, setUser: SetUser): AccountLanguageIo => ({
  readAccount: async () => accountLanguageOf((await getMe(token)).user),
  saveAccount: async (language: AccountLanguage) => {
    await updateSettings(token, { preferences: { uiLanguage: language } });
  },
  mirrorAccount: (language: AccountLanguage) => {
    const latest = userRef.current;
    if (!latest || latest.id !== userId) return;
    if (accountLanguageOf(latest) === language) return;
    setUser({ ...latest, uiLanguage: language, preferences: { ...latest.preferences, uiLanguage: language } });
  },
});

/** The sign-in reconcile's input: a failed read falls back on the session's own copy from the sign-in. */
const signInReconcileInput = (io: AccountLanguageIo, userRef: MutableRefObject<User | null>): SignedInLanguageReconcile => ({
  fetchAccountLanguage: async () => {
    try {
      return await io.readAccount();
    } catch (err) {
      console.info("account_language.sign_in_read_failed", JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      return accountLanguageOf(userRef.current);
    }
  },
  ask: askAccountLanguage,
  saveAccountLanguage: io.saveAccount,
  onAccountLanguage: io.mirrorAccount,
});

/**
 * Keeps the app's language and the account's one language together on phone and TV (UX-I18N-01, UX-I18N-07): the
 * account holds a single language for every app, every profile and its emails, so switching profile never changes it.
 *   - Right after a sign-in or a pairing (the session appears while the app runs signed out, not a session restored
 *     at start), `reconcileSignedInLanguage` runs once: the language chosen before signing in meets the account's,
 *     and "Which language do you want?" settles a difference for the whole account. While the phone's first setup
 *     still has the language to settle, the setup asks instead (`useSetupLanguageReconcile`, UX-SETUP-08), and this
 *     hook neither asks nor syncs until it has: the account's language must not replace the step-0 pick first.
 *   - While signed in, the account's language from `/auth/me` wins (that is how another device's change arrives), and
 *     a language picked on this device is pushed with `PATCH /account/settings` (retried on the next start or change
 *     when it fails). Every sync reads the account fresh and runs on one chain with the picks (`syncAccountLanguage`).
 * Mount once.
 */
export const useAccountLanguageSync = (): void => {
  const { token, user, loading, setUser } = useAuth();
  const { i18n } = useTranslation();
  const current = i18n.language;
  const account = accountLanguageOf(user);
  const userId = user?.id ?? null;
  const userRef = useRef<User | null>(user);
  userRef.current = user;
  // Badger phone's setup (the TV never uses it): null until read.
  const setup = usePhoneSetup(!IS_TV);
  const setupLoading = !IS_TV && setup === null;
  const setupOwnsLanguage = !IS_TV && !!setup && !setup.done && !setup.languageReconciled;
  // True once the app ran signed out: the next session is a fresh sign-in, sign-up or pairing.
  const signedOutRef = useRef(false);
  // The session whose sign-in language was reconciled (or is being reconciled, here or by the setup).
  const reconciledTokenRef = useRef<string | null>(null);

  useEffect(() => {
    if (loading) return;
    if (!token || !userId) {
      signedOutRef.current = true;
      reconciledTokenRef.current = null;
      void forgetAccountLanguage();
      return;
    }
    if (setupLoading) return;
    if (setupOwnsLanguage) {
      // The setup's language step settles this session (UX-SETUP-08) and logs its sign-in: not again here.
      if (signedOutRef.current) {
        signedOutRef.current = false;
        reconciledTokenRef.current = token;
      }
      return;
    }
    const io = accountLanguageIo(token, userId, userRef, setUser);
    if (signedOutRef.current && reconciledTokenRef.current !== token) {
      signedOutRef.current = false;
      reconciledTokenRef.current = token;
      console.info("account_language.sign_in", JSON.stringify({ userId, device: current, account }));
      // Queued before the sync below, on the same chain: the account's language is not applied over the question.
      void reconcileSignedInLanguage(signInReconcileInput(io, userRef));
    }
    let cancelled = false;
    void syncAccountLanguage({
      account,
      cancelled: () => cancelled,
      fetchAccountLanguage: io.readAccount,
      saveAccountLanguage: io.saveAccount,
      onAccountLanguage: io.mirrorAccount,
    });
    return () => {
      cancelled = true;
    };
    // `current` re-runs the sync after a pick; `account` after `/auth/me` brought another device's change; the setup
    // flags once it settled the language.
  }, [loading, token, userId, current, account, setUser, setupLoading, setupOwnsLanguage]);

  // Signed out during the setup (Back from the key): the next sign-in settles the language again, before step 1.
  useEffect(() => {
    if (loading || token || !setup) return;
    const next = phoneSetupSignedOut(setup);
    if (next !== setup) void savePhoneSetup(next);
  }, [loading, token, setup]);
};

/**
 * The phone setup's `reconcileLanguage` (UX-SETUP-08, UX-I18N-07): the same sign-in reconcile as
 * `useAccountLanguageSync`, run by the setup right after the sign-in, before its first numbered step.
 */
export const useSetupLanguageReconcile = (): (() => Promise<void>) => {
  const { token, user, setUser } = useAuth();
  const userRef = useRef<User | null>(user);
  userRef.current = user;
  const sessionRef = useRef({ token, setUser });
  sessionRef.current = { token, setUser };
  return useCallback(async () => {
    const { token: signedIn, setUser: set } = sessionRef.current;
    const latest = userRef.current;
    if (!signedIn || !latest) return;
    console.info(
      "account_language.sign_in",
      JSON.stringify({ userId: latest.id, device: getCurrentLanguage(), account: accountLanguageOf(latest), by: "setup" })
    );
    await reconcileSignedInLanguage(signInReconcileInput(accountLanguageIo(signedIn, latest.id, userRef, set), userRef));
  }, []);
};
