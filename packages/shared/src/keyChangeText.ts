import type { ClientUiLanguage } from "./i18n";

/** Every sentence of the media library key change (ACCT-KEYCHG-01, STOR-RESEAL-01), on a computer and on Badger's phone. */
export type KeyChangeStringKey =
  | "dialogTitle"
  | "keyLabel"
  | "keyHint"
  | "copyButton"
  | "confirmLabel"
  | "passwordLabel"
  | "noPasswordHint"
  | "codeLabel"
  | "codeHintEmail"
  | "codeHintTotp"
  | "submit"
  | "working"
  | "cancel"
  | "resealHint"
  | "reseal.title"
  | "reseal.readyTitle"
  | "reseal.files"
  | "reseal.etaUnknown"
  | "reseal.etaUnderMinute"
  | "reseal.etaMinutes"
  | "reseal.etaHours"
  | "reseal.keepOpen"
  | "reseal.keepOpenPlugged"
  | "reseal.mobileDataTitle"
  | "reseal.mobileDataBody"
  | "reseal.useMobileData"
  | "reseal.useMobileDataHint"
  | "reseal.finish"
  | "reseal.waitingTitle"
  | "reseal.waitingBody.one"
  | "reseal.waitingBody.other"
  | "reseal.switchNowBody"
  | "reseal.switchNow"
  | "reseal.unreadable.one"
  | "reseal.unreadable.other"
  | "reseal.seeFiles.one"
  | "reseal.seeFiles.other"
  | "reseal.moreOptions"
  | "reseal.stop"
  | "reseal.stopTitle"
  | "reseal.stopBody"
  | "reseal.keepGoing"
  | "reseal.stopConfirm"
  | "reseal.stoppedTitle"
  | "reseal.stoppedMessage"
  | "reseal.unreadableTitle"
  | "reseal.unreadableBody"
  | "reseal.unreadableLoading"
  | "reseal.unreadableNone"
  | "reseal.close"
  | "reseal.unreadableDelete.one"
  | "reseal.unreadableDelete.other"
  | "reseal.unreadableDeletedTitle"
  | "reseal.unreadableDeletedMessage.one"
  | "reseal.unreadableDeletedMessage.other"
  | "reseal.unreadableDeleteFailed"
  | "codeSent"
  | "error.invalidPassword"
  | "error.invalidCode"
  | "error.generic"
  | "error.changed"
  | "error.resealIncomplete"
  | "error.resealStopped"
  | "error.notReencrypted"
  | "error.unreadable"
  | "error.notSnapshotted"
  | "error.reencryptFailed"
  | "entry.title"
  | "entry.body"
  | "entry.button"
  | "copied"
  | "copyFailed";

/** A key with a count picks its `.one` or `.other` form by the language's plural rule. */
export type KeyChangeCountedKey =
  | "reseal.waitingBody"
  | "reseal.unreadable"
  | "reseal.seeFiles"
  | "reseal.unreadableDelete"
  | "reseal.unreadableDeletedMessage";

/**
 * The key change's text in the five client languages (UX-I18N-01), shared by Badger desktop, Badger's phone and Parrot
 * desktop so none keeps its own copy (REL-FAM-02). `{app}` is the app's name, the same in every language;
 * `reseal.files` takes `{done}` and `{total}`, the estimates `{hours}` and `{minutes}`, the counted keys `{count}`. The
 * `reseal.mobileData*`, `reseal.useMobileData*` and `reseal.keepOpenPlugged` sentences are the phone's (ACCT-KEYCHG-05).
 */
