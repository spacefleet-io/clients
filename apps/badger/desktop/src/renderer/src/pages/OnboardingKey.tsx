import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import ReauthPasswordField from "@/components/ReauthPasswordField";
import { ApiError, getLibraryMeta, resetLibrary, rotateLibraryKey } from "@/api";
import {
  acknowledgeLibraryKey,
  clearLibraryKey,
  getStoredLibraryKey,
  isLibraryKeyAcknowledged,
  storeLibraryKey,
} from "@/lib/onboarding";
import { isDecryptFailureMessage, useLibraryActions, useLibraryShell } from "@/lib/libraryContext";
import { LibraryDb } from "@/lib/libraryDb";
import { loadClientConfig, saveClientConfig } from "@/lib/config";
import { decryptBase64ToBytes, encryptBytesToBase64 } from "@/lib/crypto";
import { deriveNoStoredKeyDecision, deriveOnboardingRemoteDecision } from "@/lib/onboardingKeyDecision";
import type { OnboardingRemoteDecision } from "@/lib/onboardingKeyDecision";
import { generateLibraryKeyWords, libraryKeyWordsText, type NewLibraryKey } from "@space/shared/libraryKeyWords";
import { LibraryKeyWordsGrid } from "@space/ui/library-key-words";
import { getActionableDesktopErrorMessage } from "@/lib/actionableErrors";
import { Button } from "@space/ui";
import { Input } from "@space/ui";
import { Label } from "@space/ui";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@space/ui";
import { Checkbox } from "@space/ui";
import { Check, Copy, RotateCcw } from "lucide-react";
import { isClientUiLanguage } from "@space/shared";
import { tooManyAttemptsText } from "@space/shared/signInError";
import {
  DesktopStartupCard,
  DesktopStartupControls,
  DesktopStartupPage,
  LIBRARY_KEY_STEP_FIT,
  LibraryKeyStep,
  libraryKeyEraseOutcomeOf,
  libraryKeyStepText,
  type LibraryKeyEraseOutcome,
  type LibraryKeyTyped,
} from "@space/desktop-shell/components";
import mascotWebp from "@/assets/mascot.webp";
import { verifyPairedKey, type ApprovedPairing, type PairedKeyCheck } from "@/lib/pairedSignIn";
import { pairedKeyCheckDeps } from "@/lib/pairedSignInDeps";
import { rendererLogger } from "@/logger";
import { loadFirstSetup } from "../components/firstSetupSteps";
import SetupLanguageMenu from "@/components/SetupLanguageMenu";
import { useProfiles } from "@/lib/profileStore";
import { needsProfileSetupStep } from "@space/desktop-shell/profile-setup";
import { noteSetupRun, titleQuestionExpected } from "@/lib/titleLanguageSetup";

const log = rendererLogger.child({ scope: "onboarding.key" });

