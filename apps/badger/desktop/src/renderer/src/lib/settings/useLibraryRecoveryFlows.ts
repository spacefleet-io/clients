import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, reauthSession, resetLibrary } from "@/api";
import { LibraryDb } from "@/lib/libraryDb";
import { rotateWithOtherLibraries, rotationRefusalText } from "@/lib/rotationRefusal";
import { useAuth, useHasPassword } from "../../auth";
import { useLibraryActions } from "@/lib/libraryContext";
import { encryptBytesToBase64 } from "@/lib/crypto";
import { clearLibraryKey, getStoredLibraryKey, getStoredLibraryKeyWords, storeLibraryKey } from "@/lib/onboarding";
import { generateLibraryKeyWords, libraryKeyWordsText, type NewLibraryKey } from "@space/shared/libraryKeyWords";
import { notify } from "@/lib/notify";
import { tooManyAttemptsText } from "@space/shared/signInError";

const resolveTwoFactorMethod = (payload: { method?: unknown }) =>
  payload.method === "totp" ? "totp" : "email";

/** The key Show key reveals: its words, or null when this device received the key from another device by pairing. */
export type ShownLibraryKey = { key: string; words: string[] | null };

/**
 * The three encryption-key recovery flows — reveal key, rotate key, reset
 * library — each a full reauth + optional 2FA state machine. Lifted wholesale
 * out of the old Settings God component (which kept all 30 of these state vars
 * inline) into a single hook the Security section consumes. Behavior is
 * preserved exactly; the hardcoded English notify titles are the only fix.
 */
