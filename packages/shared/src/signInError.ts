import { ApiError } from "@space/sdk";

/**
 * Why a sign-in failed, in the terms the sign-in screen talks to the user (ACCT-AUTH-11). Every Badger app maps
 * each kind to its own translated sentence; only `credentials` may blame the email or password.
 */
export type SignInFailure =
  /** The API answered: wrong email or password. */
  | "credentials"
  /** The API wants a second-step code (`method` on the error says which kind). */
  | "twoFactorRequired"
  /** The second-step code was wrong. */
  | "twoFactorInvalid"
  /** The account exists but its email address is not confirmed yet. */
  | "emailNotVerified"
  /** The account is scheduled for deletion (ACCT-AUTH-06). */
  | "deletionPending"
  /** No answer within {@link SIGN_IN_TIMEOUT_MS}. */
  | "timeout"
  /** No answer at all: offline, DNS failure, connection refused, TLS failure. */
  | "unreachable"
  /** Something answered, but not the SpaceFleet API (an HTML page, a captive portal, a proxy 404). */
  | "notApi"
  /** Too many attempts: the API refused the request for now (429, OPS-LIMIT-02/03) and says when to try again. */
  | "rateLimited"
  /** The API answered with a server error or said it is busy. */
  | "serverError"
  /** Anything else; logged with its details by the caller. */
  | "unknown";

/** How long a sign-in request may take before the app gives up and says the server did not answer. */
export const SIGN_IN_TIMEOUT_MS = 20_000;

/** The `ApiError` payload `error` the shared client uses when a request ran past its timeout. */
export const REQUEST_TIMEOUT_ERROR = "timeout";

/** How long the "too many attempts" sentence says to wait when the 429 carries no `retryAfterSeconds`. */
export const RATE_LIMIT_DEFAULT_MINUTES = 15;

// React Native: "Network request failed"; browsers: "Failed to fetch" / "NetworkError when attempting to fetch";
// Node/Bun/undici: "fetch failed" with ECONNREFUSED / ENOTFOUND / certificate causes.
const NETWORK_FAILURE =
  /network request failed|failed to fetch|networkerror|fetch failed|load failed|econnrefused|econnreset|enotfound|eai_again|getaddrinfo|unable to resolve host|certificate|ssl|tls|socket/i;

const describeError = (err: unknown): string => {
  if (!(err instanceof Error)) return String(err);
  const cause = "cause" in err ? err.cause : undefined;
  return cause instanceof Error ? `${err.name}: ${err.message} (${cause.message})` : `${err.name}: ${err.message}`;
};

/** Sorts any error a sign-in call can throw into one {@link SignInFailure}. Never throws. */
export const classifySignInError = (err: unknown): SignInFailure => {
  if (err instanceof ApiError) {
    switch (err.payload?.error) {
      case "invalid_credentials":
        return "credentials";
      case "two_factor_required":
        return "twoFactorRequired";
      case "two_factor_invalid":
        return "twoFactorInvalid";
      case "email_not_verified":
        return "emailNotVerified";
      case "account_deletion_pending":
        return "deletionPending";
      case REQUEST_TIMEOUT_ERROR:
        return "timeout";
      case "no_response":
        return "unreachable";
      case "invalid_response":
        return "notApi";
      case "rate_limited":
        return "rateLimited";
      default:
        break;
    }
    // Any 429, the API's own or a proxy's in front of it: too many attempts, never a server failure.
    if (err.status === 429) return "rateLimited";
    if (err.status >= 500) return "serverError";
    // A 4xx without one of the API's own error codes: whatever answered is not the SpaceFleet API.
    if (err.status >= 400) return "notApi";
    return "unknown";
  }
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.name === "TimeoutError") return "timeout";
    // A 2xx body that is not the JSON the API sends.
    if (err.name === "SyntaxError") return "notApi";
    if (NETWORK_FAILURE.test(describeError(err))) return "unreachable";
    if (err.name === "TypeError") return "unreachable";
  }
  return "unknown";
};

/** The sentences a failed sign-in can show (ACCT-AUTH-11); several failures share one. */
export type SignInErrorMessage =
  | "credentials"
  | "invalidCode"
  | "emailNotVerified"
  | "deletionPending"
  | "timeout"
  | "unreachable"
  | "serverError"
  | "tooManyAttempts"
  | "unknown";

/**
 * Which sentence a failed sign-in shows (ACCT-AUTH-11). Only a wrong email or password blames the credentials; an
 * answer that is not the SpaceFleet API (a web page, a Wi-Fi login page) reads like a server the app cannot reach
 * (REL-LAUNCH-03).
 */
export const signInErrorMessage = (failure: SignInFailure): SignInErrorMessage => {
  switch (failure) {
    case "twoFactorInvalid":
      return "invalidCode";
    case "notApi":
      return "unreachable";
    case "twoFactorRequired":
      return "unknown";
    case "rateLimited":
      return "tooManyAttempts";
    default:
      return failure;
  }
};

