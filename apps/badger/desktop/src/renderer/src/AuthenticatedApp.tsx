import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { LibraryProvider, useLibraryActions, useLibraryShell } from "@/lib/libraryContext";
import { LabJobsProvider } from "@/lib/labJobs";
import { LoadingModalProvider } from "@/components/LoadingModalProvider";
import { LoadingScreen } from "@/components/LoadingScreen";
import { shouldPreloadPrimaryRoutes } from "@/lib/routePreload";
import { IngestionProvider, useIngestion } from "@/lib/ingestionContext";
import {
  isInitialRestorePending,
  persistLastAuthenticatedRoute,
  readLastAuthenticatedRoute,
  resolveInitialAuthenticatedRoute,
} from "@/lib/routePersistence";
import { useRouteFlushOnLeave } from "@/lib/useRouteFlushOnLeave";
import { RequireClientReadyGuard, resolveClientReadyStatus } from "@space/desktop-shell/guards";
import { useWindowFileDrop, WindowDropOverlay } from "@space/desktop-shell/window-drop";
import { isImportableMediaFile } from "../../shared/importableMedia";
import AppBackdrop from "@space/ui/app-backdrop";
import { RenderBoundary } from "@space/ui/render-boundary";
import { useAuth } from "./auth";
import { isLibraryKeyAcknowledged } from "@/lib/onboarding";
import { rendererLogger } from "@/logger";
import { useProfileSession } from "@/lib/useProfileSession";
import { RequireLibraryMedia } from "@/components/RequireLibraryMedia";

const authenticatedAppLog = rendererLogger.child({ scope: "authenticated-app" });

