/**
 * The account's one language (UX-I18N-07, ACCT-SQUAD-03, ACCT-EMAIL-01): every app's UI on every profile, plus the
 * account's emails and other communication. The server keeps it (`users.ui_language`, `/auth/me` `uiLanguage`);
 * apps change it with `PATCH /account/settings {preferences: {uiLanguage}}` and pick up another device's change on
 * their next `/auth/me` refresh.
 *
 * Before sign-in the language chosen on step 0 ("Choose your language") lives on the device only. Right after a
 * sign-in, sign-up or pairing, the setup flow calls `reconcileAccountLanguage` once, before the numbered setup steps:
 *   - an account without a language takes the device's choice;
 *   - an account already in the device's language changes nothing;
 *   - otherwise the user is asked "Which language do you want?" with both, and the answer becomes the account's
 *     language and the device's.
 */
import { CLIENT_UI_LANGUAGES, isAccountLanguage, type AccountLanguage } from "./i18n";

/** The account language a `/auth/me` user carries, or `null` when it carries none. */
export const accountLanguageOf = (
  user: { uiLanguage?: string | null; preferences?: { uiLanguage?: string | null } | null } | null | undefined,
): AccountLanguage | null => {
  const value = user?.uiLanguage ?? user?.preferences?.uiLanguage ?? null;
  return isAccountLanguage(value) ? value : null;
};

export type AccountLanguageDecision =
  /** The account already speaks the device's language. */
  | { kind: "same"; language: AccountLanguage }
  /** The account has no language yet: the device's choice becomes the account's. */
  | { kind: "adopt-device"; language: AccountLanguage }
  /** They differ: ask which one, then apply the answer to the account and the device. */
  | { kind: "ask"; device: AccountLanguage; account: AccountLanguage };

export const decideAccountLanguage = (device: AccountLanguage, account: string | null | undefined): AccountLanguageDecision => {
  if (!isAccountLanguage(account)) return { kind: "adopt-device", language: device };
  if (account === device) return { kind: "same", language: device };
  return { kind: "ask", device, account };
};

export type ReconcileAccountLanguageInput = {
  /** The language this device shows now (the step-0 choice before sign-in). */
  device: AccountLanguage;
  /** The signed-in account's language (`accountLanguageOf(user)`), `null` when it has none. */
  account: string | null | undefined;
  /** Shows "Which language do you want?" with both options; resolves with the one picked. */
  ask: (options: { device: AccountLanguage; account: AccountLanguage }) => Promise<AccountLanguage>;
  /** Saves the account's language (`PATCH /account/settings`). */
  saveAccount: (language: AccountLanguage) => Promise<void>;
  /** Shows and remembers the language on this device. */
  applyDevice: (language: AccountLanguage) => Promise<void> | void;
};

/** Runs the decision above; resolves with the language the account and the device now share. */
export const reconcileAccountLanguage = async (input: ReconcileAccountLanguageInput): Promise<AccountLanguage> => {
  const decision = decideAccountLanguage(input.device, input.account);
  console.info("account_language.reconcile", JSON.stringify(decision));
  if (decision.kind === "same") return decision.language;
  if (decision.kind === "adopt-device") {
    await input.saveAccount(decision.language);
    return decision.language;
  }
  const picked = await input.ask({ device: decision.device, account: decision.account });
  console.info("account_language.reconcile_picked", JSON.stringify({ picked, device: decision.device, account: decision.account }));
  if (picked !== decision.account) await input.saveAccount(picked);
  if (picked !== decision.device) await input.applyDevice(picked);
  return picked;
};

/** A language's name in itself ("Français"), for the prompt's two options. */
export const accountLanguageNativeName = (language: AccountLanguage): string =>
  CLIENT_UI_LANGUAGES.find((option) => option.code === language)?.nativeName ?? language;

export type AccountLanguagePromptTexts = { title: string; body: string };

/**
 * The prompt's texts, the same on every app (REL-FAM-02). Shown in the device's language: the one the user chose on
 * step 0.
 */
export const accountLanguagePromptTexts: Record<AccountLanguage, AccountLanguagePromptTexts> = {
  en: {
    title: "Which language do you want?",
    body: "Your account is set to {account}, and this device to {device}. The language you pick applies to your whole account: every app, every profile and our emails.",
  },
  fr: {
    title: "Quelle langue voulez-vous ?",
    body: "Votre compte est en {account} et cet appareil en {device}. La langue choisie s’applique à tout votre compte : toutes les applis, tous les profils et nos e-mails.",
  },
  nl: {
    title: "Welke taal wil je?",
    body: "Je account staat op {account} en dit apparaat op {device}. De taal die je kiest geldt voor je hele account: alle apps, alle profielen en onze e-mails.",
  },
  de: {
    title: "Welche Sprache möchtest du?",
    body: "Dein Konto ist auf {account} eingestellt, dieses Gerät auf {device}. Die gewählte Sprache gilt für dein ganzes Konto: alle Apps, alle Profile und unsere E-Mails.",
  },
  es: {
    title: "¿Qué idioma quieres?",
    body: "Tu cuenta está en {account} y este dispositivo en {device}. El idioma que elijas se aplica a toda tu cuenta: todas las apps, todos los perfiles y nuestros correos.",
  },
};

/**
 * Each language named in the language shown, as it reads inside the prompt's sentence ("Votre compte est en anglais").
 * The two option buttons keep each language named in itself (`accountLanguageNativeName`).
 */
export const accountLanguageNamesIn: Record<AccountLanguage, Record<AccountLanguage, string>> = {
  en: { en: "English", fr: "French", nl: "Dutch", de: "German", es: "Spanish" },
  fr: { en: "anglais", fr: "français", nl: "néerlandais", de: "allemand", es: "espagnol" },
  nl: { en: "Engels", fr: "Frans", nl: "Nederlands", de: "Duits", es: "Spaans" },
  de: { en: "Englisch", fr: "Französisch", nl: "Niederländisch", de: "Deutsch", es: "Spanisch" },
  es: { en: "inglés", fr: "francés", nl: "neerlandés", de: "alemán", es: "español" },
};

/** The prompt's texts in `shown` with both language names filled in, named in `shown`. */
export const accountLanguagePrompt = (
  shown: string,
  options: { device: AccountLanguage; account: AccountLanguage },
): AccountLanguagePromptTexts => {
  const language: AccountLanguage = isAccountLanguage(shown) ? shown : "en";
  const texts = accountLanguagePromptTexts[language];
  const names = accountLanguageNamesIn[language];
  return {
    title: texts.title,
    body: texts.body.replace("{account}", names[options.account]).replace("{device}", names[options.device]),
  };
};