export default function OnboardingKey() {
  const { user, token, logout } = useAuth();
  // ACCT-AUTH-04: an account without a password confirms the key change and the erase with a code alone.
  const hasPassword = user?.hasPassword !== false;
  const { error: libraryError } = useLibraryShell();
  const { reload, clearLocalCache, activateRemoteLibrary } = useLibraryActions();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const pairLanguage = isClientUiLanguage(i18n.language) ? i18n.language : "en";
  const [loadingKey, setLoadingKey] = useState(true);
  const [acknowledged, setAcknowledged] = useState(false);
  const [libraryKey, setLibraryKey] = useState<string | null>(null);
  const [libraryKeyWords, setLibraryKeyWords] = useState<string[] | null>(null);
  const [mode, setMode] = useState<"generate" | "enter">("generate");
  const pairingAvailable = Boolean(window.sf?.pairing);
  const [promptReason, setPromptReason] = useState<"invalid" | "remote" | "missing" | null>(null);
  // UX-SETUP-08: during this computer's first setup the key is "Step 1 of M", M counting the questions after it.
  const [setupStepsAfterKey, setSetupStepsAfterKey] = useState(0);
  // UX-SETUP-10 / ACCT-PROF-03: a new profile is asked "Your profile" right after the key ("Step 2 of M"), then a
  // profile created since the title question exists is asked it.
  const profiles = useProfiles();
  const keyProfile =
    profiles.profiles.find((profile) => profile.id === profiles.activeId) ??
    (profiles.profiles.length === 1 ? profiles.profiles[0] : undefined);
  const profileStepAfterKey = window.sf?.profileSetupOff !== true && needsProfileSetupStep(keyProfile) ? 1 : 0;
  const titleStepAfterKey = titleQuestionExpected(keyProfile) ? 1 : 0;
  const [enterError, setEnterError] = useState<string | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState(false);
  const [localCacheAvailable, setLocalCacheAvailable] = useState(false);
  const [recoverOpen, setRecoverOpen] = useState(false);
  const [recoverKey, setRecoverKey] = useState<NewLibraryKey | null>(null);
  const [recoverConfirmed, setRecoverConfirmed] = useState(false);
  const [recoverCopied, setRecoverCopied] = useState(false);
  const [recoverPassword, setRecoverPassword] = useState("");
  const [recoverCode, setRecoverCode] = useState("");
  const [recoverNeedsCode, setRecoverNeedsCode] = useState(false);
  const [recoverMethod, setRecoverMethod] = useState<"email" | "totp" | null>(null);
  const [recoverBusy, setRecoverBusy] = useState(false);
  const [recoverError, setRecoverError] = useState<string | null>(null);
  const [recoverNotice, setRecoverNotice] = useState<string | null>(null);
  const [generateRequested, setGenerateRequested] = useState(false);

  const syncActiveMediaKey = async (key: string | null) => {
    await window.sf?.setMediaKey?.(key ?? null).catch(() => undefined);
    if (key && user) {
      await window.sf?.forwardKeyToRuntime?.(user.id, key).catch(() => undefined);
    }
  };

  const startGenerateFlow = async () => {
    setGenerateError(null);
    setEnterError(null);
    const generated = generateLibraryKeyWords(i18n.language);
    await storeLibraryKey(generated.keyBase64, generated.words);
    setLibraryKey(generated.keyBase64);
    setLibraryKeyWords(generated.words);
    setMode("generate");
    setPromptReason("missing");
    setGenerateRequested(true);
  };

  useEffect(() => {
    let cancelled = false;
    const startedAt = Date.now();
    const step = (name: string, extra?: Record<string, unknown>) =>
      log.info({ step: name, elapsedMs: Date.now() - startedAt, cancelled, ...extra }, "key load step");
    const load = async () => {
      setLoadingKey(true);
      step("start", { hasToken: Boolean(token), libraryError: Boolean(libraryError) });
      const [keyAck, existingKey] = await Promise.all([
        isLibraryKeyAcknowledged().catch(() => false),
        getStoredLibraryKey().catch(() => null),
      ]);
      step("storedKey.done", { keyAck, hasExistingKey: Boolean(existingKey) });
      if (cancelled) return;
      setAcknowledged(keyAck);

      if (existingKey) {
        if (token) {
          try {
            step("existingKey.meta.start");
            const meta = await getLibraryMeta(token);
            step("existingKey.meta.done", { remoteExists: meta.exists, hasKeyProbe: Boolean(meta.keyProbe) });
            if (meta.exists) {
              if (meta.keyProbe) {
                await decryptBase64ToBytes(existingKey, meta.keyProbe);
              } else {
                if (!user) throw new Error("LIBRARY_USER_MISSING");
                const testDb = await LibraryDb.open(token, existingKey, user.id);
                testDb.close();
              }
              step("existingKey.verified");
              await syncActiveMediaKey(existingKey);
              step("existingKey.syncMediaKey.done");
              await acknowledgeLibraryKey();
              setLoadingKey(false);
              reload();
              navigate("/", { replace: true });
              return;
            }
            if (!meta.exists) {
              const decision = deriveOnboardingRemoteDecision({
                existingKey: false,
                libraryError: false,
                remoteExists: meta.exists,
                bootstrapRequired: meta.bootstrapRequired,
              });
              if (decision.mode === "generate") {
                await startGenerateFlow();
              } else {
                setMode(decision.mode);
                setPromptReason(decision.promptReason);
                setLibraryKey(null);
                setGenerateError(null);
                setEnterError(null);
              }
              setLoadingKey(false);
              return;
            }
          } catch (err) {
            if (err instanceof ApiError && err.status === 401) {
              await logout("sessionRejected");
              return;
            }
            if (isDecryptFailureMessage(err)) {
              await clearLibraryKey();
            }
          }
        }
        setMode("enter");
        setPromptReason("remote");
        setLibraryKey(null);
        setGenerateError(null);
        setEnterError(null);
        setLoadingKey(false);
        return;
      }

      if (libraryError) {
        const decision = deriveOnboardingRemoteDecision({
          existingKey: false,
          libraryError: true,
          remoteExists: false,
          bootstrapRequired: false,
        });
        setAcknowledged(false);
        setMode(decision.mode);
        setPromptReason(decision.promptReason);
        setLibraryKey(null);
        setLoadingKey(false);
        return;
      }

      if (!token) {
        setLoadingKey(true);
        return;
      }

      let decision: OnboardingRemoteDecision;
      try {
        step("meta.start");
        const meta = await getLibraryMeta(token);
        step("meta.done", { remoteExists: meta.exists, bootstrapRequired: meta.bootstrapRequired });
        decision = deriveNoStoredKeyDecision(meta);
      } catch (err) {
        if (!cancelled && err instanceof ApiError && err.status === 401) {
          await logout("sessionRejected");
          return;
        }
        if (cancelled) return;
        setAcknowledged(false);
        setMode("enter");
        setPromptReason("remote");
        setLibraryKey(null);
        setEnterError(t("onboarding.key.errorValidate"));
        setLoadingKey(false);
        return;
      }

      if (decision.mode === "generate") {
        await startGenerateFlow();
        step("generate.done");
      } else {
        setMode(decision.mode);
        setPromptReason(decision.promptReason);
        setLibraryKey(null);
      }
      setLoadingKey(false);
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [token, libraryError, logout, t, reload, navigate]);

  useEffect(() => {
    if (libraryError && mode === "enter") {
      setEnterError(t("onboarding.key.errorDecrypt"));
    }
  }, [libraryError, mode, t]);

  useEffect(() => {
    LibraryDb.hasLocalCache()
      .then((exists) => setLocalCacheAvailable(Boolean(exists)))
      .catch(() => setLocalCacheAvailable(false));
  }, []);

  useEffect(() => {
    if (!recoverOpen) return;
    setRecoverKey(generateLibraryKeyWords(i18n.language));
    setRecoverConfirmed(false);
    setRecoverCopied(false);
    setRecoverPassword("");
    setRecoverCode("");
    setRecoverNeedsCode(false);
    setRecoverMethod(null);
    setRecoverError(null);
    setRecoverNotice(null);
  }, [recoverOpen]);

  useEffect(() => {
    let cancelled = false;
    loadFirstSetup()
      .then((result) => {
        if (!cancelled && result.status === "deferred") setSetupStepsAfterKey(result.openSteps);
      })
      .catch((err: unknown) => log.warn({ err: String(err) }, "[onboarding.key] could not count the setup steps; no step count shown"));
    return () => {
      cancelled = true;
    };
  }, []);
  const setupTotal = 1 + profileStepAfterKey + titleStepAfterKey + setupStepsAfterKey;
  const setupProgress =
    setupTotal > 1
      ? {
          current: 1,
          total: setupTotal,
          label: t("firstSetup.stepOf", { current: 1, total: setupTotal }),
          testId: "onboarding-key-progress",
        }
      : undefined;
  useEffect(() => {
    if (profileStepAfterKey === 0 && titleStepAfterKey === 0) return;
    log.info(
      { total: setupTotal, profileStep: profileStepAfterKey === 1, titleStep: titleStepAfterKey === 1 },
      "[onboarding.key] the profile questions follow the key in this setup"
    );
    noteSetupRun({ total: setupTotal, profileStep: profileStepAfterKey === 1, titleStep: titleStepAfterKey === 1 });
  }, [profileStepAfterKey, titleStepAfterKey, setupTotal]);

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (loadingKey) {
    return (
      <DesktopStartupPage nebula="badger">
        <div className="grid min-h-full w-full place-items-center">
          <div className="text-sm text-muted-foreground">{t("onboarding.key.loading")}</div>
        </div>
      </DesktopStartupPage>
    );
  }

  if (acknowledged && !libraryError) {
    return <Navigate to="/home" replace />;
  }

  const continueNext = () => {
    if (!libraryKey || savingKey) return;
    setSavingKey(true);
    setGenerateError(null);
    const run = async () => {
      const startedAt = Date.now();
      const step = (name: string, extra?: Record<string, unknown>) =>
        log.info({ step: name, elapsedMs: Date.now() - startedAt, ...extra }, "continueNext step");
      step("meta.start");
      const meta = token ? await getLibraryMeta(token).catch(() => null) : null;
      step("meta.done", { exists: meta?.exists ?? null });
      if (token && !meta?.exists) {
        step("activate.start");
        await activateRemoteLibrary(token, libraryKey);
        step("activate.done");
      }
      await syncActiveMediaKey(libraryKey);
      step("syncMediaKey.done");
      await acknowledgeLibraryKey();
      step("acknowledge.done");
      const current = loadClientConfig();
      if (!current.configured) {
        saveClientConfig({ ...current, configured: true });
      }
      if (meta?.exists) {
        step("activate.start");
        await activateRemoteLibrary(token!, libraryKey);
        step("activate.done");
      }
      // Navigate first so the LibraryProvider observes the post-onboarding
      // route (`suspendLoad=false`), then bump the reload nonce to force
      // `load()` to re-run with the freshly-acknowledged key. The sibling
      // "enter an existing key" and recovery branches already call
      // `reload()` for the same reason; the generate-new-key branch was
      // missing it, which left `useLibraryActions()` with `db = null` and
      // ingestion flows throwing `LIBRARY_NOT_READY` in fresh-account E2E.
      navigate("/", { replace: true });
      reload();
    };
    run()
      .catch(async (err) => {
        // Surface the underlying error so integration tests and real-world
        // deployments can diagnose why the user sees the generic
        // "Could not create the initial library" message.
        log.error({ err }, "continueNext failed");
        const actionableMessage = getActionableDesktopErrorMessage(err);
        if (actionableMessage) {
          setGenerateError(actionableMessage);
          return;
        }
        if (err instanceof ApiError) {
          if (err.status === 401) {
            setGenerateError(t("onboarding.key.errorCreateAuth"));
            return;
          }
          if (err.payload?.error === "version_conflict") {
            await clearLibraryKey();
            setLibraryKey(null);
            setMode("enter");
            setPromptReason("remote");
            setEnterError(t("onboarding.key.errorCreateConflict"));
            return;
          }
        }
        if (isDecryptFailureMessage(err)) {
          await clearLibraryKey();
          setLibraryKey(null);
          setMode("enter");
          setPromptReason("remote");
          setEnterError(libraryKeyStepText(pairLanguage, "badger")("wrongKey"));
          return;
        }
        if (import.meta.env.DEV && err instanceof Error && err.message) {
          setGenerateError(`${t("onboarding.key.errorCreate")} (${err.message})`);
          return;
        }
        setGenerateError(t("onboarding.key.errorCreate"));
      })
      .finally(() => setSavingKey(false));
  };

  /**
   * A key that opens the account's library (typed, or from another device): keep it and open the library. Typed words
   * are kept with it so Show key can show them; a key from another device comes without words.
   */
  const keepKeyAndOpenLibrary = async (sessionToken: string, key: string, words: string[] | null = null) => {
    await storeLibraryKey(key, words);
    await syncActiveMediaKey(key);
    await acknowledgeLibraryKey();
    await activateRemoteLibrary(sessionToken, key);
    const current = loadClientConfig();
    if (!current.configured) {
      saveClientConfig({ ...current, configured: true });
    }
    navigate("/", { replace: true });
  };

  /**
   * ACCT-PAIR-01: another signed-in device approved the key-only request. The key is checked like a paired sign-in's
   * (nothing is stored on "mismatch"), then kept exactly like a typed key. The session is this window's own.
   */
  const completeKeyPairing = async (approved: ApprovedPairing): Promise<PairedKeyCheck> => {
    const check = await verifyPairedKey(pairedKeyCheckDeps, approved.token, approved.libraryKey, approved.user.id);
    log.info({ check, userId: approved.user.id }, "key from another device checked");
    if (check === "verified") await keepKeyAndOpenLibrary(approved.token, approved.libraryKey);
    return check;
  };

  /** The step's Continue: the step keeps the typed words and shows "Validating…" until this settles. */
  const submitEnteredKey = async ({ keyBase64, words }: LibraryKeyTyped) => {
    if (!token) return;
    setEnterError(null);
    try {
      // Lightweight validation: ensure the API has a DB and that we can decrypt it later.
      const meta = await getLibraryMeta(token);
      // The account's key probe decides first (PRIV-KEY-01: one key per account, the probe is the account's): with
      // no Badger library yet, a key made in Parrot is still the only right one, and a wrong key here would encrypt
      // Badger's library under it and split the apps for good. WebCrypto rejects a wrong key with a bare
      // OperationError, so any failure to open the probe is a wrong key.
      if (meta.keyProbe) {
        const opened = await decryptBase64ToBytes(keyBase64, meta.keyProbe).then(
          () => true,
          () => false,
        );
        if (!opened) {
          setEnterError(libraryKeyStepText(pairLanguage, "badger")("wrongKey"));
          return;
        }
      }
      if (!meta.exists) {
        if (meta.bootstrapRequired) {
          await keepKeyAndOpenLibrary(token, keyBase64, words);
          return;
        }
        // Keep typed key in local state and avoid wiping stored key on transient/remote issues.
        setMode("enter");
        setPromptReason("missing");
        setEnterError(t("onboarding.key.errorNoRemote"));
        return;
      }

      if (!meta.keyProbe) {
        if (!user) throw new Error("LIBRARY_USER_MISSING");
        const testDb = await LibraryDb.open(token, keyBase64, user.id);
        testDb.close();
      }

      await keepKeyAndOpenLibrary(token, keyBase64, words);
    } catch (err) {
      setEnterError(isDecryptFailureMessage(err) ? libraryKeyStepText(pairLanguage, "badger")("wrongKey") : t("onboarding.key.errorValidate"));
    }
  };

  const buildKeyProbe = async (key: string) => {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return encryptBytesToBase64(key, bytes);
  };

  const copyRecoverKey = async () => {
    if (!recoverKey) return;
    setRecoverCopied(false);
    try {
      await navigator.clipboard.writeText(libraryKeyWordsText(recoverKey.words));
      setRecoverCopied(true);
      setTimeout(() => setRecoverCopied(false), 1500);
    } catch {
      setRecoverCopied(false);
    }
  };

  const submitRecover = async () => {
    if (!token || !recoverKey || !recoverConfirmed || recoverBusy) return;
    setRecoverBusy(true);
    setRecoverError(null);
    setRecoverNotice(null);
    try {
      const rawBytes = await LibraryDb.getLocalCacheBytes();
      if (!rawBytes) {
        setRecoverError(t("onboarding.recovery.errorNoLocal"));
        return;
      }
      const blobBase64 = await encryptBytesToBase64(recoverKey.keyBase64, rawBytes);
      const keyProbe = await buildKeyProbe(recoverKey.keyBase64);
      await rotateLibraryKey(token, blobBase64, keyProbe, recoverPassword, recoverCode || undefined);
      await storeLibraryKey(recoverKey.keyBase64, recoverKey.words);
      await syncActiveMediaKey(recoverKey.keyBase64);
      await acknowledgeLibraryKey();
      setRecoverOpen(false);
      // The rotation signs every session out (revokeAllSessions); keep the new key just stored.
      await logout("sessionRejected");
    } catch (err) {
      const actionableMessage = getActionableDesktopErrorMessage(err);
      if (actionableMessage) {
        setRecoverError(actionableMessage);
        return;
      }
      if (err instanceof ApiError) {
        if (err.payload.error === "invalid_password") {
          setRecoverError(t("onboarding.recovery.errorInvalidPassword"));
        } else if (err.payload.error === "two_factor_required") {
          setRecoverNeedsCode(true);
          setRecoverMethod((err.payload as any).method === "totp" ? "totp" : "email");
          setRecoverNotice(t("onboarding.recovery.codeSent"));
        } else if (err.payload.error === "two_factor_invalid") {
          setRecoverError(t("onboarding.recovery.errorTwoFactorInvalid"));
        } else {
          // ACCT-AUTH-11: too many wrong passwords or codes (429, OPS-LIMIT-05) says when to try again.
          setRecoverError(tooManyAttemptsText(t, err) ?? t("onboarding.recovery.errorGeneric"));
        }
      } else {
        setRecoverError(t("onboarding.recovery.errorGeneric"));
      }
    } finally {
      setRecoverBusy(false);
    }
  };

  /**
   * PRIV-KEY-01: the erase dialog's call. It erases the account's whole library (every profile, Badger and Parrot);
   * without a code it asks for one again ("Resend code"). Once erased, this computer starts over with a new key.
   */
  const eraseLibrary = async (password: string, twoFactorCode?: string): Promise<LibraryKeyEraseOutcome> => {
    if (!token) return { status: "failed", reason: "other" };
    try {
      await resetLibrary(token, password, twoFactorCode);
    } catch (err) {
      const outcome = libraryKeyEraseOutcomeOf(err);
      log.warn({ outcome, err: String(err) }, "library erase refused");
      return outcome;
    }
    await clearLibraryKey();
    await clearLocalCache();
    setAcknowledged(false);
    await startGenerateFlow();
    return { status: "erased" };
  };

  if (mode === "generate" && !libraryKey) {
    return (
      <DesktopStartupPage nebula="badger">
        <div className="grid min-h-full w-full place-items-center">
          <div className="text-sm text-muted-foreground">{t("onboarding.key.errorLoad")}</div>
        </div>
      </DesktopStartupPage>
    );
  }

  return (
    <DesktopStartupPage
      nebula="badger"
      // UX-SETUP-08: the language button keeps the window's top-right spot on every setup step, never inside the card.
      controls={
        <DesktopStartupControls>
          <SetupLanguageMenu />
        </DesktopStartupControls>
      }
      // UX-SETUP-08: framed like the other setup steps (no top bar, the mascot on the card); the shared tighter
      // spacing and less room around the card in a short window fit the smallest window (1200x600) with no scrolling.
      mainClassName="pb-8 pt-32 [@media(max-height:700px)]:pb-4 [@media(max-height:700px)]:pt-16"
    >
        <div className={`w-full max-w-2xl ${LIBRARY_KEY_STEP_FIT}`}>
          {/* UX-KEY-01: the step itself is the one Parrot desktop shows too; the page only frames it and does the calls.
              Entering a key and being shown a new one never look alike; the card's title says which it is. The enter
              screen says one sentence, the card's; no banner above it, whatever brought the user here. */}
          <DesktopStartupCard
            maxWidthClassName="max-w-2xl"
            progress={setupProgress}
            title={mode === "enter" ? t("onboarding.key.enterTitle") : t("onboarding.key.title")}
            titleAs="h1"
            description={mode === "enter" ? t("onboarding.key.enterSubtitle") : undefined}
            mascotSrc={mascotWebp}
            mascotAlt={t("brand.mascotAlt")}
            contentClassName="pt-0 pb-5"
          >
            {mode === "enter" ? (
              <LibraryKeyStep
                mode="enter"
                language={pairLanguage}
                app="badger"
                error={enterError}
                onSubmitKey={submitEnteredKey}
                pairing={
                  pairingAvailable
                    ? {
                        actions: window.sf!.pairing!,
                        onApproved: completeKeyPairing,
                        log: {
                          info: (message, extra) => log.info(extra ?? {}, message),
                          warn: (message, extra) => log.warn(extra ?? {}, message),
                          error: (message, extra) => log.error(extra ?? {}, message),
                        },
                      }
                    : undefined
                }
                onCreateKey={promptReason === "missing" ? startGenerateFlow : undefined}
                onErase={eraseLibrary}
                hasPassword={hasPassword}
                secondary={
                  localCacheAvailable ? (
                    <Button type="button" variant="secondary" className="gap-2" onClick={() => setRecoverOpen(true)}>
                      <RotateCcw className="h-4 w-4" />
                      <span>{t("onboarding.recovery.button")}</span>
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <LibraryKeyStep
                mode="show"
                language={pairLanguage}
                app="badger"
                words={libraryKeyWords ?? []}
                saving={savingKey}
                onSaved={continueNext}
                error={generateError}
                note={generateRequested ? undefined : t("onboarding.key.reasonMissing")}
              />
            )}
          </DesktopStartupCard>
        </div>

        <Dialog open={recoverOpen} onOpenChange={setRecoverOpen}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>{t("onboarding.recovery.title")}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-2 text-sm">
              <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-muted-foreground">
                {t("onboarding.recovery.subtitle")}
              </div>
              <div className="rounded-xl border border-border bg-muted/20 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="text-xs text-muted-foreground">{t("onboarding.recovery.keyLabel")}</div>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="shrink-0"
                    onClick={() => void copyRecoverKey()}
                    disabled={!recoverKey}
                    aria-label={t("onboarding.recovery.copy")}
                  >
                    {recoverCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
                {recoverKey ? <LibraryKeyWordsGrid words={recoverKey.words} className="mt-2" /> : null}
                <div className="mt-2 text-xs text-muted-foreground">{t("onboarding.recovery.keyHint")}</div>
              </div>
              <div className="flex items-center gap-3 rounded-md border border-border p-3">
                <Checkbox checked={recoverConfirmed} onCheckedChange={(checked) => setRecoverConfirmed(Boolean(checked))} />
                <span>{t("onboarding.recovery.confirmLabel")}</span>
              </div>
              <div className="grid gap-3">
                <ReauthPasswordField
                  id="recoverPassword"
                  label={t("onboarding.recovery.passwordLabel")}
                  value={recoverPassword}
                  onChange={setRecoverPassword}
                />
                {recoverNeedsCode ? (
                  <div className="grid gap-2">
                    <Label htmlFor="recoverCode">{t("onboarding.recovery.codeLabel")}</Label>
                    <Input
                      id="recoverCode"
                      value={recoverCode}
                      onChange={(e) => setRecoverCode(e.target.value)}
                      placeholder="123456"
                      autoComplete="one-time-code"
                    />
                    <div className="text-xs text-muted-foreground">
                      {recoverMethod === "totp"
                        ? t("onboarding.recovery.codeHintTotp")
                        : t("onboarding.recovery.codeHintEmail")}
                    </div>
                  </div>
                ) : null}
              </div>
              {recoverNotice ? (
                <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                  {recoverNotice}
                </div>
              ) : null}
              {recoverError ? (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {recoverError}
                </div>
              ) : null}
            </div>
            <DialogFooter className="gap-2">
              <Button type="button" variant="ghost" onClick={() => setRecoverOpen(false)}>
                {t("onboarding.recovery.cancel")}
              </Button>
              <Button
                type="button"
                onClick={submitRecover}
                disabled={!recoverConfirmed || (hasPassword && !recoverPassword.trim()) || recoverBusy}
              >
                {recoverBusy ? t("onboarding.recovery.working") : t("onboarding.recovery.submit")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
    </DesktopStartupPage>
  );
}
