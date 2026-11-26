/**
 * ACCT-UNPAID-06: an unpaid account cannot set up its first library. The API keeps refusing the library's first
 * publish with 402 `{ error: "subscription_unpaid", wipeAt }` (ACCT-UNPAID-01); every app's setup recognises that
 * answer at the step that creates the library and shows one clear screen instead of an error: the plan has ended, the
 * library can be set up once it is renewed. The computers offer Renew there (ACCT-UNPAID-04); the phone and TV only
 * inform (ACCT-PAY-02), with nothing pointing to payment. After a renewal, setup goes on from that step ("Try again").
 *
 * The refusal reaches the setup in several shapes: an `ApiError`/`StorageTunnelError` with `status` 402 in the process
 * that called (Parrot desktop's main, the phone), or only its message once it crossed Electron's IPC (Badger desktop:
 * "Error invoking remote method 'sf-library-db-open': Error: subscription_unpaid"). `isUnpaidLibrarySetupRefusal`
 * reads all of them; a caller that also knows the account's `access` passes it, so an unpaid account whose refusal
 * came back in another shape still gets this screen (a library can never be created while unpaid).
 */
import type { AccountAccess } from "./accountAccess";
import { isAccessUnpaid } from "./effectiveAccess";
import type { ClientUiLanguage } from "./i18n";
import { LIBRARY_NOUN, type KeySavedWarningApp } from "./keySavedWarning";
import { SUBSCRIPTION_UNPAID_CODE, isSubscriptionUnpaidError } from "./subscriptionUnpaid";

const UNPAID_IN_MESSAGE = new RegExp(`\\b${SUBSCRIPTION_UNPAID_CODE}\\b`);

const messageOf = (err: unknown): string => {
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err && typeof err.message === "string") return err.message;
  return "";
};

/** Whether a failed library creation was the API's unpaid refusal (see the module comment for the shapes). */
export const isUnpaidLibrarySetupRefusal = (
  err: unknown,
  access?: AccountAccess | null,
  now: number = Date.now()
): boolean =>
  isSubscriptionUnpaidError(err) ||
  UNPAID_IN_MESSAGE.test(messageOf(err)) ||
  isAccessUnpaid(access, now);

/** Where the screen shows: a computer offers Renew; a phone or TV only informs (ACCT-PAY-02). */
export type UnpaidLibrarySetupSurface = "computer" | "phone";

export type UnpaidLibrarySetupText = {
  title: string;
  body: string;
  /** Computer only: the Renew button and its busy label. */
  renew: string;
  renewing: string;
  /** Runs the library step again: setup goes on once the plan is renewed. */
  tryAgain: string;
  /** Said after "Try again" while the plan is still not renewed. */
  notRenewed: string;
};

type Words = Omit<UnpaidLibrarySetupText, "body"> & { body: Record<UnpaidLibrarySetupSurface, string> };

const TEXT: Record<ClientUiLanguage, (library: string) => Words> = {
  en: (library) => ({
    title: "Your plan has ended",
    body: {
      computer: `Your ${library} can be set up once your plan is renewed. Renew it here and setup goes on from this step.`,
      phone: `Your ${library} can be set up once your plan is renewed. Setup then goes on from this step.`,
    },
    renew: "Renew",
    renewing: "Renewing…",
    tryAgain: "Try again",
    notRenewed: "Your plan is not renewed yet.",
  }),
  fr: (library) => ({
    title: "Votre abonnement est terminé",
    body: {
      computer: `Votre ${library} pourra être créée une fois l'abonnement renouvelé. Renouvelez-le ici et la configuration reprendra à cette étape.`,
      phone: `Votre ${library} pourra être créée une fois l'abonnement renouvelé. La configuration reprendra ensuite à cette étape.`,
    },
    renew: "Renouveler",
    renewing: "Renouvellement…",
    tryAgain: "Réessayer",
    notRenewed: "L'abonnement n'est pas encore renouvelé.",
  }),
  nl: (library) => ({
    title: "Je abonnement is beëindigd",
    body: {
      computer: `Je ${library} kan worden aangemaakt zodra je abonnement is verlengd. Verleng het hier en de installatie gaat verder vanaf deze stap.`,
      phone: `Je ${library} kan worden aangemaakt zodra je abonnement is verlengd. De installatie gaat daarna verder vanaf deze stap.`,
    },
    renew: "Verlengen",
    renewing: "Bezig met verlengen…",
    tryAgain: "Opnieuw proberen",
    notRenewed: "Je abonnement is nog niet verlengd.",
  }),
  de: (library) => ({
    title: "Dein Tarif ist abgelaufen",
    body: {
      computer: `Deine ${library} kann eingerichtet werden, sobald dein Tarif verlängert ist. Verlängere ihn hier, dann geht die Einrichtung bei diesem Schritt weiter.`,
      phone: `Deine ${library} kann eingerichtet werden, sobald dein Tarif verlängert ist. Die Einrichtung geht danach bei diesem Schritt weiter.`,
    },
    renew: "Verlängern",
    renewing: "Wird verlängert…",
    tryAgain: "Erneut versuchen",
    notRenewed: "Dein Tarif ist noch nicht verlängert.",
  }),
  es: (library) => ({
    title: "Tu suscripción ha terminado",
    body: {
      computer: `Podrás crear tu ${library} en cuanto renueves la suscripción. Renuévala aquí y la configuración seguirá desde este paso.`,
      phone: `Podrás crear tu ${library} cuando la suscripción esté renovada. La configuración seguirá después desde este paso.`,
    },
    renew: "Renovar",
    renewing: "Renovando…",
    tryAgain: "Reintentar",
    notRenewed: "Tu suscripción aún no está renovada.",
  }),
};

export const unpaidLibrarySetupText = (
  language: ClientUiLanguage,
  app: KeySavedWarningApp,
  surface: UnpaidLibrarySetupSurface
): UnpaidLibrarySetupText => {
  const words = TEXT[language](LIBRARY_NOUN[app][language]);
  return { ...words, body: words.body[surface] };
};
