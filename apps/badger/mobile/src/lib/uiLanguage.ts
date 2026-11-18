import AsyncStorage from "@react-native-async-storage/async-storage";
import { changeLanguage, getCurrentLanguage, initI18n, type MobileUiLanguage } from "@space/mobile-shell/i18n";
import { pickStartLanguage, readDeviceLocale } from "@space/mobile-shell/i18n/deviceLanguage";
import { isAccountLanguage, type AccountLanguage } from "@space/shared/i18n";
import { reconcileAccountLanguage } from "@space/shared/accountLanguage";
import { scopeLogger } from "@space/mobile-shell/logger";

const log = scopeLogger("i18n");

/** AsyncStorage key of the language the user picked (or the account's language once applied after sign-in). */
export const UI_LANGUAGE_KEY = "sf_ui_language";
/**
 * Set while a language picked on this signed-in phone has not reached the account yet (in flight, offline, failed
 * request). Its value is the account's language this phone knew when the pick was made ("" when the account had
 * none): if the account holds something else when the push is retried, another device changed it since, and that
 * newer choice wins over the old pick.
 */
export const UI_LANGUAGE_UNSYNCED_KEY = "sf_ui_language_unsynced";

// Every read and write of the push marker and every account save runs on this one chain, so saves reach the account
// in the order the user picked and the last pick is always the last save.
let accountLanguageJobs: Promise<void> = Promise.resolve();
// The account's language as this phone last knew it: the signed-in user's copy until a sync reads `/auth/me`, then
// what the API answered or what this phone saved.
let accountLanguageSeen: string | null = null;

const queueAccountLanguageJob = (job: () => Promise<void>): Promise<void> => {
  accountLanguageJobs = accountLanguageJobs.then(job).catch((err: unknown) => {
    log.warn("account_language.job_failed", { error: err instanceof Error ? err.message : String(err) });
  });
  return accountLanguageJobs;
};

/** Makes sure i18next runs in the start language (idempotent): every screen that may mount first calls it. */
export const ensureI18n = async (): Promise<void> => {
  const saved = await AsyncStorage.getItem(UI_LANGUAGE_KEY).catch(() => null);
  const deviceLocale = readDeviceLocale();
  const language = pickStartLanguage(saved, deviceLocale);
  log.info("start_language", { saved, deviceLocale, language });
  await initI18n(language);
};

/**
 * Switches the app to `language` and remembers it, so it wins over the device language on every later start. The
 * language is the account's, the same on every profile (UX-I18N-07). `pushToAccount`: the user picked it while
 * signed in, so the account takes it too (the account holds every app language and its emails, ACCT-EMAIL-01). The
 * marker is written on the account chain, queued before the switch re-runs `useAccountLanguageSync`, and is not
 * awaited: a save in flight must not hold the picker.
 */
export const chooseUiLanguage = async (language: MobileUiLanguage, { pushToAccount }: { pushToAccount: boolean }) => {
  await AsyncStorage.setItem(UI_LANGUAGE_KEY, language);
  const marks = pushToAccount && isAccountLanguage(language);
  void queueAccountLanguageJob(async () => {
    if (!marks) {
      await AsyncStorage.removeItem(UI_LANGUAGE_UNSYNCED_KEY);
      return;
    }
    // A marker still there keeps its value: the account has not moved since that earlier pick (a save that lands
    // in between rewrites the marker to what it saved).
    if ((await AsyncStorage.getItem(UI_LANGUAGE_UNSYNCED_KEY)) === null) {
      await AsyncStorage.setItem(UI_LANGUAGE_UNSYNCED_KEY, accountLanguageSeen ?? "");
    }
  });
  await changeLanguage(language);
  log.info("chosen", { language, pushToAccount });
};

export type AccountLanguageStep =
  | { kind: "none"; reason: "same" | "account_has_none" }
  | { kind: "apply"; language: AccountLanguage }
  | { kind: "push"; language: AccountLanguage };

export type AccountLanguageInput = {
  /** The app's language now. */
  current: string;
  /** The account's language from a fresh `/auth/me`. */
  account: string | null | undefined;
  /** The push marker (`UI_LANGUAGE_UNSYNCED_KEY`): null when nothing waits for the account. */
  marker: string | null;
};

/**
 * What a signed-in phone does with the account's language (UX-I18N-01, UX-I18N-07). A pick made on this phone that
 * has not reached the account yet is pushed, even when the account already shows that language (it may be what an
 * earlier pick of this phone saved, so only this save makes the last pick the account's), unless the account
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

/** What `syncAccountLanguage` needs from the signed-in session. */
export type AccountLanguageSync = {
  /** The account's language in the app's state (the saved copy until `/auth/me` answers). */
  account: string | null;
  /** True once a newer sync is queued or the session ended: a sync that has not started yet is skipped. */
  cancelled: () => boolean;
  /** The account's language from a fresh `GET /auth/me`. */
  fetchAccountLanguage: () => Promise<string | null>;
  /** Saves the language on the account (`PATCH /account/settings`). */
  saveAccountLanguage: (language: AccountLanguage) => Promise<void>;
  /** The account holds `language` now (read or saved): mirrors it into the app's state. */
  onAccountLanguage: (language: AccountLanguage) => void;
};