export function useLibraryRecoveryFlows() {
  const { t, i18n } = useTranslation();
  const { token, logout } = useAuth();
  const hasPassword = useHasPassword();
  const { exportLocalDb, clearLocalCache } = useLibraryActions();

  // --- reveal key ---
  const [showKeyOpen, setShowKeyOpen] = useState(false);
  const [showKeyPassword, setShowKeyPassword] = useState("");
  const [showKeyCode, setShowKeyCode] = useState("");
  const [showKeyNeedsCode, setShowKeyNeedsCode] = useState(false);
  const [showKeyMethod, setShowKeyMethod] = useState<"email" | "totp" | null>(null);
  const [showKeyBusy, setShowKeyBusy] = useState(false);
  const [showKeyError, setShowKeyError] = useState<string | null>(null);
  const [showKeyNotice, setShowKeyNotice] = useState<string | null>(null);
  const [showKeyValue, setShowKeyValue] = useState<ShownLibraryKey | null>(null);

  // --- rotate key ---
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState<NewLibraryKey | null>(null);
  const [recoveryConfirmed, setRecoveryConfirmed] = useState(false);
  const [recoveryPassword, setRecoveryPassword] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [recoveryNeedsCode, setRecoveryNeedsCode] = useState(false);
  const [recoveryMethod, setRecoveryMethod] = useState<"email" | "totp" | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null);

  // --- reset library ---
  const [resetOpen, setResetOpen] = useState(false);
  const [resetConfirmed, setResetConfirmed] = useState(false);
  const [resetPassword, setResetPassword] = useState("");
  const [resetCode, setResetCode] = useState("");
  const [resetNeedsCode, setResetNeedsCode] = useState(false);
  const [resetMethod, setResetMethod] = useState<"email" | "totp" | null>(null);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetNotice, setResetNotice] = useState<string | null>(null);
  const [resetResending, setResetResending] = useState(false);

  useEffect(() => {
    if (!recoveryOpen) return;
    setRecoveryKey(generateLibraryKeyWords(i18n.language));
    setRecoveryConfirmed(false);
    setRecoveryPassword("");
    setRecoveryCode("");
    setRecoveryNeedsCode(false);
    setRecoveryMethod(null);
    setRecoveryError(null);
    setRecoveryNotice(null);
  }, [recoveryOpen]);

  useEffect(() => {
    if (!showKeyOpen) return;
    setShowKeyPassword("");
    setShowKeyCode("");
    setShowKeyNeedsCode(false);
    setShowKeyMethod(null);
    setShowKeyBusy(false);
    setShowKeyError(null);
    setShowKeyNotice(null);
    setShowKeyValue(null);
  }, [showKeyOpen]);

  useEffect(() => {
    if (!resetOpen) return;
    setResetConfirmed(false);
    setResetPassword("");
    setResetCode("");
    setResetNeedsCode(false);
    setResetMethod(null);
    setResetError(null);
    setResetNotice(null);
    setResetResending(false);
  }, [resetOpen]);

  const buildKeyProbe = async (key: string) => {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return encryptBytesToBase64(key, bytes);
  };

  const copyKey = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      notify({ title: t("settings.recovery.copyToastTitle"), message: t("settings.recovery.rotate.copySuccess"), level: "success", ephemeral: true });
    } catch {
      notify({ title: t("settings.recovery.errorToastTitle"), message: t("settings.recovery.rotate.copyFail"), level: "error", ephemeral: true });
    }
  };

  const copyRecoveryKey = async () => {
    if (!recoveryKey) return;
    await copyKey(libraryKeyWordsText(recoveryKey.words));
  };

  /** The words when this device has them; a key received from another device has none, so its base64 is copied. */
  const copyShowKey = async () => {
    if (!showKeyValue) return;
    await copyKey(showKeyValue.words ? libraryKeyWordsText(showKeyValue.words) : showKeyValue.key);
  };

  const submitShowKey = async () => {
    if (!token || showKeyBusy) return;
    setShowKeyBusy(true);
    setShowKeyError(null);
    setShowKeyNotice(null);
    try {
      await reauthSession(token, showKeyPassword, showKeyCode || undefined);
      const key = await getStoredLibraryKey();
      if (!key) {
        setShowKeyError(t("settings.recovery.show.errorMissing"));
        return;
      }
      setShowKeyValue({ key, words: await getStoredLibraryKeyWords().catch(() => null) });
      setShowKeyNeedsCode(false);
      setShowKeyMethod(null);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.payload.error === "invalid_password") {
          setShowKeyError(t("settings.recovery.show.errorInvalidPassword"));
        } else if (err.payload.error === "two_factor_required") {
          setShowKeyNeedsCode(true);
          setShowKeyMethod(resolveTwoFactorMethod(err.payload));
          setShowKeyNotice(t("settings.recovery.show.codeSent"));
        } else if (err.payload.error === "two_factor_invalid") {
          setShowKeyError(t("settings.recovery.show.errorTwoFactorInvalid"));
        } else {
          // ACCT-AUTH-11: too many wrong passwords or codes (429, OPS-LIMIT-05) says when to try again.
          setShowKeyError(tooManyAttemptsText(t, err) ?? t("settings.recovery.show.errorGeneric"));
        }
      } else {
        setShowKeyError(t("settings.recovery.show.errorGeneric"));
      }
    } finally {
      setShowKeyBusy(false);
    }
  };

  const submitRecovery = async () => {
    if (!token || !recoveryKey || !recoveryConfirmed || recoveryBusy) return;
    setRecoveryBusy(true);
    setRecoveryError(null);
    setRecoveryNotice(null);
    try {
      const rawBytes = await exportLocalDb();
      const blobBase64 = await encryptBytesToBase64(recoveryKey.keyBase64, rawBytes);
      const keyProbe = await buildKeyProbe(recoveryKey.keyBase64);
      // PRIV-KEY-06: Parrot's library is re-encrypted with this computer's current key, never emptied; without the
      // key here none is sent and the server refuses the rotation if Parrot has a library.
      const oldKey = await getStoredLibraryKey();
      await rotateWithOtherLibraries({
        token,
        blobBase64,
        keyProbe,
        password: recoveryPassword,
        twoFactorCode: recoveryCode || undefined,
        reencrypt: () => (oldKey ? LibraryDb.reencryptForRotation(token, oldKey, recoveryKey.keyBase64) : Promise.resolve([])),
      });
      await clearLibraryKey();
      await storeLibraryKey(recoveryKey.keyBase64, recoveryKey.words);
      setRecoveryOpen(false);
      // The rotation signs every session out (revokeAllSessions); keep the new key just stored.
      await logout("sessionRejected");
    } catch (err) {
      const refusal = rotationRefusalText(t, err);
      if (refusal) {
        setRecoveryError(refusal);
      } else if (err instanceof ApiError) {
        if (err.payload.error === "invalid_password") {
          setRecoveryError(t("settings.recovery.rotate.errorInvalidPassword"));
        } else if (err.payload.error === "two_factor_required") {
          setRecoveryNeedsCode(true);
          setRecoveryMethod(resolveTwoFactorMethod(err.payload));
          setRecoveryNotice(t("settings.recovery.rotate.codeSent"));
        } else if (err.payload.error === "two_factor_invalid") {
          setRecoveryError(t("settings.recovery.rotate.errorTwoFactorInvalid"));
        } else {
          setRecoveryError(tooManyAttemptsText(t, err) ?? t("settings.recovery.rotate.errorGeneric"));
        }
      } else {
        setRecoveryError(t("settings.recovery.rotate.errorGeneric"));
      }
    } finally {
      setRecoveryBusy(false);
    }
  };

  const submitReset = async () => {
    if (!token || !resetConfirmed || resetBusy) return;
    setResetBusy(true);
    setResetError(null);
    setResetNotice(null);
    try {
      await resetLibrary(token, resetPassword, resetCode || undefined);
      // API reset succeeded — ensure logout always runs even if local cleanup fails.
      await clearLibraryKey().catch(() => undefined);
      await clearLocalCache().catch(() => undefined);
      setResetOpen(false);
      // The library was reset and its key is gone.
      await logout("signOut");
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.payload.error === "invalid_password") {
          setResetError(t("settings.recovery.reset.errorInvalidPassword"));
        } else if (err.payload.error === "two_factor_required") {
          setResetNeedsCode(true);
          setResetMethod(resolveTwoFactorMethod(err.payload));
          setResetNotice(t("settings.recovery.reset.codeSent"));
        } else if (err.payload.error === "two_factor_invalid") {
          setResetError(t("settings.recovery.reset.errorTwoFactorInvalid"));
        } else {
          setResetError(tooManyAttemptsText(t, err) ?? t("settings.recovery.reset.errorGeneric"));
        }
      } else {
        setResetError(t("settings.recovery.reset.errorGeneric"));
      }
    } finally {
      setResetBusy(false);
    }
  };

  const resendResetCode = async () => {
    // ACCT-AUTH-04: an account without a password has none to send; the code alone confirms it.
    if (!token || (hasPassword && !resetPassword.trim())) return;
    setResetResending(true);
    setResetError(null);
    try {
      await resetLibrary(token, resetPassword);
      setResetNeedsCode(true);
      setResetMethod("email");
      setResetNotice(t("settings.recovery.reset.codeResent"));
    } catch (err) {
      if (err instanceof ApiError && err.payload.error === "invalid_password") {
        setResetError(t("settings.recovery.reset.errorInvalidPassword"));
      } else {
        setResetError(t("settings.recovery.reset.errorGeneric"));
      }
    } finally {
      setResetResending(false);
    }
  };

  const anyDialogOpen = showKeyOpen || recoveryOpen || resetOpen;

  return {
    anyDialogOpen,
    // reveal
    showKeyOpen, setShowKeyOpen, showKeyValue, copyShowKey,
    showKeyPassword, setShowKeyPassword, showKeyNeedsCode, showKeyCode, setShowKeyCode,
    showKeyMethod, showKeyNotice, showKeyError, showKeyBusy, submitShowKey,
    // rotate
    recoveryOpen, setRecoveryOpen, recoveryKey, copyRecoveryKey, recoveryConfirmed, setRecoveryConfirmed,
    recoveryPassword, setRecoveryPassword, recoveryNeedsCode, recoveryCode, setRecoveryCode,
    recoveryMethod, recoveryNotice, recoveryError, recoveryBusy, submitRecovery,
    // reset
    resetOpen, setResetOpen, resetConfirmed, setResetConfirmed, resetPassword, setResetPassword,
    resetNeedsCode, resetCode, setResetCode, resetMethod, resetNotice, resetError, resetBusy,
    submitReset, resetResending, resendResetCode,
  };
}
