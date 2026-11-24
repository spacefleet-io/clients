// The account's one language on the phones and TVs (UX-I18N-01, UX-I18N-07), shared by Badger and Parrot (REL-FAM-03):
// the language shown on this device, the pick that has not reached the account yet, and the account's own language
// meet here. Each app makes one instance with its storage keys and wires it to its session (Badger:
// `useAccountLanguageSync`, Parrot: `src/lib/accountLanguage`); the rules below are the same for both.
import { reconcileAccountLanguage } from "@space/shared/accountLanguage";
import { isAccountLanguage, type AccountLanguage } from "@space/shared/i18n";
import { scopeLogger } from "./logger";

const log = scopeLogger("account_language");

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export type AccountLanguageStep =
  | { kind: "none"; reason: "same" | "account_has_none" }
  | { kind: "apply"; language: AccountLanguage }
  | { kind: "push"; language: AccountLanguage };

export type AccountLanguageInput = {
  /** The app's language now. */
  current: string;
  /** The account's language from a fresh `/auth/me`. */
  account: string | null | undefined;
  /** The push marker: null when nothing waits for the account. */
  marker: string | null;
};

/**
 * What a signed-in device does with the account's language (UX-I18N-01, UX-I18N-07). A pick made on this device that
 * has not reached the account yet is pushed, even when the account already shows that language (it may be what an
 * earlier pick of this device saved, so only this save makes the last pick the account's), unless the account
 * changed since the pick, which means another device chose later: then the account's language is applied. Without a
 * pending pick the account's language wins and is applied.
 */
export const accountLanguageStep = (input: AccountLanguageInput): AccountLanguageStep => {
  if (input.marker !== null && isAccountLanguage(input.current)) {
    if (isAccountLanguage(input.account) && input.account !== input.marker) return { kind: "apply", language: input.account };
    return { kind: "push", language: input.current };
  }
  if (input.current === input.account) return { kind: "none", reason: "same" };
  if (isAccountLanguage(input.account)) return { kind: "apply", language: input.account };
  return { kind: "none", reason: "account_has_none" };
};

/** What a sync needs from the signed-in session. */
export type AccountLanguageSync = {
  /** The account's language in the app's state (the saved copy until `/auth/me` answers). */
  account: string | null;
  /** True once a newer sync is queued or the session ended: a sync that has not started yet is skipped. */
  cancelled?: () => boolean;
  /** The account's language from a fresh `GET /auth/me`. */
  fetchAccountLanguage: () => Promise<string | null>;
  /** Saves the language on the account (`PATCH /account/settings`). */
  saveAccountLanguage: (language: AccountLanguage) => Promise<void>;
  /** The account holds `language` now (read or saved): mirrors it into the app's state. */
  onAccountLanguage?: (language: AccountLanguage) => void;
};

/** What the sign-in reconcile needs from the session that just started. */
export type SignedInLanguageReconcile = Omit<AccountLanguageSync, "cancelled" | "account"> & {
  /** "Which language do you want?" (`askAccountLanguage`); resolves with the language picked. */
  ask: (options: { device: AccountLanguage; account: AccountLanguage }) => Promise<AccountLanguage>;
};

/** The slice of AsyncStorage the sync uses. */
export type AccountLanguageStorage = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
};

export type AccountLanguageSyncDeps = {
  asyncStorage: AccountLanguageStorage;
  /** Key of the language shown on this device, read at the next start. */
  languageKey: string;
  /**
   * Key of the push marker, set while a language picked on this signed-in device has not reached the account yet (in
   * flight, offline, failed request). Its value is the account's language this device knew when the pick was made
   * ("" when the account had none): if the account holds something else when the push is retried, another device
   * changed it since, and that newer choice wins over the old pick.
   */
  unsyncedKey: string;
  /** The language i18next shows now (`getCurrentLanguage`). */
  currentLanguage: () => string;
  /** Switches i18next to `language` (`changeLanguage`). */
  showLanguage: (language: string) => Promise<unknown>;
};

/** One device's account-language chain (`createAccountLanguageSync`). */
export type AccountLanguageSyncChain = {
  choose: (language: string, options: { pushToAccount: boolean; account?: string | null }) => Promise<void>;
  sync: (input: AccountLanguageSync) => Promise<void>;
  reconcileAfterSignIn: (input: SignedInLanguageReconcile) => Promise<void>;
  forget: () => Promise<void>;
};

/**
 * One device's account-language chain. Every read and write of the push marker and every account save runs on one
 * promise chain, so saves reach the account in the order the user picked and the last pick is always the last save.
 */
