/**
 * UX-KEY-02: the library key step reads the account's library meta (`getLibraryMetaForKeyStep` in `./api`) before it
 * can show a new key or ask for the account's. That read is bounded: past {@link KEY_STEP_META_TIMEOUT_MS} it fails
 * with `ApiError(0, { error: "timeout" })`, and every app then shows one screen in place of "Loading key…": the key
 * could not be loaded, why in one sentence, and Retry, which reads the meta again. Nothing about the key is decided
 * on a failed read: no new key is made over the account's, and a key kept on the device stays.
 *
 * Every read reports one {@link KeyStepMetaRead} (anonymous: no account, no token) that the apps log as
 * {@link KEY_STEP_META_LOG_EVENT}, so the logs count slow and failed key steps per app.
 */
import { ApiError } from "@space/sdk";
import type { ClientUiLanguage } from "./i18n";
import { REQUEST_TIMEOUT_ERROR, SIGN_IN_TIMEOUT_MS } from "./signInError";

/**
 * How long the key step waits for the library meta in all, retries included: the sign-in's own bound, so a server
 * that answers neither the sign-in nor the key step is given up on after the same time.
 */
export const KEY_STEP_META_TIMEOUT_MS = SIGN_IN_TIMEOUT_MS;

/** The log line (event name) of one key-step meta read. */
export const KEY_STEP_META_LOG_EVENT = "key_step.meta_read";

/**
 * Why a key-step meta read failed: no answer in time, no connection, a server error (5xx), a refused session
 * (401/403), another refusal (4xx), or anything else.
 */
export type KeyStepMetaErrorClass = "timeout" | "unreachable" | "server" | "session" | "refused" | "unknown";

export const keyStepMetaErrorClass = (error: unknown): KeyStepMetaErrorClass => {
  if (error instanceof ApiError) {
    if (error.status === 0) return error.payload.error === REQUEST_TIMEOUT_ERROR ? "timeout" : "unreachable";
    if (error.status === 401 || error.status === 403) return "session";
    if (error.status >= 500) return "server";
    return "refused";
  }
  // `fetch` rejects with a TypeError when there is no connection at all.
  if (error instanceof TypeError) return "unreachable";
  return "unknown";
};

/** One key-step meta read, as logged: anonymous fields only. */
export type KeyStepMetaRead = {
  step: "library_meta";
  outcome: "ok" | "failed";
  durationMs: number;
  /** Requests sent, retries included. */
  attempts: number;
  errorClass: KeyStepMetaErrorClass | null;
  /** The HTTP status of the last failed request; 0 for no answer; null on success. */
  status: number | null;
};

/** The read as one `key=value` line, for the apps whose log takes a string (Parrot desktop's main process). */
export const keyStepMetaReadLine = (read: KeyStepMetaRead): string =>
  `${KEY_STEP_META_LOG_EVENT} ${Object.entries(read)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ")}`;

/** What the screen says in place of "Loading key…" after a failed read. */
export type KeyStepLoadFailedText = {
  title: string;
  /** One sentence on why, by {@link KeyStepMetaErrorClass}. */
  body: string;
  retry: string;
  retrying: string;
};

type Words = Omit<KeyStepLoadFailedText, "body"> & { slow: string; offline: string; server: string };

const TEXT: Record<ClientUiLanguage, Words> = {
  en: {
    title: "Your key could not be loaded",
    slow: "The server is taking too long to answer. Nothing is lost: try again in a moment.",
    offline: "The server cannot be reached. Check your internet connection, then try again.",
    server: "The server ran into a problem. Nothing is lost: try again in a moment.",
    retry: "Retry",
    retrying: "Retrying…",
  },
  fr: {
    title: "Impossible de charger votre clé",
    slow: "Le serveur met trop de temps à répondre. Rien n'est perdu\u202f: réessayez dans un instant.",
    offline: "Le serveur est injoignable. Vérifiez votre connexion internet, puis réessayez.",
    server: "Le serveur a rencontré un problème. Rien n'est perdu\u202f: réessayez dans un instant.",
    retry: "Réessayer",
    retrying: "Nouvel essai…",
  },
  nl: {
    title: "Je sleutel kon niet worden geladen",
    slow: "De server doet er te lang over om te antwoorden. Er gaat niets verloren: probeer het zo opnieuw.",
    offline: "De server is niet bereikbaar. Controleer je internetverbinding en probeer het opnieuw.",
    server: "Er ging iets mis op de server. Er gaat niets verloren: probeer het zo opnieuw.",
    retry: "Opnieuw proberen",
    retrying: "Opnieuw proberen…",
  },
  de: {
    title: "Dein Schlüssel konnte nicht geladen werden",
    slow: "Der Server braucht zu lange für eine Antwort. Es geht nichts verloren: Versuche es gleich noch einmal.",
    offline: "Der Server ist nicht erreichbar. Prüfe deine Internetverbindung und versuche es dann noch einmal.",
    server: "Auf dem Server ist ein Fehler aufgetreten. Es geht nichts verloren: Versuche es gleich noch einmal.",
    retry: "Erneut versuchen",
    retrying: "Wird erneut versucht…",
  },
  es: {
    title: "No se ha podido cargar tu clave",
    slow: "El servidor tarda demasiado en responder. No se ha perdido nada: vuelve a intentarlo en un momento.",
    offline: "No se puede conectar con el servidor. Comprueba tu conexión a internet y vuelve a intentarlo.",
    server: "El servidor ha tenido un problema. No se ha perdido nada: vuelve a intentarlo en un momento.",
    retry: "Reintentar",
    retrying: "Reintentando…",
  },
};

/** The failed-read screen's words in `language`, its sentence picked by why the read failed. */
export const keyStepLoadFailedText = (language: ClientUiLanguage, errorClass: KeyStepMetaErrorClass): KeyStepLoadFailedText => {
  const { slow, offline, server, ...words } = TEXT[language];
  const body = errorClass === "timeout" ? slow : errorClass === "unreachable" ? offline : server;
  return { ...words, body };
};

/** For the typography and locale tests: every language's words. */
export const keyStepLoadFailedWords = TEXT;
