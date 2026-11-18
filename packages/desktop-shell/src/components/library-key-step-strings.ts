import type { ClientUiLanguage } from "@space/shared/i18n";
import type { KeySavedWarningApp } from "@space/shared/keySavedWarning";

/**
 * Every sentence of the shared library key step (UX-KEY-01), written once for Badger and Parrot desktop.
 * `eraseConfirmLabel` takes `{word}` (the `eraseConfirmWord` the user types to erase). `{collection}`,
 * `{CollectionKey}` are the app's word for the collection (UX-NAME-03, as `keySavedWarningText`): Badger's media
 * library, Parrot's library; every noun of a language takes the same article, so one sentence fits both apps.
 */
export type LibraryKeyStepStringKey =
  | "fieldLabel"
  | "checksum"
  | "wrongKey"
  | "unknownMark"
  | "continue"
  | "validating"
  | "copy"
  | "creating"
  | "newKey"
  | "lostKeyLink"
  | "lostKeyNote"
  | "eraseTitle"
  | "eraseConfirmWord"
  | "eraseConfirmLabel"
  | "erasePasswordLabel"
  | "eraseNoPasswordHint"
  | "eraseCodeLabel"
  | "eraseCodeHintEmail"
  | "eraseCodeHintTotp"
  | "eraseCodeSent"
  | "eraseResend"
  | "eraseResending"
  | "eraseCodeResent"
  | "eraseCancel"
  | "eraseSubmit"
  | "eraseWorking"
  | "eraseInvalidPassword"
  | "eraseInvalidCode"
  | "eraseFailed"
  | "eraseWarning"
  | "eraseOtherDevice";

