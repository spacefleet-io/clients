import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useRuntimeInstanceId } from "@space/desktop-shell/services/runtime-status";
import {
  getMe,
  getSystemContract,
  getSystemContractIssue,
  login as apiLogin,
  logout as apiLogout,
  setApiBaseUrl,
  updateSettings,
  User,
} from "./api";
import { resetClientStorage } from "@/lib/clientReset";
import { logoutStep } from "@/lib/logoutStep";
import { setMetadataUrlOverride, startMetadataTicketsAfterKeyStep, stopMetadataTickets } from "@/lib/metadataTickets";
import { isLibraryKeyAcknowledged, onLibraryKeyAcknowledged } from "@/lib/onboarding";
import { shouldClearSessionFromAuthError } from "@/authSession";
import { clearLastAuthenticatedRoute } from "@/lib/routePersistence";
import { persistSessionToMain } from "@/lib/sessionMirror";
import { AUTH_TOKEN_KEY as TOKEN_KEY } from "../../shared/sessionKeys";
import { rendererLogger } from "@/logger";
import { useClientConfig } from "@/lib/useClientConfig";
import {
  deviceUiLanguageNow,
  showUiLanguage,
  subscribeUiLanguagePicks,
} from "@/lib/accountUiLanguage";
import { accountLanguageOf, reconcileAccountLanguage } from "@space/shared/accountLanguage";
import type { AccountLanguage } from "@space/shared";
import { AccountLanguageDialog, type AccountLanguageQuestion } from "@space/ui";
import { keyAfterSignedOut, type SignedOutReason } from "@space/shared/keptLibraryKey";
import { DESKTOP_TOUR_STORAGE_KEYS } from "@space/desktop-shell/tour";

const logoutFlushLog = rendererLogger.child({ scope: "logout-flush" });
const logoutLog = rendererLogger.child({ scope: "logout" });
const languageLog = rendererLogger.child({ scope: "account-language" });

/**
 * Flush any pending local library writes to the remote API before the local
 * SQLite cache is discarded as part of logout. Without this, writes made just
 * before logout (e.g., addMediaFromCatalog) are lost when the user logs back in
 * because the snapshot never reached the API. Must not block logout: if the
 * API is unreachable we log a warning and let logout proceed — the user's
 * intent to sign out wins.
 *
 * The timeout (15s) budgets for flushPending's own internal waits — up to 3s
 * for an idle-scheduled persist plus 5s for an in-flight ops flush plus
 * per-op network upload time. A shorter race used to abandon the flush mid-
 * upload, after which clearLocalCache() raced with the still-running runtime
 * flushPending and triggered a "Cannot use a closed database" quarantine.
 * The runtime service now serializes db lifecycle ops against in-flight
 * calls, but the renderer still honours a bounded logout.
 */
const flushPendingLibraryWrites = async () => {
  const bridge = window.sf?.libraryDb;
  if (!bridge?.call) return;
  const flushPromise = bridge.call({ method: "flushPending", args: [] });
  try {
    await Promise.race([
      flushPromise,
      new Promise<void>((resolve) => setTimeout(resolve, 15_000)),
    ]);
  } catch (error) {
    logoutFlushLog.warn(
      { err: error instanceof Error ? error.message : String(error) },
      "flush pending library writes failed; proceeding with logout"
    );
  }
  // Swallow any late rejection from the still-pending flushPromise so we
  // don't surface an unhandled rejection after logout completes.
  void flushPromise.catch(() => undefined);
};

const USER_KEY = "sf_client_user";

const readStoredUser = () => {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as User;
    return parsed ?? null;
  } catch {
    localStorage.removeItem(USER_KEY);
    return null;
  }
};