export const createAccountLanguageSync = (deps: AccountLanguageSyncDeps): AccountLanguageSyncChain => {
  const { asyncStorage: storage, languageKey, unsyncedKey } = deps;
  let jobs: Promise<void> = Promise.resolve();
  // The account's language as this device last knew it: the signed-in user's copy until a sync reads `/auth/me`, then
  // what the API answered or what this device saved.
  let accountSeen: string | null = null;

  const queue = (job: () => Promise<void>): Promise<void> => {
    jobs = jobs.then(job).catch((err: unknown) => log.warn("job_failed", { error: message(err) }));
    return jobs;
  };

  /**
   * Switches the app to `language` and remembers it, so it wins over the device language on every later start.
   * `pushToAccount`: the user picked it while signed in, so the account takes it too (the account holds every app
   * language and its emails, ACCT-EMAIL-01); the next `sync` pushes it, and keeps retrying until it lands. `account`:
   * the account's language in the session's own copy, for a pick made before any sync read the account. The marker
   * is written on the chain and not awaited: a save in flight must not hold the picker.
   */
  const choose = async (language: string, options: { pushToAccount: boolean; account?: string | null }): Promise<void> => {
    if (options.account !== undefined) accountSeen ??= options.account;
    await storage.setItem(languageKey, language);
    const marks = options.pushToAccount && isAccountLanguage(language);
    void queue(async () => {
      if (!marks) {
        await storage.removeItem(unsyncedKey);
        return;
      }
      // A marker still there keeps its value: the account has not moved since that earlier pick (a save that lands
      // in between rewrites the marker to what it saved).
      if ((await storage.getItem(unsyncedKey)) === null) await storage.setItem(unsyncedKey, accountSeen ?? "");
    });
    await deps.showLanguage(language);
    log.info("chosen", { language, pushToAccount: options.pushToAccount });
  };

  /**
   * Brings the device's language and the account's together (see `accountLanguageStep`), on the chain: it reads the
   * account fresh, then applies it or pushes the pending pick. A failed read or save keeps the marker, so the next
   * sync (next start, back to the front, next change) retries.
   */
  const sync = (input: AccountLanguageSync): Promise<void> => {
    accountSeen ??= input.account;
    const cancelled = input.cancelled ?? (() => false);
    return queue(async () => {
      if (cancelled()) return;
      const current = deps.currentLanguage();
      const marker = await storage.getItem(unsyncedKey).catch(() => null);
      let account: string | null;
      try {
        account = await input.fetchAccountLanguage();
      } catch (err) {
        log.warn("read_failed", { error: message(err) });
        return;
      }
      // Signed out (or a newer sync queued) while the read ran: its answer is no longer ours to apply.
      if (cancelled()) {
        log.info("step", { current, account, step: "none", reason: "cancelled" });
        return;
      }
      accountSeen = account;
      if (isAccountLanguage(account)) input.onAccountLanguage?.(account);
      const step = accountLanguageStep({ current, account, marker });
      log.info("step", { current, account, marker, step: step.kind, reason: step.kind === "none" ? step.reason : null });
      if (step.kind === "none") return;
      if (step.kind === "apply") {
        await choose(step.language, { pushToAccount: false });
        return;
      }
      try {
        await input.saveAccountLanguage(step.language);
      } catch (err) {
        log.warn("push_failed", { language: step.language, error: message(err) });
        return;
      }
      // A pick made while the save ran stays pending, and the account now holds this save.
      if ((await storage.getItem(languageKey)) === step.language) await storage.removeItem(unsyncedKey);
      else await storage.setItem(unsyncedKey, step.language);
      accountSeen = step.language;
      input.onAccountLanguage?.(step.language);
      log.info("pushed", { language: step.language });
    });
  };

  /**
   * Right after a sign-in or a pairing (not a session restored at start), brings this device's language (the one
   * chosen before signing in) and the account's together once (`reconcileAccountLanguage`): an account without a
   * language takes this device's, the same language changes nothing, and two different ones ask which to keep for the
   * whole account. Runs on the chain, before any sync queued after it. A failure is logged and never blocks the
   * sign-in; a language the account could not save stays pending, so the next sync pushes it.
   */
  const reconcileAfterSignIn = (input: SignedInLanguageReconcile): Promise<void> =>
    queue(async () => {
      const device = deps.currentLanguage();
      if (!isAccountLanguage(device)) {
        log.warn("reconcile_skipped", { device, reason: "device_language_not_account" });
        return;
      }
      let account: string | null;
      try {
        account = await input.fetchAccountLanguage();
      } catch (err) {
        log.warn("reconcile_failed", { step: "read", device, error: message(err) });
        return;
      }
      accountSeen = account;
      try {
        const language = await reconcileAccountLanguage({
          device,
          account,
          ask: input.ask,
          saveAccount: input.saveAccountLanguage,
          applyDevice: (picked) => choose(picked, { pushToAccount: false }),
        });
        accountSeen = language;
        await storage.removeItem(unsyncedKey);
        input.onAccountLanguage?.(language);
        log.info("reconciled", { device, account, language });
      } catch (err) {
        log.warn("reconcile_failed", { step: "save", device, account, error: message(err) });
        await storage.setItem(unsyncedKey, isAccountLanguage(account) ? account : "");
      }
    });

  /** Signed out: a pending push and the known account language belonged to the account that just left. */
  const forget = (): Promise<void> => {
    accountSeen = null;
    return queue(async () => {
      accountSeen = null;
      await storage.removeItem(unsyncedKey);
    });
  };

  return { choose, sync, reconcileAfterSignIn, forget };
};
