/**
 * Text the main process shows itself (the quit warning, file-dialog filters), in the five app languages (UX-I18N-01).
 * The tray and macOS menu words are shared with Parrot (`MAIN_SHELL_STRINGS`, `@space/desktop-shell/main-shell`). The
 * renderer's strings live in `src/renderer/src/i18n/*.json`; these few are drawn by Electron before or outside any
 * window, so they live here. The language is the one the renderer shows: it reports every change over
 * `sf-ui-language`; until the first report the main process uses the OS language.
 */
import { DEFAULT_ACCOUNT_LANGUAGE, isClientUiLanguage, pickStartLanguage, type ClientUiLanguage } from "@space/shared";

export type MainUiStrings = {
  quitTitle: string;
  quitMessage: string;
  quitDetail: string;
  quitKeep: string;
  quitAnyway: string;
  filterMedia: string;
  filterVideos: string;
  filterSubtitles: string;
};

export const MAIN_UI_STRINGS: Record<ClientUiLanguage, MainUiStrings> = {
  en: {
    quitTitle: "Processing in progress",
    quitMessage: "Media processing is still running.",
    quitDetail: "Closing now will stop active processing jobs. Do you want to quit anyway?",
    quitKeep: "Keep processing",
    quitAnyway: "Quit anyway",
    filterMedia: "Media files",
    filterVideos: "Videos",
    filterSubtitles: "Subtitles",
  },
  fr: {
    quitTitle: "Traitement en cours",
    quitMessage: "Le traitement des médias est toujours en cours.",
    quitDetail: "Fermer maintenant arrêtera les traitements en cours. Voulez-vous quitter quand même ?",
    quitKeep: "Continuer le traitement",
    quitAnyway: "Quitter quand même",
    filterMedia: "Fichiers multimédias",
    filterVideos: "Vidéos",
    filterSubtitles: "Sous-titres",
  },
  nl: {
    quitTitle: "Verwerking bezig",
    quitMessage: "Er worden nog media verwerkt.",
    quitDetail: "Als je nu afsluit, stoppen de lopende verwerkingen. Wil je toch stoppen?",
    quitKeep: "Doorgaan met verwerken",
    quitAnyway: "Toch stoppen",
    filterMedia: "Mediabestanden",
    filterVideos: "Video's",
    filterSubtitles: "Ondertiteling",
  },
  de: {
    quitTitle: "Verarbeitung läuft",
    quitMessage: "Medien werden noch verarbeitet.",
    quitDetail: "Wenn du jetzt beendest, werden laufende Verarbeitungen gestoppt. Trotzdem beenden?",
    quitKeep: "Weiter verarbeiten",
    quitAnyway: "Trotzdem beenden",
    filterMedia: "Mediendateien",
    filterVideos: "Videos",
    filterSubtitles: "Untertitel",
  },
  es: {
    quitTitle: "Procesamiento en curso",
    quitMessage: "Todavía se están procesando contenidos multimedia.",
    quitDetail: "Si cierras ahora, se detendrán los procesamientos en curso. ¿Quieres salir de todos modos?",
    quitKeep: "Seguir procesando",
    quitAnyway: "Salir de todos modos",
    filterMedia: "Archivos multimedia",
    filterVideos: "Videos",
    filterSubtitles: "Subtítulos",
  },
};

let current: ClientUiLanguage = DEFAULT_ACCOUNT_LANGUAGE;

/** Seeds the language from the OS locale (`app.getLocale()`), before the renderer has reported its own. */
export const seedMainUiLanguage = (osLocale: string): ClientUiLanguage => {
  current = pickStartLanguage(null, [osLocale], isClientUiLanguage, DEFAULT_ACCOUNT_LANGUAGE);
  return current;
};

/** Records the renderer's language; returns whether it changed (so the caller rebuilds the menus). */
export const setMainUiLanguage = (language: unknown): boolean => {
  if (typeof language !== "string" || !isClientUiLanguage(language) || language === current) return false;
  current = language;
  return true;
};

export const mainUiLanguage = (): ClientUiLanguage => current;

export const mainUiStrings = (): MainUiStrings => MAIN_UI_STRINGS[current];
