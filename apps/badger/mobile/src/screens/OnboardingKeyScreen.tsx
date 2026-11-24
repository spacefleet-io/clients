// Badger's library key step (UX-KEY-01, ACCT-DEV-04): a new key's 12 words to write down, or the boxes for an existing
// library's key, on phone and TV. The screen is the shared step (`MobileLibraryKeyStep`), as in Parrot. Chris
// 2026-11-12 (chat): "the setup step to enter/save the key should be the same shared one between the 2 apps".
import React, { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, Text } from "react-native";
import { MobileScreen } from "@space/mobile-shell/components";
import { useAuth } from "../store/auth";
import { useLibrary } from "../store/library";
import { getLibraryMetaForKeyStep, resetLibrary } from "@space/shared/api";
import { libraryReadOpStreamVersion } from "../lib/library/libraryReads";
import { getStoredLibraryKey, setStoredLibraryKey, clearLibraryKey } from "../lib/onboarding";
import { generateLibraryKeyWords, readLibraryKeyInput } from "@space/shared/libraryKeyWords";
import { useSignOut } from "../lib/useSignOut";
import { SetupStepBar } from "../setup/BadgerSetupFlow";
import { decryptBase64ToBytes } from "../lib/crypto";
import { LibraryDb } from "../lib/libraryDb";
import { accountKeyState, generatedKeyAction, keyOnboardingStart } from "../lib/libraryMetaState";
import { classifyLibraryMeta, type LibraryMetaState } from "@space/shared/libraryMetaState";
import { theme } from "../theme/theme";
import { scopeLogger } from "@space/mobile-shell/logger";
import { useTranslation } from "@space/mobile-shell/i18n";
import { isClientUiLanguage } from "@space/shared/i18n";
import { keySavedWarningText } from "@space/shared/keySavedWarning";
import { MobileKeySavedWarning } from "@space/mobile-shell/key-saved-warning";
import { MobileLibraryKeyStep } from "@space/mobile-shell/library-key-step";
import { KeyFromAnotherDevice } from "./KeyFromAnotherDevice";

const log = scopeLogger("onboarding");

type OnboardingError =
  | "checkStatus"
  | "generate"
  | "initialize"
  | "noLibrary"
  | "unavailable"
  | "mismatch"
  | "validate";

/** Creates Badger's library with the account's key (made in Parrot), as "I've written it down" does for a new key. */
const createOwnLibrary = async (token: string, keyBase64: string) => {
  log.info("library.create_for_account_key");
  const db = await LibraryDb.open(token, keyBase64);
  // Await: acknowledgeKey() opens the same db files right after.
  await db.close();
};

