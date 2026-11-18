import type { ClientUiLanguage } from "@space/shared/i18n";

/** The tour's own buttons and labels, the same in Badger and Parrot. */
type ChromeKey = "label" | "skip" | "stepOf" | "gotIt" | "pickFiles" | "videoLabel" | "showAgain" | "showAgainBody";

/**
 * One step's title and body: `<app>.<id>.title` / `<app>.<id>.body`. `jobs` is step 3 pointing at the
 * top bar's jobs button; `jobsPanel` is the same step drawn inside the open panel (its title is `jobs.title`).
 */
type CopyId =
  | "badger.intro"
  | "badger.review"
  | "badger.jobs"
  | "parrot.intro"
  | "parrot.review"
  | "parrot.jobs";

export type DesktopTourStringKey =
  | ChromeKey
  | `${CopyId}.title`
  | `${CopyId}.body`
  | "badger.jobsPanel.body"
  | "parrot.jobsPanel.body";

/**
 * Every sentence of the first-open tour (UX-TOUR-01..02/04, PAR-TOUR-01..02/04), in the five client languages
 * (UX-I18N-01), kept in one place for both desktop apps (REL-FAM-02) so a copy change is one line here.
 * `stepOf` takes `{n}` and `{m}`; `showAgainBody` takes `{app}`.
 */
