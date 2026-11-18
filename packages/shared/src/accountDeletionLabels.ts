/**
 * WEB-LEGAL-04: the labels on the way to "delete my account" in each app, in every app language. The apps read
 * them as i18next keys (added at load by {@link withAccountDeletionLabels}) and the legal account deletion page
 * prints the same labels as a path ({@link accountDeletionPath}), so the page can never name a button the app no
 * longer shows (REL-FAM-02).
 */
export type AccountDeletionApp = "mobile" | "desktop" | "web";

export type AccountDeletionLanguage = "en" | "fr" | "nl" | "de" | "es";

type Step = { key: string; labels: Record<AccountDeletionLanguage, string> };

/** Each app's path, in order: the i18next key the app shows and its label per language. */
const STEPS: Record<AccountDeletionApp, readonly Step[]> = {
  // Phone and TV apps (`packages/mobile-shell`): Settings > Account > Delete account.
  mobile: [
    {
      key: "settings.title",
      labels: { en: "Settings", fr: "Paramètres", nl: "Instellingen", de: "Einstellungen", es: "Ajustes" },
    },
    { key: "settings.account.title", labels: { en: "Account", fr: "Compte", nl: "Account", de: "Konto", es: "Cuenta" } },
    {
      key: "settings.account.deleteAccount",
      labels: {
        en: "Delete account",
        fr: "Supprimer le compte",
        nl: "Account verwijderen",
        de: "Konto löschen",
        es: "Eliminar cuenta",
      },
    },
  ],
  // Computer app (`apps/badger/desktop`): Settings > Account deletion.
  desktop: [
    {
      key: "settings.title",
      labels: { en: "Settings", fr: "Paramètres", nl: "Instellingen", de: "Einstellungen", es: "Ajustes" },
    },
    {
      key: "account.deletion.title",
      labels: {
        en: "Account deletion",
        fr: "Suppression du compte",
        nl: "Account verwijderen",
        de: "Konto löschen",
        es: "Eliminación de la cuenta",
      },
    },
  ],
  // Website: Settings > Danger Zone > Delete My Account.
  web: [
    { key: "nav.settings", labels: { en: "Settings", fr: "Paramètres", nl: "Instellingen", de: "Einstellungen", es: "Ajustes" } },
    {
      key: "account.danger_zone",
      labels: { en: "Danger Zone", fr: "Zone de danger", nl: "Gevarenzone", de: "Gefahrenzone", es: "Zona de peligro" },
    },
    {
      key: "account.delete_button",
      labels: {
        en: "Delete My Account",
        fr: "Supprimer mon compte",
        nl: "Mijn account verwijderen",
        de: "Mein Konto löschen",
        es: "Eliminar mi cuenta",
      },
    },
  ],
};

/** The labels an app shows on the way to account deletion, joined as "Settings > Account > Delete account". */
export const accountDeletionPath = (app: AccountDeletionApp, language: AccountDeletionLanguage): string =>
  STEPS[app].map((step) => step.labels[language]).join(" > ");

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Puts an app's account deletion labels into an i18next translation tree at their keys, keeping its other keys. */
export const withAccountDeletionLabels = <T extends Record<string, unknown>>(
  translation: T,
  app: AccountDeletionApp,
  language: AccountDeletionLanguage,
): T => {
  const out: Record<string, unknown> = { ...translation };
  for (const { key, labels } of STEPS[app]) {
    const parts = key.split(".");
    let node = out;
    for (const part of parts.slice(0, -1)) {
      const next = node[part];
      node[part] = isObject(next) ? { ...next } : {};
      node = node[part] as Record<string, unknown>;
    }
    node[parts.at(-1)!] = labels[language];
  }
  return out as T;
};
