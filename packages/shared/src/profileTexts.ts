/**
 * The words of the profile screens ("Who's watching?", add, edit, delete and their refusals, ACCT-PROF-01,
 * ACCT-PROF-02, UX-PROF-01; the avatar chooser, the names of the 22 avatars under `avatars.<id>` and the top-bar profile
 * menu, ACCT-PROF-05, UX-TOP-01), the same in every Badger and Parrot app (REL-FAM-02): each puts them into its i18next tree
 * at load as `profiles` (`withProfilesTexts`). Parrot asks "Who's listening?" (`whoIsListening`). `errors` holds the texts of
 * `profileErrorKey`. `setup` is the "Your profile" setup step (UX-SETUP-10) and `whatsNew` the "New in this update" window
 * (UX-UPDATE-01), one `whatsNew.<featureId>` per app feature (`./appFeatures`); apps draw `{{name}}` of
 * `whatsNew.avatars.text` in bold.
 */
export type ProfilesTextLanguage = "en" | "fr" | "nl" | "de" | "es";

export const profilesTexts = {
  en: {
    "whoIsWatching": "Who's watching?",
    "whoIsListening": "Who's listening?",
    "add": "Add profile",
    "manage": "Manage profiles",
    "manageHint": "Add, edit or delete the profiles of this account.",
    "manageTitle": "Manage profiles",
    "done": "Done",
    "delete": "Delete",
    "deleteA11y": "Delete {{name}}",
    "addTitle": "New profile",
    "nameLabel": "Profile name",
    "namePlaceholder": "Name",
    "save": "Save",
    "cancel": "Cancel",
    "deleteTitle": "Delete {{name}}?",
    "deleteBody": "This profile's watch history, resume points, playlists and favorites are deleted for good. The media library stays as it is.",
    "deleteConfirm": "Delete profile",
    "settingsGroup": "Profiles",
    "switch": "Switch profile",
    "watchingAs": "Watching as {{name}}",
    "listeningAs": "Listening as {{name}}",
    "deleteBodyListening": "This profile's listening history, playlists and liked songs are deleted for good. The music library stays as it is.",
    "edit": "Edit",
    "editA11y": "Edit {{name}}",
    "editTitle": "Edit profile",
    "chooseAvatar": "Choose an avatar",
    "changeAvatar": "Change avatar",
    "avatarLabel": "Avatar: {{name}}",
    "menuA11y": "Profile menu ({{name}})",
    "current": "Current profile",
    "limitFree": "A free account has one profile. Paid plans have up to {{paidMax}}.",
    "seePlans": "See plans",
    "avatars": {
      "badger": "Badger",
      "parrot": "Parrot",
      "fox": "Fox",
      "cat": "Cat",
      "dog": "Corgi",
      "owl": "Owl",
      "bear": "Bear",
      "raccoon": "Raccoon",
      "octopus": "Octopus",
      "panda": "Panda",
      "penguin": "Penguin",
      "bunny": "Bunny",
      "dino": "Dino",
      "frog": "Frog",
      "whale": "Whale",
      "moon": "Sleepy moon",
      "alien": "Alien",
      "robot": "Robot",
      "rocket": "Rocket",
      "planet": "Planet",
      "ufo": "Saucer",
      "earth": "Earth"
    },
    "setup": {
      "title": "Your profile",
      "lead": "How you appear on every app. You can change it later.",
      "name": "Name",
      "tvRename": "Rename on your phone or in Settings"
    },
    "whatsNew": {
      "badge": "New in this update",
      "avatars": {
        "title": "Pick an avatar",
        "text": "Profiles now have avatars, the same on every app. Choose one for {{name}}.",
        "cta": "Choose my avatar"
      },
      "later": "Later"
    },
    "errors": {
      "limit": "This account already has its {{max}} profiles.",
      "last": "An account always keeps at least one profile.",
      "invalid": "Enter a name of 1 to 40 characters.",
      "notFound": "This profile no longer exists.",
      "offline": "No connection. Try again once you're online.",
      "unknown": "That didn't work. Please try again."
    }
  },
  fr: {
    "whoIsWatching": "Qui regarde ?",
    "whoIsListening": "Qui écoute ?",
    "add": "Ajouter un profil",
    "manage": "Gérer les profils",
    "manageHint": "Ajouter, modifier ou supprimer les profils de ce compte.",
    "manageTitle": "Gérer les profils",
    "done": "Terminé",
    "delete": "Supprimer",
    "deleteA11y": "Supprimer {{name}}",
    "addTitle": "Nouveau profil",
    "nameLabel": "Nom du profil",
    "namePlaceholder": "Nom",
    "save": "Enregistrer",
    "cancel": "Annuler",
    "deleteTitle": "Supprimer {{name}} ?",
    "deleteBody": "L'historique, les reprises de lecture, les playlists et les favoris de ce profil sont supprimés définitivement. La médiathèque reste telle quelle.",
    "deleteConfirm": "Supprimer le profil",
    "settingsGroup": "Profils",
    "switch": "Changer de profil",
    "watchingAs": "Profil actuel : {{name}}",
    "listeningAs": "Profil actuel : {{name}}",
    "deleteBodyListening": "L'historique d'écoute, les playlists et les titres aimés de ce profil sont supprimés définitivement. La bibliothèque musicale reste telle quelle.",
    "edit": "Modifier",
    "editA11y": "Modifier {{name}}",
    "editTitle": "Modifier le profil",
    "chooseAvatar": "Choisir un avatar",
    "changeAvatar": "Changer d'avatar",
    "avatarLabel": "Avatar : {{name}}",
    "menuA11y": "Menu du profil ({{name}})",
    "current": "Profil actuel",
    "limitFree": "Un compte gratuit a un seul profil. Les offres payantes en ont jusqu'à {{paidMax}}.",
    "seePlans": "Voir les offres",
    "avatars": {
      "badger": "Badger",
      "parrot": "Parrot",
      "fox": "Renard",
      "cat": "Chat",
      "dog": "Corgi",
      "owl": "Hibou",
      "bear": "Ours",
      "raccoon": "Raton laveur",
      "octopus": "Pieuvre",
      "panda": "Panda",
      "penguin": "Manchot",
      "bunny": "Lapin",
      "dino": "Dino",
      "frog": "Grenouille",
      "whale": "Baleine",
      "moon": "Lune endormie",
      "alien": "Extraterrestre",
      "robot": "Robot",
      "rocket": "Fusée",
      "planet": "Planète",
      "ufo": "Soucoupe volante",
      "earth": "Terre"
    },
    "setup": {
      "title": "Votre profil",
      "lead": "Votre apparence dans toutes les apps. Vous pourrez la changer plus tard.",
      "name": "Nom",
      "tvRename": "Renommez-le sur votre téléphone ou dans Paramètres"
    },
    "whatsNew": {
      "badge": "Nouveau dans cette mise à jour",
      "avatars": {
        "title": "Choisissez un avatar",
        "text": "Les profils ont maintenant des avatars, les mêmes dans toutes les apps. Choisissez-en un pour {{name}}.",
        "cta": "Choisir mon avatar"
      },
      "later": "Plus tard"
    },
    "errors": {
      "limit": "Ce compte a déjà ses {{max}} profils.",
      "last": "Un compte garde toujours au moins un profil.",
      "invalid": "Saisissez un nom de 1 à 40 caractères.",
      "notFound": "Ce profil n'existe plus.",
      "offline": "Pas de connexion. Réessayez une fois en ligne.",
      "unknown": "Ça n'a pas marché. Réessayez."
    }
  },
  nl: {
    "whoIsWatching": "Wie kijkt er?",
    "whoIsListening": "Wie luistert er?",
    "add": "Profiel toevoegen",
    "manage": "Profielen beheren",
    "manageHint": "Voeg profielen van dit account toe, bewerk of verwijder ze.",
    "manageTitle": "Profielen beheren",
    "done": "Klaar",
    "delete": "Verwijderen",
    "deleteA11y": "{{name}} verwijderen",
    "addTitle": "Nieuw profiel",
    "nameLabel": "Profielnaam",
    "namePlaceholder": "Naam",
    "save": "Opslaan",
    "cancel": "Annuleren",
    "deleteTitle": "{{name}} verwijderen?",
    "deleteBody": "De kijkgeschiedenis, hervatpunten, afspeellijsten en favorieten van dit profiel worden definitief verwijderd. De mediatheek blijft zoals hij is.",
    "deleteConfirm": "Profiel verwijderen",
    "settingsGroup": "Profielen",
    "switch": "Ander profiel kiezen",
    "watchingAs": "Je kijkt als {{name}}",
    "listeningAs": "Je luistert als {{name}}",
    "deleteBodyListening": "De luistergeschiedenis, afspeellijsten en favoriete nummers van dit profiel worden definitief verwijderd. De muziekbibliotheek blijft zoals hij is.",
    "edit": "Bewerken",
    "editA11y": "{{name}} bewerken",
    "editTitle": "Profiel bewerken",
    "chooseAvatar": "Kies een avatar",
    "changeAvatar": "Avatar wijzigen",
    "avatarLabel": "Avatar: {{name}}",
    "menuA11y": "Profielmenu ({{name}})",
    "current": "Huidig profiel",
    "limitFree": "Een gratis account heeft één profiel. Betaalde abonnementen hebben er tot {{paidMax}}.",
    "seePlans": "Abonnementen bekijken",
    "avatars": {
      "badger": "Badger",
      "parrot": "Parrot",
      "fox": "Vos",
      "cat": "Kat",
      "dog": "Corgi",
      "owl": "Uil",
      "bear": "Beer",
      "raccoon": "Wasbeer",
      "octopus": "Octopus",
      "panda": "Panda",
      "penguin": "Pinguïn",
      "bunny": "Konijn",
      "dino": "Dino",
      "frog": "Kikker",
      "whale": "Walvis",
      "moon": "Slaperige maan",
      "alien": "Alien",
      "robot": "Robot",
      "rocket": "Raket",
      "planet": "Planeet",
      "ufo": "Vliegende schotel",
      "earth": "Aarde"
    },
    "setup": {
      "title": "Je profiel",
      "lead": "Zo zie je eruit in elke app. Je kunt het later wijzigen.",
      "name": "Naam",
      "tvRename": "Wijzig de naam op je telefoon of in Instellingen"
    },
    "whatsNew": {
      "badge": "Nieuw in deze update",
      "avatars": {
        "title": "Kies een avatar",
        "text": "Profielen hebben nu avatars, in elke app dezelfde. Kies er een voor {{name}}.",
        "cta": "Mijn avatar kiezen"
      },
      "later": "Later"
    },
    "errors": {
      "limit": "Dit account heeft al zijn {{max}} profielen.",
      "last": "Een account houdt altijd minstens één profiel.",
      "invalid": "Vul een naam in van 1 tot 40 tekens.",
      "notFound": "Dit profiel bestaat niet meer.",
      "offline": "Geen verbinding. Probeer het opnieuw zodra je online bent.",
      "unknown": "Dat is niet gelukt. Probeer het opnieuw."
    }
  },
  de: {
    "whoIsWatching": "Wer schaut?",
    "whoIsListening": "Wer hört zu?",
    "add": "Profil hinzufügen",
    "manage": "Profile verwalten",
    "manageHint": "Füge Profile dieses Kontos hinzu, bearbeite oder lösche sie.",
    "manageTitle": "Profile verwalten",
    "done": "Fertig",
    "delete": "Löschen",
    "deleteA11y": "{{name}} löschen",
    "addTitle": "Neues Profil",
    "nameLabel": "Profilname",
    "namePlaceholder": "Name",
    "save": "Speichern",
    "cancel": "Abbrechen",
    "deleteTitle": "{{name}} löschen?",
    "deleteBody": "Verlauf, Fortsetzungspunkte, Playlists und Favoriten dieses Profils werden endgültig gelöscht. Die Mediathek bleibt, wie sie ist.",
    "deleteConfirm": "Profil löschen",
    "settingsGroup": "Profile",
    "switch": "Profil wechseln",
    "watchingAs": "Du schaust als {{name}}",
    "listeningAs": "Du hörst als {{name}}",
    "deleteBodyListening": "Hörverlauf, Playlists und Lieblingssongs dieses Profils werden endgültig gelöscht. Die Musikbibliothek bleibt, wie sie ist.",
    "edit": "Bearbeiten",
    "editA11y": "{{name}} bearbeiten",
    "editTitle": "Profil bearbeiten",
    "chooseAvatar": "Avatar auswählen",
    "changeAvatar": "Avatar ändern",
    "avatarLabel": "Avatar: {{name}}",
    "menuA11y": "Profilmenü ({{name}})",
    "current": "Aktuelles Profil",
    "limitFree": "Ein kostenloses Konto hat ein Profil. Bezahlte Tarife haben bis zu {{paidMax}}.",
    "seePlans": "Tarife ansehen",
    "avatars": {
      "badger": "Badger",
      "parrot": "Parrot",
      "fox": "Fuchs",
      "cat": "Katze",
      "dog": "Corgi",
      "owl": "Eule",
      "bear": "Bär",
      "raccoon": "Waschbär",
      "octopus": "Krake",
      "panda": "Panda",
      "penguin": "Pinguin",
      "bunny": "Hase",
      "dino": "Dino",
      "frog": "Frosch",
      "whale": "Wal",
      "moon": "Schläfriger Mond",
      "alien": "Alien",
      "robot": "Roboter",
      "rocket": "Rakete",
      "planet": "Planet",
      "ufo": "Ufo",
      "earth": "Erde"
    },
    "setup": {
      "title": "Dein Profil",
      "lead": "So erscheinst du in jeder App. Du kannst es später ändern.",
      "name": "Name",
      "tvRename": "Benenne es auf deinem Handy oder in den Einstellungen um"
    },
    "whatsNew": {
      "badge": "Neu in diesem Update",
      "avatars": {
        "title": "Wähle einen Avatar",
        "text": "Profile haben jetzt Avatare, in jeder App dieselben. Wähle einen für {{name}}.",
        "cta": "Meinen Avatar wählen"
      },
      "later": "Später"
    },
    "errors": {
      "limit": "Dieses Konto hat schon seine {{max}} Profile.",
      "last": "Ein Konto behält immer mindestens ein Profil.",
      "invalid": "Gib einen Namen mit 1 bis 40 Zeichen ein.",
      "notFound": "Dieses Profil gibt es nicht mehr.",
      "offline": "Keine Verbindung. Versuch es noch mal, sobald du online bist.",
      "unknown": "Das hat nicht geklappt. Versuch es noch mal."
    }
  },
  es: {
    "whoIsWatching": "¿Quién está viendo?",
    "whoIsListening": "¿Quién está escuchando?",
    "add": "Añadir perfil",
    "manage": "Gestionar perfiles",
    "manageHint": "Añade, edita o elimina los perfiles de esta cuenta.",
    "manageTitle": "Gestionar perfiles",
    "done": "Listo",
    "delete": "Eliminar",
    "deleteA11y": "Eliminar {{name}}",
    "addTitle": "Nuevo perfil",
    "nameLabel": "Nombre del perfil",
    "namePlaceholder": "Nombre",
    "save": "Guardar",
    "cancel": "Cancelar",
    "deleteTitle": "¿Eliminar {{name}}?",
    "deleteBody": "El historial, los puntos de reanudación, las listas y los favoritos de este perfil se eliminarán para siempre. La mediateca se queda como está.",
    "deleteConfirm": "Eliminar perfil",
    "settingsGroup": "Perfiles",
    "switch": "Cambiar de perfil",
    "watchingAs": "Viendo como {{name}}",
    "listeningAs": "Escuchando como {{name}}",
    "deleteBodyListening": "El historial de escucha, las listas y las canciones que te gustan de este perfil se eliminarán para siempre. La biblioteca musical se queda como está.",
    "edit": "Editar",
    "editA11y": "Editar {{name}}",
    "editTitle": "Editar perfil",
    "chooseAvatar": "Elige un avatar",
    "changeAvatar": "Cambiar avatar",
    "avatarLabel": "Avatar: {{name}}",
    "menuA11y": "Menú del perfil ({{name}})",
    "current": "Perfil actual",
    "limitFree": "Una cuenta gratuita tiene un solo perfil. Los planes de pago tienen hasta {{paidMax}}.",
    "seePlans": "Ver planes",
    "avatars": {
      "badger": "Badger",
      "parrot": "Parrot",
      "fox": "Zorro",
      "cat": "Gato",
      "dog": "Corgi",
      "owl": "Búho",
      "bear": "Oso",
      "raccoon": "Mapache",
      "octopus": "Pulpo",
      "panda": "Panda",
      "penguin": "Pingüino",
      "bunny": "Conejo",
      "dino": "Dino",
      "frog": "Rana",
      "whale": "Ballena",
      "moon": "Luna dormilona",
      "alien": "Extraterrestre",
      "robot": "Robot",
      "rocket": "Cohete",
      "planet": "Planeta",
      "ufo": "Platillo volante",
      "earth": "Tierra"
    },
    "setup": {
      "title": "Tu perfil",
      "lead": "Así apareces en todas las apps. Puedes cambiarlo más tarde.",
      "name": "Nombre",
      "tvRename": "Cámbiale el nombre en tu teléfono o en Ajustes"
    },
    "whatsNew": {
      "badge": "Novedad de esta actualización",
      "avatars": {
        "title": "Elige un avatar",
        "text": "Los perfiles ahora tienen avatares, los mismos en todas las apps. Elige uno para {{name}}.",
        "cta": "Elegir mi avatar"
      },
      "later": "Más tarde"
    },
    "errors": {
      "limit": "Esta cuenta ya tiene sus {{max}} perfiles.",
      "last": "Una cuenta siempre conserva al menos un perfil.",
      "invalid": "Escribe un nombre de 1 a 40 caracteres.",
      "notFound": "Este perfil ya no existe.",
      "offline": "Sin conexión. Vuelve a intentarlo cuando estés en línea.",
      "unknown": "No ha funcionado. Vuelve a intentarlo."
    }
  },
} as const;

