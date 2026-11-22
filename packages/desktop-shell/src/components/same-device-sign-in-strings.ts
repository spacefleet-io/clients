import type { ClientUiLanguage } from "@space/shared/i18n";

/**
 * ACCT-PAIR-07: every sentence of the "Continue with your Badger account" card (and its Parrot twin) on a computer's
 * sign-in screen. `{Other}` is the sister app already signed in on this computer; `button` takes `{email}`.
 */
export type SameDeviceSignInStringKey = "title" | "body" | "button" | "link" | "waiting" | "cancel" | "failure";

/** The card's text in the five client languages (UX-I18N-01), shared by Badger desktop and Parrot desktop. */
export const sameDeviceSignInStrings: Record<ClientUiLanguage, Record<SameDeviceSignInStringKey, string>> = {
  en: {
    title: "Continue with your {Other} account",
    body: "{Other} is signed in on this computer. Nothing to type.",
    button: "Continue as {email}",
    link: "Use another account",
    waiting: "Signing in with {Other}…",
    cancel: "Cancel",
    failure: "{Other} could not sign you in. Sign in another way.",
  },
  fr: {
    title: "Continuer avec votre compte {Other}",
    body: "{Other} est connecté sur cet ordinateur. Rien à saisir.",
    button: "Continuer : {email}",
    link: "Utiliser un autre compte",
    waiting: "Connexion avec {Other}…",
    cancel: "Annuler",
    failure: "{Other} n'a pas pu vous connecter. Connectez-vous autrement.",
  },
  nl: {
    title: "Doorgaan met je {Other}-account",
    body: "{Other} is ingelogd op deze computer. Niets te typen.",
    button: "Doorgaan als {email}",
    link: "Een ander account gebruiken",
    waiting: "Inloggen met {Other}…",
    cancel: "Annuleren",
    failure: "{Other} kon je niet inloggen. Log op een andere manier in.",
  },
  de: {
    title: "Mit deinem {Other}-Konto fortfahren",
    body: "{Other} ist auf diesem Computer angemeldet. Nichts zu tippen.",
    button: "Weiter als {email}",
    link: "Anderes Konto verwenden",
    waiting: "Anmeldung mit {Other}…",
    cancel: "Abbrechen",
    failure: "{Other} konnte dich nicht anmelden. Melde dich anders an.",
  },
  es: {
    title: "Continuar con tu cuenta de {Other}",
    body: "{Other} tiene la sesión iniciada en esta computadora. Sin escribir nada.",
    button: "Continuar como {email}",
    link: "Usar otra cuenta",
    waiting: "Iniciando sesión con {Other}…",
    cancel: "Cancelar",
    failure: "{Other} no pudo iniciar tu sesión. Inicia sesión de otra forma.",
  },
};

export const sameDeviceSignInText =
  (language: ClientUiLanguage) =>
  (key: SameDeviceSignInStringKey, vars?: Record<string, string>): string =>
    sameDeviceSignInStrings[language][key].replace(/\{(\w+)\}/g, (_, name: string) => vars?.[name] ?? `{${name}}`);
