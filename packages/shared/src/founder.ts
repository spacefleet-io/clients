/**
 * Founder status as every client shows it (WAIT-FOUND-01, WAIT-FOUND-04): the API contract of `GET /account/founder`
 * and `POST /account/founder/notice-seen`, and the one copy every surface uses (web, Badger and Parrot on desktop,
 * phone and TV), so the banner and the badge read the same everywhere. Product names are never translated (UX-I18N-13).
 *
 * WAIT-FOUND-03: the API answers `founder: false` until the account's email is verified, so typing an address never
 * tells anyone whether it belongs to a founder.
 */
import type { AccountLanguage } from "./i18n";

export const FOUNDER_STATUS_PATH = "/account/founder";
export const FOUNDER_NOTICE_SEEN_PATH = "/account/founder/notice-seen";

/** `GET /account/founder`. */
export type FounderStatusResponse = {
  /** The verified account holds a founder place (its own, or one it just claimed by its email). */
  founder: boolean;
  /** When the place was earned: the waitlist confirmation date, else when the account got it (ISO), null when not a founder. */
  since: string | null;
  /** The one-time "Founder ticket recognised" banner is still to show (claimed, never marked seen on any device). */
  noticePending: boolean;
};

export type FounderCopy = {
  /** Banner, bold part. */
  bannerTitle: string;
  /** Banner, rest of the line. */
  bannerBody: string;
  /** Banner close control (accessibility label and button text). */
  bannerDismiss: string;
  /** Settings badge label. */
  badge: string;
  /** Settings badge detail; `{date}` is the localized `since` date. */
  badgeSince: string;
  /** Under a struck list price on a plan screen. */
  priceLabel: string;
};

export const FOUNDER_COPY: Record<AccountLanguage, FounderCopy> = {
  en: {
    bannerTitle: "Founder ticket recognised.",
    bannerBody: "Your 30% for life is applied to your plan.",
    bannerDismiss: "Got it",
    badge: "Founder",
    badgeSince: "since the waitlist, {date}",
    priceLabel: "Founder price, −30% for life",
  },
  fr: {
    bannerTitle: "Remise fondateur reconnue.",
    bannerBody: "Vos −30 % à vie s'appliquent à votre offre.",
    bannerDismiss: "J'ai compris",
    badge: "Fondateur",
    badgeSince: "depuis la liste d'attente, {date}",
    priceLabel: "Prix fondateur, −30 % à vie",
  },
  nl: {
    bannerTitle: "Founderticket herkend.",
    bannerBody: "Je 30% korting voor altijd geldt voor je abonnement.",
    bannerDismiss: "Begrepen",
    badge: "Founder",
    badgeSince: "sinds de wachtlijst, {date}",
    priceLabel: "Founderprijs, −30% voor altijd",
  },
  de: {
    bannerTitle: "Gründerticket erkannt.",
    bannerBody: "Deine 30 % Rabatt auf Lebenszeit gelten für dein Abo.",
    bannerDismiss: "Verstanden",
    badge: "Gründer",
    badgeSince: "seit der Warteliste, {date}",
    priceLabel: "Gründerpreis, −30 % auf Lebenszeit",
  },
  es: {
    bannerTitle: "Ticket de fundador reconocido.",
    bannerBody: "Tu 30 % de descuento de por vida se aplica a tu plan.",
    bannerDismiss: "Entendido",
    badge: "Fundador",
    badgeSince: "desde la lista de espera, {date}",
    priceLabel: "Precio de fundador, −30 % de por vida",
  },
};

/** The copy for a UI language; any language the account cannot hold reads English. */
export const founderCopy = (language: string | null | undefined): FounderCopy =>
  FOUNDER_COPY[(language ?? "en") as AccountLanguage] ?? FOUNDER_COPY.en;

/** The badge detail with the `since` date formatted for `language` (day, month name, year), or null without a date. */
export const founderSinceText = (language: string | null | undefined, since: string | null): string | null => {
  if (!since) return null;
  const date = new Date(since);
  if (Number.isNaN(date.getTime())) return null;
  const formatted = date.toLocaleDateString(language ?? "en", { day: "numeric", month: "long", year: "numeric" });
  return founderCopy(language).badgeSince.replace("{date}", formatted);
};