/** Puts {@link profilesTexts} into an i18next translation tree as `profiles`, keeping its other keys. */
export const withProfilesTexts = <T extends Record<string, unknown>>(translation: T, language: ProfilesTextLanguage): T => ({
  ...translation,
  profiles: profilesTexts[language],
});

/**
 * The `t` of the profile screens (`@space/ui/profiles`) for an app without i18next (Parrot desktop): resolves
 * `profiles.*` and nested keys (`profiles.errors.*`, `profiles.avatars.*`, `profiles.whatsNew.avatars.*`, …) in {@link profilesTexts} with `{{var}}` values. A music app (`listening`) says
 * what a listening profile loses when deleted (`deleteBodyListening`), as Parrot's phone does.
 */
export const profilesTranslator =
  (language: ProfilesTextLanguage, { listening = false }: { listening?: boolean } = {}) =>
  (key: string, values: Record<string, unknown> = {}): string => {
    const path = key.replace(/^profiles\./, "").split(".");
    if (listening && path[0] === "deleteBody") path[0] = "deleteBodyListening";
    const texts = profilesTexts[language] as Record<string, unknown>;
    const found = path.reduce<unknown>((node, part) => (node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined), texts);
    if (typeof found !== "string") return key;
    return found.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values[name] ?? ""));
  };
