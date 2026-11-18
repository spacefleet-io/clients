import { isClientUiLanguage, type ClientUiLanguage } from "@space/shared/i18n";

/**
 * REL-UPD-06: every sentence of the Android self-update (the prompt, its steps, Settings › About) in the five app
 * languages. `{app}` is the product name (Badger, Parrot: never translated), `{version}` and `{percent}` are filled
 * in by `selfUpdateText`. The setting reuses the desktop label (REL-UPD-05 "Update automatically").
 */
export type SelfUpdateStringKey =
  | "promptTitle"
  | "promptBody"
  | "update"
  | "later"
  | "permissionTitle"
  | "permissionBody"
  | "permissionContinue"
  | "downloading"
  | "verifying"
  | "installing"
  | "cancel"
  | "close"
  | "errorNetwork"
  | "errorIntegrity"
  | "errorInstall"
  | "version"
  | "checking"
  | "upToDate"
  | "available"
  | "availableElsewhere"
  | "check"
  | "autoLabel"
  | "autoHint"
  | "consentTitle"
  | "consentBody"
  | "consentYes"
  | "consentNo";

/** French puts U+202F before `: ; ? ! %` and inside `« »` (WEB-LANG-04), written `\u202f` so it stays visible here. */
export const selfUpdateStrings: Record<ClientUiLanguage, Record<SelfUpdateStringKey, string>> = {
  en: {
    promptTitle: "Update {app}",
    promptBody: "{app} {version} is available. Update?",
    update: "Update",
    later: "Later",
    permissionTitle: "One more step",
    permissionBody:
      "Android will ask you to allow {app} to install apps. Turn on \"Allow from this source\", then come back here: the update continues. You only do this once.",
    permissionContinue: "Continue",
    downloading: "Downloading {app} {version}… {percent}%",
    verifying: "Checking the download…",
    installing: "Android will now ask you to confirm the update.",
    cancel: "Cancel",
    close: "Close",
    errorNetwork: "Couldn't reach the update server. Try again later.",
    errorIntegrity: "The downloaded update didn't pass its safety check, so it wasn't installed. Try again later.",
    errorInstall: "The update wasn't installed. Try again later.",
    version: "Version {version}",
    checking: "Checking for updates…",
    upToDate: "{app} is up to date.",
    available: "Version {version} is available.",
    availableElsewhere: "Version {version} is available. Update {app} from the app you installed it with.",
    check: "Check for updates",
    autoLabel: "Update automatically",
    autoHint: "Checks when {app} starts and once a day, and asks before installing.",
    consentTitle: "Keep {app} up to date?",
    consentBody:
      "You installed {app} yourself, so no store updates it. {app} can check SpaceFleet's servers when it starts and once a day, and offer each new version. Updates come straight from SpaceFleet: no app store or F-Droid reviews them first. You can change this later in Settings.",
    consentYes: "Yes, check for updates",
    consentNo: "No, I'll update it myself",
  },
  fr: {
    promptTitle: "Mettre à jour {app}",
    promptBody: "{app} {version} est disponible. Mettre à jour\u202f?",
    update: "Mettre à jour",
    later: "Plus tard",
    permissionTitle: "Une étape de plus",
    permissionBody:
      "Android va vous demander d'autoriser {app} à installer des applications. Activez «\u202fAutoriser cette source\u202f», puis revenez ici\u202f: la mise à jour continue. Vous ne le faites qu'une fois.",
    permissionContinue: "Continuer",
    downloading: "Téléchargement de {app} {version}… {percent}\u202f%",
    verifying: "Vérification du téléchargement…",
    installing: "Android va maintenant vous demander de confirmer la mise à jour.",
    cancel: "Annuler",
    close: "Fermer",
    errorNetwork: "Impossible de joindre le serveur de mises à jour. Réessayez plus tard.",
    errorIntegrity: "La mise à jour téléchargée n'a pas passé la vérification de sécurité, elle n'a pas été installée. Réessayez plus tard.",
    errorInstall: "La mise à jour n'a pas été installée. Réessayez plus tard.",
    version: "Version {version}",
    checking: "Recherche de mises à jour…",
    upToDate: "{app} est à jour.",
    available: "La version {version} est disponible.",
    availableElsewhere: "La version {version} est disponible. Mettez {app} à jour depuis l'application qui l'a installé.",
    check: "Rechercher des mises à jour",
    autoLabel: "Mettre à jour automatiquement",
    autoHint: "Vérifie au démarrage de {app} et une fois par jour, et demande avant d'installer.",
    consentTitle: "Garder {app} à jour\u202f?",
    consentBody:
      "Vous avez installé {app} vous-même, aucune boutique ne le met donc à jour. {app} peut interroger les serveurs de SpaceFleet au démarrage et une fois par jour, et vous proposer chaque nouvelle version. Les mises à jour viennent directement de SpaceFleet\u202f: aucune boutique d'applications ni F-Droid ne les vérifie avant. Vous pourrez changer ce choix dans les Réglages.",
    consentYes: "Oui, vérifier les mises à jour",
    consentNo: "Non, je le mettrai à jour moi-même",
  },
  nl: {
    promptTitle: "{app} bijwerken",
    promptBody: "{app} {version} is beschikbaar. Bijwerken?",
    update: "Bijwerken",
    later: "Later",
    permissionTitle: "Nog één stap",
    permissionBody:
      "Android vraagt je om {app} toe te staan apps te installeren. Zet \"Toestaan van deze bron\" aan en kom dan hier terug: de update gaat verder. Dit doe je maar één keer.",
    permissionContinue: "Doorgaan",
    downloading: "{app} {version} downloaden… {percent}%",
    verifying: "Download controleren…",
    installing: "Android vraagt je nu de update te bevestigen.",
    cancel: "Annuleren",
    close: "Sluiten",
    errorNetwork: "De updateserver is niet bereikbaar. Probeer het later opnieuw.",
    errorIntegrity: "De gedownloade update kwam niet door de veiligheidscontrole en is niet geïnstalleerd. Probeer het later opnieuw.",
    errorInstall: "De update is niet geïnstalleerd. Probeer het later opnieuw.",
    version: "Versie {version}",
    checking: "Zoeken naar updates…",
    upToDate: "{app} is up-to-date.",
    available: "Versie {version} is beschikbaar.",
    availableElsewhere: "Versie {version} is beschikbaar. Werk {app} bij via de app waarmee je het hebt geïnstalleerd.",
    check: "Zoeken naar updates",
    autoLabel: "Automatisch bijwerken",
    autoHint: "Controleert bij het starten van {app} en één keer per dag, en vraagt het voordat het installeert.",
    consentTitle: "{app} up-to-date houden?",
    consentBody:
      "Je hebt {app} zelf geïnstalleerd, dus geen enkele winkel werkt het bij. {app} kan bij het starten en één keer per dag de servers van SpaceFleet raadplegen en elke nieuwe versie aanbieden. Updates komen rechtstreeks van SpaceFleet: geen appwinkel of F-Droid controleert ze eerst. Je kunt dit later wijzigen in Instellingen.",
    consentYes: "Ja, naar updates zoeken",
    consentNo: "Nee, ik werk het zelf bij",
  },
  de: {
    promptTitle: "{app} aktualisieren",
    promptBody: "{app} {version} ist verfügbar. Aktualisieren?",
    update: "Aktualisieren",
    later: "Später",
    permissionTitle: "Noch ein Schritt",
    permissionBody:
      "Android fragt dich, ob {app} Apps installieren darf. Schalte „Dieser Quelle vertrauen“ ein und komm dann hierher zurück: Das Update geht weiter. Das machst du nur einmal.",
    permissionContinue: "Weiter",
    downloading: "{app} {version} wird heruntergeladen… {percent} %",
    verifying: "Download wird geprüft…",
    installing: "Android bittet dich jetzt, das Update zu bestätigen.",
    cancel: "Abbrechen",
    close: "Schließen",
    errorNetwork: "Der Update-Server ist nicht erreichbar. Versuche es später noch einmal.",
    errorIntegrity: "Das heruntergeladene Update hat die Sicherheitsprüfung nicht bestanden und wurde nicht installiert. Versuche es später noch einmal.",
    errorInstall: "Das Update wurde nicht installiert. Versuche es später noch einmal.",
    version: "Version {version}",
    checking: "Suche nach Updates…",
    upToDate: "{app} ist auf dem neuesten Stand.",
    available: "Version {version} ist verfügbar.",
    availableElsewhere: "Version {version} ist verfügbar. Aktualisiere {app} über die App, mit der du es installiert hast.",
    check: "Nach Updates suchen",
    autoLabel: "Automatisch aktualisieren",
    autoHint: "Sucht beim Start von {app} und einmal am Tag und fragt vor dem Installieren.",
    consentTitle: "{app} aktuell halten?",
    consentBody:
      "Du hast {app} selbst installiert, daher aktualisiert es kein Store. {app} kann beim Start und einmal am Tag die Server von SpaceFleet abfragen und jede neue Version anbieten. Updates kommen direkt von SpaceFleet: Kein App-Store und nicht F-Droid prüft sie vorher. Du kannst das später in den Einstellungen ändern.",
    consentYes: "Ja, nach Updates suchen",
    consentNo: "Nein, ich aktualisiere selbst",
  },
  es: {
    promptTitle: "Actualizar {app}",
    promptBody: "{app} {version} está disponible. ¿Actualizar?",
    update: "Actualizar",
    later: "Más tarde",
    permissionTitle: "Un paso más",
    permissionBody:
      "Android te pedirá que permitas a {app} instalar aplicaciones. Activa «Permitir desde esta fuente» y vuelve aquí: la actualización continúa. Solo lo haces una vez.",
    permissionContinue: "Continuar",
    downloading: "Descargando {app} {version}… {percent} %",
    verifying: "Comprobando la descarga…",
    installing: "Android te pedirá ahora que confirmes la actualización.",
    cancel: "Cancelar",
    close: "Cerrar",
    errorNetwork: "No se pudo conectar con el servidor de actualizaciones. Inténtalo más tarde.",
    errorIntegrity: "La actualización descargada no superó la comprobación de seguridad y no se instaló. Inténtalo más tarde.",
    errorInstall: "La actualización no se instaló. Inténtalo más tarde.",
    version: "Versión {version}",
    checking: "Buscando actualizaciones…",
    upToDate: "{app} está actualizado.",
    available: "La versión {version} está disponible.",
    availableElsewhere: "La versión {version} está disponible. Actualiza {app} desde la aplicación con la que lo instalaste.",
    check: "Buscar actualizaciones",
    autoLabel: "Actualizar automáticamente",
    autoHint: "Busca al iniciar {app} y una vez al día, y pregunta antes de instalar.",
    consentTitle: "¿Mantener {app} al día?",
    consentBody:
      "Instalaste {app} tú mismo, así que ninguna tienda lo actualiza. {app} puede consultar los servidores de SpaceFleet al iniciarse y una vez al día, y ofrecerte cada nueva versión. Las actualizaciones vienen directamente de SpaceFleet: ninguna tienda de aplicaciones ni F-Droid las revisa antes. Puedes cambiarlo más tarde en Ajustes.",
    consentYes: "Sí, buscar actualizaciones",
    consentNo: "No, lo actualizaré yo",
  },
};

/** The sentence in the app language (English for any other), placeholders filled. */
export const selfUpdateText = (language: string | undefined, key: SelfUpdateStringKey, values: Record<string, string | number> = {}) =>
  selfUpdateStrings[language && isClientUiLanguage(language) ? language : "en"][key].replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  );
