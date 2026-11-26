/**
 * The words every app's notices share, in every app language (UX-NOTICE-13, UX-I18N-01): the bell and its history,
 * the default titles of each level (never English-only), the TV hints, job and account news, and the setting for the
 * computer's system notifications. Apps with i18next merge them under `notify` (`withNotifyTexts`); apps without it,
 * and the Kodi and Jellyfin string files, read them with `notifyTranslator`. Product names are never translated.
 *
 * The bell's wording is the computer apps' (Chris's reference look), moved here from Badger's `nav.notifications`.
 */
import { pluralCategory } from "@space/shared/pluralRules";
import type { DeviceKind, NoticeLevel, NoticePart, NoticeVars, TextVars } from "./kinds";

export const NOTIFY_LANGUAGES = ["en", "fr", "nl", "de", "es"] as const;
export type NotifyLanguage = (typeof NOTIFY_LANGUAGES)[number];

type LevelTexts = Record<NoticeLevel, string>;

export type NotifyTexts = {
  bell: string;
  title: string;
  unread_one: string;
  unread_other: string;
  unread_many: string;
  /** The tray's subtitle: how many entries the history holds. */
  recent_one: string;
  recent_other: string;
  recent_many: string;
  empty: string;
  open: string;
  close: string;
  markAllRead: string;
  clearAll: string;
  remove: string;
  filterAll: string;
  filterUnread: string;
  filter: LevelTexts;
  defaultTitle: LevelTexts;
  tv: { openOrClose: string; oneTime: string; settingsRow: string };
  job: {
    importDone: string;
    importFailed: string;
    downloadDone: string;
    downloadFailed: string;
    jobDone: string;
    jobFailed: string;
    openJobs: string;
  };
  account: {
    newDevice: string;
    newDeviceMessage: string;
    paymentReceived: string;
    paymentFailed: string;
    storageNearLimit: string;
    storageOverLimit: string;
    unpaid: string;
    unnamedDevice: string;
    /** A device's kind, as the account's device list names it (ACCT-DEV-01). */
    deviceType: Record<DeviceKind, string>;
    openDevices: string;
    openBilling: string;
    openStorage: string;
  };
  system: { hiddenJobsSetting: string; hiddenJobsHint: string };
};

const en: NotifyTexts = {
  bell: "Notifications",
  title: "Notifications",
  unread_one: "{{count}} unread",
  unread_other: "{{count}} unread",
  unread_many: "{{count}} unread",
  recent_one: "{{count}} recent item",
  recent_other: "{{count}} recent items",
  recent_many: "{{count}} recent items",
  empty: "No notifications yet.",
  open: "Open",
  close: "Close",
  markAllRead: "Mark all as read",
  clearAll: "Clear all",
  remove: "Remove",
  filterAll: "All",
  filterUnread: "Unread",
  filter: { info: "Info", success: "Success", warning: "Warning", error: "Error" },
  defaultTitle: { info: "Info", success: "Success", warning: "Warning", error: "Error" },
  tv: { openOrClose: "OK opens · Back closes", oneTime: "Press OK or Back to close", settingsRow: "Notifications" },
  job: {
    importDone: "Import finished",
    importFailed: "Import failed",
    downloadDone: "Download ready",
    downloadFailed: "Download failed",
    jobDone: "Job finished",
    jobFailed: "Job failed",
    openJobs: "Open Jobs",
  },
  account: {
    newDevice: "New device added",
    newDeviceMessage: "{{name}} ({{type}})",
    paymentReceived: "Payment received",
    paymentFailed: "Payment failed",
    storageNearLimit: "Storage almost full",
    storageOverLimit: "Over your storage limit",
    unpaid: "Subscription unpaid",
    unnamedDevice: "Unnamed device",
    deviceType: { desktop: "Computer", mobile: "Phone", tv: "TV", kodi: "Kodi", jellyfin: "Jellyfin server", web: "Web browser", other: "Device" },
    openDevices: "See devices",
    openBilling: "See billing",
    openStorage: "See storage",
  },
  system: {
    hiddenJobsSetting: "Notify me when a job ends while the app is hidden",
    hiddenJobsHint: "Shows a system notification when an import or download finishes or fails while the window is minimised or in the tray.",
  },
};

