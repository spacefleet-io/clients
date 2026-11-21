import { isClientUiLanguage, type ClientUiLanguage } from "@space/shared/i18n";
import type { SystemUpdateFailure } from "./types";

/**
 * Every sentence of Settings › "About & updates" (REL-UPD-05) and of the update-required screen around it (REL-CD-29,
 * `required*`), shared by Badger and Parrot desktop in the five app languages. `{app}` is the product name,
 * `{version}`, `{time}` and `{percent}` are filled in by `updateSectionText`.
 * A failure never shows the updater's raw message (the main process logs it): `updateErrorKey` picks one of the plain
 * `error*` sentences. `system*`, `install*`, `later`, `close`, `installing`, `installed`, `restartApp`, `manualHint`,
 * `copy*` and `flatpakHint` are the package-manager update (REL-UPD-07): the update modal and the same steps in Settings.
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
  | "errorReadOnly"
  | "errorOther"
  | "unsupported"
  | "check"
  | "download"
  | "restart"
  | "autoLabel"
  | "autoHint"
  | "requiredTitle"
  | "requiredBody"
  | "systemPrompt"
  | "install"
  | "later"
  | "installing"
  | "installed"
  | "restartApp"
  | "autoHintSystem"
  | "autoHintFlatpak"
  | "systemNotNewer"
  | "systemRepoMissing"
  | "systemNeedsSystemUpdate"
  | "systemNetwork"
  | "systemPackageManager"
  | "systemNotAuthorized"
  | "systemNoPasswordDialog"
  | "systemOther"
  | "manualHint"
  | "copy"
  | "copied"
  | "flatpakHint"
  | "systemPromptTitle"
  | "systemFailedTitle"
  | "installNow"
  | "close";

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
    errorReadOnly: "{app} can't update itself from where it runs now (a disk image or the Downloads folder). Move {app} to your Applications folder, open it from there, and it will update itself.",
    errorOther: "The update didn't work. Try again later.",
    unsupported: "This copy of {app} doesn't update itself: install new versions from where you got it.",
    check: "Check for updates",
    download: "Download update",
    restart: "Restart to update",
    autoLabel: "Update automatically",
    autoHint: "Checks when {app} starts and every 6 hours, downloads in the background and installs when {app} quits.",
    requiredTitle: "Update {app} to keep using it",
    requiredBody: "This version of {app} is too old to connect. Download the new version, then restart {app}.",
    systemPrompt: "{app} {version} is available. Install now?",
    install: "Install",
    later: "Later",
    installing: "Installing {app} {version}… Enter your password in the system window if it asks.",
    installed: "{app} {version} is installed. Restarting {app}…",
    restartApp: "Restart {app}",
    autoHintSystem: "Checks when {app} starts and every 6 hours, then asks you before installing with your password.",
    autoHintFlatpak: "Checks when {app} starts and every 6 hours, and tells you when Flatpak has a new version.",
    systemNotNewer: "The package repository doesn't have the new version yet. Try again later.",
    systemRepoMissing: "The SpaceFleet package repository isn't set up on this computer.",
    systemNeedsSystemUpdate: "{app} needs newer system packages first. Update your whole system, then try again.",
    systemNetwork: "Couldn't reach SpaceFleet's update server. Check your connection and try again.",
    systemPackageManager: "The package manager couldn't install the update.",
    systemNotAuthorized: "Your account isn't allowed to install updates.",
    systemNoPasswordDialog: "{app} can't open the system password window here.",
    systemOther: "The update didn't work.",
    manualHint: "To update by hand, run this in a terminal:",
    copy: "Copy",
    copied: "Copied",
    flatpakHint: "{app} {version} is available. Update it from your software centre, or run this in a terminal:",
    systemPromptTitle: "Update available",
    systemFailedTitle: "The update wasn't installed",
    installNow: "Install now",
    close: "Close",
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
    errorReadOnly: "{app} ne peut pas se mettre à jour depuis l'endroit d'où il est lancé (une image disque ou le dossier Téléchargements). Déplacez {app} dans le dossier Applications, ouvrez-le depuis là et il se mettra à jour seul.",
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
    systemPrompt: "{app} {version} est disponible. L'installer maintenant ?",
    install: "Installer",
    later: "Plus tard",
    installing: "Installation de {app} {version}… Saisissez votre mot de passe dans la fenêtre du système s'il est demandé.",
    installed: "{app} {version} est installé. Redémarrage de {app}…",
    restartApp: "Redémarrer {app}",
    autoHintSystem: "Recherche au démarrage de {app} puis toutes les 6 heures, et vous demande avant d'installer avec votre mot de passe.",
    autoHintFlatpak: "Recherche au démarrage de {app} puis toutes les 6 heures, et vous prévient quand Flatpak a une nouvelle version.",
    systemNotNewer: "Le dépôt de paquets n'a pas encore la nouvelle version. Réessayez plus tard.",
    systemRepoMissing: "Le dépôt de paquets SpaceFleet n'est pas configuré sur cet ordinateur.",
    systemNeedsSystemUpdate:
      "{app} a d'abord besoin de paquets système plus récents. Mettez tout le système à jour, puis réessayez.",
    systemNetwork: "Impossible de joindre le serveur de mises à jour de SpaceFleet. Vérifiez votre connexion et réessayez.",
    systemPackageManager: "Le gestionnaire de paquets n'a pas pu installer la mise à jour.",
    systemNotAuthorized: "Votre compte n'a pas le droit d'installer des mises à jour.",
    systemNoPasswordDialog: "{app} ne peut pas ouvrir ici la fenêtre de mot de passe du système.",
    systemOther: "La mise à jour n'a pas abouti.",
    manualHint: "Pour mettre à jour à la main, lancez ceci dans un terminal :",
    copy: "Copier",
    copied: "Copié",
    flatpakHint: "{app} {version} est disponible. Mettez-le à jour depuis votre logithèque, ou lancez ceci dans un terminal :",
    systemPromptTitle: "Mise à jour disponible",
    systemFailedTitle: "La mise à jour n'a pas été installée",
    installNow: "Installer maintenant",
    close: "Fermer",
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
    errorReadOnly: "{app} kan zichzelf niet bijwerken vanaf de plek waar hij nu draait (een schijfkopie of de map Downloads). Zet {app} in je map Programma's, open hem daarvandaan en hij werkt zichzelf bij.",
    errorOther: "De update is niet gelukt. Probeer het later opnieuw.",
    unsupported: "Deze kopie van {app} werkt zichzelf niet bij: installeer nieuwe versies vanaf waar je hem hebt gekregen.",
    check: "Zoeken naar updates",
    download: "Update downloaden",
    restart: "Opnieuw starten om bij te werken",
    autoLabel: "Automatisch bijwerken",
    autoHint: "Controleert bij het starten van {app} en elke 6 uur, downloadt op de achtergrond en installeert wanneer {app} sluit.",
    requiredTitle: "Werk {app} bij om verder te gaan",
    requiredBody: "Deze versie van {app} is te oud om verbinding te maken. Download de nieuwe versie en start {app} daarna opnieuw.",
    systemPrompt: "{app} {version} is beschikbaar. Nu installeren?",
    install: "Installeren",
    later: "Later",
    installing: "{app} {version} wordt geïnstalleerd… Typ je wachtwoord in het systeemvenster als dat wordt gevraagd.",
    installed: "{app} {version} is geïnstalleerd. {app} wordt opnieuw gestart…",
    restartApp: "{app} opnieuw starten",
    autoHintSystem: "Zoekt bij het starten van {app} en elke 6 uur, en vraagt het je voordat het met je wachtwoord installeert.",
    autoHintFlatpak: "Zoekt bij het starten van {app} en elke 6 uur, en laat je weten wanneer Flatpak een nieuwe versie heeft.",
    systemNotNewer: "De pakketbron heeft de nieuwe versie nog niet. Probeer het later opnieuw.",
    systemRepoMissing: "De SpaceFleet-pakketbron is niet ingesteld op deze computer.",
    systemNeedsSystemUpdate: "{app} heeft eerst nieuwere systeempakketten nodig. Werk je hele systeem bij en probeer het opnieuw.",
    systemNetwork: "De updateserver van SpaceFleet is niet bereikbaar. Controleer je verbinding en probeer het opnieuw.",
    systemPackageManager: "De pakketbeheerder kon de update niet installeren.",
    systemNotAuthorized: "Je account mag geen updates installeren.",
    systemNoPasswordDialog: "{app} kan het wachtwoordvenster van het systeem hier niet openen.",
    systemOther: "De update is niet gelukt.",
    manualHint: "Om met de hand bij te werken, voer je dit uit in een terminal:",
    copy: "Kopiëren",
    copied: "Gekopieerd",
    flatpakHint: "{app} {version} is beschikbaar. Werk het bij via je softwarecentrum, of voer dit uit in een terminal:",
    systemPromptTitle: "Update beschikbaar",
    systemFailedTitle: "De update is niet geïnstalleerd",
    installNow: "Nu installeren",
    close: "Sluiten",
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
    errorReadOnly: "{app} kann sich an seinem aktuellen Ort nicht selbst aktualisieren (ein Disk-Image oder der Ordner „Downloads“). Bewege {app} in den Ordner „Programme“, öffne es von dort, dann aktualisiert es sich selbst.",
    errorOther: "Das Update hat nicht geklappt. Versuche es später noch einmal.",
    unsupported: "Diese Kopie von {app} aktualisiert sich nicht selbst: Installiere neue Versionen von dort, woher du sie hast.",
    check: "Nach Updates suchen",
    download: "Update herunterladen",
    restart: "Neu starten und aktualisieren",
    autoLabel: "Automatisch aktualisieren",
    autoHint: "Sucht beim Start von {app} und alle 6 Stunden, lädt im Hintergrund herunter und installiert beim Beenden von {app}.",
    requiredTitle: "Aktualisiere {app}, um es weiter zu nutzen",
    requiredBody: "Diese {app}-Version ist zu alt, um sich zu verbinden. Lade die neue Version herunter und starte {app} dann neu.",
    systemPrompt: "{app} {version} ist verfügbar. Jetzt installieren?",
    install: "Installieren",
    later: "Später",
    installing: "{app} {version} wird installiert… Gib dein Passwort im Systemfenster ein, falls es gefragt wird.",
    installed: "{app} {version} ist installiert. {app} wird neu gestartet…",
    restartApp: "{app} neu starten",
    autoHintSystem: "Sucht beim Start von {app} und alle 6 Stunden und fragt dich, bevor es mit deinem Passwort installiert.",
    autoHintFlatpak: "Sucht beim Start von {app} und alle 6 Stunden und sagt dir, wenn Flatpak eine neue Version hat.",
    systemNotNewer: "Die Paketquelle hat die neue Version noch nicht. Versuch es später noch einmal.",
    systemRepoMissing: "Die SpaceFleet-Paketquelle ist auf diesem Computer nicht eingerichtet.",
    systemNeedsSystemUpdate: "{app} braucht zuerst neuere Systempakete. Aktualisiere das ganze System und versuch es dann noch einmal.",
    systemNetwork: "Der Update-Server von SpaceFleet ist nicht erreichbar. Prüf deine Verbindung und versuch es noch einmal.",
    systemPackageManager: "Die Paketverwaltung konnte das Update nicht installieren.",
    systemNotAuthorized: "Dein Konto darf keine Updates installieren.",
    systemNoPasswordDialog: "{app} kann das Passwortfenster des Systems hier nicht öffnen.",
    systemOther: "Das Update hat nicht funktioniert.",
    manualHint: "Zum Aktualisieren von Hand führe das in einem Terminal aus:",
    copy: "Kopieren",
    copied: "Kopiert",
    flatpakHint: "{app} {version} ist verfügbar. Aktualisiere es in deiner Softwareverwaltung oder führe das in einem Terminal aus:",
    systemPromptTitle: "Update verfügbar",
    systemFailedTitle: "Das Update wurde nicht installiert",
    installNow: "Jetzt installieren",
    close: "Schließen",
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
    errorReadOnly: "{app} no puede actualizarse desde donde se ejecuta ahora (una imagen de disco o la carpeta Descargas). Mueve {app} a la carpeta Aplicaciones, ábrelo desde allí y se actualizará solo.",
    errorOther: "La actualización no funcionó. Inténtalo más tarde.",
    unsupported: "Esta copia de {app} no se actualiza sola: instala las nuevas versiones desde donde la obtuviste.",
    check: "Buscar actualizaciones",
    download: "Descargar actualización",
    restart: "Reiniciar para actualizar",
    autoLabel: "Actualizar automáticamente",
    autoHint: "Busca al iniciar {app} y cada 6 horas, descarga en segundo plano e instala al cerrar {app}.",
    requiredTitle: "Actualiza {app} para seguir usándolo",
    requiredBody: "Esta versión de {app} es demasiado antigua para conectarse. Descarga la nueva versión y reinicia {app}.",
    systemPrompt: "{app} {version} está disponible. ¿Instalar ahora?",
    install: "Instalar",
    later: "Más tarde",
    installing: "Instalando {app} {version}… Escribe tu contraseña en la ventana del sistema si la pide.",
    installed: "{app} {version} está instalado. Reiniciando {app}…",
    restartApp: "Reiniciar {app}",
    autoHintSystem: "Busca al iniciar {app} y cada 6 horas, y te pregunta antes de instalar con tu contraseña.",
    autoHintFlatpak: "Busca al iniciar {app} y cada 6 horas, y te avisa cuando Flatpak tiene una versión nueva.",
    systemNotNewer: "El repositorio de paquetes aún no tiene la nueva versión. Inténtalo más tarde.",
    systemRepoMissing: "El repositorio de paquetes de SpaceFleet no está configurado en este ordenador.",
    systemNeedsSystemUpdate: "{app} necesita antes paquetes del sistema más recientes. Actualiza todo el sistema y vuelve a intentarlo.",
    systemNetwork: "No se pudo conectar con el servidor de actualizaciones de SpaceFleet. Comprueba tu conexión y vuelve a intentarlo.",
    systemPackageManager: "El gestor de paquetes no pudo instalar la actualización.",
    systemNotAuthorized: "Tu cuenta no tiene permiso para instalar actualizaciones.",
    systemNoPasswordDialog: "{app} no puede abrir aquí la ventana de contraseña del sistema.",
    systemOther: "La actualización no ha funcionado.",
    manualHint: "Para actualizar a mano, ejecuta esto en una terminal:",
    copy: "Copiar",
    copied: "Copiado",
    flatpakHint: "{app} {version} está disponible. Actualízalo desde tu centro de software, o ejecuta esto en una terminal:",
    systemPromptTitle: "Actualización disponible",
    systemFailedTitle: "La actualización no se instaló",
    installNow: "Instalar ahora",
    close: "Cerrar",
  },
};

/** The plain sentence for an updater failure, from electron-updater's raw message (which only the log keeps). */
export const updateErrorKey = (message: string | null): Extract<UpdateSectionStringKey, `error${string}`> => {
  const raw = message ?? "";
  if (/ENOSPC|no space left|disk full/i.test(raw)) return "errorDisk";
  // macOS Squirrel refuses an app started from a disk image or translocated out of Downloads (read-only volume).
  if (/read-only volume/i.test(raw)) return "errorReadOnly";
  if (/sha512|checksum|signature|not signed|signed by|code ?sign/i.test(raw)) return "errorIntegrity";
  if (
    /net::ERR_|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ESOCKETTIMEDOUT|EHOSTUNREACH|ENETUNREACH|getaddrinfo|socket hang up|timed? ?out|HttpError|status ?code|\b[45]\d\d\b|Cannot find (channel|latest)/i.test(
      raw,
    )
  )
    return "errorNetwork";
  return "errorOther";
};

/** The sentence for a failed package-manager update (REL-UPD-07). */
export const systemFailureKey = (failure: SystemUpdateFailure | null): UpdateSectionStringKey => {
  switch (failure) {
    case "notNewer":
      return "systemNotNewer";
    case "repoMissing":
      return "systemRepoMissing";
    case "needsSystemUpdate":
      return "systemNeedsSystemUpdate";
    case "network":
      return "systemNetwork";
    case "packageManager":
      return "systemPackageManager";
    case "notAuthorized":
      return "systemNotAuthorized";
    case "noPasswordDialog":
      return "systemNoPasswordDialog";
    case "other":
    case null:
      return "systemOther";
  }
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
