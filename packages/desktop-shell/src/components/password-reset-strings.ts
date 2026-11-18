import type { ClientUiLanguage } from "@space/shared/i18n";

/**
 * Every sentence of "Forgot password?" on a computer (Badger and Parrot desktop, ACCT-AUTH-05): the link under the
 * sign-in form and the reset dialog (the email gets a code, then the code and a new password reset it).
 */
export type PasswordResetStringKey =
  | "button"
  | "title"
  | "subtitle"
  | "emailLabel"
  | "codeLabel"
  | "codePlaceholder"
  | "passwordLabel"
  | "passwordConfirmLabel"
  | "request"
  | "requesting"
  | "submit"
  | "submitting"
  | "cancel"
  | "resend"
  | "resending"
  | "noticeSent"
  | "noticeResent"
  | "noticeComplete"
  | "errorMismatch"
  | "errorInvalidCode"
  | "errorFailed"
  | "errorResend";

export const passwordResetStrings: Record<ClientUiLanguage, Record<PasswordResetStringKey, string>> = {
  en: {
    button: "Forgot password?",
    title: "Reset your password",
    subtitle: "We will email you a verification code to set a new password.",
    emailLabel: "Account email",
    codeLabel: "Verification code",
    codePlaceholder: "123456",
    passwordLabel: "New password",
    passwordConfirmLabel: "Confirm new password",
    request: "Send code",
    requesting: "Sending...",
    submit: "Update password",
    submitting: "Updating...",
    cancel: "Cancel",
    resend: "Resend code",
    resending: "Resending...",
    noticeSent: "If the email exists, we sent a verification code.",
    noticeResent: "We sent another verification code.",
    noticeComplete: "Password updated. Please sign in again.",
    errorMismatch: "Passwords do not match.",
    errorInvalidCode: "Verification code is invalid or expired.",
    errorFailed: "Could not reset the password right now.",
    errorResend: "Could not resend the code.",
  },
  fr: {
    button: "Mot de passe oublié ?",
    title: "Réinitialiser votre mot de passe",
    subtitle: "Nous envoyons un code de vérification pour définir un nouveau mot de passe.",
    emailLabel: "Email du compte",
    codeLabel: "Code de vérification",
    codePlaceholder: "123456",
    passwordLabel: "Nouveau mot de passe",
    passwordConfirmLabel: "Confirmer le nouveau mot de passe",
    request: "Envoyer le code",
    requesting: "Envoi...",
    submit: "Mettre à jour",
    submitting: "Mise à jour...",
    cancel: "Annuler",
    resend: "Renvoyer le code",
    resending: "Renvoi...",
    noticeSent: "Si l'email existe, nous avons envoyé un code de vérification.",
    noticeResent: "Nous avons renvoyé un code de vérification.",
    noticeComplete: "Mot de passe mis à jour. Veuillez vous reconnecter.",
    errorMismatch: "Les mots de passe ne correspondent pas.",
    errorInvalidCode: "Code invalide ou expiré.",
    errorFailed: "Impossible de réinitialiser le mot de passe.",
    errorResend: "Impossible de renvoyer le code.",
  },
  nl: {
    button: "Wachtwoord vergeten?",
    title: "Wachtwoord opnieuw instellen",
    subtitle: "We mailen je een verificatiecode waarmee je een nieuw wachtwoord instelt.",
    emailLabel: "E-mailadres van je account",
    codeLabel: "Verificatiecode",
    codePlaceholder: "123456",
    passwordLabel: "Nieuw wachtwoord",
    passwordConfirmLabel: "Nieuw wachtwoord bevestigen",
    request: "Code sturen",
    requesting: "Versturen...",
    submit: "Wachtwoord wijzigen",
    submitting: "Wijzigen...",
    cancel: "Annuleren",
    resend: "Code opnieuw sturen",
    resending: "Opnieuw sturen...",
    noticeSent: "Als dit e-mailadres bestaat, hebben we een verificatiecode gestuurd.",
    noticeResent: "We hebben nog een verificatiecode gestuurd.",
    noticeComplete: "Wachtwoord gewijzigd. Log opnieuw in.",
    errorMismatch: "De wachtwoorden komen niet overeen.",
    errorInvalidCode: "De verificatiecode is ongeldig of verlopen.",
    errorFailed: "Kan het wachtwoord nu niet opnieuw instellen.",
    errorResend: "Kan de code niet opnieuw sturen.",
  },
  de: {
    button: "Passwort vergessen?",
    title: "Passwort zurücksetzen",
    subtitle: "Wir schicken dir einen Bestätigungscode per E-Mail, mit dem du ein neues Passwort festlegst.",
    emailLabel: "E-Mail-Adresse des Kontos",
    codeLabel: "Bestätigungscode",
    codePlaceholder: "123456",
    passwordLabel: "Neues Passwort",
    passwordConfirmLabel: "Neues Passwort bestätigen",
    request: "Code senden",
    requesting: "Wird gesendet...",
    submit: "Passwort ändern",
    submitting: "Wird geändert...",
    cancel: "Abbrechen",
    resend: "Code erneut senden",
    resending: "Wird erneut gesendet...",
    noticeSent: "Falls die E-Mail-Adresse existiert, haben wir einen Bestätigungscode gesendet.",
    noticeResent: "Wir haben einen weiteren Bestätigungscode gesendet.",
    noticeComplete: "Passwort geändert. Bitte melde dich erneut an.",
    errorMismatch: "Die Passwörter stimmen nicht überein.",
    errorInvalidCode: "Der Bestätigungscode ist ungültig oder abgelaufen.",
    errorFailed: "Das Passwort kann gerade nicht zurückgesetzt werden.",
    errorResend: "Der Code konnte nicht erneut gesendet werden.",
  },
  es: {
    button: "¿Olvidaste tu contraseña?",
    title: "Restablece tu contraseña",
    subtitle: "Te enviaremos por correo un código de verificación para crear una nueva contraseña.",
    emailLabel: "Correo de la cuenta",
    codeLabel: "Código de verificación",
    codePlaceholder: "123456",
    passwordLabel: "Nueva contraseña",
    passwordConfirmLabel: "Confirma la nueva contraseña",
    request: "Enviar código",
    requesting: "Enviando...",
    submit: "Actualizar contraseña",
    submitting: "Actualizando...",
    cancel: "Cancelar",
    resend: "Reenviar código",
    resending: "Reenviando...",
    noticeSent: "Si el correo existe, te enviamos un código de verificación.",
    noticeResent: "Te enviamos otro código de verificación.",
    noticeComplete: "Contraseña actualizada. Vuelve a iniciar sesión.",
    errorMismatch: "Las contraseñas no coinciden.",
    errorInvalidCode: "El código de verificación no es válido o ha caducado.",
    errorFailed: "No se pudo restablecer la contraseña en este momento.",
    errorResend: "No se pudo reenviar el código.",
  },
};

export const passwordResetText =
  (language: ClientUiLanguage) =>
  (key: PasswordResetStringKey): string =>
    passwordResetStrings[language][key];