const fr: NotifyTexts = {
  bell: "Notifications",
  title: "Notifications",
  unread_one: "{{count}} non lue",
  unread_other: "{{count}} non lues",
  unread_many: "{{count}} non lues",
  recent_one: "{{count}} élément récent",
  recent_other: "{{count}} éléments récents",
  recent_many: "{{count}} éléments récents",
  empty: "Aucune notification pour le moment.",
  open: "Ouvrir",
  close: "Fermer",
  markAllRead: "Tout marquer comme lu",
  clearAll: "Tout effacer",
  remove: "Supprimer",
  filterAll: "Tout",
  filterUnread: "Non lues",
  filter: { info: "Info", success: "Succès", warning: "Alerte", error: "Erreur" },
  defaultTitle: { info: "Info", success: "Succès", warning: "Alerte", error: "Erreur" },
  tv: { openOrClose: "OK ouvre · Retour ferme", oneTime: "Appuyez sur OK ou Retour pour fermer", settingsRow: "Notifications" },
  job: {
    importDone: "Import terminé",
    importFailed: "Échec de l’import",
    downloadDone: "Téléchargement prêt",
    downloadFailed: "Échec du téléchargement",
    jobDone: "Tâche terminée",
    jobFailed: "Échec de la tâche",
    openJobs: "Ouvrir les tâches",
  },
  account: {
    newDevice: "Nouvel appareil ajouté",
    newDeviceMessage: "{{name}} ({{type}})",
    paymentReceived: "Paiement reçu",
    paymentFailed: "Échec du paiement",
    storageNearLimit: "Stockage presque plein",
    storageOverLimit: "Limite de stockage dépassée",
    unpaid: "Abonnement impayé",
    unnamedDevice: "Appareil sans nom",
    deviceType: { desktop: "Ordinateur", mobile: "Téléphone", tv: "TV", kodi: "Kodi", jellyfin: "Serveur Jellyfin", web: "Navigateur web", other: "Appareil" },
    openDevices: "Voir les appareils",
    openBilling: "Voir la facturation",
    openStorage: "Voir le stockage",
  },
  system: {
    hiddenJobsSetting: "Me prévenir quand une tâche se termine pendant que l’app est masquée",
    hiddenJobsHint:
      "Affiche une notification du système quand un import ou un téléchargement se termine ou échoue alors que la fenêtre est réduite ou dans la barre des tâches.",
  },
};

const nl: NotifyTexts = {
  bell: "Meldingen",
  title: "Meldingen",
  unread_one: "{{count}} ongelezen",
  unread_other: "{{count}} ongelezen",
  unread_many: "{{count}} ongelezen",
  recent_one: "{{count}} recent item",
  recent_other: "{{count}} recente items",
  recent_many: "{{count}} recente items",
  empty: "Nog geen meldingen.",
  open: "Openen",
  close: "Sluiten",
  markAllRead: "Alles als gelezen markeren",
  clearAll: "Alles wissen",
  remove: "Verwijderen",
  filterAll: "Alle",
  filterUnread: "Ongelezen",
  filter: { info: "Info", success: "Gelukt", warning: "Waarschuwing", error: "Fout" },
  defaultTitle: { info: "Info", success: "Gelukt", warning: "Waarschuwing", error: "Fout" },
  tv: { openOrClose: "OK opent · Terug sluit", oneTime: "Druk op OK of Terug om te sluiten", settingsRow: "Meldingen" },
  job: {
    importDone: "Importeren voltooid",
    importFailed: "Importeren mislukt",
    downloadDone: "Download klaar",
    downloadFailed: "Download mislukt",
    jobDone: "Taak voltooid",
    jobFailed: "Taak mislukt",
    openJobs: "Taken openen",
  },
  account: {
    newDevice: "Nieuw apparaat toegevoegd",
    newDeviceMessage: "{{name}} ({{type}})",
    paymentReceived: "Betaling ontvangen",
    paymentFailed: "Betaling mislukt",
    storageNearLimit: "Opslag bijna vol",
    storageOverLimit: "Opslaglimiet overschreden",
    unpaid: "Abonnement niet betaald",
    unnamedDevice: "Naamloos apparaat",
    deviceType: { desktop: "Computer", mobile: "Telefoon", tv: "Tv", kodi: "Kodi", jellyfin: "Jellyfin-server", web: "Webbrowser", other: "Apparaat" },
    openDevices: "Apparaten bekijken",
    openBilling: "Facturatie bekijken",
    openStorage: "Opslag bekijken",
  },
  system: {
    hiddenJobsSetting: "Meld het als een taak klaar is terwijl de app verborgen is",
    hiddenJobsHint: "Toont een systeemmelding als een import of download klaar is of mislukt terwijl het venster geminimaliseerd of in het systeemvak staat.",
  },
};

