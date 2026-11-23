import { isClientUiLanguage, type ClientUiLanguage } from "@space/shared/i18n";

/**
 * Every sentence of Settings › "About & updates" (REL-UPD-05) and of the update-required screen around it (REL-CD-29,
 * `required*`), shared by Badger and Parrot desktop in the five app languages. `{app}` is the product name,
 * `{version}`, `{time}` and `{percent}` are filled in by `updateSectionText`.
 * A failure never shows the updater's raw message (the main process logs it): `updateErrorKey` picks one of the plain
 * `error*` sentences.
 */
export type UpdateSectionStringKey =
  | "title"
  | "version"
  | "notChecked"
  | "upToDate"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "errorNetwork"
  | "errorIntegrity"
  | "errorDisk"
  | "errorOther"
  | "unsupported"
  | "check"
  | "download"
  | "restart"
  | "autoLabel"
  | "autoHint"
  | "requiredTitle"
  | "requiredBody";

export const updateSectionStrings: Record<ClientUiLanguage, Record<UpdateSectionStringKey, string>> = {
  en: {
    title: "About & updates",
    version: "Version {version}",
    notChecked: "Not checked for updates yet.",
    upToDate: "{app} is up to date · checked {time}",
    checking: "Checking for updates…",
    available: "Version {version} is available.",
    downloading: "Downloading version {version}… {percent}%",
    ready: "Version {version} is ready to install. It installs when {app} restarts.",
    errorNetwork: "Couldn't reach the update server. Try again later.",
    errorIntegrity: "The downloaded update didn't pass its safety check, so it wasn't installed. Try again later.",
    errorDisk: "There isn't enough free disk space to download the update.",
    errorOther: "The update didn't work. Try again later.",
    unsupported: "This copy of {app} doesn't update itself: install new versions from where you got it.",
    check: "Check for updates",
    download: "Download update",
    restart: "Restart to update",
    autoLabel: "Update automatically",
    autoHint: "Checks when {app} starts and every 6 hours, downloads in the background and installs when {app} quits.",
    requiredTitle: "Update {app} to keep using it",
    requiredBody: "This version of {app} is too old to connect. Download the new version, then restart {app}.",
  },
  fr: {
    title: "À propos et mises à jour",
    version: "Version {version}",
    notChecked: "Aucune recherche de mise à jour pour l'instant.",
    upToDate: "{app} est à jour · vérifié à {time}",
    checking: "Recherche de mises à jour…",
    available: "La version {version} est disponible.",
    downloading: "Téléchargement de la version {version}… {percent} %",
    ready: "La version {version} est prête. Elle s'installe au redémarrage de {app}.",
    errorNetwork: "Impossible de joindre le serveur de mises à jour. Réessayez plus tard.",
    errorIntegrity: "La mise à jour téléchargée n'a pas passé la vérification de sécurité, elle n'a pas été installée. Réessayez plus tard.",
    errorDisk: "Il n'y a pas assez d'espace disque libre pour télécharger la mise à jour.",
    errorOther: "La mise à jour n'a pas abouti. Réessayez plus tard.",
    unsupported: "Cette copie de {app} ne se met pas à jour seule : installez les nouvelles versions depuis l'endroit où vous l'avez obtenue.",
    check: "Rechercher des mises à jour",
    download: "Télécharger la mise à jour",
    restart: "Redémarrer pour mettre à jour",
    autoLabel: "Mettre à jour automatiquement",
    autoHint:
      "Recherche au démarrage de {app} puis toutes les 6 heures, télécharge en arrière-plan et installe à la fermeture de {app}.",
    requiredTitle: "Mettez {app} à jour pour continuer",
    requiredBody: "Cette version de {app} est trop ancienne pour se connecter. Téléchargez la nouvelle version, puis redémarrez {app}.",
  },
  nl: {
    title: "Over en updates",
    version: "Versie {version}",
    notChecked: "Nog niet op updates gecontroleerd.",
    upToDate: "{app} is up-to-date · gecontroleerd om {time}",
    checking: "Zoeken naar updates…",
    available: "Versie {version} is beschikbaar.",
    downloading: "Versie {version} downloaden… {percent}%",
    ready: "Versie {version} is klaar om te installeren. Hij wordt geïnstalleerd wanneer {app} opnieuw start.",
    errorNetwork: "De updateserver is niet bereikbaar. Probeer het later opnieuw.",
    errorIntegrity: "De gedownloade update kwam niet door de veiligheidscontrole en is niet geïnstalleerd. Probeer het later opnieuw.",
    errorDisk: "Er is niet genoeg vrije schijfruimte om de update te downloaden.",
    errorOther: "De update is niet gelukt. Probeer het later opnieuw.",
    unsupported: "Deze kopie van {app} werkt zichzelf niet bij: installeer nieuwe versies vanaf waar je hem hebt gekregen.",
    check: "Zoeken naar updates",
    download: "Update downloaden",
    restart: "Opnieuw starten om bij te werken",
    autoLabel: "Automatisch bijwerken",
    autoHint: "Controleert bij het starten van {app} en elke 6 uur, downloadt op de achtergrond en installeert wanneer {app} sluit.",
    requiredTitle: "Werk {app} bij om verder te gaan",
    requiredBody: "Deze versie van {app} is te oud om verbinding te maken. Download de nieuwe versie en start {app} daarna opnieuw.",
  },
  de: {
    title: "Info & Updates",
    version: "Version {version}",
    notChecked: "Noch nicht nach Updates gesucht.",
    upToDate: "{app} ist auf dem neuesten Stand · geprüft um {time}",
    checking: "Suche nach Updates…",
    available: "Version {version} ist verfügbar.",
    downloading: "Version {version} wird heruntergeladen… {percent} %",
    ready: "Version {version} ist bereit. Sie wird beim Neustart von {app} installiert.",
    errorNetwork: "Der Update-Server ist nicht erreichbar. Versuche es später noch einmal.",
    errorIntegrity: "Das heruntergeladene Update hat die Sicherheitsprüfung nicht bestanden und wurde nicht installiert. Versuche es später noch einmal.",
    errorDisk: "Es ist nicht genug Speicherplatz frei, um das Update herunterzuladen.",
    errorOther: "Das Update hat nicht geklappt. Versuche es später noch einmal.",
    unsupported: "Diese Kopie von {app} aktualisiert sich nicht selbst: Installiere neue Versionen von dort, woher du sie hast.",
    check: "Nach Updates suchen",
    download: "Update herunterladen",
    restart: "Neu starten und aktualisieren",
    autoLabel: "Automatisch aktualisieren",
    autoHint: "Sucht beim Start von {app} und alle 6 Stunden, lädt im Hintergrund herunter und installiert beim Beenden von {app}.",
    requiredTitle: "Aktualisiere {app}, um es weiter zu nutzen",
    requiredBody: "Diese {app}-Version ist zu alt, um sich zu verbinden. Lade die neue Version herunter und starte {app} dann neu.",
  },
  es: {
    title: "Acerca de y actualizaciones",
    version: "Versión {version}",
    notChecked: "Aún no se han buscado actualizaciones.",
    upToDate: "{app} está actualizado · comprobado a las {time}",
    checking: "Buscando actualizaciones…",
    available: "La versión {version} está disponible.",
    downloading: "Descargando la versión {version}… {percent} %",
    ready: "La versión {version} está lista. Se instala cuando {app} se reinicia.",
    errorNetwork: "No se pudo conectar con el servidor de actualizaciones. Inténtalo más tarde.",
    errorIntegrity: "La actualización descargada no superó la comprobación de seguridad y no se instaló. Inténtalo más tarde.",
    errorDisk: "No hay suficiente espacio libre en el disco para descargar la actualización.",
    errorOther: "La actualización no funcionó. Inténtalo más tarde.",
    unsupported: "Esta copia de {app} no se actualiza sola: instala las nuevas versiones desde donde la obtuviste.",
    check: "Buscar actualizaciones",
    download: "Descargar actualización",
    restart: "Reiniciar para actualizar",
    autoLabel: "Actualizar automáticamente",
    autoHint: "Busca al iniciar {app} y cada 6 horas, descarga en segundo plano e instala al cerrar {app}.",
    requiredTitle: "Actualiza {app} para seguir usándolo",
    requiredBody: "Esta versión de {app} es demasiado antigua para conectarse. Descarga la nueva versión y reinicia {app}.",
  },
};