const libraryKeyStepStrings: Record<ClientUiLanguage, Record<LibraryKeyStepStringKey, string>> = {
  en: {
    fieldLabel: "{CollectionKey}",
    checksum: "These words don’t form a valid key. Check each word against the ones you saved.",
    wrongKey: "That key doesn’t open your {collection}. Check the 12 words and try again.",
    unknownMark: "not a key word",
    continue: "Continue",
    validating: "Validating…",
    copy: "Copy",
    creating: "Creating...",
    newKey: "Create a new key",
    lostKeyLink: "Lost your key? Erase this {collection} and start over",
    lostKeyNote: "Without the key, nobody can open this {collection}, not even us.",
    eraseTitle: "Erase this {collection}?",
    eraseConfirmWord: "ERASE",
    eraseConfirmLabel: "Type {word} to confirm",
    erasePasswordLabel: "Account password",
    eraseNoPasswordHint: "Your account has no password, so a code confirms it is you. The first try emails it to you, or asks for your authenticator code.",
    eraseCodeLabel: "Verification code",
    eraseCodeHintEmail: "Enter the code we sent to your email.",
    eraseCodeHintTotp: "Enter your authenticator code.",
    eraseCodeSent: "We sent a verification code. Check your email or authenticator.",
    eraseResend: "Resend code",
    eraseResending: "Resending...",
    eraseCodeResent: "We sent another verification code.",
    eraseCancel: "Cancel",
    eraseSubmit: "Erase everything and start over",
    eraseWorking: "Erasing...",
    eraseInvalidPassword: "Incorrect password.",
    eraseInvalidCode: "Verification code is invalid.",
    eraseFailed: "Could not reset the {collection} right now. Please try again.",
    eraseWarning: "This erases the entire {collection} of this account, for every profile: all music, movies and shows, and all their details (metadata, playlists, history, settings), in Badger and Parrot. Nobody can undo this, not even us. Your account and plan stay.",
    eraseOtherDevice: "Still signed in somewhere? Any Badger or Parrot app works, on any computer, phone or TV, even on another profile of this account. Get your key from there.",
  },
  fr: {
    fieldLabel: "{CollectionKey}",
    checksum: "Ces mots ne forment pas une clé valide. Vérifiez chaque mot avec ceux que vous avez enregistrés.",
    wrongKey: "Cette clé n’ouvre pas votre {collection}. Vérifiez les 12 mots et réessayez.",
    unknownMark: "pas un mot de la clé",
    continue: "Continuer",
    validating: "Vérification…",
    copy: "Copier",
    creating: "Création...",
    newKey: "Créer une nouvelle clé",
    lostKeyLink: "Clé perdue ? Effacer cette {collection} et recommencer",
    lostKeyNote: "Sans la clé, personne ne peut ouvrir cette {collection}, pas même nous.",
    eraseTitle: "Effacer cette {collection} ?",
    eraseConfirmWord: "EFFACER",
    eraseConfirmLabel: "Tapez {word} pour confirmer",
    erasePasswordLabel: "Mot de passe du compte",
    eraseNoPasswordHint: "Votre compte n'a pas de mot de passe : un code confirme que c'est vous. Le premier essai vous l'envoie par email, ou demande le code de votre authenticator.",
    eraseCodeLabel: "Code de vérification",
    eraseCodeHintEmail: "Entrez le code envoyé par email.",
    eraseCodeHintTotp: "Entrez le code de votre authenticator.",
    eraseCodeSent: "Code envoyé. Vérifiez votre email ou votre application d'authentification.",
    eraseResend: "Renvoyer le code",
    eraseResending: "Renvoi...",
    eraseCodeResent: "Nous avons renvoyé un code de vérification.",
    eraseCancel: "Annuler",
    eraseSubmit: "Tout effacer et recommencer",
    eraseWorking: "Effacement...",
    eraseInvalidPassword: "Mot de passe incorrect.",
    eraseInvalidCode: "Code de vérification invalide.",
    eraseFailed: "Impossible de réinitialiser la {collection}.",
    eraseWarning: "Cela efface toute la {collection} de ce compte, pour tous les profils : toute la musique, tous les films et séries, et tous leurs détails (métadonnées, playlists, historique, réglages), dans Badger et Parrot. Personne ne peut l'annuler, pas même nous. Votre compte et votre abonnement sont conservés.",
    eraseOtherDevice: "Encore connecté quelque part ? N'importe quelle app Badger ou Parrot convient, sur n'importe quel ordinateur, téléphone ou TV, même sur un autre profil de ce compte. Récupérez votre clé depuis celle-ci.",
  },
  es: {
    fieldLabel: "{CollectionKey}",
    checksum: "Estas palabras no forman una clave válida. Compara cada palabra con las que guardaste.",
    wrongKey: "Esta clave no abre tu {collection}. Revisa las 12 palabras e inténtalo de nuevo.",
    unknownMark: "no es una palabra de la clave",
    continue: "Continuar",
    validating: "Validando…",
    copy: "Copiar",
    creating: "Creando...",
    newKey: "Crear una nueva clave",
    lostKeyLink: "¿Has perdido tu clave? Borra esta {collection} y empieza de cero",
    lostKeyNote: "Sin la clave, nadie puede abrir esta {collection}, ni siquiera nosotros.",
    eraseTitle: "¿Borrar esta {collection}?",
    eraseConfirmWord: "BORRAR",
    eraseConfirmLabel: "Escribe {word} para confirmar",
    erasePasswordLabel: "Contraseña de la cuenta",
    eraseNoPasswordHint: "Tu cuenta no tiene contraseña, así que un código confirma que eres tú. El primer intento te lo envía por correo o pide el código de tu app de autenticación.",
    eraseCodeLabel: "Código de verificación",
    eraseCodeHintEmail: "Introduce el código que te enviamos por correo.",
    eraseCodeHintTotp: "Introduce el código de tu app de autenticación.",
    eraseCodeSent: "Te enviamos un código de verificación. Revisa tu correo o tu app de autenticación.",
    eraseResend: "Reenviar código",
    eraseResending: "Reenviando...",
    eraseCodeResent: "Te enviamos otro código de verificación.",
    eraseCancel: "Cancelar",
    eraseSubmit: "Borrarlo todo y empezar de cero",
    eraseWorking: "Borrando...",
    eraseInvalidPassword: "Contraseña incorrecta.",
    eraseInvalidCode: "El código de verificación no es válido.",
    eraseFailed: "No se pudo restablecer la {collection} en este momento. Vuelve a intentarlo.",
    eraseWarning: "Esto borra toda la {collection} de esta cuenta, para todos los perfiles: toda la música, las películas y las series, y todos sus detalles (metadatos, listas de reproducción, historial, ajustes), en Badger y Parrot. Nadie puede deshacerlo, ni siquiera nosotros. Tu cuenta y tu plan se mantienen.",
    eraseOtherDevice: "¿Sigues con la sesión iniciada en algún sitio? Sirve cualquier app de Badger o Parrot, en cualquier ordenador, móvil o TV, incluso en otro perfil de esta cuenta. Obtén tu clave desde allí.",
  },
  de: {
    fieldLabel: "{CollectionKey}",
    checksum: "Diese Wörter ergeben keinen gültigen Schlüssel. Vergleiche jedes Wort mit den Wörtern, die du gespeichert hast.",
    wrongKey: "Dieser Schlüssel öffnet deine {collection} nicht. Prüfe die 12 Wörter und versuche es noch einmal.",
    unknownMark: "kein Schlüsselwort",
    continue: "Weiter",
    validating: "Wird geprüft…",
    copy: "Kopieren",
    creating: "Wird erstellt...",
    newKey: "Neuen Schlüssel erstellen",
    lostKeyLink: "Schlüssel verloren? Diese {collection} löschen und neu beginnen",
    lostKeyNote: "Ohne den Schlüssel kann niemand diese {collection} öffnen, auch wir nicht.",
    eraseTitle: "Diese {collection} löschen?",
    eraseConfirmWord: "LÖSCHEN",
    eraseConfirmLabel: "Gib {word} ein, um zu bestätigen",
    erasePasswordLabel: "Kontopasswort",
    eraseNoPasswordHint: "Dein Konto hat kein Passwort, deshalb bestätigt ein Code, dass du es bist. Der erste Versuch schickt ihn per E-Mail oder fragt nach dem Code deiner Authentifizierungs-App.",
    eraseCodeLabel: "Bestätigungscode",
    eraseCodeHintEmail: "Gib den Code ein, den wir dir per E-Mail geschickt haben.",
    eraseCodeHintTotp: "Gib den Code aus deiner Authentifizierungs-App ein.",
    eraseCodeSent: "Wir haben einen Bestätigungscode gesendet. Sieh in deinen E-Mails oder deiner Authentifizierungs-App nach.",
    eraseResend: "Code erneut senden",
    eraseResending: "Wird erneut gesendet...",
    eraseCodeResent: "Wir haben einen weiteren Bestätigungscode gesendet.",
    eraseCancel: "Abbrechen",
    eraseSubmit: "Alles löschen und neu beginnen",
    eraseWorking: "Wird gelöscht...",
    eraseInvalidPassword: "Falsches Passwort.",
    eraseInvalidCode: "Der Bestätigungscode ist ungültig.",
    eraseFailed: "Die {collection} kann gerade nicht zurückgesetzt werden. Bitte versuch es erneut.",
    eraseWarning: "Dabei wird die gesamte {collection} dieses Kontos gelöscht, für alle Profile: alle Musik, Filme und Serien und alle ihre Details (Metadaten, Playlists, Verlauf, Einstellungen), in Badger und Parrot. Niemand kann das rückgängig machen, auch wir nicht. Dein Konto und dein Tarif bleiben bestehen.",
    eraseOtherDevice: "Noch irgendwo angemeldet? Jede Badger- oder Parrot-App funktioniert, auf jedem Computer, Handy oder Fernseher, auch in einem anderen Profil dieses Kontos. Hol dir deinen Schlüssel von dort.",
  },
  nl: {
    fieldLabel: "{CollectionKey}",
    checksum: "Deze woorden vormen geen geldige sleutel. Vergelijk elk woord met de woorden die je hebt bewaard.",
    wrongKey: "Die sleutel opent je {collection} niet. Controleer de 12 woorden en probeer het opnieuw.",
    unknownMark: "geen sleutelwoord",
    continue: "Doorgaan",
    validating: "Controleren…",
    copy: "Kopiëren",
    creating: "Aanmaken...",
    newKey: "Nieuwe sleutel maken",
    lostKeyLink: "Sleutel kwijt? Wis deze {collection} en begin opnieuw",
    lostKeyNote: "Zonder de sleutel kan niemand deze {collection} openen, ook wij niet.",
    eraseTitle: "Deze {collection} wissen?",
    eraseConfirmWord: "WISSEN",
    eraseConfirmLabel: "Typ {word} om te bevestigen",
    erasePasswordLabel: "Accountwachtwoord",
    eraseNoPasswordHint: "Je account heeft geen wachtwoord, dus een code bevestigt dat jij het bent. De eerste poging mailt hem, of vraagt de code uit je authenticator-app.",
    eraseCodeLabel: "Verificatiecode",
    eraseCodeHintEmail: "Vul de code in die we naar je e-mail hebben gestuurd.",
    eraseCodeHintTotp: "Vul de code uit je authenticator-app in.",
    eraseCodeSent: "We hebben een verificatiecode verstuurd. Kijk in je e-mail of authenticator-app.",
    eraseResend: "Code opnieuw sturen",
    eraseResending: "Opnieuw sturen...",
    eraseCodeResent: "We hebben nog een verificatiecode gestuurd.",
    eraseCancel: "Annuleren",
    eraseSubmit: "Alles wissen en opnieuw beginnen",
    eraseWorking: "Wissen...",
    eraseInvalidPassword: "Onjuist wachtwoord.",
    eraseInvalidCode: "De verificatiecode is ongeldig.",
    eraseFailed: "Kan de {collection} nu niet resetten. Probeer het opnieuw.",
    eraseWarning: "Dit wist de volledige {collection} van dit account, voor elk profiel: alle muziek, films en series, en al hun gegevens (metadata, afspeellijsten, geschiedenis, instellingen), in Badger en Parrot. Niemand kan dit ongedaan maken, ook wij niet. Je account en abonnement blijven bestaan.",
    eraseOtherDevice: "Nog ergens ingelogd? Elke Badger- of Parrot-app werkt, op elke computer, telefoon of tv, ook op een ander profiel van dit account. Haal je sleutel daar vandaan.",
  },
};

