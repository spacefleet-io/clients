import { lazy, Suspense, useSyncExternalStore, type ReactNode } from "react";
import { Route, Routes } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { CloseLabelProvider } from "@space/ui";
import { getAppUpdateRequired, onAppUpdateRequired } from "@space/shared/appVersion";
import { AuthProvider, useAuth } from "./auth";
import { RequireAuthGuard } from "@space/desktop-shell/guards";
import { AppRouter } from "./lib/AppRouter";
import { LoadingScreen } from "./components/LoadingScreen";
import UpdateReadyNotice from "./components/UpdateReadyNotice";
import { useUpdater } from "./lib/useUpdater";
import { SystemUpdatePrompt } from "@space/desktop-shell/updater-system-prompt";

const Login = lazy(() => import("./pages/Login"));
const Signup = lazy(() => import("./pages/Signup"));
const VerifyEmail = lazy(() => import("./pages/VerifyEmail"));
const AuthenticatedApp = lazy(() => import("./AuthenticatedApp"));
const FirstSetupGate = lazy(() => import("./components/FirstSetupGate"));
const LanguageFirstGate = lazy(() => import("./components/LanguageFirstGate"));
const AppUpdateRequiredGate = lazy(() => import("./components/AppUpdateRequiredGate"));

export const RequireAuth = ({ children }: { children: ReactNode }) => {
  const { user, loading } = useAuth();
  const { t } = useTranslation();
  return (
    <RequireAuthGuard
      loading={loading}
      isAuthenticated={Boolean(user)}
      loadingFallback={<LoadingScreen label={t("app.loadingAccount")} />}
      unauthenticatedRedirectTo="/login"
    >
      {children}
    </RequireAuthGuard>
  );
};

/**
 * UX-SETUP-08: right after a sign-in, "Which language do you want?" (UX-I18N-07, asked by the auth provider) comes
 * before step 1 of the setup: nothing behind the question until it is answered.
 */
const AfterLanguageSettled = ({ children }: { children: ReactNode }) => {
  const { languageSettling } = useAuth();
  const { t } = useTranslation();
  if (languageSettling) return <LoadingScreen label={t("app.loading")} />;
  return <>{children}</>;
};

export default function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}

function AppContent() {
  const { t, i18n } = useTranslation();
  // REL-CD-29: this build is too old (the API refused it, or release-status reported it below the minimum); the update
  // prompt covers every screen, signed out included.
  const updateRequired = useSyncExternalStore(onAppUpdateRequired, getAppUpdateRequired);
  const updater = useUpdater();
  const serverMandatory = updater.state.mandatory;
  const mustUpdate = updateRequired !== null || serverMandatory;
  return (
    <CloseLabelProvider label={t("common.close")}>
      <AppRouter>
        <AppRoutes />
      </AppRouter>
      {mustUpdate ? (
        <Suspense fallback={null}>
          <AppUpdateRequiredGate refusal={updateRequired} />
        </Suspense>
      ) : null}
      <UpdateReadyNotice blocked={mustUpdate} />
      {/* REL-UPD-07: a copy from SpaceFleet's .deb/.rpm/.pacman packages asks before updating through the package manager. */}
      <SystemUpdatePrompt controls={updater} language={i18n.language} appName="Badger" blocked={mustUpdate} />
    </CloseLabelProvider>
  );
}

function AppRoutes() {
  const { t } = useTranslation();
  return (
    <Suspense fallback={<LoadingScreen label={t("app.loading")} />}>
      <Routes>
        {/* UX-SETUP-08: a new computer picks its language (setup step 0) before the sign-in or sign-up. */}
        <Route path="/login" element={<LanguageFirstGate><Login /></LanguageFirstGate>} />
        <Route path="/signup" element={<LanguageFirstGate><Signup /></LanguageFirstGate>} />
        <Route path="/verify" element={<VerifyEmail />} />
        <Route
          path="*"
          element={
            <RequireAuth>
              <AfterLanguageSettled>
                {/* #25: the first-setup flow replaces the app until this computer has answered. */}
                <FirstSetupGate loadingFallback={<LoadingScreen label={t("app.loading")} />}>
                  <AuthenticatedApp />
                </FirstSetupGate>
              </AfterLanguageSettled>
            </RequireAuth>
          }
        />
      </Routes>
    </Suspense>
  );
}
