import type { ClientUiLanguage } from "@space/shared/i18n";
import type { ApprovePairingErrorKind } from "@space/pairing-crypto";

/** Every sentence the pairing dialog shows. */
export type PairDeviceStringKey =
  | "title"
  | "description"
  | "cancel"
  | "close"
  | "tryAgain"
  | "code.label"
  | "code.submit"
  | "code.looking"
  | "confirm.question"
  | "confirm.keyQuestion"
  | "confirm.warning"
  | "confirm.passwordLabel"
  | "confirm.passwordHint"
  | "confirm.approve"
  | "confirm.approving"
  | "confirm.deny"
  | "confirm.noPasswordHint"
  | "confirm.codeLabel"
  | "confirm.codeSentEmail"
  | "confirm.codeTotp"
  | "done.added"
  | "done.keySent"
  | "done.denied"
  | `errors.${Exclude<ApprovePairingErrorKind, "rate_limited">}`;

export type PairDeviceKind =
  "desktop" | "mobile" | "tv" | "kodi" | "jellyfin" | "web" | "other";

/**
 * The dialog's text in the five client languages (UX-I18N-01), shared by Badger desktop and Parrot desktop so neither
 * keeps its own copy (REL-FAM-02). Either approves a sign-in of any Badger or Parrot app (ACCT-PAIR-05), so
 * `confirm.question` names the asking app: it takes `{app}` (its name, the same in every language), `{name}` and
 * `{type}`; `confirm.keyQuestion` is the same for a signed-in device asking only for the library key (ACCT-PAIR-01, its
 * key screen); `done.*` take `{name}`.
 */
export const pairDeviceStrings: Record<
  ClientUiLanguage,
  Record<PairDeviceStringKey | `type.${PairDeviceKind}`, string>
