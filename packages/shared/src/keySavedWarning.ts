import type { ClientUiLanguage } from "./i18n";

/** Which app speaks: Badger calls the library the "media library" (UX-NAME-03), Parrot a "library". */
export type KeySavedWarningApp = "badger" | "parrot";

/**
 * ACCT-DEV-04: the words of the new-key step and of the warning that comes before leaving it, in plain words with no
 * talk of encryption. `stepLine` sits on the key screen itself; the rest is the warning shown when the user presses
 * "I've written it down". Only `confirm` moves on; `back` returns to the key, still shown.
 */
export type KeySavedWarningText = {
  stepLine: string;
  saved: string;
  title: string;
  needed: string;
  noReset: string;
  lost: string;
  confirm: string;
  back: string;
};

// Every library noun below is feminine (fr, de, es) or takes "je" (nl), so one sentence fits both apps. The unpaid
// setup screen (`unpaidLibrarySetup.ts`) names the library with the same nouns.
export const LIBRARY_NOUN: Record<KeySavedWarningApp, Record<ClientUiLanguage, string>> = {
  badger: { en: "media library", fr: "médiathèque", nl: "mediatheek", de: "Mediathek", es: "mediateca" },
  parrot: { en: "library", fr: "bibliothèque", nl: "bibliotheek", de: "Bibliothek", es: "biblioteca" },
};

const TEXT: Record<ClientUiLanguage, (library: string) => KeySavedWarningText> = {
  en: (library) => ({
    stepLine: `Save this key somewhere safe: you'll need it to sign in on any new device, and if it's lost, nobody, not even us, can get your ${library} back.`,
    saved: "I've written it down",
    title: "Before you go on",
    needed: "You'll need this key every time you sign in on a new device or app.",
    noReset: "We can't see your key and we can't reset it.",
    lost: `If you lose it, your ${library} can't be recovered, by anyone, including us.`,
    confirm: "Yes, I understand",
    back: "Go back",
  }),
  fr: (library) => ({
    stepLine: `Enregistrez cette clé en lieu sûr : elle vous sera demandée sur chaque nouvel appareil, et si vous la perdez, personne, pas même nous, ne pourra récupérer votre ${library}.`,
    saved: "Je l'ai notée",
    title: "Avant de continuer",
    needed: "Vous aurez besoin de cette clé chaque fois que vous vous connecterez sur un nouvel appareil ou une nouvelle app.",
    noReset: "Nous ne pouvons ni voir votre clé, ni la réinitialiser.",
    lost: `Si vous la perdez, votre ${library} ne pourra être récupérée par personne, pas même par nous.`,
    confirm: "Oui, j'ai compris",
    back: "Retour",
  }),
  nl: (library) => ({
    stepLine: `Bewaar deze sleutel op een veilige plek: je hebt hem nodig om in te loggen op een nieuw apparaat, en als je hem kwijtraakt, kan niemand, ook wij niet, je ${library} terughalen.`,
    saved: "Ik heb hem opgeschreven",
    title: "Voordat je verdergaat",
    needed: "Je hebt deze sleutel nodig elke keer dat je inlogt op een nieuw apparaat of in een nieuwe app.",
    noReset: "Wij kunnen je sleutel niet zien en niet opnieuw instellen.",
    lost: `Als je hem kwijtraakt, kan niemand je ${library} terughalen, ook wij niet.`,
    confirm: "Ja, ik begrijp het",
    back: "Terug",
  }),
  de: (library) => ({
    stepLine: `Bewahre diesen Schlüssel an einem sicheren Ort auf: Du brauchst ihn für die Anmeldung auf jedem neuen Gerät, und wenn er verloren geht, kann niemand, auch wir nicht, deine ${library} wiederherstellen.`,
    saved: "Ich habe ihn notiert",
    title: "Bevor es weitergeht",
    needed: "Du brauchst diesen Schlüssel jedes Mal, wenn du dich auf einem neuen Gerät oder in einer neuen App anmeldest.",
    noReset: "Wir können deinen Schlüssel weder sehen noch zurücksetzen.",
    lost: `Wenn du ihn verlierst, kann niemand deine ${library} wiederherstellen, auch wir nicht.`,
    confirm: "Ja, ich habe verstanden",
    back: "Zurück",
  }),
  es: (library) => ({
    stepLine: `Guarda esta clave en un lugar seguro: la necesitarás para iniciar sesión en cualquier dispositivo nuevo y, si la pierdes, nadie, ni siquiera nosotros, podrá recuperar tu ${library}.`,
    saved: "Ya la he anotado",
    title: "Antes de continuar",
    needed: "Necesitarás esta clave cada vez que inicies sesión en un dispositivo o una app nuevos.",
    noReset: "No podemos ver tu clave ni restablecerla.",
    lost: `Si la pierdes, nadie podrá recuperar tu ${library}, ni siquiera nosotros.`,
    confirm: "Sí, lo entiendo",
    back: "Volver",
  }),
};

export const keySavedWarningText = (language: ClientUiLanguage, app: KeySavedWarningApp): KeySavedWarningText =>
  TEXT[language](LIBRARY_NOUN[app][language]);