export type AuthContextValue = {
  user: User | null;
  token: string | null;
  loading: boolean;
  systemIssue: string | null;
  login: (
    email: string,
    password: string,
    twoFactorCode?: string,
    resendTwoFactor?: boolean
  ) => Promise<void>;
  setSession: (token: string, user: User) => void;
  /**
   * True while a fresh sign-in's language is being settled with the account (UX-I18N-07): the setup waits for it, so
   * "Which language do you want?" comes before step 1 instead of over it (UX-SETUP-08).
   */
  languageSettling: boolean;
  /**
   * The user's own Sign out forgets the library key; a session the server refused or ended (expired, password
   * changed, key rotated) keeps it so signing in again opens the library (ACCT-DEV-01, `keyAfterSignedOut`).
   */
  logout: (reason: SignedOutReason) => Promise<void>;
  setUser: (user: User | null) => void;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const { t } = useTranslation();
  const [token, setToken] = useState<string | null>(() =>
    localStorage.getItem(TOKEN_KEY)
  );
  const [user, setUser] = useState<User | null>(() => readStoredUser());
  const [loading, setLoading] = useState(true);
  const [systemIssue, setSystemIssue] = useState<string | null>(null);
  const clientConfig = useClientConfig();
  // Bumps every time the runtime transitions to "ready" (first spawn AND any
  // restart). Threaded into the attach-auth and configure-scheduling effects
  // below so they refire when the runtime has lost its in-memory ingest state.
  // Without this, a `bun --hot` reload or runtime crash leaves the runtime
  // with no token for new ingest/replan jobs — see plan
  // `all-newly-added-jobs-cuddly-cookie`, Bug B.
  const runtimeInstanceId = useRuntimeInstanceId();

  useEffect(() => {
    const load = async () => {
      const configuredApiBase = await window.sf?.apiHost?.get?.().catch(() => null);
      if (configuredApiBase?.apiBaseUrl) {
        setApiBaseUrl(configuredApiBase.apiBaseUrl);
      }
      setMetadataUrlOverride(configuredApiBase?.metadataUrl);
      const contract = await getSystemContract().catch(() => null);
      setSystemIssue(getSystemContractIssue(contract, "badger"));
      if (!token) {
        setLoading(false);
        return;
      }

      try {
        const result = await getMe(token);
        // `access` rides on the user object; fall back to the top-level copy of older APIs.
        setUser({ ...result.user, access: result.user.access ?? result.access });
      } catch (error) {
        if (shouldClearSessionFromAuthError(error)) {
          localStorage.removeItem(TOKEN_KEY);
          localStorage.removeItem(USER_KEY);
          void stopMetadataTickets();
          void persistSessionToMain();
          setToken(null);
          setUser(null);
        }
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [token]);

  // The app language is the account's (UX-I18N-07): one language for every app, profile and e-mail.
  //  - Right after a sign-in, sign-up or pairing (`setSession`), `reconcileAccountLanguage` settles this computer's
  //    language with the account's, asking which one when they differ (`AccountLanguageDialog`).
  //  - Otherwise, whenever the user (startup, `/auth/me` refresh) carries an account language, this computer shows it:
  //    that is how a change made on another device arrives here.
  //  - A language control's choice while signed in (`pickUiLanguage`, Settings) is saved to the account.
  const [languageQuestion, setLanguageQuestion] = useState<
    { question: AccountLanguageQuestion; answer: (language: AccountLanguage) => void } | null
  >(null);
  const reconcilingRef = useRef(false);
  const [languageSettling, setLanguageSettling] = useState(false);
  const accountLanguage = accountLanguageOf(user);
  const accountLanguageRef = useRef(accountLanguage);
  accountLanguageRef.current = accountLanguage;

  const saveAccountLanguage = async (sessionToken: string, userId: string, language: AccountLanguage) => {
    try {
      const result = await updateSettings(sessionToken, { preferences: { uiLanguage: language } });
      languageLog.info({ language }, "account_language.saved");
      setUser((current) =>
        current && current.id === userId
          ? {
              ...current,
              uiLanguage: language,
              preferences: { ...current.preferences, uiLanguage: language },
              access: current.access ?? result.user.access,
            }
          : current
      );
    } catch (err) {
      languageLog.warn(
        { language, message: err instanceof Error ? err.message : String(err) },
        "account_language.save_failed"
      );
    }
  };

  const askAccountLanguage = (question: AccountLanguageQuestion): Promise<AccountLanguage> => {
    const { promise, resolve } = Promise.withResolvers<AccountLanguage>();
    setLanguageQuestion({
      question,
      answer: (language) => {
        setLanguageQuestion(null);
        resolve(language);
      },
    });
    return promise;
  };

  const reconcileAfterSignIn = (sessionToken: string, signedIn: User) => {
    reconcilingRef.current = true;
    setLanguageSettling(true);
    void reconcileAccountLanguage({
      device: deviceUiLanguageNow(),
      account: accountLanguageOf(signedIn),
      ask: askAccountLanguage,
      saveAccount: (language) => saveAccountLanguage(sessionToken, signedIn.id, language),
      applyDevice: (language) => showUiLanguage(language),
    })
      .catch((err) => {
        languageLog.warn({ message: err instanceof Error ? err.message : String(err) }, "account_language.reconcile_failed");
      })
      .finally(() => {
        reconcilingRef.current = false;
        setLanguageSettling(false);
      });
  };

  useEffect(() => {
    if (!token || !accountLanguage || reconcilingRef.current) return;
    const shown = deviceUiLanguageNow();
    if (shown === accountLanguage) return;
    languageLog.info({ from: shown, to: accountLanguage }, "account_language.applied_from_account");
    showUiLanguage(accountLanguage);
  }, [token, accountLanguage]);

  useEffect(() => {
    if (!token || !user?.id) return;
    const userId = user.id;
    return subscribeUiLanguagePicks((language) => {
      if (accountLanguageRef.current === language) return;
      languageLog.info({ language, account: accountLanguageRef.current }, "account_language.picked");
      void saveAccountLanguage(token, userId, language);
    });
  }, [token, user?.id]);

  useEffect(() => {
    void window.sf?.setAuthToken?.(token ?? null).catch(() => undefined);
  }, [token]);

  // Forward the bearer token to the runtime's badger module so ingest steps
  // (Extract/Upload) can read `getActiveIngestToken()` and reach storage with
  // proper auth. Without this, jobs fail at the Extracting step with
  // "BADGER_AUTH_NOT_READY". Fires on every (token, user.id) change AND on
  // every runtime respawn — see runtimeInstanceId above. The runtime's
  // in-memory IngestUserState map is wiped on restart, so we must re-issue
  // badger.ingest.open to repopulate it.
  useEffect(() => {
    if (!token || !user?.id) return;
    void window.sf?.runtimeJobs?.attachAuth?.({ userId: user.id, token }).catch((err) => {
      rendererLogger.error(
        { scope: "auth", message: err instanceof Error ? err.message : String(err) },
        "runtimeJobs.attachAuth failed",
      );
    });
  }, [token, user?.id, runtimeInstanceId]);

  // Bind the ingest-concurrency settings to the live V2 jobs engine. The
  // engineV2 `format` (transcode) and `source` (extraction) lane caps track
  // Settings → Video in real time — no runtime restart needed. Gated on auth
  // (token + user.id) the same way the attach-auth effect above is, because
  // the runtimeJobs IPC layer (runtimeJobsIpc.ts) throws
  // RUNTIME_JOBS_AUTH_REQUIRED when the backend token is not yet set. Firing
  // pre-auth would surface that as a console error and break the
  // console-error guard of the e2e/integration suites (guardConsoleErrors). Caps fire (a) when
  // the user authenticates and (b) on any subsequent setting change.
  const maxParallelTranscodes = clientConfig.maxParallelTranscodes;
  const maxParallelExtractions = clientConfig.maxParallelExtractions;
  useEffect(() => {
    if (!token || !user?.id) return;
    void window.sf?.runtimeJobs
      ?.configureScheduling?.({ maxParallelTranscodes, maxParallelExtractions })
      .catch((err) => {
        rendererLogger.error(
          { scope: "auth", message: err instanceof Error ? err.message : String(err) },
          "runtimeJobs.configureScheduling failed",
        );
      });
  }, [token, user?.id, maxParallelTranscodes, maxParallelExtractions, runtimeInstanceId]);

  // META-ANON-02: keep a reserve of anonymous lookup tickets while signed in (issued in batches by the API, spent
  // one per lookup straight at the metadata service). Started on sign-in and on every launch with a session, once
  // the library key step is done (META-ANON-11: a refill keeps the renderer busy, and the key page is the first
  // screen after sign-in); cleared on sign-out (logout() and the expired-session path above). Only once `loading` is
  // over: until then the configured API base (apiHost, set in load()) is not applied yet, and the session bearer of
  // an account on a custom host would go to the default API host.
  useEffect(() => {
    if (loading || !token || !user?.id) return;
    return startMetadataTicketsAfterKeyStep({ isAcknowledged: isLibraryKeyAcknowledged, onAcknowledged: onLibraryKeyAcknowledged });
  }, [loading, token, user?.id]);

  useEffect(() => {
    if (user) {
      localStorage.setItem(USER_KEY, JSON.stringify(user));
    } else {
      localStorage.removeItem(USER_KEY);
    }
    void persistSessionToMain();
  }, [user]);

  // tla: VaultKeys/SignIn
  const login = async (
    email: string,
    password: string,
    twoFactorCode?: string,
    resendTwoFactor?: boolean
  ) => {
    if (systemIssue) {
      throw new Error(`system_contract_blocked:${systemIssue}`);
    }
    const result = await apiLogin(email, password, twoFactorCode, resendTwoFactor);
    setSession(result.token, result.user);
  };

  const setSession = (nextToken: string, nextUser: User) => {
    // Before the user state, so the account-wins effect leaves the language to the reconcile.
    reconcileAfterSignIn(nextToken, nextUser);
    localStorage.setItem(TOKEN_KEY, nextToken);
    localStorage.setItem(USER_KEY, JSON.stringify(nextUser));
    setToken(nextToken);
    setUser(nextUser);
    void persistSessionToMain();
  };

  // One sign-out at a time (ACCT-DEV-01): run 38822's sign-out revoked the session, then the library sync's 401 with
  // that revoked token started a second `logout("sessionRejected")` (handleForcedLogout) while the first still ran;
  // both reset the local storage at once and neither finished. A logout while one runs joins it, with its reason.
  const logoutInFlight = useRef<Promise<void> | null>(null);

  const runLogout = async (reason: SignedOutReason) => {
    const key = keyAfterSignedOut(reason);
    const startedAt = Date.now();
    rendererLogger.info({ scope: "auth", reason, key }, "logout");
    // Flush pending library writes BEFORE we tear down local state. Otherwise
    // writes made while logged in (e.g., newly added media) are lost when the
    // local SQLite cache is cleared by resetClientStorage below — the remote
    // API snapshot was never uploaded.
    await flushPendingLibraryWrites();
    logoutLog.info({ reason, elapsedMs: Date.now() - startedAt }, "logout: pending library writes flushed");
    if (token) {
      await apiLogout(token).catch(() => undefined);
      logoutLog.info({ reason, elapsedMs: Date.now() - startedAt }, "logout: session ended on the server");
    }
    // Drop the token from main's durable copy NOW, before the (slow) local reset:
    // a kill mid-logout must not bring the signed-out session back. The user blob
    // stays until the end because resetClientStorage scopes the preserved library
    // key by it.
    localStorage.removeItem(TOKEN_KEY);
    // Stop the ticket schedule and drop the stored reserve: the next account starts with none of these tickets.
    await logoutStep("stopMetadataTickets", stopMetadataTickets);
    await persistSessionToMain();
    window.dispatchEvent(new CustomEvent("sf:logout"));
    // Bounded step by step inside (ACCT-DEV-01), so the library key is forgotten even when the cache clear hangs.
    await resetClientStorage({
      preserveLibraryKey: key === "keep",
      // UX-TOUR-02: the tour is once per computer, not once per sign-in.
      preserveLocalStorageKeys: ["sf-api-base-url", ...DESKTOP_TOUR_STORAGE_KEYS],
    });
    logoutLog.info({ reason, elapsedMs: Date.now() - startedAt }, "logout: local storage reset");
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    await persistSessionToMain();
    clearLastAuthenticatedRoute();
    setToken(null);
    setUser(null);
    logoutLog.info({ reason, elapsedMs: Date.now() - startedAt }, "logout: signed out");
  };

  const logout = (reason: SignedOutReason): Promise<void> => {
    const running = logoutInFlight.current;
    if (running) {
      logoutLog.info({ reason }, "logout joins the one in progress");
      return running;
    }
    // A late refusal of the session a finished sign-out already ended (a probe still holding the revoked token): this
    // window holds no session, so there is nothing to sign out. Running again would reset the storage with no user to
    // scope the kept key by and drop it (PRIV-KEY-13: the computer that rotated the key came back asking for it).
    if (localStorage.getItem(TOKEN_KEY) === null) {
      logoutLog.info({ reason }, "logout skipped: already signed out");
      return Promise.resolve();
    }
    const run = runLogout(reason).finally(() => {
      logoutInFlight.current = null;
    });
    logoutInFlight.current = run;
    return run;
  };

  const value = useMemo(
    () => ({ user, token, loading, systemIssue, languageSettling, login, setSession, logout, setUser }),
    [user, token, loading, systemIssue, languageSettling]
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
      <AccountLanguageDialog
        question={languageQuestion?.question ?? null}
        onPick={(language) => languageQuestion?.answer(language)}
        closeLabel={t("common.close")}
      />
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
};

/**
 * ACCT-AUTH-04: false only for an account without a password; its re-checks ask a code
 * instead of the password. An older API that sends no `hasPassword` reads as having one.
 */
export const useHasPassword = () => useAuth().user?.hasPassword !== false;