> = {
  en: {
    title: "Pair a device",
    description: "Type the code shown on the device you want to sign in.",
    cancel: "Cancel",
    close: "Close",
    tryAgain: "Try another code",
    "code.label": "Pairing code",
    "code.submit": "Continue",
    "code.looking": "Looking up the code…",
    "confirm.keyQuestion": "{app} on {name} ({type}) is signed in to your account and wants your media library key.",
    "confirm.question": "{app} on {name} ({type}) wants to sign in to your account.",
    "confirm.warning":
      "Only approve a code shown on a screen in front of you. Someone who sent you a code is trying to get into your account.",
    "confirm.passwordLabel": "Your account password",
    "confirm.passwordHint":
      "Confirms it is you before the device gets your library key.",
    "confirm.approve": "Approve",
    "confirm.approving": "Approving…",
    "confirm.deny": "Decline",
    "confirm.noPasswordHint":
      "Your account has no password, so a code confirms it is you before the device gets your library key.",
    "confirm.codeLabel": "Code",
    "confirm.codeSentEmail": "We emailed you a code. Type it here.",
    "confirm.codeTotp": "Type the code from your authenticator app.",
    "done.keySent": "{name} has your media library key.",
    "done.added": "{name} is signed in to your account.",
    "done.denied": "{name} was declined. Its code no longer works.",
    "errors.invalid_code":
      "That is not a pairing code. It has 8 letters and numbers, like ABCD-EFGH.",
    "errors.not_found":
      "No device is waiting with this code. Check it, or get a new code on the device.",
    "errors.expired": "This code has expired. Get a new code on the device.",
    "errors.already_used":
      "This code was already used. Get a new code on the device.",
    "errors.no_library_key":
      "This computer does not have your library key, so it cannot pass it on.",
    "errors.password_missing": "Type your account password to approve.",
    "errors.wrong_password": "Wrong password. Try again.",
    "errors.code_required": "Type the code to approve.",
    "errors.wrong_code": "That code is wrong. Try again.",
    "errors.signed_out":
      "You are signed out. Sign in again, then pair the device.",
    "errors.network":
      "Could not reach the server. Check your connection and try again.",
    "errors.bad_request":
      "This code could not be approved. Get a new code on the device.",
    "errors.unknown": "Something went wrong. Try again.",
    "type.desktop": "Computer",
    "type.mobile": "Phone",
    "type.tv": "TV",
    "type.kodi": "Kodi",
    "type.jellyfin": "Jellyfin server",
    "type.web": "Web browser",
    "type.other": "Device",
  },
  fr: {
    title: "Associer un appareil",
    description: "Saisissez le code affiché sur l’appareil à connecter.",
    cancel: "Annuler",
    close: "Fermer",
    tryAgain: "Essayer un autre code",
    "code.label": "Code d’association",
    "code.submit": "Continuer",
    "code.looking": "Recherche du code…",
    "confirm.keyQuestion": "{app} sur {name} ({type}) est connecté à votre compte et demande votre clé de médiathèque.",
    "confirm.question": "{app} sur {name} ({type}) veut se connecter à votre compte.",
    "confirm.warning":
      "N’approuvez qu’un code affiché sur un écran devant vous. Quelqu’un qui vous envoie un code essaie d’entrer dans votre compte.",
    "confirm.passwordLabel": "Le mot de passe de votre compte",
    "confirm.passwordHint":
      "Confirme que c’est bien vous avant que l’appareil reçoive la clé de votre bibliothèque.",
    "confirm.approve": "Approuver",
    "confirm.approving": "Approbation…",
    "confirm.deny": "Refuser",
    "confirm.noPasswordHint":
      "Votre compte n’a pas de mot de passe : un code confirme que c’est bien vous avant que l’appareil reçoive la clé de votre bibliothèque.",
    "confirm.codeLabel": "Code",
    "confirm.codeSentEmail": "Nous vous avons envoyé un code par e-mail. Saisissez-le ici.",
    "confirm.codeTotp": "Saisissez le code de votre application d’authentification.",
    "done.keySent": "{name} a reçu votre clé de médiathèque.",
    "done.added": "{name} est connecté à votre compte.",
    "done.denied": "{name} a été refusé. Son code ne fonctionne plus.",
    "errors.invalid_code":
      "Ce n’est pas un code d’association. Il compte 8 lettres et chiffres, comme ABCD-EFGH.",
    "errors.not_found":
      "Aucun appareil n’attend avec ce code. Vérifiez-le ou obtenez un nouveau code sur l’appareil.",
    "errors.expired":
      "Ce code a expiré. Obtenez un nouveau code sur l’appareil.",
    "errors.already_used":
      "Ce code a déjà servi. Obtenez un nouveau code sur l’appareil.",
    "errors.no_library_key":
      "Cet ordinateur n’a pas la clé de votre bibliothèque, il ne peut donc pas la transmettre.",
    "errors.password_missing":
      "Saisissez le mot de passe de votre compte pour approuver.",
    "errors.wrong_password": "Mot de passe incorrect. Réessayez.",
    "errors.code_required": "Saisissez le code pour approuver.",
    "errors.wrong_code": "Ce code est incorrect. Réessayez.",
    "errors.signed_out":
      "Vous êtes déconnecté. Reconnectez-vous, puis associez l’appareil.",
    "errors.network":
      "Impossible de joindre le serveur. Vérifiez votre connexion et réessayez.",
    "errors.bad_request":
      "Ce code n’a pas pu être approuvé. Obtenez un nouveau code sur l’appareil.",
    "errors.unknown": "Une erreur est survenue. Réessayez.",
    "type.desktop": "Ordinateur",
    "type.mobile": "Téléphone",
    "type.tv": "TV",
    "type.kodi": "Kodi",
    "type.jellyfin": "Serveur Jellyfin",
    "type.web": "Navigateur web",
    "type.other": "Appareil",
  },
  nl: {
    title: "Apparaat koppelen",
    description: "Typ de code die op het apparaat staat dat je wilt aanmelden.",
    cancel: "Annuleren",
    close: "Sluiten",
    tryAgain: "Andere code proberen",
    "code.label": "Koppelcode",
    "code.submit": "Doorgaan",
    "code.looking": "Code opzoeken…",
    "confirm.keyQuestion": "{app} op {name} ({type}) is ingelogd op je account en vraagt om je mediatheeksleutel.",
    "confirm.question": "{app} op {name} ({type}) wil inloggen op je account.",
    "confirm.warning":
      "Keur alleen een code goed die op een scherm voor je staat. Wie je een code stuurt, probeert in je account te komen.",
    "confirm.passwordLabel": "Het wachtwoord van je account",
    "confirm.passwordHint":
      "Bevestigt dat jij het bent voordat het apparaat je bibliotheeksleutel krijgt.",
    "confirm.approve": "Goedkeuren",
    "confirm.approving": "Goedkeuren…",
    "confirm.deny": "Weigeren",
    "confirm.noPasswordHint":
      "Je account heeft geen wachtwoord, dus een code bevestigt dat jij het bent voordat het apparaat je bibliotheeksleutel krijgt.",
    "confirm.codeLabel": "Code",
    "confirm.codeSentEmail": "We hebben je een code gemaild. Typ hem hier.",
    "confirm.codeTotp": "Typ de code uit je authenticator-app.",
    "done.keySent": "{name} heeft je mediatheeksleutel.",
    "done.added": "{name} is aangemeld bij je account.",
    "done.denied": "{name} is geweigerd. De code werkt niet meer.",
    "errors.invalid_code":
      "Dat is geen koppelcode. Die heeft 8 letters en cijfers, zoals ABCD-EFGH.",
    "errors.not_found":
      "Er wacht geen apparaat met deze code. Controleer hem of vraag een nieuwe code op het apparaat.",
    "errors.expired":
      "Deze code is verlopen. Vraag een nieuwe code op het apparaat.",
    "errors.already_used":
      "Deze code is al gebruikt. Vraag een nieuwe code op het apparaat.",
    "errors.no_library_key":
      "Deze computer heeft je bibliotheeksleutel niet en kan hem dus niet doorgeven.",
    "errors.password_missing":
      "Typ het wachtwoord van je account om goed te keuren.",
    "errors.wrong_password": "Onjuist wachtwoord. Probeer het opnieuw.",
    "errors.code_required": "Typ de code om goed te keuren.",
    "errors.wrong_code": "Die code klopt niet. Probeer het opnieuw.",
    "errors.signed_out":
      "Je bent afgemeld. Meld je opnieuw aan en koppel dan het apparaat.",
    "errors.network":
      "De server is niet bereikbaar. Controleer je verbinding en probeer het opnieuw.",
    "errors.bad_request":
      "Deze code kon niet worden goedgekeurd. Vraag een nieuwe code op het apparaat.",
    "errors.unknown": "Er ging iets mis. Probeer het opnieuw.",
    "type.desktop": "Computer",
    "type.mobile": "Telefoon",
    "type.tv": "Tv",
    "type.kodi": "Kodi",
    "type.jellyfin": "Jellyfin-server",
    "type.web": "Webbrowser",
    "type.other": "Apparaat",
  },
  de: {
    title: "Gerät koppeln",
    description: "Gib den Code ein, den das Gerät zum Anmelden zeigt.",
    cancel: "Abbrechen",
    close: "Schließen",
    tryAgain: "Anderen Code versuchen",
    "code.label": "Kopplungscode",
    "code.submit": "Weiter",
    "code.looking": "Code wird gesucht…",
    "confirm.keyQuestion": "{app} auf {name} ({type}) ist bei deinem Konto angemeldet und möchte deinen Mediathek-Schlüssel.",
    "confirm.question": "{app} auf {name} ({type}) möchte sich bei deinem Konto anmelden.",
    "confirm.warning":
      "Gib nur einen Code frei, der auf einem Bildschirm vor dir steht. Wer dir einen Code schickt, will in dein Konto.",
    "confirm.passwordLabel": "Das Passwort deines Kontos",
    "confirm.passwordHint":
      "Bestätigt, dass du es bist, bevor das Gerät deinen Bibliotheksschlüssel erhält.",
    "confirm.approve": "Freigeben",
    "confirm.approving": "Wird freigegeben…",
    "confirm.deny": "Ablehnen",
    "confirm.noPasswordHint":
      "Dein Konto hat kein Passwort, deshalb bestätigt ein Code, dass du es bist, bevor das Gerät deinen Bibliotheksschlüssel bekommt.",
    "confirm.codeLabel": "Code",
    "confirm.codeSentEmail": "Wir haben dir einen Code per E-Mail geschickt. Gib ihn hier ein.",
    "confirm.codeTotp": "Gib den Code aus deiner Authenticator-App ein.",
    "done.keySent": "{name} hat deinen Mediathek-Schlüssel.",
    "done.added": "{name} ist bei deinem Konto angemeldet.",
    "done.denied": "{name} wurde abgelehnt. Sein Code funktioniert nicht mehr.",
    "errors.invalid_code":
      "Das ist kein Kopplungscode. Er hat 8 Buchstaben und Ziffern, etwa ABCD-EFGH.",
    "errors.not_found":
      "Kein Gerät wartet mit diesem Code. Prüfe ihn oder hol dir einen neuen Code auf dem Gerät.",
    "errors.expired":
      "Dieser Code ist abgelaufen. Hol dir einen neuen Code auf dem Gerät.",
    "errors.already_used":
      "Dieser Code wurde schon benutzt. Hol dir einen neuen Code auf dem Gerät.",
    "errors.no_library_key":
      "Dieser Computer hat deinen Bibliotheksschlüssel nicht und kann ihn daher nicht weitergeben.",
    "errors.password_missing":
      "Gib das Passwort deines Kontos ein, um freizugeben.",
    "errors.wrong_password": "Falsches Passwort. Versuch es noch einmal.",
    "errors.code_required": "Gib den Code ein, um freizugeben.",
    "errors.wrong_code": "Dieser Code ist falsch. Versuch es noch einmal.",
    "errors.signed_out":
      "Du bist abgemeldet. Melde dich wieder an und kopple dann das Gerät.",
    "errors.network":
      "Der Server ist nicht erreichbar. Prüfe deine Verbindung und versuch es noch einmal.",
    "errors.bad_request":
      "Dieser Code konnte nicht freigegeben werden. Hol dir einen neuen Code auf dem Gerät.",
    "errors.unknown": "Etwas ist schiefgelaufen. Versuch es noch einmal.",
    "type.desktop": "Computer",
    "type.mobile": "Telefon",
    "type.tv": "Fernseher",
    "type.kodi": "Kodi",
    "type.jellyfin": "Jellyfin-Server",
    "type.web": "Webbrowser",
    "type.other": "Gerät",
  },
  es: {
    title: "Vincular un dispositivo",
    description: "Escribe el código que aparece en el dispositivo en el que quieres iniciar sesión.",
    cancel: "Cancelar",
    close: "Cerrar",
    tryAgain: "Probar otro código",
    "code.label": "Código de vinculación",
    "code.submit": "Continuar",
    "code.looking": "Buscando el código…",
    "confirm.keyQuestion": "{app} en {name} ({type}) ha iniciado sesión en tu cuenta y pide la clave de tu mediateca.",
    "confirm.question": "{app} en {name} ({type}) quiere iniciar sesión en tu cuenta.",
    "confirm.warning":
      "Aprueba solo un código que aparezca en una pantalla que tengas delante. Si alguien te envió un código, está intentando entrar en tu cuenta.",
    "confirm.passwordLabel": "La contraseña de tu cuenta",
    "confirm.passwordHint":
      "Confirma que eres tú antes de que el dispositivo reciba la clave de tu mediateca.",
    "confirm.approve": "Aprobar",
    "confirm.approving": "Aprobando…",
    "confirm.deny": "Rechazar",
    "confirm.noPasswordHint":
      "Tu cuenta no tiene contraseña, así que un código confirma que eres tú antes de que el dispositivo reciba la clave de tu biblioteca.",
    "confirm.codeLabel": "Código",
    "confirm.codeSentEmail": "Te enviamos un código por correo. Escríbelo aquí.",
    "confirm.codeTotp": "Escribe el código de tu app de autenticación.",
    "done.keySent": "{name} ya tiene la clave de tu mediateca.",
    "done.added": "{name} inició sesión en tu cuenta.",
    "done.denied": "{name} fue rechazado. Su código ya no funciona.",
    "errors.invalid_code":
      "Eso no es un código de vinculación. Tiene 8 letras y números, como ABCD-EFGH.",
    "errors.not_found":
      "Ningún dispositivo está esperando con este código. Revísalo u obtén un código nuevo en el dispositivo.",
    "errors.expired":
      "Este código caducó. Obtén un código nuevo en el dispositivo.",
    "errors.already_used":
      "Este código ya se usó. Obtén un código nuevo en el dispositivo.",
    "errors.no_library_key":
      "Esta computadora no tiene la clave de tu mediateca, así que no puede transmitirla.",
    "errors.password_missing":
      "Escribe la contraseña de tu cuenta para aprobar.",
    "errors.wrong_password": "Contraseña incorrecta. Vuelve a intentarlo.",
    "errors.code_required": "Escribe el código para aprobar.",
    "errors.wrong_code": "Ese código no es correcto. Vuelve a intentarlo.",
    "errors.signed_out":
      "Cerraste sesión. Vuelve a iniciar sesión y luego vincula el dispositivo.",
    "errors.network":
      "No se pudo conectar con el servidor. Revisa tu conexión y vuelve a intentarlo.",
    "errors.bad_request":
      "No se pudo aprobar este código. Obtén un código nuevo en el dispositivo.",
    "errors.unknown": "Algo salió mal. Vuelve a intentarlo.",
    "type.desktop": "Computadora",
    "type.mobile": "Teléfono",
    "type.tv": "TV",
    "type.kodi": "Kodi",
    "type.jellyfin": "Servidor Jellyfin",
    "type.web": "Navegador web",
    "type.other": "Dispositivo",
  },
};

/** The dialog's text in `language`, with `{name}`-style variables filled in. */
export const pairDeviceText =
  (language: ClientUiLanguage) =>
  (
    key: PairDeviceStringKey | `type.${PairDeviceKind}`,
    vars?: Record<string, string>,
  ): string =>
    pairDeviceStrings[language][key].replace(
      /\{(\w+)\}/g,
      (_, name: string) => vars?.[name] ?? `{${name}}`,
    );
