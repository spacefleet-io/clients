/**
 * ACCT-STREAM-02 prompt text in every app language (en, fr, nl, de, es, as the shared app shells carry). `{device}` is
 * the other device's name; when the API has none (a session without a device name), `deviceLabel` gives a
 * generic one from its device type.
 */

export const STREAM_SLOT_LANGUAGES = ["en", "fr", "nl", "de", "es"] as const;
export type StreamSlotLanguage = (typeof STREAM_SLOT_LANGUAGES)[number];

export type StreamSlotTextKey = "alreadyPlaying" | "playHere" | "cancel" | "playingElsewhere";

export const STREAM_SLOT_STRINGS: Readonly<Record<StreamSlotLanguage, Readonly<Record<StreamSlotTextKey, string>>>> = {
  en: {
    alreadyPlaying: "Already playing on {device}. Play here instead?",
    playHere: "Play here",
    cancel: "Cancel",
    playingElsewhere: "Playing on {device} now",
  },
  fr: {
    alreadyPlaying: "Déjà en lecture sur {device}. Lire ici à la place ?",
    playHere: "Lire ici",
    cancel: "Annuler",
    playingElsewhere: "Lecture en cours sur {device}",
  },
  nl: {
    alreadyPlaying: "Speelt al af op {device}. Hier afspelen?",
    playHere: "Hier afspelen",
    cancel: "Annuleren",
    playingElsewhere: "Speelt nu af op {device}",
  },
  de: {
    alreadyPlaying: "Wird bereits auf {device} abgespielt. Stattdessen hier abspielen?",
    playHere: "Hier abspielen",
    cancel: "Abbrechen",
    playingElsewhere: "Wird jetzt auf {device} abgespielt",
  },
  es: {
    alreadyPlaying: "Ya se está reproduciendo en {device}. ¿Reproducir aquí?",
    playHere: "Reproducir aquí",
    cancel: "Cancelar",
    playingElsewhere: "Ahora se está reproduciendo en {device}",
  },
};

/** Generic device names by `deviceType`, used when the other device has no name of its own. */
const DEVICE_LABELS: Readonly<Record<StreamSlotLanguage, Readonly<Record<string, string>>>> = {
  en: { desktop: "a computer", mobile: "a phone", tv: "a TV", web: "a web browser", kodi: "Kodi", jellyfin: "Jellyfin", other: "another device" },
  fr: { desktop: "un ordinateur", mobile: "un téléphone", tv: "une TV", web: "un navigateur web", kodi: "Kodi", jellyfin: "Jellyfin", other: "un autre appareil" },
  nl: { desktop: "een computer", mobile: "een telefoon", tv: "een tv", web: "een webbrowser", kodi: "Kodi", jellyfin: "Jellyfin", other: "een ander apparaat" },
  de: { desktop: "einem Computer", mobile: "einem Telefon", tv: "einem Fernseher", web: "einem Webbrowser", kodi: "Kodi", jellyfin: "Jellyfin", other: "einem anderen Gerät" },
  es: { desktop: "una computadora", mobile: "un teléfono", tv: "un televisor", web: "un navegador web", kodi: "Kodi", jellyfin: "Jellyfin", other: "otro dispositivo" },
};

const languageOf = (language: string): StreamSlotLanguage => {
  const base = language.toLowerCase().split(/[-_]/u)[0];
  return (STREAM_SLOT_LANGUAGES as readonly string[]).includes(base) ? (base as StreamSlotLanguage) : "en";
};

/** The device's own name, else a generic label for its type in `language`. */
export const deviceLabel = (language: string, device: { deviceName: string | null; deviceType?: string | null }): string => {
  const name = device.deviceName?.trim();
  if (name) return name;
  const labels = DEVICE_LABELS[languageOf(language)];
  return labels[device.deviceType ?? "other"] ?? labels.other;
};

/** The text for `key` in `language` (unknown languages fall back to English), with `{device}` filled in. */
export const streamSlotText = (language: string, key: StreamSlotTextKey, device?: { deviceName: string | null; deviceType?: string | null }): string => {
  const template = STREAM_SLOT_STRINGS[languageOf(language)][key];
  return device ? template.replace("{device}", deviceLabel(language, device)) : template;
};
