/**
 * ACCT-UNPAID-05, UX-NOTICE-08: the unpaid sign's words for the apps whose strings are not i18next catalogues (Parrot
 * desktop, the Badger and Parrot web players). The sign shows one or two words; its accessible label and tooltip carry
 * the whole notice: the plan ended, playback and uploads are stopped, the files are deleted on the wipe date. The same
 * words as the phone and TV sign (`@space/mobile-shell` `account.access.unpaidSign`/`unpaidBanner`). Nothing here
 * points to payment, so a surface that may not (ACCT-PAY-02, a web player without account management) can use it as is.
 *
 * `access` comes from the app's own `/auth/me` read; it is judged against the clock here (`resolveEffectiveAccess`),
 * so a paid period that ended since the read already shows the sign.
 */
import type { AccountAccess } from "./accountAccess";
import { formatAccessDate, resolveEffectiveAccess } from "./effectiveAccess";
import type { ClientUiLanguage } from "./i18n";

export type UnpaidAccessSignText = {
  /** The words on screen. */
  sign: string;
  /** The whole notice: accessible label and tooltip. */
  message: string;
  wipeAt: string | null;
};

type Words = { sign: string; notice: (date: string) => string; noticeNoDate: string };

const WORDS: Record<ClientUiLanguage, Words> = {
  en: {
    sign: "Plan ended",
    notice: (date) => `Your subscription ended. Playback and uploads are stopped. Your files are deleted on ${date}.`,
    noticeNoDate: "Your subscription ended. Playback and uploads are stopped. Your files will be deleted after a limited time.",
  },
  fr: {
    sign: "Abonnement terminé",
    notice: (date) => `Votre abonnement est terminé. La lecture et les envois sont arrêtés. Vos fichiers seront supprimés le ${date}.`,
    noticeNoDate:
      "Votre abonnement est terminé. La lecture et les envois sont arrêtés. Vos fichiers seront supprimés après un délai limité.",
  },
  nl: {
    sign: "Abonnement beëindigd",
    notice: (date) => `Je abonnement is beëindigd. Afspelen en uploaden zijn gestopt. Je bestanden worden verwijderd op ${date}.`,
    noticeNoDate: "Je abonnement is beëindigd. Afspelen en uploaden zijn gestopt. Je bestanden worden na een beperkte tijd verwijderd.",
  },
  de: {
    sign: "Tarif abgelaufen",
    notice: (date) => `Dein Tarif ist abgelaufen. Wiedergabe und Uploads sind gestoppt. Deine Dateien werden am ${date} gelöscht.`,
    noticeNoDate: "Dein Tarif ist abgelaufen. Wiedergabe und Uploads sind gestoppt. Deine Dateien werden nach einer begrenzten Zeit gelöscht.",
  },
  es: {
    sign: "Suscripción terminada",
    notice: (date) => `Tu suscripción ha terminado. La reproducción y las subidas están detenidas. Tus archivos se eliminarán el ${date}.`,
    noticeNoDate:
      "Tu suscripción ha terminado. La reproducción y las subidas están detenidas. Tus archivos se eliminarán pasado un tiempo limitado.",
  },
};

/** The sign for an unpaid account, or null while the account is paid (or its access is unknown). */
export const unpaidAccessSignText = (
  access: AccountAccess | null | undefined,
  language: ClientUiLanguage,
  now: number = Date.now()
): UnpaidAccessSignText | null => {
  const effective = resolveEffectiveAccess(access, now);
  if (effective?.state !== "unpaid") return null;
  const words = WORDS[language];
  const date = formatAccessDate(effective.wipeAt, language);
  return { sign: words.sign, message: date ? words.notice(date) : words.noticeNoDate, wipeAt: effective.wipeAt };
};
