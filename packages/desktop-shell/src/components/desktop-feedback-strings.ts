import type { ClientUiLanguage } from "@space/shared/i18n";

/** Every sentence of the desktop "Send feedback" form (UX-SUP-05), with the error-log tick and its hint (UX-SUP-02). */
export type DesktopFeedbackStringKey = "title" | "send" | "cancel" | "sent" | "error" | "attachLog" | "attachLogHint";

/**
 * The form's text in the five client languages (UX-I18N-01), shared by Badger desktop and Parrot desktop so neither
 * keeps its own copy (REL-FAM-02, REL-FAM-05). The phones' form (`@space/mobile-shell`) has its own sentences: it
 * names the outcome of each refusal and has no Cancel, so the two are not one text.
 */
export const desktopFeedbackStrings: Record<ClientUiLanguage, Record<DesktopFeedbackStringKey, string>> = {
  en: {
    title: "Tell us what you think",
    send: "Send",
    cancel: "Cancel",
    sent: "Thanks, we got it.",
    error: "Could not send. Try again.",
    attachLog: "Attach the app's error log",
    attachLogHint: "Helps us find a problem. It contains no titles or file names.",
  },
  fr: {
    title: "Dites-nous ce que vous en pensez",
    send: "Envoyer",
    cancel: "Annuler",
    sent: "Merci, c’est bien reçu.",
    error: "Envoi impossible. Réessayez.",
    attachLog: "Joindre le journal d’erreurs de l’application",
    attachLogHint: "Nous aide à trouver un problème. Il ne contient ni titres ni noms de fichiers.",
  },
  nl: {
    title: "Vertel ons wat je ervan vindt",
    send: "Versturen",
    cancel: "Annuleren",
    sent: "Bedankt, ontvangen.",
    error: "Versturen mislukt. Probeer het opnieuw.",
    attachLog: "Foutenlogboek van de app bijvoegen",
    attachLogHint: "Helpt ons een probleem te vinden. Het bevat geen titels of bestandsnamen.",
  },
  de: {
    title: "Sag uns, was du denkst",
    send: "Senden",
    cancel: "Abbrechen",
    sent: "Danke, ist angekommen.",
    error: "Senden fehlgeschlagen. Versuche es erneut.",
    attachLog: "Fehlerprotokoll der App anhängen",
    attachLogHint: "Hilft uns, ein Problem zu finden. Es enthält keine Titel oder Dateinamen.",
  },
  es: {
    title: "Cuéntanos qué opinas",
    send: "Enviar",
    cancel: "Cancelar",
    sent: "Gracias, lo recibimos.",
    error: "No se pudo enviar. Vuelve a intentarlo.",
    attachLog: "Adjuntar el registro de errores de la app",
    attachLogHint: "Nos ayuda a encontrar un problema. No contiene títulos ni nombres de archivos.",
  },
};
