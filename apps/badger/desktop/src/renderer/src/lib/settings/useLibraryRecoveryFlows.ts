import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, reauthSession, resetLibrary } from "@/api";
import {
  createKeyChange,
  KEY_CHANGE_IDLE,
  KEY_CHANGE_WAIT_POLL_MS,
  switchNowOpen,
  type KeyChange,
  type KeyChangeOutcome,
  type KeyChangeState,
  type UnreadableFile,
} from "@space/media-reseal";
import type { KeyChangeDialogView } from "@space/desktop-shell/components";
import { keyChangeCountText, keyChangeText } from "@space/shared/keyChangeText";
import { isClientUiLanguage } from "@space/shared";
import { LibraryDb } from "@/lib/libraryDb";
import { keyChangeFailureOf, keyChangeFailureText } from "@space/shared/keyChangeFailure";
import { DEFAULT_SPACE_APP_ID, SPACE_APP_NAMES } from "@space/shared/appScope";
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
  const language = isClientUiLanguage(i18n.language) ? i18n.language : "en";
  const keyChangeT = keyChangeText(language);
  const { token, logout } = useAuth();
  const hasPassword = useHasPassword();
  const { sealLibraryForRotation, clearLocalCache } = useLibraryActions();

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
  const [recoveryOpen, setRecoveryOpenState] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState<NewLibraryKey | null>(null);
  const [recoveryConfirmed, setRecoveryConfirmed] = useState(false);
  const [recoveryPassword, setRecoveryPassword] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [recoveryNeedsCode, setRecoveryNeedsCode] = useState(false);
  const [recoveryMethod, setRecoveryMethod] = useState<"email" | "totp" | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null);

  // --- the media re-seal of a key change (STOR-RESEAL-01, ACCT-KEYCHG-06..09), shared with every app ---
  const [keyChangeState, setKeyChangeState] = useState<KeyChangeState>(KEY_CHANGE_IDLE);
  const [unreadableOpen, setUnreadableOpen] = useState(false);
  const [unreadableFiles, setUnreadableFiles] = useState<UnreadableFile[] | null>(null);
  const [unreadableBusy, setUnreadableBusy] = useState(false);
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  /**
   * The key change of this dialog's new key. Its run's copies are sealed with that key, which lives only here: a run
   * found open without it (another session, a restart) is stopped and opened afresh, never finished with another key.
   */
  const keyChangeRef = useRef<KeyChange | null>(null);

  /** While media is being re-sealed or switched, the dialog closes only through Stop (ACCT-KEYCHG-08). */
  const keyChangeRunning = keyChangeState.phase !== "form";
  const setRecoveryOpen = (open: boolean) => {
    if (!open && keyChangeRunning) return;
    setRecoveryOpenState(open);
  };

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
    setKeyChangeState(KEY_CHANGE_IDLE);
    setUnreadableFiles(null);
    setUnreadableOpen(false);
    setStopConfirmOpen(false);
    keyChangeRef.current = null;
  }, [recoveryOpen]);

  // Leaving Settings pauses the re-seal; the copies made stay with the run until it is stopped or finished.
  useEffect(() => () => keyChangeRef.current?.pause(), []);

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

  /** The words for a refused or failed step; a code request shows the code field instead. */
  const showRecoveryError = (err: unknown) => {
    const failure = keyChangeFailureOf(err);
    if (failure.status === "codeNeeded") {
      setRecoveryNeedsCode(true);
      setRecoveryMethod(failure.method);
      setRecoveryNotice(keyChangeT("codeSent"));
    } else {
      // PRIV-KEY-06: Parrot's library is the one re-encrypted alongside.
      setRecoveryError(keyChangeFailureText(language, failure, SPACE_APP_NAMES.parrot));
    }
  };

  const busyRef = useRef(false);
  const runBusy = async (step: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setRecoveryBusy(true);
    setRecoveryError(null);
    setRecoveryNotice(null);
    try {
      await step();
    } finally {
      busyRef.current = false;
      setRecoveryBusy(false);
    }
  };

  /**
   * This dialog's key change. The switch publishes this library and Parrot's with their media references renamed to
   * the run's copies (STOR-RESEAL-01), under the new key, in the request that also switches the media (STOR-RESEAL-04).
   */
  const keyChangeFor = (signedIn: string, newKey: NewLibraryKey) => {
    keyChangeRef.current ??= createKeyChange({
      token: signedIn,
      newKeyBase64: newKey.keyBase64,
      app: {
        appId: DEFAULT_SPACE_APP_ID,
        oldKey: getStoredLibraryKey,
        // PRIV-KEY-13: this library as a snapshot under the new key (chunks uploaded), declaring its formats.
        sealOwnLibrary: sealLibraryForRotation,
        // PRIV-KEY-06: Parrot's library is re-encrypted with this computer's current key, never emptied.
        reencryptOtherLibraries: (oldKey, newKeyBase64, copies) =>
          LibraryDb.reencryptForRotation(signedIn, oldKey, newKeyBase64, copies),
        keyProbe: buildKeyProbe,
      },
      onState: (state) => {
        setKeyChangeState(state);
        if (state.phase === "waiting") setNow(Date.now());
        // The run opened: the code was spent on it (codes are single-use) and the switch asks nothing again.
        if (state.phase === "resealing") {
          setRecoveryCode("");
          setRecoveryNeedsCode(false);
        }
      },
    });
    return keyChangeRef.current;
  };

  /** After the switch: the new key is kept and every session signed out (the rotation revoked them). */
  const finishKeyChange = async (outcome: KeyChangeOutcome | null) => {
    if (outcome !== "switched" || !recoveryKey) return;
    keyChangeRef.current = null;
    await clearLibraryKey();
    await storeLibraryKey(recoveryKey.keyBase64, recoveryKey.words);
    setRecoveryOpenState(false);
    await logout("sessionRejected");
  };

  /**
   * Start (ACCT-KEYCHG-03): the password (and 2FA code) is checked first. Without media the key changes at once; with
   * media, every file is re-sealed under the new key first (STOR-RESEAL-01), then the key and the media switch together.
   * "Finish" (or try again) after a refused switch or an interrupted re-seal carries on with the same run.
   */
  const submitRecovery = async () => {
    if (!token || !recoveryKey || !recoveryConfirmed) return;
    const keyChange = keyChangeFor(token, recoveryKey);
    await runBusy(async () => {
      try {
        await finishKeyChange(
          keyChange.state().phase !== "form"
            ? await keyChange.resume()
            : await keyChange.start({ password: recoveryPassword, ...(recoveryCode ? { twoFactorCode: recoveryCode } : {}) })
        );
      } catch (err) {
        showRecoveryError(err);
      }
    });
  };

  /** "Switch now" (ACCT-KEYCHG-06): the other device's unfinished uploads are cancelled (STOR-RESEAL-10). */
  const switchNowKeyChange = () =>
    runBusy(async () => {
      try {
        await finishKeyChange((await keyChangeRef.current?.switchNow()) ?? null);
      } catch (err) {
        showRecoveryError(err);
      }
    });

  // STOR-RESEAL-08: a waiting switch asks the run whether the other uploads ended, then switches.
  useEffect(() => {
    const keyChange = keyChangeRef.current;
    if (keyChangeState.phase !== "waiting" || !keyChange) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      if (busyRef.current) return;
      void keyChange
        .poll()
        .then(finishKeyChange)
        // A failed look at the run is tried again on the next tick; a refused switch left the wait and says why.
        .catch((err: unknown) => {
          if (keyChange.state().phase !== "waiting") showRecoveryError(err);
        });
    }, KEY_CHANGE_WAIT_POLL_MS);
    return () => window.clearInterval(timer);
  }, [keyChangeState.phase]);

  /** Stop (ACCT-KEYCHG-08, confirmed): the copies are deleted and the library stays as it was (STOR-RESEAL-07). */
  const stopKeyChange = async () => {
    setStopConfirmOpen(false);
    try {
      await keyChangeRef.current?.stop();
    } catch (err) {
      showRecoveryError(err);
      return;
    }
    keyChangeRef.current = null;
    setRecoveryOpenState(false);
    notify({
      title: keyChangeT("reseal.stoppedTitle"),
      message: keyChangeT("reseal.stoppedMessage"),
      level: "info",
      ephemeral: true,
    });
  };

  /** "See the N files" (ACCT-KEYCHG-07): the files the old key could not open. */
  const showUnreadableFiles = async () => {
    setUnreadableOpen(true);
    setUnreadableFiles(null);
    const keyChange = keyChangeRef.current;
    setUnreadableFiles(keyChange ? await keyChange.unreadableFiles().catch(() => []) : []);
  };

  /** Deletes the unreadable files; they were lost already (STOR-RESEAL-05). */
  const deleteUnreadableFiles = async () => {
    const keyChange = keyChangeRef.current;
    if (!keyChange || !unreadableFiles?.length) return;
    setUnreadableBusy(true);
    try {
      await keyChange.deleteUnreadableFiles(unreadableFiles);
      setUnreadableFiles([]);
      notify({
        title: keyChangeT("reseal.unreadableDeletedTitle"),
        message: keyChangeCountText(language, "reseal.unreadableDeletedMessage", unreadableFiles.length),
        level: "success",
        ephemeral: true,
      });
    } catch {
      notify({
        title: t("settings.recovery.errorToastTitle"),
        message: keyChangeT("reseal.unreadableDeleteFailed"),
        level: "error",
        ephemeral: true,
      });
    } finally {
      setUnreadableBusy(false);
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
    keyChange: {
      ...keyChangeState, canSwitchNow: switchNowOpen(keyChangeState.switchNowAt, now),
      switchNow: switchNowKeyChange, stopConfirmOpen, setStopConfirmOpen, stop: stopKeyChange,
      unreadableOpen, setUnreadableOpen, unreadableFiles, unreadableBusy, showUnreadableFiles, deleteUnreadableFiles,
    } satisfies KeyChangeDialogView,
    // reset
    resetOpen, setResetOpen, resetConfirmed, setResetConfirmed, resetPassword, setResetPassword,
    resetNeedsCode, resetCode, setResetCode, resetMethod, resetNotice, resetError, resetBusy,
    submitReset, resetResending, resendResetCode,
  };
}