/**
 * Brings the phone's language and the account's language together (see `accountLanguageStep`), on the account
 * chain: it reads the account fresh, then applies it or pushes the pending pick. A failed read or save keeps the
 * marker, so the next sync (next start, next change) retries.
 */
export const syncAccountLanguage = (sync: AccountLanguageSync): Promise<void> => {
  accountLanguageSeen ??= sync.account;
  return queueAccountLanguageJob(async () => {
    if (sync.cancelled()) return;
    const current = getCurrentLanguage();
    const marker = await AsyncStorage.getItem(UI_LANGUAGE_UNSYNCED_KEY).catch(() => null);
    let account: string | null;
    try {
      account = await sync.fetchAccountLanguage();
    } catch (err) {
      log.warn("account_language.read_failed", { error: err instanceof Error ? err.message : String(err) });
      return;
    }
    // Signed out (or a newer sync queued) while the read ran: its answer is no longer ours to apply.
    if (sync.cancelled()) {
      log.info("account_language.step", { current, account, step: "none", reason: "cancelled" });
      return;
    }
    accountLanguageSeen = account;
    if (isAccountLanguage(account)) sync.onAccountLanguage(account);
    const step = accountLanguageStep({ current, account, marker });
    log.info("account_language.step", { current, account, marker, step: step.kind, reason: step.kind === "none" ? step.reason : null });
    if (step.kind === "none") return;
    if (step.kind === "apply") {
      await chooseUiLanguage(step.language, { pushToAccount: false });
      return;
    }
    try {
      await sync.saveAccountLanguage(step.language);
    } catch (err) {
      log.warn("account_language.push_failed", { language: step.language, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    // A pick made while the save ran stays pending, and the account now holds this save.
    if ((await AsyncStorage.getItem(UI_LANGUAGE_KEY)) === step.language) await AsyncStorage.removeItem(UI_LANGUAGE_UNSYNCED_KEY);
    else await AsyncStorage.setItem(UI_LANGUAGE_UNSYNCED_KEY, step.language);
    accountLanguageSeen = step.language;
    sync.onAccountLanguage(step.language);
    log.info("account_language.pushed", { language: step.language });
  });
};

/** What `reconcileSignedInLanguage` needs from the session that just started. */
export type SignedInLanguageReconcile = Omit<AccountLanguageSync, "cancelled" | "account"> & {
  /** "Which language do you want?" (`askAccountLanguage`); resolves with the language picked. */
  ask: (options: { device: AccountLanguage; account: AccountLanguage }) => Promise<AccountLanguage>;
};

/**
 * Right after a sign-in or a pairing (not a session restored at start), brings this phone's language (the one chosen
 * before signing in) and the account's together once (UX-I18N-07, `reconcileAccountLanguage`): an account without
 * a language takes this phone's, the same language changes nothing, and two different ones ask which to keep for
 * the whole account. Runs on the account chain, before any sync queued after it. A failure is logged and never
 * blocks the sign-in; a language the account could not save stays pending, so the next sync pushes it.
 */
export const reconcileSignedInLanguage = (input: SignedInLanguageReconcile): Promise<void> =>
  queueAccountLanguageJob(async () => {
    const device = getCurrentLanguage();
    if (!isAccountLanguage(device)) {
      log.warn("account_language.reconcile_skipped", { device, reason: "device_language_not_account" });
      return;
    }
    let account: string | null;
    try {
      account = await input.fetchAccountLanguage();
    } catch (err) {
      log.warn("account_language.reconcile_failed", { step: "read", error: err instanceof Error ? err.message : String(err) });
      return;
    }
    accountLanguageSeen = account;
    try {
      const language = await reconcileAccountLanguage({
        device,
        account,
        ask: input.ask,
        saveAccount: input.saveAccountLanguage,
        applyDevice: (picked) => chooseUiLanguage(picked, { pushToAccount: false }),
      });
      accountLanguageSeen = language;
      await AsyncStorage.removeItem(UI_LANGUAGE_UNSYNCED_KEY);
      input.onAccountLanguage(language);
      log.info("account_language.reconciled", { device, account, language });
    } catch (err) {
      log.warn("account_language.reconcile_failed", { step: "save", device, account, error: err instanceof Error ? err.message : String(err) });
      await AsyncStorage.setItem(UI_LANGUAGE_UNSYNCED_KEY, isAccountLanguage(account) ? account : "");
    }
  });

/** Signed out: a pending push and the known account language belonged to the account that just left. */
export const forgetAccountLanguage = (): Promise<void> => {
  accountLanguageSeen = null;
  return queueAccountLanguageJob(async () => {
    accountLanguageSeen = null;
    await AsyncStorage.removeItem(UI_LANGUAGE_UNSYNCED_KEY);
  });
};
