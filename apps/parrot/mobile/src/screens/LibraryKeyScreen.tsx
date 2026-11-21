// The account's library key on Parrot phone (PRIV-KEY-01, UX-KEY-01): one key for Badger and Parrot (Chris 2026-11-12
// (chat): "they share the key and everything related to it"). When any app already holds the account's key probe, the
// key is typed and checked against it (UX-SETUP-06); when none does (a new account, or after the account-wide erase),
// Parrot makes the key itself and shows its 12 words to write down, as Badger does and as Parrot desktop does
// (`createLibraryKey`). The screen is the shared library key step (`MobileLibraryKeyStep`), in the setup's key step and
// here (after a sign-out once setup is done). Chris 2026-11-12 (chat): "the setup step to enter/save the key should be
// the same shared one between the 2 apps".
import React, { useCallback, useEffect, useState } from "react";
import { SafeAreaView } from "react-native-safe-area-context";
import { getLibraryMetaForKeyStep, resetLibrary } from "@space/shared/api";
import { checkLibraryKey } from "@space/mobile-shell/libraryKey";
import { generateLibraryKeyWords, type LibraryKeyInput } from "@space/shared/libraryKeyWords";
import { isClientUiLanguage } from "@space/shared/i18n";
import { keySavedWarningText } from "@space/shared/keySavedWarning";
import { decryptBase64ToBytes } from "@space/mobile-shell/libraryEnvelope";
import { useTranslation } from "@space/mobile-shell/i18n";
import { MobileKeySavedWarning } from "@space/mobile-shell/key-saved-warning";
import { MobileMascotLoader } from "@space/mobile-shell/mascot-loader";
import { MobileLibraryKeyStep, type MobileLibraryKeyStepProps } from "@space/mobile-shell/library-key-step";
import { PARROT_MASCOT } from "../brand";
import { useSession } from "../state/session";
import { useSignOut } from "../state/useSignOut";
import { KeyPairingPanel } from "./PairingPanel";
import { scopeLogger } from "@space/mobile-shell/logger";
import { claimAccountKey } from "../lib/library";

const log = scopeLogger("library-key");

/** `checking` until the account's meta says whether a key exists; `enter` types it; `create` shows a new one. */
type KeyStepMode = "checking" | "enter" | "create";

/**
 * The key step's state: whether the account already has a key (any app's probe, read account-wide by the API), the
 * boxes' read and its check against the probe, the new key made when there is none, and the account-wide erase.
 */
export const useLibraryKeyEntry = () => {
  const { session, saveLibraryKey } = useSession();
  const { t, i18n } = useTranslation();
  const uiLanguage = i18n?.language;
  const language = isClientUiLanguage(uiLanguage) ? uiLanguage : "en";
  const token = session?.token ?? null;
  const [mode, setMode] = useState<KeyStepMode>("checking");
  const [input, setInput] = useState<LibraryKeyInput>({ status: "empty" });
  const [newKey, setNewKey] = useState<{ words: string[]; keyBase64: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setValue = (_text: string, result: LibraryKeyInput) => {
    setInput(result);
    setError(null);
  };

  /** No app holds a probe: the account has no key yet, so Parrot makes it (12 words in the app's language). */
  const makeKey = useCallback(() => {
    const generated = generateLibraryKeyWords(language);
    setNewKey({ words: generated.words, keyBase64: generated.keyBase64 });
    setError(null);
    setMode("create");
    log.info("library_key.generated");
  }, [language]);

  /** Same rule as Badger (bd8b196c2, 791aa12f8): a probe from either app → type the key; none → make one. */
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void getLibraryMetaForKeyStep(token, "parrot").then(
      (meta) => {
        if (cancelled) return;
        log.info("library_key.start", { hasKeyProbe: Boolean(meta.keyProbe) });
        if (meta.keyProbe) setMode("enter");
        else makeKey();
      },
      (err: unknown) => {
        if (cancelled) return;
        // Unknown: never make a key that could replace the account's real one; ask for it, saying why.
        log.warn("library_key.meta_failed", { message: err instanceof Error ? err.message : String(err) });
        setError(t("parrot.key.errors.unavailable"));
        setMode("enter");
      },
    );
    return () => {
      cancelled = true;
    };
    // On the session only: `makeKey` follows the language, and a language change must not replace a key already shown.
  }, [token]);

  /** Enter mode. True once the key is saved. */
  const submit = async (): Promise<boolean> => {
    if (!token || input.status !== "ok") return false;
    setError(null);
    setBusy(true);
    try {
      const meta = await getLibraryMetaForKeyStep(token, "parrot");
      const result = await checkLibraryKey(input.keyBase64, meta.keyProbe, decryptBase64ToBytes);
      if (result === "ok") {
        await saveLibraryKey(input.keyBase64);
        return true;
      }
      if (result === "no_probe") {
        // The key was erased meanwhile (from another app): the account has none, so this phone makes it.
        makeKey();
        return false;
      }
      // The words always make a well-formed key, so a key that is not one is a key that does not open the library.
      setError(t("libraryKeyStep.wrongKey"));
    } catch (err) {
      log.warn("library_key.check_failed", { message: err instanceof Error ? err.message : String(err) });
      setError(t("parrot.key.errors.unavailable"));
    } finally {
      setBusy(false);
    }
    return false;
  };

  /**
   * Create mode, after "Yes, I understand". The account's meta is read again: a key made meanwhile on another device
   * wins (this one would lock it out), so the step asks for that key instead. Otherwise the new key becomes the
   * account's before it is kept: an empty library published with it writes the account's key probe (UX-KEY-01), so
   * the other devices and this phone's own start check know it. True once the new key is saved.
   */
  const keepNewKey = async (): Promise<boolean> => {
    if (!token || !newKey) return false;
    setError(null);
    setBusy(true);
    const madeElsewhere = () => {
      log.info("library_key.made_elsewhere");
      setNewKey(null);
      setMode("enter");
    };
    try {
      const meta = await getLibraryMetaForKeyStep(token, "parrot");
      if (meta.keyProbe) {
        madeElsewhere();
        return false;
      }
      // A library from before key probes has no probe to write over version 0; its snapshot stays the key check.
      if (!meta.exists) {
        try {
          await claimAccountKey(token, newKey.keyBase64);
        } catch (claimErr) {
          log.warn("library_key.claim_failed", { message: claimErr instanceof Error ? claimErr.message : String(claimErr) });
          // Another device may have made the account's key first (the PUT over version 0 then fails): ask for it.
          const after = await getLibraryMetaForKeyStep(token, "parrot").catch(() => null);
          if (after?.keyProbe) {
            madeElsewhere();
            return false;
          }
          throw claimErr;
        }
      }
      await saveLibraryKey(newKey.keyBase64);
      log.info("library_key.created", { claimed: !meta.exists });
      return true;
    } catch (err) {
      log.warn("library_key.create_failed", { message: err instanceof Error ? err.message : String(err) });
      setError(t("parrot.key.errors.unavailable"));
    } finally {
      setBusy(false);
    }
    return false;
  };

  // Account-wide (Chris 2026-11-12 (chat): "they share the key and everything related to it"). API errors reject
  // unchanged: the erase dialog says why and stays open. Done, the account has no key: this phone makes the new one.
  const erase = async (password: string, twoFactorCode?: string): Promise<void> => {
    if (!token) return;
    await resetLibrary(token, password, twoFactorCode);
    log.info("library_key.erased");
    makeKey();
  };

  return {
    mode,
    words: newKey?.words ?? [],
    language,
    setValue,
    ready: input.status === "ok",
    busy,
    error,
    submit,
    keepNewKey,
    regenerate: makeKey,
    erase,
  };
};