export const keyChangeStrings: Record<ClientUiLanguage, Record<KeyChangeStringKey, string>> = {
  en: {
    dialogTitle: "Replace your media library key",
    keyLabel: "New media library key",
    keyHint: "Store this key safely before continuing.",
    copyButton: "Copy key",
    confirmLabel: "I understand this will end other sessions",
    passwordLabel: "Account password",
    noPasswordHint:
      "Your account has no password, so a code confirms it is you: the code from your authenticator app when it is on, otherwise one we email you when you continue.",
    codeLabel: "Verification code",
    codeHintEmail: "Enter the code we sent to your email.",
    codeHintTotp: "Enter your authenticator code.",
    submit: "Replace key",
    working: "Replacing…",
    cancel: "Cancel",
    resealHint:
      "If your library holds media files, each one is copied with the new key before the switch. This can take hours: keep {app} open until it ends.",
    "reseal.title": "Copying your files with the new key",
    "reseal.readyTitle": "Every file is copied",
    "reseal.files": "{done} of {total} files",
    "reseal.etaUnknown": "Estimating the time left…",
    "reseal.etaUnderMinute": "Less than a minute left",
    "reseal.etaMinutes": "About {minutes} min left",
    "reseal.etaHours": "About {hours} h {minutes} min left",
    "reseal.keepOpen": "Keep {app} open until this ends. If {app} closes, the key change starts over the next time.",
    "reseal.keepOpenPlugged":
      "Keep {app} open on screen and plugged in until this ends. If {app} closes, the key change starts over the next time.",
    "reseal.mobileDataTitle": "Paused on mobile data",
    "reseal.mobileDataBody": "Copying carries on when this phone is on Wi-Fi.",
    "reseal.useMobileData": "Use mobile data",
    "reseal.useMobileDataHint":
      "Copy over mobile data too. Every media file is downloaded and uploaded again, which can use a lot of data.",
    "reseal.finish": "Finish key change",
    "reseal.waitingTitle": "Waiting for another device",
    "reseal.waitingBody.one": "Another device is still uploading {count} file. The key changes as soon as it ends.",
    "reseal.waitingBody.other": "Another device is still uploading {count} files. The key changes as soon as they end.",
    "reseal.switchNowBody":
      "The other device has been uploading for more than 24 hours. Switch now cancels its unfinished uploads; they start again after it signs in with the new key.",
    "reseal.switchNow": "Switch now",
    "reseal.unreadable.one": "{count} file can't be opened with your current key. It stays as it is.",
    "reseal.unreadable.other": "{count} files can't be opened with your current key. They stay as they are.",
    "reseal.seeFiles.one": "See the file",
    "reseal.seeFiles.other": "See the {count} files",
    "reseal.moreOptions": "More options",
    "reseal.stop": "Stop key change",
    "reseal.stopTitle": "Stop the key change?",
    "reseal.stopBody":
      "The copies made so far are deleted and your library stays as it is, with your current media library key.",
    "reseal.keepGoing": "Keep going",
    "reseal.stopConfirm": "Stop",
    "reseal.stoppedTitle": "Key change stopped",
    "reseal.stoppedMessage": "Your library still uses your current media library key.",
    "reseal.unreadableTitle": "Files your key can't open",
    "reseal.unreadableBody": "These files were already damaged and can't be played. Deleting them frees their space.",
    "reseal.unreadableLoading": "Loading…",
    "reseal.unreadableNone": "No files left to delete.",
    "reseal.close": "Close",
    "reseal.unreadableDelete.one": "Delete the file",
    "reseal.unreadableDelete.other": "Delete {count} files",
    "reseal.unreadableDeletedTitle": "Files deleted",
    "reseal.unreadableDeletedMessage.one": "{count} file deleted.",
    "reseal.unreadableDeletedMessage.other": "{count} files deleted.",
    "reseal.unreadableDeleteFailed": "Could not delete the files. Please try again.",
    "codeSent": "We sent a verification code. Check your email or authenticator.",
    "error.invalidPassword": "Incorrect password.",
    "error.invalidCode": "Verification code is invalid.",
    "error.generic": "Could not rotate the key. Please try again.",
    "error.changed": "Your library changed while the key was being replaced. Nothing changed. Please try again.",
    "error.resealIncomplete": "Some files were added while the key was being replaced. Select Finish key change to copy them too.",
    "error.resealStopped": "This key change was stopped, so nothing changed. Start again to replace the key.",
    "error.notReencrypted": "Your {other} library could not be re-locked with the new key from here, so nothing changed. Replace the key from Settings on a computer that has your current key.",
    "error.unreadable": "Your current key does not open your {other} library, so nothing changed.",
    "error.notSnapshotted": "Your {other} library has changes that are not saved yet. Open {other}, let it finish syncing, then try again. Nothing changed.",
    "error.reencryptFailed": "Could not re-lock your {other} library with the new key. Nothing changed. Please try again.",
    "entry.title": "Replace media library key",
    "entry.body": "Create a new key and re-lock your library data.",
    "entry.button": "Create new key",
    "copied": "Media library key copied.",
    "copyFailed": "Could not copy key.",
  },
  fr: {
    dialogTitle: "Remplacer votre clé de médiathèque",
    keyLabel: "Nouvelle clé de médiathèque",
    keyHint: "Sauvegardez cette clé avant de continuer.",
    copyButton: "Copier la clé",
    confirmLabel: "Je comprends que cela mettra fin aux autres sessions",
    passwordLabel: "Mot de passe du compte",
    noPasswordHint:
      "Votre compte n’a pas de mot de passe, donc un code confirme que c’est bien vous\u202f: celui de votre application d’authentification si elle est activée, sinon un code envoyé par email quand vous continuez.",
    codeLabel: "Code de vérification",
    codeHintEmail: "Entrez le code envoyé par email.",
    codeHintTotp: "Entrez le code de votre authenticator.",
    submit: "Remplacer la clé",
    working: "Remplacement…",
    cancel: "Annuler",
    resealHint:
      "Si votre bibliothèque contient des fichiers, chacun est copié avec la nouvelle clé avant le changement. Cela peut prendre des heures, gardez {app} ouvert jusqu'à la fin.",
    "reseal.title": "Copie de vos fichiers avec la nouvelle clé",
    "reseal.readyTitle": "Tous les fichiers sont copiés",
    "reseal.files": "{done} fichiers sur {total}",
    "reseal.etaUnknown": "Calcul du temps restant…",
    "reseal.etaUnderMinute": "Moins d'une minute restante",
    "reseal.etaMinutes": "Environ {minutes} min restantes",
    "reseal.etaHours": "Environ {hours} h {minutes} min restantes",
    "reseal.keepOpen":
      "Gardez {app} ouvert jusqu'à la fin. Si {app} se ferme, le changement de clé reprendra du début la prochaine fois.",
    "reseal.keepOpenPlugged":
      "Gardez {app} ouvert à l'écran et branché jusqu'à la fin. Si {app} se ferme, le changement de clé reprendra du début la prochaine fois.",
    "reseal.mobileDataTitle": "En pause sur les données mobiles",
    "reseal.mobileDataBody": "La copie reprend quand ce téléphone est en Wi-Fi.",
    "reseal.useMobileData": "Utiliser les données mobiles",
    "reseal.useMobileDataHint":
      "Copier aussi via les données mobiles. Chaque fichier média est téléchargé puis renvoyé, ce qui peut consommer beaucoup de données.",
    "reseal.finish": "Terminer le changement de clé",
    "reseal.waitingTitle": "En attente d'un autre appareil",
    "reseal.waitingBody.one": "Un autre appareil envoie encore {count} fichier. La clé change dès qu'il a fini.",
    "reseal.waitingBody.other": "Un autre appareil envoie encore {count} fichiers. La clé change dès qu'ils ont fini.",
    "reseal.switchNowBody":
      "L'autre appareil envoie des fichiers depuis plus de 24 heures. Changer maintenant annule ses envois inachevés, qui reprendront après sa connexion avec la nouvelle clé.",
    "reseal.switchNow": "Changer maintenant",
    "reseal.unreadable.one": "{count} fichier ne s'ouvre pas avec votre clé actuelle. Il reste tel quel.",
    "reseal.unreadable.other": "{count} fichiers ne s'ouvrent pas avec votre clé actuelle. Ils restent tels quels.",
    "reseal.seeFiles.one": "Voir le fichier",
    "reseal.seeFiles.other": "Voir les {count} fichiers",
    "reseal.moreOptions": "Plus d'options",
    "reseal.stop": "Arrêter le changement de clé",
    "reseal.stopTitle": "Arrêter le changement de clé\u202f?",
    "reseal.stopBody":
      "Les copies déjà faites sont supprimées et votre bibliothèque reste telle quelle, avec votre clé de médiathèque actuelle.",
    "reseal.keepGoing": "Continuer",
    "reseal.stopConfirm": "Arrêter",
    "reseal.stoppedTitle": "Changement de clé arrêté",
    "reseal.stoppedMessage": "Votre bibliothèque utilise toujours votre clé de médiathèque actuelle.",
    "reseal.unreadableTitle": "Fichiers que votre clé n'ouvre pas",
    "reseal.unreadableBody":
      "Ces fichiers étaient déjà endommagés et ne peuvent pas être lus. Les supprimer libère leur espace.",
    "reseal.unreadableLoading": "Chargement…",
    "reseal.unreadableNone": "Plus aucun fichier à supprimer.",
    "reseal.close": "Fermer",
    "reseal.unreadableDelete.one": "Supprimer le fichier",
    "reseal.unreadableDelete.other": "Supprimer {count} fichiers",
    "reseal.unreadableDeletedTitle": "Fichiers supprimés",
    "reseal.unreadableDeletedMessage.one": "{count} fichier supprimé.",
    "reseal.unreadableDeletedMessage.other": "{count} fichiers supprimés.",
    "reseal.unreadableDeleteFailed": "Impossible de supprimer les fichiers. Réessayez.",
    "codeSent": "Code envoyé. Vérifiez votre email ou votre application d'authentification.",
    "error.invalidPassword": "Mot de passe incorrect.",
    "error.invalidCode": "Code de vérification invalide.",
    "error.generic": "Impossible de tourner la clé. Réessayez.",
    "error.changed": "Votre bibliothèque a changé pendant le remplacement de la clé. Rien n'a changé. Réessayez.",
    "error.resealIncomplete": "Des fichiers ont été ajoutés pendant le remplacement de la clé. Choisissez Terminer le changement de clé pour les copier aussi.",
    "error.resealStopped": "Ce changement de clé a été arrêté, rien n'a changé. Recommencez pour remplacer la clé.",
    "error.notReencrypted": "Votre bibliothèque {other} ne peut pas être reverrouillée avec la nouvelle clé depuis ici, donc rien n'a changé. Remplacez la clé depuis les Réglages d'un ordinateur qui a votre clé actuelle.",
    "error.unreadable": "Votre clé actuelle n'ouvre pas votre bibliothèque {other}, donc rien n'a changé.",
    "error.notSnapshotted": "Votre bibliothèque {other} a des changements pas encore enregistrés. Ouvrez {other}, laissez-le finir de synchroniser, puis réessayez. Rien n'a changé.",
    "error.reencryptFailed": "Impossible de reverrouiller votre bibliothèque {other} avec la nouvelle clé. Rien n'a changé. Réessayez.",
    "entry.title": "Remplacer la clé de médiathèque",
    "entry.body": "Créez une nouvelle clé et reverrouillez vos données.",
    "entry.button": "Créer une nouvelle clé",
    "copied": "Clé de médiathèque copiée.",
    "copyFailed": "Impossible de copier la clé.",
  },
  de: {
    dialogTitle: "Deinen Mediathek-Schlüssel ersetzen",
    keyLabel: "Neuer Mediathek-Schlüssel",
    keyHint: "Bewahre diesen Schlüssel sicher auf, bevor du fortfährst.",
    copyButton: "Schlüssel kopieren",
    confirmLabel: "Mir ist klar, dass dadurch andere Sitzungen beendet werden",
    passwordLabel: "Kontopasswort",
    noPasswordHint:
      "Dein Konto hat kein Passwort, deshalb bestätigt ein Code, dass du es bist: der Code aus deiner Authenticator-App, wenn sie aktiv ist, sonst einer, den wir dir beim Fortfahren per E-Mail schicken.",
    codeLabel: "Bestätigungscode",
    codeHintEmail: "Gib den Code ein, den wir dir per E-Mail geschickt haben.",
    codeHintTotp: "Gib den Code aus deiner Authentifizierungs-App ein.",
    submit: "Schlüssel ersetzen",
    working: "Wird ersetzt …",
    cancel: "Abbrechen",
    resealHint:
      "Wenn deine Mediathek Mediendateien enthält, wird jede vor dem Wechsel mit dem neuen Schlüssel kopiert. Das kann Stunden dauern. Lass {app} bis zum Ende geöffnet.",
    "reseal.title": "Deine Dateien werden mit dem neuen Schlüssel kopiert",
    "reseal.readyTitle": "Alle Dateien sind kopiert",
    "reseal.files": "{done} von {total} Dateien",
    "reseal.etaUnknown": "Restzeit wird berechnet…",
    "reseal.etaUnderMinute": "Weniger als eine Minute übrig",
    "reseal.etaMinutes": "Noch etwa {minutes} Min.",
    "reseal.etaHours": "Noch etwa {hours} Std. {minutes} Min.",
    "reseal.keepOpen":
      "Lass {app} bis zum Ende geöffnet. Wenn {app} geschlossen wird, beginnt der Schlüsselwechsel beim nächsten Mal von vorn.",
    "reseal.keepOpenPlugged":
      "Lass {app} auf dem Bildschirm geöffnet und am Ladegerät, bis es fertig ist. Wenn {app} geschlossen wird, beginnt der Schlüsselwechsel beim nächsten Mal von vorn.",
    "reseal.mobileDataTitle": "Pausiert bei mobilen Daten",
    "reseal.mobileDataBody": "Das Kopieren geht weiter, sobald dieses Telefon im WLAN ist.",
    "reseal.useMobileData": "Mobile Daten verwenden",
    "reseal.useMobileDataHint":
      "Auch über mobile Daten kopieren. Jede Mediendatei wird heruntergeladen und erneut hochgeladen, das kann viele Daten verbrauchen.",
    "reseal.finish": "Schlüsselwechsel abschließen",
    "reseal.waitingTitle": "Warten auf ein anderes Gerät",
    "reseal.waitingBody.one": "Ein anderes Gerät lädt noch {count} Datei hoch. Der Schlüssel wechselt, sobald es fertig ist.",
    "reseal.waitingBody.other":
      "Ein anderes Gerät lädt noch {count} Dateien hoch. Der Schlüssel wechselt, sobald sie fertig sind.",
    "reseal.switchNowBody":
      "Das andere Gerät lädt seit über 24 Stunden hoch. Jetzt wechseln bricht seine unfertigen Uploads ab; sie starten neu, sobald es sich mit dem neuen Schlüssel anmeldet.",
    "reseal.switchNow": "Jetzt wechseln",
    "reseal.unreadable.one": "{count} Datei lässt sich mit deinem aktuellen Schlüssel nicht öffnen. Sie bleibt, wie sie ist.",
    "reseal.unreadable.other":
      "{count} Dateien lassen sich mit deinem aktuellen Schlüssel nicht öffnen. Sie bleiben, wie sie sind.",
    "reseal.seeFiles.one": "Datei ansehen",
    "reseal.seeFiles.other": "Die {count} Dateien ansehen",
    "reseal.moreOptions": "Weitere Optionen",
    "reseal.stop": "Schlüsselwechsel stoppen",
    "reseal.stopTitle": "Schlüsselwechsel stoppen?",
    "reseal.stopBody":
      "Die bisher erstellten Kopien werden gelöscht und deine Mediathek bleibt, wie sie ist, mit deinem aktuellen Mediathek-Schlüssel.",
    "reseal.keepGoing": "Weitermachen",
    "reseal.stopConfirm": "Stoppen",
    "reseal.stoppedTitle": "Schlüsselwechsel gestoppt",
    "reseal.stoppedMessage": "Deine Mediathek nutzt weiter deinen aktuellen Mediathek-Schlüssel.",
    "reseal.unreadableTitle": "Dateien, die dein Schlüssel nicht öffnet",
    "reseal.unreadableBody":
      "Diese Dateien waren schon beschädigt und lassen sich nicht abspielen. Wenn du sie löschst, wird ihr Speicher frei.",
    "reseal.unreadableLoading": "Wird geladen…",
    "reseal.unreadableNone": "Keine Dateien mehr zu löschen.",
    "reseal.close": "Schließen",
    "reseal.unreadableDelete.one": "Datei löschen",
    "reseal.unreadableDelete.other": "{count} Dateien löschen",
    "reseal.unreadableDeletedTitle": "Dateien gelöscht",
    "reseal.unreadableDeletedMessage.one": "{count} Datei gelöscht.",
    "reseal.unreadableDeletedMessage.other": "{count} Dateien gelöscht.",
    "reseal.unreadableDeleteFailed": "Die Dateien konnten nicht gelöscht werden. Versuch es noch mal.",
    "codeSent": "Wir haben dir einen Bestätigungscode geschickt. Sieh in deinen E-Mails oder deiner Authentifizierungs-App nach.",
    "error.invalidPassword": "Falsches Passwort.",
    "error.invalidCode": "Der Bestätigungscode ist ungültig.",
    "error.generic": "Der Schlüssel konnte nicht ersetzt werden. Versuch es noch mal.",
    "error.changed": "Deine Mediathek hat sich geändert, während der Schlüssel ersetzt wurde. Es wurde nichts geändert. Versuch es noch mal.",
    "error.resealIncomplete": "Während der Schlüssel ersetzt wurde, kamen Dateien hinzu. Wähle Schlüsselwechsel abschließen, um sie auch zu kopieren.",
    "error.resealStopped": "Dieser Schlüsselwechsel wurde gestoppt, es wurde nichts geändert. Starte neu, um den Schlüssel zu ersetzen.",
    "error.notReencrypted": "Deine {other}-Mediathek konnte von hier aus nicht mit dem neuen Schlüssel neu gesperrt werden, also wurde nichts geändert. Ersetze den Schlüssel in den Einstellungen eines Computers, der deinen aktuellen Schlüssel hat.",
    "error.unreadable": "Dein aktueller Schlüssel öffnet deine {other}-Mediathek nicht, also wurde nichts geändert.",
    "error.notSnapshotted": "Deine {other}-Mediathek hat noch nicht gespeicherte Änderungen. Öffne {other}, lass es fertig synchronisieren und versuch es dann noch mal. Es wurde nichts geändert.",
    "error.reencryptFailed": "Deine {other}-Mediathek konnte nicht mit dem neuen Schlüssel neu gesperrt werden. Es wurde nichts geändert. Versuch es noch mal.",
    "entry.title": "Mediathek-Schlüssel ersetzen",
    "entry.body": "Erstelle einen neuen Schlüssel und sperre die Daten deiner Mediathek neu.",
    "entry.button": "Neuen Schlüssel erstellen",
    "copied": "Mediathek-Schlüssel kopiert.",
    "copyFailed": "Schlüssel konnte nicht kopiert werden.",
  },
  es: {
    dialogTitle: "Sustituir tu clave de la mediateca",
    keyLabel: "Nueva clave de la mediateca",
    keyHint: "Guarda esta clave en un lugar seguro antes de continuar.",
    copyButton: "Copiar la clave",
    confirmLabel: "Entiendo que esto cerrará las demás sesiones",
    passwordLabel: "Contraseña de la cuenta",
    noPasswordHint:
      "Tu cuenta no tiene contraseña, así que un código confirma que eres tú: el de tu app de autenticación si está activada; si no, uno que te enviamos por correo al continuar.",
    codeLabel: "Código de verificación",
    codeHintEmail: "Introduce el código que te enviamos por correo.",
    codeHintTotp: "Introduce el código de tu app de autenticación.",
    submit: "Sustituir la clave",
    working: "Sustituyendo…",
    cancel: "Cancelar",
    resealHint:
      "Si tu mediateca tiene archivos multimedia, cada uno se copia con la nueva clave antes del cambio. Puede tardar horas: deja {app} abierto hasta que termine.",
    "reseal.title": "Copiando tus archivos con la nueva clave",
    "reseal.readyTitle": "Todos los archivos están copiados",
    "reseal.files": "{done} de {total} archivos",
    "reseal.etaUnknown": "Calculando el tiempo restante…",
    "reseal.etaUnderMinute": "Queda menos de un minuto",
    "reseal.etaMinutes": "Quedan unos {minutes} min",
    "reseal.etaHours": "Quedan unas {hours} h {minutes} min",
    "reseal.keepOpen":
      "Deja {app} abierto hasta que termine. Si {app} se cierra, el cambio de clave empezará de nuevo la próxima vez.",
    "reseal.keepOpenPlugged":
      "Deja {app} abierto en pantalla y enchufado hasta que termine. Si {app} se cierra, el cambio de clave empezará de nuevo la próxima vez.",
    "reseal.mobileDataTitle": "En pausa con datos móviles",
    "reseal.mobileDataBody": "La copia continúa cuando este teléfono está en una red Wi-Fi.",
    "reseal.useMobileData": "Usar datos móviles",
    "reseal.useMobileDataHint":
      "Copiar también con datos móviles. Cada archivo multimedia se descarga y se vuelve a subir, lo que puede gastar muchos datos.",
    "reseal.finish": "Terminar el cambio de clave",
    "reseal.waitingTitle": "Esperando a otro dispositivo",
    "reseal.waitingBody.one": "Otro dispositivo todavía está subiendo {count} archivo. La clave cambia en cuanto termine.",
    "reseal.waitingBody.other":
      "Otro dispositivo todavía está subiendo {count} archivos. La clave cambia en cuanto terminen.",
    "reseal.switchNowBody":
      "El otro dispositivo lleva más de 24 horas subiendo archivos. Cambiar ahora cancela sus subidas sin terminar; empezarán de nuevo cuando inicie sesión con la nueva clave.",
    "reseal.switchNow": "Cambiar ahora",
    "reseal.unreadable.one": "{count} archivo no se puede abrir con tu clave actual. Se queda como está.",
    "reseal.unreadable.other": "{count} archivos no se pueden abrir con tu clave actual. Se quedan como están.",
    "reseal.seeFiles.one": "Ver el archivo",
    "reseal.seeFiles.other": "Ver los {count} archivos",
    "reseal.moreOptions": "Más opciones",
    "reseal.stop": "Detener el cambio de clave",
    "reseal.stopTitle": "¿Detener el cambio de clave?",
    "reseal.stopBody":
      "Las copias hechas hasta ahora se eliminan y tu mediateca se queda como está, con tu clave de la mediateca actual.",
    "reseal.keepGoing": "Continuar",
    "reseal.stopConfirm": "Detener",
    "reseal.stoppedTitle": "Cambio de clave detenido",
    "reseal.stoppedMessage": "Tu mediateca sigue usando tu clave de la mediateca actual.",
    "reseal.unreadableTitle": "Archivos que tu clave no abre",
    "reseal.unreadableBody": "Estos archivos ya estaban dañados y no se pueden reproducir. Eliminarlos libera su espacio.",
    "reseal.unreadableLoading": "Cargando…",
    "reseal.unreadableNone": "No quedan archivos por eliminar.",
    "reseal.close": "Cerrar",
    "reseal.unreadableDelete.one": "Eliminar el archivo",
    "reseal.unreadableDelete.other": "Eliminar {count} archivos",
    "reseal.unreadableDeletedTitle": "Archivos eliminados",
    "reseal.unreadableDeletedMessage.one": "{count} archivo eliminado.",
    "reseal.unreadableDeletedMessage.other": "{count} archivos eliminados.",
    "reseal.unreadableDeleteFailed": "No se pudieron eliminar los archivos. Vuelve a intentarlo.",
    "codeSent": "Te enviamos un código de verificación. Revisa tu correo o tu app de autenticación.",
    "error.invalidPassword": "Contraseña incorrecta.",
    "error.invalidCode": "El código de verificación no es válido.",
    "error.generic": "No se pudo cambiar la clave. Vuelve a intentarlo.",
    "error.changed": "Tu mediateca cambió mientras se sustituía la clave. No ha cambiado nada. Vuelve a intentarlo.",
    "error.resealIncomplete": "Se añadieron archivos mientras se sustituía la clave. Elige Terminar el cambio de clave para copiarlos también.",
    "error.resealStopped": "Este cambio de clave se detuvo, así que no ha cambiado nada. Empieza de nuevo para sustituir la clave.",
    "error.notReencrypted": "Tu mediateca de {other} no se pudo volver a cifrar con la nueva clave desde aquí, así que no ha cambiado nada. Sustituye la clave desde los Ajustes de un ordenador que tenga tu clave actual.",
    "error.unreadable": "Tu clave actual no abre tu mediateca de {other}, así que no ha cambiado nada.",
    "error.notSnapshotted": "Tu mediateca de {other} tiene cambios que aún no se han guardado. Abre {other}, deja que termine de sincronizar y vuelve a intentarlo. No ha cambiado nada.",
    "error.reencryptFailed": "No se pudo volver a cifrar tu mediateca de {other} con la nueva clave. No ha cambiado nada. Vuelve a intentarlo.",
    "entry.title": "Sustituir la clave de la mediateca",
    "entry.body": "Crea una nueva clave y vuelve a cifrar los datos de tu mediateca.",
    "entry.button": "Crear una nueva clave",
    "copied": "Clave de la mediateca copiada.",
    "copyFailed": "No se pudo copiar la clave.",
  },
  nl: {
    dialogTitle: "Je mediatheeksleutel vervangen",
    keyLabel: "Nieuwe mediatheeksleutel",
    keyHint: "Bewaar deze sleutel op een veilige plek voordat je verdergaat.",
    copyButton: "Sleutel kopiëren",
    confirmLabel: "Ik begrijp dat andere sessies hierdoor worden beëindigd",
    passwordLabel: "Accountwachtwoord",
    noPasswordHint:
      "Je account heeft geen wachtwoord, dus een code bevestigt dat jij het bent: de code uit je authenticator-app als die aanstaat, anders een code die we je mailen als je verdergaat.",
    codeLabel: "Verificatiecode",
    codeHintEmail: "Vul de code in die we naar je e-mail hebben gestuurd.",
    codeHintTotp: "Vul de code uit je authenticator-app in.",
    submit: "Sleutel vervangen",
    working: "Vervangen…",
    cancel: "Annuleren",
    resealHint:
      "Als je mediatheek mediabestanden bevat, wordt elk bestand vóór de wissel met de nieuwe sleutel gekopieerd. Dat kan uren duren: houd {app} open tot het klaar is.",
    "reseal.title": "Je bestanden worden met de nieuwe sleutel gekopieerd",
    "reseal.readyTitle": "Alle bestanden zijn gekopieerd",
    "reseal.files": "{done} van {total} bestanden",
    "reseal.etaUnknown": "Resterende tijd wordt berekend…",
    "reseal.etaUnderMinute": "Nog minder dan een minuut",
    "reseal.etaMinutes": "Nog ongeveer {minutes} min",
    "reseal.etaHours": "Nog ongeveer {hours} u {minutes} min",
    "reseal.keepOpen": "Houd {app} open tot dit klaar is. Als {app} sluit, begint de sleutelwissel de volgende keer opnieuw.",
    "reseal.keepOpenPlugged":
      "Houd {app} open op het scherm en aan de lader tot dit klaar is. Als {app} sluit, begint de sleutelwissel de volgende keer opnieuw.",
    "reseal.mobileDataTitle": "Gepauzeerd op mobiele data",
    "reseal.mobileDataBody": "Het kopiëren gaat verder zodra deze telefoon op wifi is.",
    "reseal.useMobileData": "Mobiele data gebruiken",
    "reseal.useMobileDataHint":
      "Ook via mobiele data kopiëren. Elk mediabestand wordt gedownload en opnieuw geüpload, wat veel data kan kosten.",
    "reseal.finish": "Sleutelwissel afronden",
    "reseal.waitingTitle": "Wachten op een ander apparaat",
    "reseal.waitingBody.one": "Een ander apparaat uploadt nog {count} bestand. De sleutel wisselt zodra het klaar is.",
    "reseal.waitingBody.other": "Een ander apparaat uploadt nog {count} bestanden. De sleutel wisselt zodra ze klaar zijn.",
    "reseal.switchNowBody":
      "Het andere apparaat uploadt al meer dan 24 uur. Nu wisselen annuleert de onafgemaakte uploads; ze beginnen opnieuw nadat het met de nieuwe sleutel inlogt.",
    "reseal.switchNow": "Nu wisselen",
    "reseal.unreadable.one": "{count} bestand gaat niet open met je huidige sleutel. Het blijft zoals het is.",
    "reseal.unreadable.other": "{count} bestanden gaan niet open met je huidige sleutel. Ze blijven zoals ze zijn.",
    "reseal.seeFiles.one": "Bekijk het bestand",
    "reseal.seeFiles.other": "Bekijk de {count} bestanden",
    "reseal.moreOptions": "Meer opties",
    "reseal.stop": "Sleutelwissel stoppen",
    "reseal.stopTitle": "Sleutelwissel stoppen?",
    "reseal.stopBody":
      "De kopieën die al gemaakt zijn worden verwijderd en je mediatheek blijft zoals hij is, met je huidige mediatheeksleutel.",
    "reseal.keepGoing": "Doorgaan",
    "reseal.stopConfirm": "Stoppen",
    "reseal.stoppedTitle": "Sleutelwissel gestopt",
    "reseal.stoppedMessage": "Je mediatheek gebruikt nog steeds je huidige mediatheeksleutel.",
    "reseal.unreadableTitle": "Bestanden die je sleutel niet opent",
    "reseal.unreadableBody":
      "Deze bestanden waren al beschadigd en kunnen niet worden afgespeeld. Verwijderen maakt hun ruimte vrij.",
    "reseal.unreadableLoading": "Laden…",
    "reseal.unreadableNone": "Geen bestanden meer om te verwijderen.",
    "reseal.close": "Sluiten",
    "reseal.unreadableDelete.one": "Het bestand verwijderen",
    "reseal.unreadableDelete.other": "{count} bestanden verwijderen",
    "reseal.unreadableDeletedTitle": "Bestanden verwijderd",
    "reseal.unreadableDeletedMessage.one": "{count} bestand verwijderd.",
    "reseal.unreadableDeletedMessage.other": "{count} bestanden verwijderd.",
    "reseal.unreadableDeleteFailed": "De bestanden konden niet worden verwijderd. Probeer het opnieuw.",
    "codeSent": "We hebben een verificatiecode gestuurd. Kijk in je e-mail of je authenticator-app.",
    "error.invalidPassword": "Onjuist wachtwoord.",
    "error.invalidCode": "De verificatiecode is ongeldig.",
    "error.generic": "De sleutel kon niet worden vervangen. Probeer het opnieuw.",
    "error.changed": "Je mediatheek is veranderd terwijl de sleutel werd vervangen. Er is niets veranderd. Probeer het opnieuw.",
    "error.resealIncomplete": "Er zijn bestanden toegevoegd terwijl de sleutel werd vervangen. Kies Sleutelwissel afronden om ze ook te kopiëren.",
    "error.resealStopped": "Deze sleutelwissel is gestopt, er is niets veranderd. Begin opnieuw om de sleutel te vervangen.",
    "error.notReencrypted": "Je {other}-mediatheek kon hier niet opnieuw worden vergrendeld met de nieuwe sleutel, dus er is niets veranderd. Vervang de sleutel via Instellingen op een computer die je huidige sleutel heeft.",
    "error.unreadable": "Je huidige sleutel opent je {other}-mediatheek niet, dus er is niets veranderd.",
    "error.notSnapshotted": "Je {other}-mediatheek heeft wijzigingen die nog niet zijn opgeslagen. Open {other}, laat het klaar synchroniseren en probeer het dan opnieuw. Er is niets veranderd.",
    "error.reencryptFailed": "Je {other}-mediatheek kon niet opnieuw worden vergrendeld met de nieuwe sleutel. Er is niets veranderd. Probeer het opnieuw.",
    "entry.title": "Mediatheeksleutel vervangen",
    "entry.body": "Maak een nieuwe sleutel en vergrendel de gegevens van je mediatheek opnieuw.",
    "entry.button": "Nieuwe sleutel maken",
    "copied": "Mediatheeksleutel gekopieerd.",
    "copyFailed": "Sleutel kon niet worden gekopieerd.",
  },
};