/** The translation key of that sentence: `login.errors.*`, the same keys in every app that loads {@link signInErrorTexts}. */
export const signInErrorMessageKey = (failure: SignInFailure): `login.errors.${SignInErrorMessage}` =>
  `login.errors.${signInErrorMessage(failure)}`;

/** The i18next key of the "Too many attempts. Try again in N minutes." sentence, for any form an API answer refused with 429. */
export const TOO_MANY_ATTEMPTS_KEY = "login.errors.tooManyAttempts" satisfies `login.errors.${SignInErrorMessage}`;

/** True when the API (or a proxy in front of it) refused the request as too many attempts (HTTP 429). */
export const isRateLimited = (err: unknown): boolean =>
  err instanceof ApiError && (err.status === 429 || err.payload?.error === "rate_limited");

/**
 * Whole minutes until a refused request may be tried again, from a 429's `retryAfterSeconds`: rounded up, at least 1;
 * {@link RATE_LIMIT_DEFAULT_MINUTES} when the answer does not say (a proxy's 429). For callers that keep only the
 * seconds (the pairing clients), not the `ApiError`.
 */
export const retryAfterSecondsToMinutes = (seconds: unknown): number =>
  typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0
    ? Math.max(1, Math.ceil(seconds / 60))
    : RATE_LIMIT_DEFAULT_MINUTES;

/** {@link retryAfterSecondsToMinutes} of a refused request's `ApiError`. */
export const retryAfterMinutes = (err: unknown): number =>
  retryAfterSecondsToMinutes(err instanceof ApiError ? err.payload?.retryAfterSeconds : undefined);

/**
 * The i18next values every `login.errors.*` sentence is translated with: `minutes` fills the "too many attempts"
 * sentence and `count` picks its singular or plural form; the other sentences ignore both.
 */
export type SignInErrorValues = { count: number; minutes: number };

/** The {@link SignInErrorValues} for `err` (the default wait when it is not a 429). */
export const signInErrorValues = (err: unknown): SignInErrorValues => {
  const minutes = retryAfterMinutes(err);
  return { count: minutes, minutes };
};

/**
 * The "Too many attempts. Try again in N minutes." sentence when `err` is a 429, else null, for i18next apps that
 * load {@link signInErrorTexts}: a form shows it instead of its own error text.
 */
export const tooManyAttemptsText = (t: (key: string, values: SignInErrorValues) => string, err: unknown): string | null =>
  isRateLimited(err) ? t(TOO_MANY_ATTEMPTS_KEY, signInErrorValues(err)) : null;

/** The languages {@link signInErrorTexts} is written in: every app language (UX-I18N-01). */
export type SignInErrorLanguage = "en" | "fr" | "nl" | "de" | "es";

/**
 * The sign-in error sentences, written once for every app. i18next apps load them as their `login.errors` resources;
 * apps with their own string tables read them through {@link signInErrorText}. `tooManyAttempts` holds `{{minutes}}`
 * and is the plural form; `tooManyAttempts_one` is the singular i18next picks for `count: 1`.
 */
export type SignInErrorSentences = Record<SignInErrorMessage, string> & { tooManyAttempts_one: string };