const de: NotifyTexts = {
  bell: "Benachrichtigungen",
  title: "Benachrichtigungen",
  unread_one: "{{count}} ungelesen",
  unread_other: "{{count}} ungelesen",
  unread_many: "{{count}} ungelesen",
  recent_one: "{{count}} neuer Eintrag",
  recent_other: "{{count}} neue Einträge",
  recent_many: "{{count}} neue Einträge",
  empty: "Noch keine Benachrichtigungen.",
  open: "Öffnen",
  close: "Schließen",
  markAllRead: "Alle als gelesen markieren",
  clearAll: "Alle löschen",
  remove: "Entfernen",
  filterAll: "Alle",
  filterUnread: "Ungelesen",
  filter: { info: "Info", success: "Erfolg", warning: "Warnung", error: "Fehler" },
  defaultTitle: { info: "Info", success: "Erfolg", warning: "Warnung", error: "Fehler" },
  tv: { openOrClose: "OK öffnet · Zurück schließt", oneTime: "Zum Schließen OK oder Zurück drücken", settingsRow: "Benachrichtigungen" },
  job: {
    importDone: "Import abgeschlossen",
    importFailed: "Import fehlgeschlagen",
    downloadDone: "Download bereit",
    downloadFailed: "Download fehlgeschlagen",
    jobDone: "Auftrag abgeschlossen",
    jobFailed: "Auftrag fehlgeschlagen",
    openJobs: "Aufträge öffnen",
  },
  account: {
    newDevice: "Neues Gerät hinzugefügt",
    newDeviceMessage: "{{name}} ({{type}})",
    paymentReceived: "Zahlung erhalten",
    paymentFailed: "Zahlung fehlgeschlagen",
    storageNearLimit: "Speicher fast voll",
    storageOverLimit: "Speicherlimit überschritten",
    unpaid: "Abo nicht bezahlt",
    unnamedDevice: "Unbenanntes Gerät",
    deviceType: { desktop: "Computer", mobile: "Handy", tv: "Fernseher", kodi: "Kodi", jellyfin: "Jellyfin-Server", web: "Webbrowser", other: "Gerät" },
    openDevices: "Geräte ansehen",
    openBilling: "Abrechnung ansehen",
    openStorage: "Speicher ansehen",
  },
  system: {
    hiddenJobsSetting: "Benachrichtigen, wenn ein Auftrag endet, während die App ausgeblendet ist",
    hiddenJobsHint:
      "Zeigt eine Systembenachrichtigung, wenn ein Import oder Download fertig ist oder fehlschlägt, während das Fenster minimiert oder im Infobereich ist.",
  },
};