/** The shared key step with Parrot's check, new key, other-device panel and erase. */
export const ParrotLibraryKeyStep = ({
  onKeySaved,
  ...rest
}: { onKeySaved?: () => void } & Pick<MobileLibraryKeyStepProps, "step" | "total" | "header" | "onLanguage">) => {
  const { t } = useTranslation();
  // No key is held on this step, so this signs out at once (ACCT-DEV-03 asks only a key holder). Back signs out: the
  // step before the key is the sign-in (UX-SETUP-03).
  const signOut = useSignOut();
  const entry = useLibraryKeyEntry();
  const [warningOpen, setWarningOpen] = useState(false);
  if (entry.mode === "checking") return <MobileMascotLoader app="parrot" source={PARROT_MASCOT} size={120} />;
  const show = entry.mode === "create";
  // ACCT-DEV-04: the new key's line and the warning before leaving it, in Parrot's word for the library.
  const warning = keySavedWarningText(entry.language, "parrot");
  return (
    <MobileLibraryKeyStep
      {...rest}
      mode={show ? "show" : "enter"}
      title={show ? t("parrot.key.showTitle") : t("parrot.key.title")}
      body={show ? warning.stepLine : t("parrot.key.body")}
      onBack={() => void signOut()}
      words={show ? entry.words : undefined}
      onRegenerate={show ? entry.regenerate : undefined}
      onKeyChange={entry.setValue}
      // Only an existing key can come from another device; a new one is made here.
      renderOtherDevice={show ? undefined : () => <KeyPairingPanel onKeySaved={() => onKeySaved?.()} />}
      // Show mode: "I've written it down" opens the warning; only its "Yes, I understand" keeps the key.
      continueLabel={show ? warning.saved : undefined}
      canContinue={show || entry.ready}
      onContinue={
        show
          ? () => setWarningOpen(true)
          : () => void entry.submit().then((saved) => (saved ? onKeySaved?.() : undefined))
      }
      busy={entry.busy}
      error={entry.error}
      onErase={show ? undefined : entry.erase}
      overlay={
        <MobileKeySavedWarning
          visible={warningOpen}
          text={warning}
          onBack={() => setWarningOpen(false)}
          onConfirm={() => {
            setWarningOpen(false);
            void entry.keepNewKey().then((saved) => (saved ? onKeySaved?.() : undefined));
          }}
        />
      }
    />
  );
};

/**
 * After a sign-out once the setup is done: the same step, without the setup's numbering; below the status bar, as the
 * setup's own key step (`SetupFlow`).
 */
export const LibraryKeyScreen = () => (
  <SafeAreaView style={{ flex: 1 }} edges={["top"]}>
    <ParrotLibraryKeyStep header={null} />
  </SafeAreaView>
);