export const signInErrorTexts: Record<SignInErrorLanguage, SignInErrorSentences> = {
  en: {
    credentials: "Wrong email or password.",
    emailNotVerified: "Confirm your email address first with the code we emailed you, then sign in.",
    deletionPending: "This account is being deleted and can't sign in.",
    timeout: "The SpaceFleet server didn't answer in time. Check your connection and try again.",
    unreachable: "Can't reach the SpaceFleet server. Check your connection and try again.",
    serverError: "The SpaceFleet server ran into a problem. Try again in a few minutes.",
    unknown: "Signing in didn't work. Try again.",
    invalidCode: "Invalid verification code. Try again.",
    tooManyAttempts: "Too many attempts. Try again in {{minutes}} minutes.",
    tooManyAttempts_one: "Too many attempts. Try again in {{minutes}} minute.",
  },
  fr: {
    credentials: "Adresse e-mail ou mot de passe incorrect.",
    emailNotVerified: "Confirmez d'abord votre adresse e-mail avec le code que nous vous avons envoyé, puis connectez-vous.",
    deletionPending: "Ce compte est en cours de suppression et ne peut plus se connecter.",
    timeout: "Le serveur SpaceFleet n'a pas répondu à temps. Vérifiez votre connexion et réessayez.",
    unreachable: "Impossible de joindre le serveur SpaceFleet. Vérifiez votre connexion et réessayez.",
    serverError: "Le serveur SpaceFleet a rencontré un problème. Réessayez dans quelques minutes.",
    unknown: "La connexion n'a pas abouti. Réessayez.",
    invalidCode: "Code invalide. Réessayez.",
    tooManyAttempts: "Trop de tentatives. Réessayez dans {{minutes}} minutes.",
    tooManyAttempts_one: "Trop de tentatives. Réessayez dans {{minutes}} minute.",
  },
  nl: {
    credentials: "E-mailadres of wachtwoord klopt niet.",
    emailNotVerified: "Bevestig eerst je e-mailadres met de code die we je hebben gestuurd en log dan in.",
    deletionPending: "Dit account wordt verwijderd en kan niet meer inloggen.",
    timeout: "De SpaceFleet-server antwoordde niet op tijd. Controleer je verbinding en probeer het opnieuw.",
    unreachable: "De SpaceFleet-server is niet bereikbaar. Controleer je verbinding en probeer het opnieuw.",
    serverError: "De SpaceFleet-server had een probleem. Probeer het over een paar minuten opnieuw.",
    unknown: "Inloggen is niet gelukt. Probeer het opnieuw.",
    invalidCode: "Ongeldige verificatiecode. Probeer het opnieuw.",
    tooManyAttempts: "Te veel pogingen. Probeer het over {{minutes}} minuten opnieuw.",
    tooManyAttempts_one: "Te veel pogingen. Probeer het over {{minutes}} minuut opnieuw.",
  },
  de: {
    credentials: "E-Mail oder Passwort ist falsch.",
    emailNotVerified: "Bestätige zuerst deine E-Mail-Adresse mit dem Code, den wir dir geschickt haben, und melde dich dann an.",
    deletionPending: "Dieses Konto wird gerade gelöscht und kann sich nicht mehr anmelden.",
    timeout: "Der SpaceFleet-Server hat nicht rechtzeitig geantwortet. Prüfe deine Verbindung und versuch es nochmal.",
    unreachable: "Der SpaceFleet-Server ist nicht erreichbar. Prüfe deine Verbindung und versuch es nochmal.",
    serverError: "Beim SpaceFleet-Server ist ein Problem aufgetreten. Versuch es in ein paar Minuten nochmal.",
    unknown: "Die Anmeldung hat nicht geklappt. Versuch es nochmal.",
    invalidCode: "Ungültiger Bestätigungscode. Versuch es nochmal.",
    tooManyAttempts: "Zu viele Versuche. Versuch es in {{minutes}} Minuten nochmal.",
    tooManyAttempts_one: "Zu viele Versuche. Versuch es in {{minutes}} Minute nochmal.",
  },
  es: {
    credentials: "El correo electrónico o la contraseña no son correctos.",
    emailNotVerified: "Primero confirma tu dirección de correo con el código que te enviamos y luego inicia sesión.",
    deletionPending: "Esta cuenta se está eliminando y ya no puede iniciar sesión.",
    timeout: "El servidor de SpaceFleet no respondió a tiempo. Revisa tu conexión y vuelve a intentarlo.",
    unreachable: "No se puede conectar con el servidor de SpaceFleet. Revisa tu conexión y vuelve a intentarlo.",
    serverError: "El servidor de SpaceFleet tuvo un problema. Vuelve a intentarlo en unos minutos.",
    unknown: "No se pudo iniciar sesión. Vuelve a intentarlo.",
    invalidCode: "Código de verificación no válido. Vuelve a intentarlo.",
    tooManyAttempts: "Demasiados intentos. Vuelve a intentarlo en {{minutes}} minutos.",
    tooManyAttempts_one: "Demasiados intentos. Vuelve a intentarlo en {{minutes}} minuto.",
  },
};

/** Puts {@link signInErrorTexts} into an i18next translation tree as `login.errors`, keeping the tree's other keys. */
export const withSignInErrorTexts = <T extends Record<string, unknown>>(translation: T, language: SignInErrorLanguage): T => {
  const login = translation.login;
  return {
    ...translation,
    login: { ...(login && typeof login === "object" ? login : {}), errors: signInErrorTexts[language] },
  };
};

/**
 * The sentence a failed sign-in shows, for apps with their own string tables (no i18next): the "too many attempts"
 * sentence in its singular or plural form with `minutes` filled in ({@link retryAfterMinutes}).
 */
export const signInErrorText = (
  language: SignInErrorLanguage,
  message: SignInErrorMessage,
  minutes: number = RATE_LIMIT_DEFAULT_MINUTES,
): string => {
  const texts = signInErrorTexts[language];
  // In every app language, only exactly 1 takes the singular among whole minutes of 1 or more.
  const text = message === "tooManyAttempts" && minutes === 1 ? texts.tooManyAttempts_one : texts[message];
  return text.replace("{{minutes}}", String(minutes));
};

/** Loggable details of a sign-in error (status, API error code, message), never the credentials. */
export const signInErrorDetails = (err: unknown): Record<string, unknown> =>
  err instanceof ApiError
    ? { status: err.status, error: err.payload?.error ?? null }
    : { error: describeError(err) };