const es: NotifyTexts = {
  bell: "Notificaciones",
  title: "Notificaciones",
  unread_one: "{{count}} sin leer",
  unread_other: "{{count}} sin leer",
  unread_many: "{{count}} sin leer",
  recent_one: "{{count}} elemento reciente",
  recent_other: "{{count}} elementos recientes",
  recent_many: "{{count}} elementos recientes",
  empty: "Aún no hay notificaciones.",
  open: "Abrir",
  close: "Cerrar",
  markAllRead: "Marcar todo como leído",
  clearAll: "Borrar todo",
  remove: "Eliminar",
  filterAll: "Todas",
  filterUnread: "Sin leer",
  filter: { info: "Información", success: "Éxito", warning: "Advertencia", error: "Error" },
  defaultTitle: { info: "Información", success: "Éxito", warning: "Advertencia", error: "Error" },
  tv: { openOrClose: "OK abre · Atrás cierra", oneTime: "Pulsa OK o Atrás para cerrar", settingsRow: "Notificaciones" },
  job: {
    importDone: "Importación terminada",
    importFailed: "La importación falló",
    downloadDone: "Descarga lista",
    downloadFailed: "La descarga falló",
    jobDone: "Tarea terminada",
    jobFailed: "La tarea falló",
    openJobs: "Abrir tareas",
  },
  account: {
    newDevice: "Nuevo dispositivo añadido",
    newDeviceMessage: "{{name}} ({{type}})",
    paymentReceived: "Pago recibido",
    paymentFailed: "El pago falló",
    storageNearLimit: "Almacenamiento casi lleno",
    storageOverLimit: "Límite de almacenamiento superado",
    unpaid: "Suscripción sin pagar",
    unnamedDevice: "Dispositivo sin nombre",
    deviceType: { desktop: "Computadora", mobile: "Teléfono", tv: "TV", kodi: "Kodi", jellyfin: "Servidor Jellyfin", web: "Navegador web", other: "Dispositivo" },
    openDevices: "Ver dispositivos",
    openBilling: "Ver facturación",
    openStorage: "Ver almacenamiento",
  },
  system: {
    hiddenJobsSetting: "Avisarme cuando una tarea termine con la app oculta",
    hiddenJobsHint: "Muestra una notificación del sistema cuando una importación o descarga termina o falla con la ventana minimizada o en la bandeja.",
  },
};

export const notifyTexts: Record<NotifyLanguage, NotifyTexts> = { en, fr, nl, de, es };

/** The notify language of an app language tag (`fr-BE` → `fr`); English for any other. */
export const notifyLanguage = (tag: string | null | undefined): NotifyLanguage => {
  const base = (tag ?? "").toLowerCase().split(/[-_]/)[0];
  return NOTIFY_LANGUAGES.find((lang) => lang === base) ?? "en";
};

/** An app's i18next translation with the shared texts under `notify` (the `profiles` pattern). */
export const withNotifyTexts = <T extends Record<string, unknown>>(translation: T, language: NotifyLanguage): T & { notify: NotifyTexts } => ({
  ...translation,
  notify: notifyTexts[language],
});

export type Translate = (key: string, vars?: TextVars) => string;

const fill = (text: string, vars: TextVars) => text.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(vars[name] ?? ""));

/**
 * The `t` of the shared texts for an app without i18next (and the Kodi / Jellyfin string files): `notify.*` keys with
 * `{{var}}` values; a `count` picks the `_one` / `_many` / `_other` form like i18next. An unknown key comes back as is.
 */
export const notifyTranslator =
  (language: NotifyLanguage): Translate =>
  (key, vars = {}) => {
    const path = key.replace(/^notify\./, "").split(".");
    const texts: unknown = notifyTexts[language];
    const lookup = (parts: string[]) =>
      parts.reduce<unknown>((node, part) => (typeof node === "object" && node !== null && part in node ? Reflect.get(node, part) : undefined), texts);
    let found = lookup(path);
    if (typeof found !== "string" && typeof vars.count === "number") {
      const leaf = path[path.length - 1];
      const category = pluralCategory(language, vars.count);
      found = lookup([...path.slice(0, -1), `${leaf}_${category}`]) ?? lookup([...path.slice(0, -1), `${leaf}_other`]);
    }
    return typeof found === "string" ? fill(found, vars) : key;
  };

const plainVars = (t: Translate, vars: NoticeVars): TextVars =>
  Object.fromEntries(Object.entries(vars).map(([name, value]) => [name, typeof value === "object" ? t(value.key, value.vars) : value]));

/** A notice's words in the language of `t`: a text key is translated, plain text is shown as it is; a value that is a text key is translated first. */
export const partText = (t: Translate, part: NoticePart | undefined): string => {
  if (part === undefined) return "";
  if (typeof part === "string") return part;
  return part.vars ? t(part.key, plainVars(t, part.vars)) : t(part.key);
};

/** The title shown for a notice: its own, else its level's translated default (no English-only title, UX-NOTICE-13). */
export const titleText = (t: Translate, notice: { title?: NoticePart; level: NoticeLevel }): string =>
  notice.title === undefined ? t(`notify.defaultTitle.${notice.level}`) : partText(t, notice.title);