const fill = (text: string, vars?: Record<string, string | number>): string =>
  text.replace(/\{(\w+)\}/g, (_, name: string) => (vars?.[name] === undefined ? `{${name}}` : String(vars[name])));

/** The key change's text in `language`; `{app}` and other variables filled in. */
export const keyChangeText =
  (language: ClientUiLanguage) =>
  (key: KeyChangeStringKey, vars?: Record<string, string | number>): string =>
    fill(keyChangeStrings[language][key], vars);

/** A counted sentence ("3 files can't be opened…"), its form picked by `count` and `language`'s plural rule. */
export const keyChangeCountText = (
  language: ClientUiLanguage,
  key: KeyChangeCountedKey,
  count: number,
): string => {
  const form = new Intl.PluralRules(language).select(count) === "one" ? "one" : "other";
  return fill(keyChangeStrings[language][`${key}.${form}`], { count });
};

/** "About 2 h 5 min left", "About 4 min left", "Less than a minute left" (ACCT-KEYCHG-09). */
export const keyChangeEtaText = (language: ClientUiLanguage, seconds: number | null): string => {
  const t = keyChangeText(language);
  if (seconds === null) return t("reseal.etaUnknown");
  if (seconds < 60) return t("reseal.etaUnderMinute");
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return t("reseal.etaMinutes", { minutes });
  return t("reseal.etaHours", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
};