/** The plain sentence for an updater failure, from electron-updater's raw message (which only the log keeps). */
export const updateErrorKey = (message: string | null): Extract<UpdateSectionStringKey, `error${string}`> => {
  const raw = message ?? "";
  if (/ENOSPC|no space left|disk full/i.test(raw)) return "errorDisk";
  if (/sha512|checksum|signature|not signed|signed by|code ?sign/i.test(raw)) return "errorIntegrity";
  if (
    /net::ERR_|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ESOCKETTIMEDOUT|EHOSTUNREACH|ENETUNREACH|getaddrinfo|socket hang up|timed? ?out|HttpError|status ?code|\b[45]\d\d\b|Cannot find (channel|latest)/i.test(
      raw,
    )
  )
    return "errorNetwork";
  return "errorOther";
};

/** `language` is the window's UI language (any string: an unknown one falls back to English). */
export const updateSectionText = (
  language: string,
  key: UpdateSectionStringKey,
  values: Partial<Record<"app" | "version" | "time" | "percent", string | number>> = {},
): string => {
  const base = language.split("-")[0];
  const lang: ClientUiLanguage = isClientUiLanguage(base) ? base : "en";
  return updateSectionStrings[lang][key].replace(/\{(app|version|time|percent)\}/g, (match, name: keyof typeof values) =>
    values[name] === undefined ? match : String(values[name]),
  );
};
