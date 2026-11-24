import type { ClientUiLanguage } from "@space/shared/i18n";

/**
 * Every sentence the "Sign in with another device" screen shows, and its key-screen variant ("Get your library key from
 * another device", the `key*` strings plus `typeKeyInstead`). `expiresIn` takes `{time}`.
 */
export type PairWithPhoneStringKey =
  | "title"
  | "instructions"
  | "codeLabel"
  | "starting"
  | "waiting"
  | "verifying"
  | "expiresIn"
  | "expired"
  | "newCode"
  | "emailInstead"
  | "or"
  | "card"
  | "qrAlt"
  | "denied"
  | "keyUnreadable"
  | "keyMismatch"
  | "unreachable"
  | "failed"
  | "keyLink"
  | "keyCard"
  | "keyTitle"
  | "keyInstructions"
  | "keyWaiting"
  | "typeKeyInstead"
  | "checkLabel"
  | "checkHint";

/**
 * The screen's text in the five client languages (UX-I18N-01), shared by Badger desktop and Parrot desktop so neither
 * keeps its own copy (REL-FAM-02). A signed-in Badger or Parrot app approves either one (ACCT-PAIR-05), so the text
 * names both.
 */
export const pairWithPhoneStrings: Record<ClientUiLanguage, Record<PairWithPhoneStringKey, string>> = {
  en: {
    title: "Sign in with another device",
    instructions: "On a phone or computer already signed in, open Badger or Parrot → Settings → Pair a device, then scan this code.",
    codeLabel: "Or type this code in Badger or Parrot on your other device",
    starting: "Getting a code…",
    waiting: "Waiting for your other device…",
    verifying: "Unlocking your library…",
    expiresIn: "This code expires in {time}",
    expired: "This code has expired.",
    newCode: "Get a new code",
    emailInstead: "Sign in with email and password instead",
    or: "or",
    card: "Scan a QR code with Badger or Parrot on another signed-in device. Nothing to type.",
    qrAlt: "Code to scan with Badger or Parrot on another device",
    denied: "Your other device declined this device. Get a new code to try again.",
    keyUnreadable: "The key from your other device could not be read. Get a new code and try again.",
    keyMismatch: "The key from your other device doesn't match this account's library. Get a new code and try again.",
    unreachable: "Can't reach SpaceFleet. Check your connection, then get a new code.",
    failed: "Something went wrong. Get a new code to try again.",
    keyLink: "Get the key from another device",
    keyCard: "Use any Badger or Parrot app you're signed in to, on any device or profile of this account: approve the code shown here.",
    keyTitle: "Get your library key from another device",
    keyInstructions:
      "On a phone or computer already signed in to this account, open Badger or Parrot → Settings → Pair a device, then scan this code.",
    keyWaiting: "Waiting for your other device…",
    typeKeyInstead: "Type the key instead",
    checkLabel: "Code to check",
    checkHint: "Compare it with your other device. Approve only if both show the same six digits.",
  },
  fr: {
    title: "Se connecter avec un autre appareil",
    instructions: "Sur un téléphone ou un ordinateur déjà connecté, ouvrez Badger ou Parrot → Réglages → Associer un appareil, puis scannez ce code.",
    codeLabel: "Ou saisissez ce code dans Badger ou Parrot sur votre autre appareil",
    starting: "Obtention d’un code…",
    waiting: "En attente de votre autre appareil…",
    verifying: "Déverrouillage de votre bibliothèque…",
    expiresIn: "Ce code expire dans {time}",
    expired: "Ce code a expiré.",
    newCode: "Obtenir un nouveau code",
    emailInstead: "Se connecter avec l’email et le mot de passe",
    or: "ou",
    card: "Scannez un code QR avec Badger ou Parrot sur un autre appareil connecté. Rien à taper.",
    qrAlt: "Code à scanner avec Badger ou Parrot sur un autre appareil",
    denied: "Votre autre appareil a refusé cet appareil. Obtenez un nouveau code pour réessayer.",
    keyUnreadable: "La clé envoyée par votre autre appareil n’a pas pu être lue. Obtenez un nouveau code et réessayez.",
    keyMismatch:
      "La clé envoyée par votre autre appareil ne correspond pas à la bibliothèque de ce compte. Obtenez un nouveau code et réessayez.",
    unreachable: "Impossible de joindre SpaceFleet. Vérifiez votre connexion, puis obtenez un nouveau code.",
    failed: "Un problème est survenu. Obtenez un nouveau code pour réessayer.",
    keyLink: "Obtenir la clé depuis un autre appareil",
    keyCard:
      "Utilisez n'importe quelle app Badger ou Parrot où vous êtes connecté, sur n'importe quel appareil ou profil de ce compte : approuvez-y le code affiché ici.",
    keyTitle: "Obtenir votre clé de médiathèque depuis un autre appareil",
    keyInstructions:
      "Sur un téléphone ou un ordinateur déjà connecté à ce compte, ouvrez Badger ou Parrot → Réglages → Associer un appareil, puis scannez ce code.",
    keyWaiting: "En attente de votre autre appareil…",
    typeKeyInstead: "Saisir la clé à la place",
    checkLabel: "Code à vérifier",
    checkHint: "Comparez-le avec votre autre appareil. N’approuvez que si les deux affichent les mêmes six chiffres.",
  },
  nl: {
    title: "Inloggen met een ander apparaat",
    instructions: "Open op een telefoon of computer die al is ingelogd Badger of Parrot → Instellingen → Apparaat koppelen en scan dan deze code.",
    codeLabel: "Of typ deze code in Badger of Parrot op je andere apparaat",
    starting: "Code ophalen…",
    waiting: "Wachten op je andere apparaat…",
    verifying: "Je mediatheek ontgrendelen…",
    expiresIn: "Deze code verloopt over {time}",
    expired: "Deze code is verlopen.",
    newCode: "Nieuwe code ophalen",
    emailInstead: "Liever inloggen met e-mail en wachtwoord",
    or: "of",
    card: "Scan een QR-code met Badger of Parrot op een ander ingelogd apparaat. Niets te typen.",
    qrAlt: "Code om te scannen met Badger of Parrot op een ander apparaat",
    denied: "Je andere apparaat heeft dit apparaat geweigerd. Haal een nieuwe code op om het opnieuw te proberen.",
    keyUnreadable: "De sleutel van je andere apparaat kon niet worden gelezen. Haal een nieuwe code op en probeer het opnieuw.",
    keyMismatch:
      "De sleutel van je andere apparaat past niet bij de mediatheek van dit account. Haal een nieuwe code op en probeer het opnieuw.",
    unreachable: "SpaceFleet is niet bereikbaar. Controleer je verbinding en haal dan een nieuwe code op.",
    failed: "Er ging iets mis. Haal een nieuwe code op om het opnieuw te proberen.",
    keyLink: "Sleutel ophalen van een ander apparaat",
    keyCard: "Gebruik elke Badger- of Parrot-app waarin je bent ingelogd, op elk apparaat of profiel van dit account: keur daar de code goed die hier staat.",
    keyTitle: "Haal je mediatheeksleutel op van een ander apparaat",
    keyInstructions:
      "Open op een telefoon of computer die al is ingelogd op dit account Badger of Parrot → Instellingen → Apparaat koppelen en scan dan deze code.",
    keyWaiting: "Wachten op je andere apparaat…",
    typeKeyInstead: "Liever de sleutel typen",
    checkLabel: "Controlecode",
    checkHint: "Vergelijk hem met je andere apparaat. Keur alleen goed als beide dezelfde zes cijfers tonen.",
  },
  de: {
    title: "Mit einem anderen Gerät anmelden",
    instructions: "Öffne auf einem Handy oder Computer, der schon angemeldet ist, Badger oder Parrot → Einstellungen → Gerät koppeln und scanne dann diesen Code.",
    codeLabel: "Oder gib diesen Code in Badger oder Parrot auf deinem anderen Gerät ein",
    starting: "Code wird abgerufen…",
    waiting: "Warten auf dein anderes Gerät…",
    verifying: "Deine Mediathek wird entsperrt…",
    expiresIn: "Dieser Code läuft in {time} ab",
    expired: "Dieser Code ist abgelaufen.",
    newCode: "Neuen Code holen",
    emailInstead: "Stattdessen mit E-Mail und Passwort anmelden",
    or: "oder",
    card: "Scanne einen QR-Code mit Badger oder Parrot auf einem anderen angemeldeten Gerät. Nichts zu tippen.",
    qrAlt: "Code zum Scannen mit Badger oder Parrot auf einem anderen Gerät",
    denied: "Dein anderes Gerät hat dieses Gerät abgelehnt. Hol dir einen neuen Code, um es erneut zu versuchen.",
    keyUnreadable: "Der Schlüssel von deinem anderen Gerät konnte nicht gelesen werden. Hol dir einen neuen Code und versuch es erneut.",
    keyMismatch:
      "Der Schlüssel von deinem anderen Gerät passt nicht zur Mediathek dieses Kontos. Hol dir einen neuen Code und versuch es erneut.",
    unreachable: "SpaceFleet ist nicht erreichbar. Prüfe deine Verbindung und hol dir dann einen neuen Code.",
    failed: "Etwas ist schiefgelaufen. Hol dir einen neuen Code, um es erneut zu versuchen.",
    keyLink: "Schlüssel von einem anderen Gerät holen",
    keyCard:
      "Nutze jede Badger- oder Parrot-App, in der du angemeldet bist, auf jedem Gerät oder Profil dieses Kontos: bestätige dort den hier gezeigten Code.",
    keyTitle: "Hol dir deinen Mediathek-Schlüssel von einem anderen Gerät",
    keyInstructions:
      "Öffne auf einem Handy oder Computer, der schon bei diesem Konto angemeldet ist, Badger oder Parrot → Einstellungen → Gerät koppeln und scanne dann diesen Code.",
    keyWaiting: "Warten auf dein anderes Gerät…",
    typeKeyInstead: "Stattdessen den Schlüssel eingeben",
    checkLabel: "Prüfcode",
    checkHint: "Vergleiche ihn mit deinem anderen Gerät. Bestätige nur, wenn beide dieselben sechs Ziffern zeigen.",
  },
  es: {
    title: "Inicia sesión con otro dispositivo",
    instructions: "En un teléfono o una computadora con la sesión ya iniciada, abre Badger o Parrot → Ajustes → Vincular un dispositivo y escanea este código.",
    codeLabel: "O escribe este código en Badger o Parrot en tu otro dispositivo",
    starting: "Obteniendo un código…",
    waiting: "Esperando a tu otro dispositivo…",
    verifying: "Desbloqueando tu mediateca…",
    expiresIn: "Este código caduca en {time}",
    expired: "Este código caducó.",
    newCode: "Obtener un código nuevo",
    emailInstead: "Iniciar sesión con correo y contraseña",
    or: "o",
    card: "Escanea un código QR con Badger o Parrot en otro dispositivo con la sesión iniciada. Sin escribir nada.",
    qrAlt: "Código para escanear con Badger o Parrot en otro dispositivo",
    denied: "Tu otro dispositivo rechazó este dispositivo. Obtén un código nuevo para volver a intentarlo.",
    keyUnreadable: "No se pudo leer la clave de tu otro dispositivo. Obtén un código nuevo y vuelve a intentarlo.",
    keyMismatch:
      "La clave de tu otro dispositivo no coincide con la mediateca de esta cuenta. Obtén un código nuevo y vuelve a intentarlo.",
    unreachable: "No se puede conectar con SpaceFleet. Revisa tu conexión y luego obtén un código nuevo.",
    failed: "Algo salió mal. Obtén un código nuevo para volver a intentarlo.",
    keyLink: "Obtener la clave desde otro dispositivo",
    keyCard:
      "Usa cualquier app de Badger o Parrot con la sesión iniciada, en cualquier dispositivo o perfil de esta cuenta: aprueba allí el código que se muestra aquí.",
    keyTitle: "Obtén la clave de tu mediateca desde otro dispositivo",
    keyInstructions:
      "En un teléfono o una computadora que ya tenga la sesión iniciada en esta cuenta, abre Badger o Parrot → Ajustes → Vincular un dispositivo y escanea este código.",
    keyWaiting: "Esperando a tu otro dispositivo…",
    typeKeyInstead: "Escribir la clave",
    checkLabel: "Código de verificación",
    checkHint: "Compáralo con tu otro dispositivo. Aprueba solo si ambos muestran los mismos seis dígitos.",
  },
};

export const pairWithPhoneText =
  (language: ClientUiLanguage) =>
  (key: PairWithPhoneStringKey, vars?: Record<string, string>): string =>
    pairWithPhoneStrings[language][key].replace(/\{(\w+)\}/g, (_, name: string) => vars?.[name] ?? `{${name}}`);