const COLLECTION: Record<KeySavedWarningApp, Record<ClientUiLanguage, { collection: string; CollectionKey: string }>> = {
  badger: {
    en: { collection: "media library", CollectionKey: "Media library key" },
    fr: { collection: "médiathèque", CollectionKey: "Clé de médiathèque" },
    es: { collection: "mediateca", CollectionKey: "Clave de la mediateca" },
    de: { collection: "Mediathek", CollectionKey: "Mediathek-Schlüssel" },
    nl: { collection: "mediatheek", CollectionKey: "Mediatheeksleutel" },
  },
  parrot: {
    en: { collection: "library", CollectionKey: "Library key" },
    fr: { collection: "bibliothèque", CollectionKey: "Clé de bibliothèque" },
    es: { collection: "biblioteca", CollectionKey: "Clave de la biblioteca" },
    de: { collection: "Bibliothek", CollectionKey: "Bibliotheksschlüssel" },
    nl: { collection: "bibliotheek", CollectionKey: "Bibliotheeksleutel" },
  },
};

/** The step's sentence `key` in `language` for `app`, with `{name}` placeholders filled from `values` and the app's word. */
export const libraryKeyStepText =
  (language: ClientUiLanguage, app: KeySavedWarningApp) =>
  (key: LibraryKeyStepStringKey, values: Record<string, string> = {}): string => {
    const filled: Record<string, string> = { ...COLLECTION[app][language], ...values };
    return libraryKeyStepStrings[language][key].replace(/\{(\w+)\}/g, (match, name: string) => filled[name] ?? match);
  };
