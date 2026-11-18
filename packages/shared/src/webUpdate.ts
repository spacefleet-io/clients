import de from "./webUpdate/de.json";
import en from "./webUpdate/en.json";
import es from "./webUpdate/es.json";
import fr from "./webUpdate/fr.json";
import nl from "./webUpdate/nl.json";

/**
 * The words of the web players' update notice (REL-CD-29): an open browser tab of an older build is refused by the API
 * and asks to be reloaded. Read from the translation files next to this module (UX-I18N-02), in the five client
 * languages, so the notice needs no i18n instance (it can show before the player's own translations load).
 */
export type WebUpdateCopy = {
  /** "SpaceFleet has been updated. Reload to continue" (Chris 2026-11-18, option (a)). */
  title: string;
  /** The one button: reloads the page. */
  reload: string;
};

export type WebUpdateLanguage = "en" | "fr" | "nl" | "de" | "es";

export const WEB_UPDATE_COPY: Record<WebUpdateLanguage, WebUpdateCopy> = {
  en: en.webUpdate,
  fr: fr.webUpdate,
  nl: nl.webUpdate,
  de: de.webUpdate,
  es: es.webUpdate,
};

/** The copy for a language tag (`"fr-FR"` reads French); English for anything else. */
export const webUpdateCopyFor = (lang: string | null | undefined): WebUpdateCopy =>
  WEB_UPDATE_COPY[(lang || "en").slice(0, 2).toLowerCase() as WebUpdateLanguage] ?? WEB_UPDATE_COPY.en;