const DebugSidebar = import.meta.env.DEV ? lazy(() => import("./components/DebugSidebar")) : null;
// Sonner is ~122 KiB and only needed visually after the first toast — lazy-load
// it so the eager AuthenticatedApp chunk stays under its 200 KiB budget. The
// Suspense boundary at the call site falls through with `null` until a toast
// fires, so cold-start UX is unaffected.
const Notifications = lazy(() =>
  import("@space/ui").then((mod) => ({ default: mod.Notifications })),
);
// The library-format update gate (Part D3) ships its blocking modal + the
// electron-updater bridge — none of it is on the cold-start path, so it is
// lazy-loaded to keep the eager AuthenticatedApp chunk under budget. The
// Suspense boundary at the mount falls through with `null` until the chunk
// loads, and `formatTooNew` is null in the common case anyway.
const LibraryUpdateGate = lazy(() => import("./components/LibraryUpdateGate"));
// ACCT-PAIR-03 new-device toasts: renders nothing and only polls, so it stays off the cold-start path (and out of the
// TopNav chunk). It does nothing until a user is signed in.
const NewDeviceNotifier = lazy(() => import("./components/NewDeviceNotifier"));
// UX-NOTICE-02 offline toast: said once when the app goes offline, taken back when it returns. Mounted here, once,
// because the top bar (which shows the lasting chip) remounts on every page change. Renders nothing.
const DesktopOfflineNotice = lazy(() =>
  import("./components/DesktopOfflineIndicator").then((mod) => ({ default: mod.DesktopOfflineNotice })),
);
// DEV-LIB-01 tool access prompt: shown only when a third-party tool asks the local runtime for access.
const ToolAccessPrompt = lazy(() => import("./components/ToolAccessPrompt"));
const StreamSlotPrompt = lazy(() => import("./components/StreamSlotPrompt"));
// PLAT-WEB-05 web player hand-off: plays what the web player sent to this app (hidden window); idle until then.
const DesktopHandoffListener = lazy(() => import("./components/DesktopHandoffListener"));
// STOR-BW-07 / STOR-BW-08 refused and stopped playback dialogs (and the dialog code they pull in): shown only when a
// saturated silo refuses or stops a playback, loaded after first paint to stay out of the TopNav chunk (renderer chunk budget).
const PlaybackSaturationHost = lazy(() => import("./components/PlaybackSaturationHost"));
// PLAY-NEXT-02 skip marker backfill: renders nothing and starts well after first paint, so it stays off the
// cold-start path (renderer chunk budget).
const SkipMarkerBackfill = lazy(() => import("./components/SkipMarkerBackfill"));
// UX-PROF-01 "Who's watching?" gate in front of every library route (not /onboarding/key): lazy, with its picker, so
// neither lands in the eager AuthenticatedApp chunk (renderer chunk budget). The routes' Suspense covers its load.
const ProfileGate = lazy(() => import("./components/profiles/ProfileGate"));
const ShowRefresh = lazy(() => import("./components/ShowRefresh"));
const OnboardingKey = lazy(() => import("./pages/OnboardingKey"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Library = lazy(() => import("./pages/Library"));
const AddMedia = lazy(() => import("./pages/AddMedia"));
const Settings = lazy(() => import("./pages/Settings"));
const Playlists = lazy(() => import("./pages/Playlists"));
const MediaDetail = lazy(() => import("./pages/MediaDetail"));
const Account = lazy(() => import("./pages/Account"));

const isDebugSidebarEnabled = () => import.meta.env.DEV && import.meta.env.VITE_DEBUG_SIDEBAR === "1";

const RequireClientReady = ({ children }: { children: ReactNode }) => {
  const { user, loading } = useAuth();
  const { loading: libraryLoading, error: libraryError } = useLibraryShell();
  const [status, setStatus] = useState<"checking" | "needs_login" | "needs_key" | "ready">("checking");

  const isKeyError =
    typeof libraryError === "string" &&
    (libraryError.toLowerCase().includes("decrypt") ||
      libraryError.toLowerCase().includes("missing encryption key"));

  useEffect(() => {
    if (loading) return;
    if (!user) {
      setStatus("needs_login");
      return;
    }

    let cancelled = false;
    const check = async () => {
      const keyOk = await isLibraryKeyAcknowledged().catch(() => false);
      if (cancelled) return;

      const nextStatus = resolveClientReadyStatus({
        hasUser: true,
        keyAcknowledged: keyOk,
        libraryLoading,
        libraryError: typeof libraryError === "string" ? libraryError : null,
        isKeyError,
      });
      if (nextStatus === "checking") return;
      setStatus(nextStatus);
    };

    setStatus("checking");
    void check();
    return () => {
      cancelled = true;
    };
  }, [loading, user, isKeyError, libraryLoading, libraryError]);

  const { t } = useTranslation();
  return (
    <RequireClientReadyGuard
      status={loading ? "checking" : status}
      loadingFallback={<LoadingScreen label={t("app.loading")} />}
      loginRedirectTo="/login"
      keyRedirectTo="/onboarding/key"
    >
      <ProfileGate>{children}</ProfileGate>
    </RequireClientReadyGuard>
  );
};

export default function AuthenticatedApp() {
  const location = useLocation();
  const suspendLibraryLoad = location.pathname === "/onboarding/key";

  return (
    <LibraryProvider suspendLoad={suspendLibraryLoad}>
      <LoadingModalProvider>
        <LabJobsProvider defer>
          <IngestionProvider>
            <AuthenticatedRoutes />
            {/*
              Mandatory-update gate (Part D3): a blocking modal that takes over
              the whole app when the library was written by a newer build.
              Mounted inside LibraryProvider so it can read `formatTooNew`;
              lazy so its updater bundle stays off the cold-start path.
            */}
            <Suspense fallback={null}>
              <LibraryUpdateGate />
            </Suspense>
            <Suspense fallback={null}>
              <NewDeviceNotifier />
            </Suspense>
            <Suspense fallback={null}>
              <DesktopOfflineNotice />
            </Suspense>
            <Suspense fallback={null}>
              <PlaybackSaturationHost />
            </Suspense>
            <Suspense fallback={null}>
              <ToolAccessPrompt />
            </Suspense>
            <Suspense fallback={null}>
              <StreamSlotPrompt />
            </Suspense>
            <Suspense fallback={null}>
              <DesktopHandoffListener />
            </Suspense>
            <Suspense fallback={null}>
              <SkipMarkerBackfill />
            </Suspense>
            <Suspense fallback={null}>
              <ShowRefresh />
            </Suspense>
          </IngestionProvider>
        </LabJobsProvider>
      </LoadingModalProvider>
    </LibraryProvider>
  );
}

function AuthenticatedRoutes() {
  const { t } = useTranslation();
  const { user, loading } = useAuth();
  useProfileSession();
  const { openIngestion } = useIngestion();
  // UX-CRASH-01: "Try again" on a crashed screen reloads the library data the screen rendered from (the same
  // full load as at startup), so the retry does not render the same cached rows again.
  const { reload: reloadLibrary } = useLibraryActions();
  const navigate = useNavigate();
  const location = useLocation();
  // UX-ADD-01: files or folders dropped anywhere on the window open the add-media dialog with them. UX-ADD-02: only
  // videos, subtitles and folders; images are left out silently, anything else gets a short toast.
  const drop = useWindowFileDrop({
    getPathForFile: window.sf?.getPathForFile,
    isImportableFile: isImportableMediaFile,
    onRefused: (names) => {
      authenticatedAppLog.info({ names }, "Dropped files Badger cannot import");
      // Sonner stays lazy (see Notifications above): it loads with the first toast.
      void import("@space/ui").then(({ toast }) => toast.info(t("app.dropOverlay.onlyMedia")));
    },
    onDrop: (paths) => {
      openIngestion(paths);
      // The drop overlay stays visible until the lazy-loaded FileIngestionDialog signals it has mounted (via the
      // `sf:ingestion-dialog-ready` window event — see the listener below). The hook's 10s safety timeout only fires
      // if the dialog never mounts (e.g. a chunk load failure) so the user is never left staring at a stuck overlay.
    },
  });
  const { startProcessing, stopProcessing } = drop;
  const hasHandledInitialRouteRef = useRef(false);
  const initialRestoreFromRef = useRef<string | null>(null);

  useEffect(() => {
    if (!shouldPreloadPrimaryRoutes(Boolean(user))) return;

    let cancelled = false;
    const preload = () => {
      if (cancelled) return;
      void import("./pages/Library");
      void import("./pages/Dashboard");
    };

    const requestIdle = window.requestIdleCallback?.bind(window);
    if (requestIdle) {
      const handle = requestIdle(preload, { timeout: 1500 });
      return () => {
        cancelled = true;
        window.cancelIdleCallback?.(handle);
      };
    }

    const timeout = window.setTimeout(preload, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [user]);

  useEffect(() => {
    window.addEventListener("sf:ingestion-dialog-ready", stopProcessing);
    return () => {
      window.removeEventListener("sf:ingestion-dialog-ready", stopProcessing);
    };
  }, [stopProcessing]);

  useEffect(() => {
    const handleE2eOpenIngestion = (event: Event) => {
      const custom = event as CustomEvent<{ paths?: string[]; seedCandidates?: unknown[] }>;
      const paths = Array.isArray(custom.detail?.paths) ? custom.detail.paths : [];
      openIngestion(paths);
      if (Array.isArray(custom.detail?.seedCandidates) && custom.detail.seedCandidates.length > 0) {
        window.setTimeout(() => {
          window.dispatchEvent(
            new CustomEvent("sf:e2e-seed-ingestion", {
              detail: { candidates: custom.detail?.seedCandidates },
            })
          );
        }, 0);
      }
    };
    window.addEventListener("sf:e2e-open-ingestion", handleE2eOpenIngestion as EventListener);
    return () => {
      window.removeEventListener("sf:e2e-open-ingestion", handleE2eOpenIngestion as EventListener);
    };
  }, [openIngestion]);

  useEffect(() => {
    const handleNativeFileDrop = (event: Event) => {
      const custom = event as CustomEvent<{ paths?: string[] }>;
      const paths = Array.isArray(custom.detail?.paths) ? custom.detail.paths : [];
      // See useWindowFileDrop's onDrop above — the overlay is dismissed by the dialog-ready event.
      startProcessing();
      openIngestion(paths);
    };
    window.addEventListener("sf:native-file-drop", handleNativeFileDrop as EventListener);
    return () => {
      window.removeEventListener("sf:native-file-drop", handleNativeFileDrop as EventListener);
    };
  }, [openIngestion, startProcessing]);

  useEffect(() => {
    const handleE2eNavigate = (event: Event) => {
      const custom = event as CustomEvent<{ to?: string }>;
      if (typeof custom.detail?.to !== "string" || !custom.detail.to.trim()) return;
      navigate(custom.detail.to);
    };
    window.addEventListener("sf:e2e-navigate", handleE2eNavigate as EventListener);
    return () => {
      window.removeEventListener("sf:e2e-navigate", handleE2eNavigate as EventListener);
    };
  }, [navigate]);

  const initialStoredRoute = readLastAuthenticatedRoute();
  const initialRestoreRoute = resolveInitialAuthenticatedRoute({
    isAuthenticated: Boolean(user),
    loading,
    pathname: location.pathname,
    search: location.search,
    storedRoute: initialStoredRoute,
  });
  const initialRestorePending = isInitialRestorePending(initialRestoreFromRef, hasHandledInitialRouteRef.current, initialRestoreRoute, location);

  useEffect(() => {
    if (!user || !hasHandledInitialRouteRef.current) return;
    if (initialRestorePending) return;
    persistLastAuthenticatedRoute(location.pathname, location.search);
  }, [user, location.pathname, location.search, initialRestorePending]);

  useRouteFlushOnLeave({
    signedIn: Boolean(user),
    pathname: location.pathname,
    search: location.search,
    restorePending: initialRestorePending,
  });

  if (!hasHandledInitialRouteRef.current && !loading) {
    hasHandledInitialRouteRef.current = true;
    if (initialRestoreRoute) {
      return <Navigate to={initialRestoreRoute} replace />;
    }
  }

  const content = (
    <>
      <Suspense fallback={null}>
        <Notifications />
      </Suspense>
      <div className="min-h-screen bg-background text-foreground flex relative overflow-hidden">
        <AppBackdrop nebula="badger" />

        <WindowDropOverlay
          drop={drop}
          labels={{
            dropTitle: t("app.dropOverlay.dropTitle"),
            dropSubtitle: t("app.dropOverlay.dropSubtitle"),
            processingTitle: t("app.dropOverlay.identifying"),
            processingSubtitle: t("app.dropOverlay.pleaseWait"),
          }}
        />

        {DebugSidebar && isDebugSidebarEnabled() ? (
          <Suspense fallback={null}>
            <DebugSidebar />
          </Suspense>
        ) : null}
        <div className="relative z-10 min-w-0 flex-1">
          {/* UX-CRASH-01: a crashing screen blanks only itself; leaving the route clears the error; "Try again" reloads
              the library data first and mounts the screen anew once it is in. */}
          <RenderBoundary
            name={`route:${location.pathname}`}
            resetKey={location.pathname}
            variant="screen"
            className="min-h-[60vh] bg-transparent"
            onRetry={() => {
              authenticatedAppLog.info({ path: location.pathname }, "Try again on a crashed screen: reloading the library data");
              return reloadLibrary();
            }}
          >
          <Suspense fallback={<LoadingScreen label={t("app.loading")} />}>
            <Routes>
              <Route path="/onboarding/key" element={<OnboardingKey />} />
              <Route
                path="/home"
                element={
                  <RequireClientReady>
                    <Dashboard />
                  </RequireClientReady>
                }
              />
              <Route
                path="/media-library"
                element={
                  <RequireClientReady>
                    <RequireLibraryMedia>
                      <Library />
                    </RequireLibraryMedia>
                  </RequireClientReady>
                }
              />
              <Route
                path="/playlists"
                element={
                  <RequireClientReady>
                    <RequireLibraryMedia>
                      <Playlists />
                    </RequireLibraryMedia>
                  </RequireClientReady>
                }
              />
              <Route
                path="/media/:id"
                element={
                  <RequireClientReady>
                    <MediaDetail />
                  </RequireClientReady>
                }
              />
              <Route
                path="/media-library/add"
                element={
                  <RequireClientReady>
                    <AddMedia />
                  </RequireClientReady>
                }
              />
              <Route
                path="/settings"
                element={
                  <RequireClientReady>
                    <Settings />
                  </RequireClientReady>
                }
              />
              <Route
                path="/account"
                element={
                  <RequireClientReady>
                    <Account />
                  </RequireClientReady>
                }
              />
              <Route path="/" element={<Navigate to="/home" replace />} />
              <Route path="/dashboard" element={<Navigate to="/home" replace />} />
              <Route path="/library" element={<Navigate to="/media-library" replace />} />
              <Route path="/library/add" element={<Navigate to="/media-library/add" replace />} />
              <Route path="/lab" element={<Navigate to="/home" replace />} />
              <Route path="/file-management" element={<Navigate to="/home" replace />} />
              <Route path="*" element={<Navigate to="/home" replace />} />
            </Routes>
          </Suspense>
          </RenderBoundary>
        </div>
      </div>
    </>
  );

  return content;
}