export const desktopTourStrings: Record<ClientUiLanguage, Record<DesktopTourStringKey, string>> = {
  en: {
    label: "Quick tour",
    skip: "Skip tour",
    stepOf: "Step {n} of {m}",
    gotIt: "Got it",
    pickFiles: "or pick files",
    videoLabel: "A file dragged from a folder and dropped onto the app's window",
    showAgain: "Show the tour again",
    showAgainBody: "A short walk through adding your first files to {app}.",
    "badger.intro.title": "Drop your first film here",
    "badger.intro.body": "Drag a video file from a folder on your computer and drop it anywhere on this window.",
    "badger.review.title": "Badger does the rest",
    "badger.review.body":
      "It finds the poster and details of every film and episode. Check what it found, then add it: your files stay yours, locked with a key only you hold.",
    "badger.jobs.title": "Your imports show here",
    "badger.jobs.body":
      "Badger uploads and prepares your files in the background while you keep using it. This button opens the list of your imports at any time.",
    "badger.jobsPanel.body":
      "Each import shows its progress here and stays listed once it is done. Close this panel whenever you like: the jobs button in the top bar opens it again.",
    "parrot.intro.title": "Drop your first song here",
    "parrot.intro.body": "Drag a song or a folder of music from your computer and drop it anywhere on this window.",
    "parrot.review.title": "Parrot does the rest",
    "parrot.review.body":
      "It fills in the tags, album covers, artist pictures and lyrics. Check what it found, then add it: your songs stay yours, locked with a key only you hold.",
    "parrot.jobs.title": "Your imports show here",
    "parrot.jobs.body":
      "Parrot uploads your songs in the background while you keep listening. This button opens the list of your imports at any time.",
    "parrot.jobsPanel.body":
      "Each import shows its progress here and stays listed once it is done. Close this panel whenever you like: the jobs button in the top bar opens it again.",
  },
  fr: {
    label: "Visite rapide",
    skip: "Passer la visite",
    stepOf: "Étape {n} sur {m}",
    gotIt: "Compris",
    pickFiles: "ou choisir des fichiers",
    videoLabel: "Un fichier glissé depuis un dossier et déposé sur la fenêtre de l’app",
    showAgain: "Revoir la visite",
    showAgainBody: "Un court guide pour ajouter vos premiers fichiers à {app}.",
    "badger.intro.title": "Déposez votre premier film ici",
    "badger.intro.body": "Glissez un fichier vidéo depuis un dossier de votre ordinateur et déposez-le n’importe où sur cette fenêtre.",
    "badger.review.title": "Badger fait le reste",
    "badger.review.body":
      "Il trouve l’affiche et les détails de chaque film et épisode. Vérifiez ce qu’il a trouvé, puis ajoutez-le : vos fichiers restent à vous, verrouillés avec une clé que vous seul détenez.",
    "badger.jobs.title": "Vos imports s’affichent ici",
    "badger.jobs.body":
      "Badger envoie et prépare vos fichiers en arrière-plan pendant que vous continuez à l’utiliser. Ce bouton ouvre la liste de vos imports à tout moment.",
    "badger.jobsPanel.body":
      "Chaque import affiche sa progression ici et reste dans la liste une fois terminé. Fermez ce panneau quand vous voulez : le bouton des tâches, dans la barre du haut, le rouvre.",
    "parrot.intro.title": "Déposez votre premier morceau ici",
    "parrot.intro.body": "Glissez un morceau ou un dossier de musique depuis votre ordinateur et déposez-le n’importe où sur cette fenêtre.",
    "parrot.review.title": "Parrot fait le reste",
    "parrot.review.body":
      "Il complète les tags, les pochettes, les photos d’artistes et les paroles. Vérifiez ce qu’il a trouvé, puis ajoutez-le : vos morceaux restent à vous, verrouillés avec une clé que vous seul détenez.",
    "parrot.jobs.title": "Vos imports s’affichent ici",
    "parrot.jobs.body":
      "Parrot envoie vos morceaux en arrière-plan pendant que vous continuez à écouter. Ce bouton ouvre la liste de vos imports à tout moment.",
    "parrot.jobsPanel.body":
      "Chaque import affiche sa progression ici et reste dans la liste une fois terminé. Fermez ce panneau quand vous voulez : le bouton des tâches, dans la barre du haut, le rouvre.",
  },
  nl: {
    label: "Korte rondleiding",
    skip: "Rondleiding overslaan",
    stepOf: "Stap {n} van {m}",
    gotIt: "Begrepen",
    pickFiles: "of kies bestanden",
    videoLabel: "Een bestand dat uit een map wordt gesleept en op het venster van de app wordt neergezet",
    showAgain: "Rondleiding opnieuw tonen",
    showAgainBody: "Een korte uitleg over het toevoegen van je eerste bestanden aan {app}.",
    "badger.intro.title": "Zet je eerste film hier neer",
    "badger.intro.body": "Sleep een videobestand uit een map op je computer en zet het ergens op dit venster neer.",
    "badger.review.title": "Badger doet de rest",
    "badger.review.body":
      "Het zoekt de poster en details van elke film en aflevering. Controleer wat het vond en voeg het toe: je bestanden blijven van jou, vergrendeld met een sleutel die alleen jij hebt.",
    "badger.jobs.title": "Je imports staan hier",
    "badger.jobs.body":
      "Badger uploadt en bereidt je bestanden op de achtergrond voor terwijl je verder werkt. Deze knop opent altijd de lijst van je imports.",
    "badger.jobsPanel.body":
      "Elke import toont hier zijn voortgang en blijft in de lijst staan als hij klaar is. Sluit dit paneel wanneer je wilt: de takenknop in de bovenbalk opent het weer.",
    "parrot.intro.title": "Zet je eerste nummer hier neer",
    "parrot.intro.body": "Sleep een nummer of een map met muziek van je computer en zet het ergens op dit venster neer.",
    "parrot.review.title": "Parrot doet de rest",
    "parrot.review.body":
      "Het vult tags, albumhoezen, artiestenfoto’s en songteksten aan. Controleer wat het vond en voeg het toe: je nummers blijven van jou, vergrendeld met een sleutel die alleen jij hebt.",
    "parrot.jobs.title": "Je imports staan hier",
    "parrot.jobs.body":
      "Parrot uploadt je nummers op de achtergrond terwijl je verder luistert. Deze knop opent altijd de lijst van je imports.",
    "parrot.jobsPanel.body":
      "Elke import toont hier zijn voortgang en blijft in de lijst staan als hij klaar is. Sluit dit paneel wanneer je wilt: de takenknop in de bovenbalk opent het weer.",
  },
  de: {
    label: "Kurze Tour",
    skip: "Tour überspringen",
    stepOf: "Schritt {n} von {m}",
    gotIt: "Verstanden",
    pickFiles: "oder Dateien auswählen",
    videoLabel: "Eine Datei wird aus einem Ordner gezogen und auf dem Fenster der App abgelegt",
    showAgain: "Tour noch einmal zeigen",
    showAgainBody: "Eine kurze Anleitung, wie du deine ersten Dateien zu {app} hinzufügst.",
    "badger.intro.title": "Leg deinen ersten Film hier ab",
    "badger.intro.body": "Zieh eine Videodatei aus einem Ordner auf deinem Computer und leg sie irgendwo auf diesem Fenster ab.",
    "badger.review.title": "Badger erledigt den Rest",
    "badger.review.body":
      "Es findet Poster und Details zu jedem Film und jeder Folge. Prüf, was es gefunden hat, und füg es hinzu: Deine Dateien bleiben deine, verschlossen mit einem Schlüssel, den nur du hast.",
    "badger.jobs.title": "Hier stehen deine Importe",
    "badger.jobs.body":
      "Badger lädt deine Dateien im Hintergrund hoch und bereitet sie vor, während du weiterarbeitest. Diese Schaltfläche öffnet jederzeit die Liste deiner Importe.",
    "badger.jobsPanel.body":
      "Jeder Import zeigt hier seinen Fortschritt und bleibt in der Liste, wenn er fertig ist. Schließ dieses Feld, wann du willst: Die Aufgaben-Schaltfläche oben öffnet es wieder.",
    "parrot.intro.title": "Leg deinen ersten Song hier ab",
    "parrot.intro.body": "Zieh einen Song oder einen Musikordner von deinem Computer und leg ihn irgendwo auf diesem Fenster ab.",
    "parrot.review.title": "Parrot erledigt den Rest",
    "parrot.review.body":
      "Es ergänzt Tags, Albumcover, Künstlerbilder und Songtexte. Prüf, was es gefunden hat, und füg es hinzu: Deine Songs bleiben deine, verschlossen mit einem Schlüssel, den nur du hast.",
    "parrot.jobs.title": "Hier stehen deine Importe",
    "parrot.jobs.body":
      "Parrot lädt deine Songs im Hintergrund hoch, während du weiterhörst. Diese Schaltfläche öffnet jederzeit die Liste deiner Importe.",
    "parrot.jobsPanel.body":
      "Jeder Import zeigt hier seinen Fortschritt und bleibt in der Liste, wenn er fertig ist. Schließ dieses Feld, wann du willst: Die Aufgaben-Schaltfläche oben öffnet es wieder.",
  },
  es: {
    label: "Recorrido rápido",
    skip: "Saltar el recorrido",
    stepOf: "Paso {n} de {m}",
    gotIt: "Entendido",
    pickFiles: "o elegir archivos",
    videoLabel: "Un archivo arrastrado desde una carpeta y soltado sobre la ventana de la app",
    showAgain: "Ver el recorrido otra vez",
    showAgainBody: "Una guía breve para añadir tus primeros archivos a {app}.",
    "badger.intro.title": "Suelta aquí tu primera película",
    "badger.intro.body": "Arrastra un archivo de vídeo desde una carpeta de tu ordenador y suéltalo en cualquier parte de esta ventana.",
    "badger.review.title": "Badger hace el resto",
    "badger.review.body":
      "Encuentra el póster y los detalles de cada película y episodio. Revisa lo que encontró y añádelo: tus archivos siguen siendo tuyos, cerrados con una clave que solo tú tienes.",
    "badger.jobs.title": "Tus importaciones aparecen aquí",
    "badger.jobs.body":
      "Badger sube y prepara tus archivos en segundo plano mientras sigues usándolo. Este botón abre la lista de tus importaciones en cualquier momento.",
    "badger.jobsPanel.body":
      "Cada importación muestra aquí su progreso y sigue en la lista cuando termina. Cierra este panel cuando quieras: el botón de tareas de la barra superior lo vuelve a abrir.",
    "parrot.intro.title": "Suelta aquí tu primera canción",
    "parrot.intro.body": "Arrastra una canción o una carpeta de música desde tu ordenador y suéltala en cualquier parte de esta ventana.",
    "parrot.review.title": "Parrot hace el resto",
    "parrot.review.body":
      "Completa las etiquetas, las portadas, las fotos de artistas y las letras. Revisa lo que encontró y añádelo: tus canciones siguen siendo tuyas, cerradas con una clave que solo tú tienes.",
    "parrot.jobs.title": "Tus importaciones aparecen aquí",
    "parrot.jobs.body":
      "Parrot sube tus canciones en segundo plano mientras sigues escuchando. Este botón abre la lista de tus importaciones en cualquier momento.",
    "parrot.jobsPanel.body":
      "Cada importación muestra aquí su progreso y sigue en la lista cuando termina. Cierra este panel cuando quieras: el botón de tareas de la barra superior lo vuelve a abrir.",
  },
};

/** The tour text in `language` (`fr` or `fr-FR`; English for anything else), with `{name}` placeholders filled. */
export const desktopTourText = (
  language: string,
  key: DesktopTourStringKey,
  vars?: Record<string, string | number>,
): string => {
  const table = desktopTourStrings[language.split("-")[0] as ClientUiLanguage] ?? desktopTourStrings.en;
  const template = table[key] ?? desktopTourStrings.en[key];
  return vars ? template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match)) : template;
};