export const OnboardingKeyScreen = () => {
  const { t, i18n } = useTranslation();
  const uiLanguage = i18n?.language;
  const keyWarningText = keySavedWarningText(isClientUiLanguage(uiLanguage) ? uiLanguage : "en", "badger");
  const { token, user } = useAuth();
  // A key already stored here (shown, not yet confirmed) asks whether it was saved first (ACCT-DEV-03).
  const signOut = useSignOut();
  const { acknowledgeKey, error: libraryError } = useLibrary();
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<"generate" | "enter">("generate");
  // The new key's words are only on screen here: the phone keeps the derived key, never the words.
  const [libraryKey, setLibraryKey] = useState<string | null>(null);
  const [newWords, setNewWords] = useState<string[]>([]);
  const [enteredKey, setEnteredKey] = useState("");
  const enteredRead = readLibraryKeyInput(enteredKey);
  // ACCT-DEV-04: "I've saved my key" opens the warning; only its "Yes, I understand" creates the library.
  const [keyWarningOpen, setKeyWarningOpen] = useState(false);
  const [error, setError] = useState<OnboardingError | null>(null);
  const [continuing, setContinuing] = useState(false);
  const continueInFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      const existing = await getStoredLibraryKey().catch(() => null);
      if (cancelled) return;
      if (existing && token) {
        const meta = await getLibraryMetaForKeyStep(token, "badger", undefined, libraryReadOpStreamVersion).catch(() => null);
        if (cancelled) return;
        if (!meta) {
          // Status unknown (API unreachable): keep the stored key; it may be the
          // user's only copy on this device. Ask to retry or enter it.
          setError("checkStatus");
          setMode("enter");
          setLoading(false);
          return;
        }
        // A probe from either app is the account's key (PRIV-KEY-01): check against it even with no Badger library.
        if (meta.exists || meta.keyProbe) {
          try {
            if (meta.keyProbe) {
              await decryptBase64ToBytes(existing, meta.keyProbe);
            } else {
              const testDb = await LibraryDb.open(token, existing);
              await testDb.close();
            }
            // The account's key, but no Badger library yet (the key was made in Parrot): create it with this key.
            if (classifyLibraryMeta(meta) === "absent") await createOwnLibrary(token, existing);
            await acknowledgeKey();
            return;
          } catch {
            await clearLibraryKey().catch(() => undefined);
          }
        }
      }
      if (!token) {
        setLoading(false);
        return;
      }
      let metaState: LibraryMetaState | null = null;
      try {
        metaState = accountKeyState(await getLibraryMetaForKeyStep(token, "badger", undefined, libraryReadOpStreamVersion));
      } catch {
        setError("checkStatus");
      }
      if (cancelled) return;
      if (keyOnboardingStart(metaState) === "enter") {
        setMode("enter");
        setLoading(false);
        return;
      }
      const generated = generateLibraryKeyWords(uiLanguage);
      await setStoredLibraryKey(generated.keyBase64);
      log.info("key.generated");
      if (cancelled) return;
      setLibraryKey(generated.keyBase64);
      setNewWords(generated.words);
      setMode("generate");
      setLoading(false);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const runContinue = useCallback(async () => {
    setError(null);
    if (!token) return;
    if (mode === "generate") {
      if (!libraryKey) {
        setError("generate");
        return;
      }
      try {
        log.info("library.create.start");
        const meta = await getLibraryMetaForKeyStep(token, "badger", undefined, libraryReadOpStreamVersion).catch(() => null);
        const action = generatedKeyAction(meta ? accountKeyState(meta) : null);
        if (action === "retry") {
          setError("unavailable");
          return;
        }
        if (action === "enterExisting") {
          await clearLibraryKey().catch(() => undefined);
          setLibraryKey(null);
          setMode("enter");
          return;
        }
        const db = await LibraryDb.open(token, libraryKey);
        await db.close();
        log.info("library.create.done");
        await acknowledgeKey();
      } catch (err) {
        log.error("library.create.failed", { error: err instanceof Error ? err.message : String(err) });
        setError("initialize");
      }
      return;
    }

    const read = readLibraryKeyInput(enteredKey);
    log.info("validate.start", { status: read.status, words: read.status === "ok" ? Boolean(read.words) : null });
    if (read.status !== "ok") return;
    const normalized = read.keyBase64;

    setLoading(true);
    try {
      const meta = await getLibraryMetaForKeyStep(token, "badger", undefined, libraryReadOpStreamVersion);
      log.info("validate.meta", { exists: meta.exists, hasKeyProbe: Boolean(meta.keyProbe) });
      // The account's key may have been made in Parrot: a probe from either app means a key exists, even with no
      // Badger library yet (KeyProbeFix 791aa12f8, same rule as Badger desktop bd8b196c2).
      const own = classifyLibraryMeta(meta);
      const account = accountKeyState(meta);
      if (account !== "present") {
        setError(account === "absent" ? "noLibrary" : "unavailable");
        setLoading(false);
        return;
      }
      if (own === "unavailable") {
        setError("unavailable");
        setLoading(false);
        return;
      }
      if (meta.keyProbe) {
        log.info("validate.decrypt_probe");
        await decryptBase64ToBytes(normalized, meta.keyProbe);
        log.info("validate.decrypt_ok");
      } else {
        const testDb = await LibraryDb.open(token, normalized);
        // Await: acknowledgeKey() opens the same db files right after.
        await testDb.close();
      }
      await setStoredLibraryKey(normalized);
      log.info("validate.key_stored");
      if (own === "absent") await createOwnLibrary(token, normalized);
      await acknowledgeKey();
      log.info("validate.acknowledged");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("validate.error", { error: msg });
      setError(err instanceof Error && err.message === "DECRYPT_FAILED" ? "mismatch" : "validate");
    } finally {
      setLoading(false);
    }
  }, [acknowledgeKey, enteredKey, libraryKey, mode, token]);

  // Ignore Continue while a press is still running: on a slow TV box nothing shows for ~20 s, and a second
  // press started a second library create that raced the first one and failed both (#1074). The ref catches
  // a press that lands before the busy button re-renders.
  const handleContinue = useCallback(async () => {
    if (continueInFlight.current) return;
    continueInFlight.current = true;
    setContinuing(true);
    try {
      await runContinue();
    } finally {
      continueInFlight.current = false;
      setContinuing(false);
    }
  }, [runContinue]);

  const handleRegenerate = useCallback(async () => {
    const generated = generateLibraryKeyWords(uiLanguage);
    await setStoredLibraryKey(generated.keyBase64);
    setLibraryKey(generated.keyBase64);
    setNewWords(generated.words);
    setKeyWarningOpen(false);
  }, [uiLanguage]);

  // "Lost your key?": erases the account's library, Badger's and Parrot's (one key and vault for both, Chris
  // 2026-11-12 (chat): "they share the key and everything related to it"), then a new key to write down, as on the
  // desktop. API errors reject unchanged: the erase dialog says why and stays open.
  const handleErase = useCallback(
    async (password: string, twoFactorCode?: string) => {
      if (!token) return;
      await resetLibrary(token, password, twoFactorCode);
      log.info("library.erased");
      await clearLibraryKey().catch(() => undefined);
      await LibraryDb.clearLocalCache().catch((err: unknown) =>
        log.warn("library.erase.cache_clear_failed", { error: err instanceof Error ? err.message : String(err) }),
      );
      await handleRegenerate();
      setError(null);
      setMode("generate");
    },
    [handleRegenerate, token],
  );

  if (loading) {
    return (
      <MobileScreen>
        <Text style={styles.muted}>{t("onboarding.loading")}</Text>
      </MobileScreen>
    );
  }

  const show = mode === "generate";
  // A wrong key reads the same on every client (UX-KEY-01): the shared key step's sentence.
  const errorText = error
    ? t(error === "mismatch" ? "libraryKeyStep.wrongKey" : `onboarding.errors.${error}`)
    : !show && libraryError
      ? libraryError
      : null;
  return (
    // Back signs out: the setup's previous step is the sign-in (UX-SETUP-03). The header is Badger's: "step N of M"
    // with the language button while the phone's setup is open, the TV's own steps on the TV, nothing after.
    <MobileLibraryKeyStep
      mode={show ? "show" : "enter"}
      title={show ? t("onboarding.showTitle") : t("onboarding.enterTitle")}
      body={show ? keyWarningText.stepLine : t("onboarding.subtitle")}
      header={<SetupStepBar />}
      onBack={() => void signOut()}
      words={newWords}
      onRegenerate={() => void handleRegenerate()}
      onKeyChange={(text) => setEnteredKey(text)}
      // Only an existing library has a key another device can send; a new one gets its key made here (ACCT-PAIR-01).
      renderOtherDevice={show ? undefined : () => <KeyFromAnotherDevice />}
      // Show mode: "I've written it down" opens the warning; only its "Yes, I understand" creates the library.
      // Enter mode: the shared "Continue", as in Parrot (Main 2026-11-12: Continue bottom-right for both apps).
      continueLabel={show ? keyWarningText.saved : undefined}
      canContinue={show || enteredRead.status === "ok"}
      onContinue={show ? () => setKeyWarningOpen(true) : () => void handleContinue()}
      busy={continuing}
      error={errorText}
      onErase={show ? undefined : handleErase}
      hasPassword={user?.hasPassword !== false}
      overlay={
        <MobileKeySavedWarning
          visible={keyWarningOpen}
          text={keyWarningText}
          onBack={() => setKeyWarningOpen(false)}
          onConfirm={() => {
            setKeyWarningOpen(false);
            void handleContinue();
          }}
        />
      }
    />
  );
};

const styles = StyleSheet.create({
  muted: {
    color: theme.colors.textMuted,
  },
});
