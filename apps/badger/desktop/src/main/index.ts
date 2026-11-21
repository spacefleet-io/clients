import "./packagedNodeEnv";
import "./devBuildEnv";
import { app, BrowserWindow, shell, ipcMain, screen, dialog, Menu, Tray, session as electronSession } from "electron";
import { NEUTRAL_USER_AGENT } from "@space/metadata-client";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { isValidPlacementId } from "@space/shared/storagePlacement";
import { resolveExternalMpvTarget } from "@space/mpv";
import { getDesktopPlatform } from "@space/desktop-platform";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PlaybackServer } from "./playbackServer";
import { PlaybackRuntimeBridge } from "./playbackRuntimeBridge";
import { registerPlaybackIpc } from "./playbackIpc";
import { installPlaybackThrottleControl } from "./playbackThrottle";
import { disposeMpvPreviewPictures, isExternalMpvAlive, registerExternalMpv, stopExternalMpvProcess } from "./externalMpv";
import { getStorageTraffic, onStorageTrafficChange } from "./storageTraffic";
import { registerPlaybackSaturation } from "./playbackSaturation";
import { killAllMpvProcessGroupsSync } from "./mpvProcessGroup";
import { MISSING_BINARIES_MESSAGE, missingBinariesReport } from "./missing-binaries";
import { getActiveLibraryDb, registerLibraryDbIpc } from "./libraryDbIpc";
import {
  noteRuntimeLost,
  noteRuntimeRestarting,
  noteRuntimeStarting,
  registerLibraryDbRuntimeProxy,
  reopenAfterRuntimeReady,
  waitForGuardianRuntime,
} from "./libraryDbRuntimeProxy";
import { uploadEncryptedFile } from "./mediaIngest";
import { deriveMediaMasterKey, setMediaMasterKey } from "./mediaCrypto";
import { registerFileSystemIpc } from "./fileSystem";
import { registerFfmpegIpc } from "./ffmpegIpc";
import { FfmpegRuntimeBridge } from "./ffmpegRuntimeBridge";
import { registerToolAccessIpc } from "./toolAccessIpc";
import { registerPairingIpc } from "./pairingIpc";
import {
  getApiBaseUrl,
  getCustomApiBaseUrl,
  getDefaultApiBaseUrl,
  getMetadataUrlOverride,
  initializeApiBaseUrl,
  setCustomHosts,
} from "./apiHost";
import {
  getElectronCommandLineSwitches,
  shouldDisableHardwareAcceleration,
  shouldDisableSpellcheck,
} from "./electronPerformance";
import { scopeLogger } from "./logger";
import { isAllowedExternalUrl } from "@space/desktop-shell/externalUrl";
import { registerSessionIpc } from "./sessionIpc";
import { setClientIdentity } from "@space/shared/appVersion";
import { CLIENT_IDENTITY_CHANNEL, desktopClientIdentity } from "@space/desktop-shell/client-identity";
import { serveStorageUnitBase } from "@space/desktop-shell/storage-units";
import { PROVIDER_RETURN_IPC } from "../shared/providerReturn";
import { detectOnFirstStart, registerDeviceSettingsIpc } from "./deviceSettingsIpc";
import { readRuntimeOwnerSecret, runtimeOwnerSecretProvider } from "./runtimeOwnerSecret";
import { RUNTIME_OWNER_SECRET_IPC_CHANNEL, createOwnerSecretIpcHandler } from "@space/runtime-client/ownerSecretIpc";
import { createUploadPlaybackPolicy } from "./uploadPlaybackPolicy";
import { RuntimeGuardian } from "@space/runtime-host";
import { buildPackagedRuntimeEnv } from "./packagedRuntime";
import { buildRuntimeSpawnEnv, isExternalRuntimeUrl } from "./runtimeSpawnEnv";
import { currentDesktopBuildEnv, isDesktopDevBuild } from "../shared/devBuild";
import {
  applyApplicationMenu,
  applySilentAudio,
  attachCloseToTray,
  attachDevShortcuts,
  buildTrayActions,
  createAppTray,
  MAIN_SHELL_STRINGS,
  registerTrayTestIpc,
  resolveTrayIconPath,
  revealWindow,
  shouldQuitWhenAllWindowsClosed,
  trayLabelsFor,
} from "@space/desktop-shell/main-shell";
import { createDesktopUpdater } from "@space/desktop-shell/updater-main";
// electron-updater is CommonJS: Node's ESM loader does not synthesize its named exports, so `import { autoUpdater }`
// throws when the built main bundle loads. Default import, read lazily (reading `autoUpdater` builds the OS updater).
import electronUpdater from "electron-updater";
import { mainUiLanguage, mainUiStrings, seedMainUiLanguage, setMainUiLanguage } from "./uiStrings";
import { sendNotification, type NotifyInput } from "./notifications";
import { handleSecondInstance } from "./secondInstanceHandler";
import { createProviderReturnMailbox } from "@space/shared/providerSignIn";
import {
  decideLaunchVisibility,
  findBadgerLink,
  paymentReturnOf,
  protocolClientArgs,
  providerReturnOf,
  shouldShowOnActivate,
} from "./protocolLink";
import { registerHandoffIpc, type HandoffRuntimeBridge } from "./handoffIpc";
import { requestRendererFlush } from "./rendererFlush";
import { installE2ePerfProbe } from "./e2ePerfProbe";
import { markAppWindowVisibility, registerAppWindowVisibilityIpc, trackAppWindowVisibility } from "./appWindowVisibility";
import { forwardEscapeKey } from "./escapeKeyForward";
import { resolveAppIdentity } from "./appIdentity";
import { createConsentFile } from "@space/error-report/consent-file";
import { createElectronMainReporting } from "@space/error-report/electron-main";
import { resolveDsn } from "@space/error-report";
import { createErrorReports, registerErrorReportsIpc } from "@space/error-report/desktop-main";
import { parseForcedErrorReports } from "@space/error-report/desktop";
const logger = scopeLogger("app-main");
installE2ePerfProbe();

// Name + userData per OS (appIdentity.ts): "Badger" everywhere; Linux/Windows keep
// <appData>/@sf/desktop, macOS uses Application Support/Badger. A development
// build uses the same dir with `-dev` appended (PLAT-DESK-14).
const appIdentity = resolveAppIdentity(
  getDesktopPlatform(),
  app.getPath("appData"),
  process.env,
  isDesktopDevBuild(currentDesktopBuildEnv()),
);
app.setName(appIdentity.name);
// The Linux window class is the packaged .desktop entry's StartupWMClass (package.json desktopName "spacebadger"),
// so the taskbar shows that entry's name, "Badger" (REL-MAC-09), not the class.
getDesktopPlatform().shell.prepareApp(app, { appUserModelId: "io.spacefleet.badger-desktop", linuxWindowClass: "spacebadger" });

// One userData root per build kind: a release build and a development build never
// share it, nor the runtime (devBuildEnv.ts gives a development build its own
// runtime port and data dir), since they talk to different servers (PLAT-DESK-14).
// Set before the single-instance lock: Electron keys the lock on userData, so a
// lane or e2e run with its own SF_USER_DATA_PATH gets its own lock instead of
// handing over to the user's Badger (PLAT-DESK-12).
app.setPath("userData", appIdentity.userDataDir);

// Single-instance lock: a second launch of the binary must not race the first
// instance's runtime/library state. The first instance keeps the lock; later
// instances receive a "second-instance" event and exit. Tests can dispatch
// directly to handleSecondInstance without going through Electron's IPC.
logger.info({ userData: app.getPath("userData") }, "single-instance lock keyed on userData");
const gotSingleInstanceLock = process.env.SF_E2E === "1" || app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  logger.info({ userData: app.getPath("userData") }, "another Badger holds this userData: handing over to it");
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    handleSecondInstance({
      showMainWindow: () => showMainWindow(),
      requestQuit: () => {
        isQuitting = true;
        app.quit();
      },
      getWindowProcessingState: () => (hasActiveProcessing() ? "active" : "idle"),
      argv,
      onLink: (link) => onBadgerLink(link, "second-instance"),
    });
  });
}

// PLAT-WEB-05: `badger://` links. The web player opens `badger://start` to start the desktop player; started (or
// reached) through a link, the app stays in the background: the window is created hidden, or not shown again.
// Windows / Linux pass the link in argv (at launch, or to the running instance via second-instance); macOS raises
// open-url, registered here before `ready` so the launching link is not missed.
let openUrlBeforeWindow = false;
let lastBadgerLinkAt: number | null = null;
// ACCT-SIGNIN-05: the provider sign-in outcome waits here for the sign-in screen to pull it (a launch through the
// link on Windows / Linux carries it in argv).
const providerReturns = createProviderReturnMailbox();
const launchLink = findBadgerLink(process.argv);
const launchProviderReturn = launchLink === null ? null : providerReturnOf(launchLink);
if (launchProviderReturn !== null) {
  console.info("[provider-sign-in] started through a return link", {
    outcome: "code" in launchProviderReturn ? "code" : launchProviderReturn.error,
  });
  providerReturns.put(launchProviderReturn);
}
const onBadgerLink = (link: string, source: "argv" | "second-instance" | "open-url") => {
  const hasWindow = Boolean(mainWindow && !mainWindow.isDestroyed());
  // ACCT-SIGNIN-05: back from a Google, Apple or Microsoft sign-in. The app comes forward and the sign-in screen
  // trades the code (pulled through PROVIDER_RETURN_IPC.pending, so a window still loading gets it on mount).
  const providerReturn = providerReturnOf(link);
  if (providerReturn !== null) {
    console.info("[provider-sign-in] return link received: app brought forward", {
      source,
      outcome: "code" in providerReturn ? "code" : providerReturn.error,
      hasWindow,
    });
    providerReturns.put(providerReturn);
    showMainWindow();
    if (hasWindow) mainWindow?.webContents.send(PROVIDER_RETURN_IPC.returned);
    return;
  }
  // ACCT-PAY-05: back from Stancer's payment page. The app comes forward and its plan change checks the payment at
  // once; with no window yet, the webhook and the next check settle it (the renderer holds the session).
  const paymentId = paymentReturnOf(link);
  if (paymentId !== null) {
    console.info("[billing] payment return link received: app brought forward", { source, paymentId, hasWindow });
    showMainWindow();
    if (hasWindow) mainWindow?.webContents.send("sf-billing-payment-return", paymentId);
    return;
  }
  lastBadgerLinkAt = Date.now();
  if (!hasWindow) openUrlBeforeWindow = true;
  console.info("[handoff] badger link received: app kept in the background", {
    source,
    link,
    hasWindow,
    windowVisible: hasWindow ? mainWindow?.isVisible() : null,
  });
};
app.on("open-url", (event, url) => {
  event.preventDefault();
  onBadgerLink(url, "open-url");
});
if (process.env.SF_E2E === "1") {
  // Tests must not rewrite the machine's `badger:` handler; they pass the link in argv instead.
  console.info("[handoff] SF_E2E=1: badger:// protocol registration skipped");
} else {
  const protocolArgs = protocolClientArgs({
    defaultApp: Boolean(process.defaultApp),
    execPath: process.execPath,
    argv: process.argv,
    resolvePath: (path) => resolve(path),
  });
  const registered = protocolArgs.length === 3
    ? app.setAsDefaultProtocolClient(protocolArgs[0], protocolArgs[1], protocolArgs[2])
    : app.setAsDefaultProtocolClient(protocolArgs[0]);
  console.info("[handoff] badger:// protocol registration", { registered, args: protocolArgs });
}

// REL-LOG-06: error reports are off until the user opts in (setup step or Settings). The answer
// lives in <userData>/error-reports.json; the SDK is only initialised for "on", as early as the
// userData path is known so startup crashes are covered.
const errorReportsLogger = scopeLogger("error-report");
const errorReports = createErrorReports({
  consent: createConsentFile(join(app.getPath("userData"), "error-reports.json")),
  reporting: createElectronMainReporting({ dsn: __SF_BUGSINK_DSN__, release: app.getVersion(), app: "badger", platform: "desktop" }),
  available: resolveDsn(__SF_BUGSINK_DSN__) !== null,
  release: app.getVersion(),
  forced: parseForcedErrorReports(process.env.SF_ERROR_REPORTS),
  log: (line) => errorReportsLogger.info(line),
  logError: (line) => errorReportsLogger.error(line),
});
registerErrorReportsIpc(ipcMain, errorReports);
void errorReports.start();

const devtoolsPort = process.env.SF_DEVTOOLS_PORT;
if (devtoolsPort) {
  app.commandLine.appendSwitch("remote-debugging-port", devtoolsPort);
}
if (shouldDisableHardwareAcceleration(process.env)) {
  app.disableHardwareAcceleration();
}
for (const switchName of getElectronCommandLineSwitches(process.env)) {
  app.commandLine.appendSwitch(switchName);
}
// REL-ENV-36: an agent's lane run or a test launch (SF_SILENT=1) never sends a sound stream to the sound server, even
// when started without the harness's Chromium flags (an AppImage by hand). The user's own run is untouched.
const silentSwitches = applySilentAudio(app.commandLine, process.env);
if (silentSwitches.length) {
  scopeLogger("silent").info(`SF_SILENT=${process.env.SF_SILENT} chromium switches=${silentSwitches.join(",")} PULSE_SINK=${process.env.PULSE_SINK ?? "(unset)"}`);
}

// Not named __filename/__dirname: electron-vite 6 injects those as ESM shims into the bundle.
const mainOutDir = dirname(fileURLToPath(import.meta.url));
const badgerDevServerUrl = process.env.VITE_DEV_SERVER_URL ?? process.env.SF_DEV_SERVER_URL;
const badgerRepoRoot = dirname(dirname(dirname(dirname(dirname(mainOutDir)))));
const guardianLogger = scopeLogger("runtime-guardian");
// Pass Electron's userData path to the runtime so its library SQLite lives
// under the proper per-user path. Without this, the runtime's
// packages/library-db-runtime/src/userDataPath.ts resolver falls through to
// process.cwd()/.sf-user-data — a location shared with integration tests
// (pre-03158529 pollution) and across dev sessions. See plan doc.
// Derive the runtime's listening PORT from SF_RUNTIME_BASE_URL so multiple
// lanes can run badger-desktop concurrently — the desktop and its spawned
// runtime must agree on the port even though apps/runtime defaults to 3020.
const desiredRuntimePort = (() => {
  const url = process.env.SF_RUNTIME_BASE_URL?.trim();
  if (!url) return undefined;
  const match = url.match(/:(\d+)/);
  return match ? match[1] : undefined;
})();
// F7 (ultimate stress, issue #25): SF_TRANSCODE_DIR / SF_BADGER_OFFLINE_DIR are
// resolved from userData HERE, before the guardian below is built and started,
// so the first runtime and every respawn share one transcode dir (they used to
// be set inside window creation, after the first guardian.start()).
const runtimeSpawnEnv = buildRuntimeSpawnEnv(process.env, app.getPath("userData"), desiredRuntimePort);
guardianLogger.info({
  userData: app.getPath("userData"),
  devBuild: isDesktopDevBuild(currentDesktopBuildEnv()),
  runtimeBaseUrl: process.env.SF_RUNTIME_BASE_URL ?? null,
  runtimeDataDir: getDesktopPlatform().paths.runtimeDataDir(process.env),
  transcodeDir: runtimeSpawnEnv.SF_TRANSCODE_DIR,
  offlineDir: runtimeSpawnEnv.SF_BADGER_OFFLINE_DIR,
}, "runtime spawn env resolved");
// SF_RUNTIME_SPAWN_MODE=source (test seam, used by the ultimate stress suite):
// the guardian manages a runtime spawned from source (`bun src/index.ts`),
// detached like the packaged binary so it survives an Electron SIGKILL, even
// when SF_RUNTIME_BASE_URL points at a non-3020 port.
const runtimeSpawnMode = process.env.SF_RUNTIME_SPAWN_MODE?.trim();
const runtimeGuardian = new RuntimeGuardian({
  appName: "badger",
  runtimePort: desiredRuntimePort ? Number(desiredRuntimePort) : undefined,
  spawnCommand: runtimeSpawnMode === "source"
    ? { command: "bun", args: ["src/index.ts"], cwd: join(badgerRepoRoot, "apps", "runtime"), detached: true, env: runtimeSpawnEnv }
    : badgerDevServerUrl
      ? { command: "bun", args: ["run", "--cwd", "apps/runtime", "dev"], cwd: badgerRepoRoot, detached: false, env: runtimeSpawnEnv }
      : {
          command: join(process.resourcesPath, "runtime", getDesktopPlatform().binaries.executableName("runtime")),
          args: [],
          cwd: process.resourcesPath,
          env: {
            ...runtimeSpawnEnv,
            ...buildPackagedRuntimeEnv(
              runtimeSpawnEnv,
              process.resourcesPath,
              (name) =>
                getDesktopPlatform().binaries.resolve(name, {
                  appRoot: app.getAppPath(),
                  resourcesPath: process.resourcesPath,
                })?.path,
            ),
          },
        },
  ownerSecret: readRuntimeOwnerSecret,
  log: (level, message, meta) => guardianLogger[level]?.(meta ?? {}, message),
});
guardianLogger.info({ runtimeSpawnMode: runtimeSpawnMode ?? null, desiredRuntimePort: desiredRuntimePort ?? null }, "runtime guardian configured");

let lastRuntimeStatus: "ready" | "restarting" | "lost" = "ready";

const broadcastRuntimeStatus = (status: "ready" | "restarting" | "lost") => {
  lastRuntimeStatus = status;
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("sf-runtime-status", { status });
  }
};

if (badgerDevServerUrl) {
  const devCleanup = () => {
    runtimeGuardian.killSync();
    process.exit(0);
  };
  process.on("SIGTERM", devCleanup);
  process.on("SIGINT", devCleanup);
  process.on("SIGHUP", devCleanup);
}

/** Whether the guardian has emitted any status since start (see the start failure handler). */
let runtimeGuardianReported = false;
runtimeGuardian.on("ready", () => {
  runtimeGuardianReported = true;
  logger.info("runtime status: ready");
  broadcastRuntimeStatus("ready");
  reopenAfterRuntimeReady().catch((err) => {
    logger.warn({ error: err instanceof Error ? err.message : String(err) }, "reopenAfterRuntimeReady failed");
  });
});
runtimeGuardian.on("restarting", () => {
  runtimeGuardianReported = true;
  logger.warn("runtime status: restarting");
  broadcastRuntimeStatus("restarting");
  // #25 P2: library calls wait for the re-open instead of failing with `fetch failed`.
  noteRuntimeRestarting();
});
runtimeGuardian.on("lost", () => {
  runtimeGuardianReported = true;
  logger.error("runtime status: lost");
  broadcastRuntimeStatus("lost");
  noteRuntimeLost();
});

const RUNTIME_BASE_URL = process.env.SF_RUNTIME_BASE_URL?.trim() || "http://127.0.0.1:3020";

const forwardKeyToRuntime = async (userId: string, masterKeyBase64: string) => {
  // #928: the window can be up before the runtime's first spawn finished.
  await waitForGuardianRuntime("keys-set");
  // Use the real cached backend bearer if attach-auth has already run; fall
  // back to the legacy placeholder otherwise. The runtime stores whatever
  // we pass here in session.backendToken, then /keys/set forwards it to
  // onKeySet → badgerModule.setBackendToken. Passing the placeholder means
  // any subsequent fallback through `badgerModule.backendToken` hands the
  // string `"desktop-key-forward"` to the storage API as a Bearer — a
  // guaranteed 401. The placeholder remains as a safety net only for the
  // pre-auth boot window where no real bearer is cached yet; in practice
  // this path is reached after auth, see plan
  // `all-newly-added-jobs-cuddly-cookie`, Fix 2b.
  const { getRuntimeJobsBackendToken } = await import("./runtimeJobsIpc");
  const cachedBearer = getRuntimeJobsBackendToken();
  const backendToken = cachedBearer ?? "desktop-key-forward";
  const { createRuntimeSession } = await import("@space/runtime-client/session");
  const session = createRuntimeSession({
    runtimeBaseUrl: RUNTIME_BASE_URL,
    backendToken,
    apps: ["badger"],
    userId,
    ownerSecret: runtimeOwnerSecretProvider,
  });
  const token = await session.getToken();
  const res = await fetch(`${RUNTIME_BASE_URL.replace(/\/+$/, "")}/runtime/keys/set`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ masterKeyBase64 }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    throw new Error(typeof body.error === "string" ? body.error : `runtime_keys_http_${res.status}`);
  }
};


ipcMain.handle(PROVIDER_RETURN_IPC.pending, () => {
  const outcome = providerReturns.take();
  console.info("[provider-sign-in] sign-in screen pulled the return", { outcome: outcome === null ? null : "code" in outcome ? "code" : outcome.error });
  return outcome;
});
ipcMain.handle("sf-runtime-status-get", () => ({ status: lastRuntimeStatus }));
ipcMain.handle("sf-runtime-restart", async () => {
  await runtimeGuardian.restart();
  return { ok: true };
});
ipcMain.handle("sf-runtime-base-url-get", () => ({ baseUrl: RUNTIME_BASE_URL }));
// RT-SEC-05: the renderer cannot read owner.secret; it asks here, per login. Top-level frames of our own UI only.
ipcMain.handle(RUNTIME_OWNER_SECRET_IPC_CHANNEL, createOwnerSecretIpcHandler({
  readSecret: readRuntimeOwnerSecret,
  rendererIndexFileUrl: pathToFileURL(join(mainOutDir, "../renderer/index.html")).href,
  allowedOrigins: badgerDevServerUrl ? [badgerDevServerUrl] : [],
}));

// #25: device-local settings (this computer only, never synced to the account).
const deviceSettings = registerDeviceSettingsIpc();

// REL-CD-29: every API call of this build (main process and window alike) says which build is calling, so an outdated
// one is told to update (and a Linux build says how it was installed). Set before any call; the preload reads the same
// identity synchronously.
const clientIdentity = desktopClientIdentity({
  app: "badger",
  version: app.getVersion(),
  packaged: app.isPackaged,
  os: process.platform,
  env: process.env,
});
setClientIdentity(clientIdentity);
ipcMain.on(CLIENT_IDENTITY_CHANNEL, (event) => {
  event.returnValue = clientIdentity;
});

// STOR-UNIT-01: storage figures follow this computer's file manager (1024 on Windows and KDE, 1000 elsewhere); the
// preload reads the base synchronously so the window sets it before its first render.
serveStorageUnitBase(ipcMain, {
  platform: process.platform,
  desktop: process.env.XDG_CURRENT_DESKTOP,
  log: (line) => logger.info(line),
});

// #25: durable main-process copy of the signed-in session, so an abrupt kill /
// crash cannot sign the user out (renderer localStorage alone was not enough).
// Its async safeStorage decrypt (`sessionStore.load()`) runs once the app is
// ready and must finish before the first window exists: the preload reads the
// session over a synchronous IPC (ACCT-AUTH-08).
const sessionStore = registerSessionIpc();
let sessionStoreLoaded = false;

// Runtime Jobs v2 IPC bridge — gated by the renderer feature flag
// `runtimeEngineV2Enabled`. Always registered so the renderer can call
// `window.sf.runtimeJobs.*` regardless of flag state.
import("./runtimeJobsIpc").then(({ registerRuntimeJobsIpc }) => {
  registerRuntimeJobsIpc({
    runtimeBaseUrl: RUNTIME_BASE_URL,
    getFallbackCopy: async () => (await deviceSettings.getTranscode()).fallbackCopy,
    waitForRuntime: () => waitForGuardianRuntime("runtime-jobs"),
  });
}).catch((err) => {
  logger.error({ err: String(err) }, "runtime-jobs-ipc registration failed");
});

ipcMain.handle("sf-notify-job-complete", (_event, input: NotifyInput) => {
  sendNotification(input);
});

const resolveIconPath = (appRoot: string) => {
  const candidates = [
    join(process.resourcesPath ?? appRoot, "icon.png"),
    join(appRoot, "resources", "icon.png"),
    join(appRoot, "src", "renderer", "public", "icon.png"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
};

// The tray icon (PLAT-DESK-06): the app icon, or on macOS the menu-bar template image.
const trayIconPathFor = (appRoot: string, appIconPath: string | undefined) =>
  resolveTrayIconPath({
    trayIcon: getDesktopPlatform().shell.trayIcon,
    appIconPath,
    templateCandidates: [join(process.resourcesPath ?? appRoot, "trayTemplate.png"), join(appRoot, "installer", "trayTemplate.png")],
    exists: existsSync,
  });

const requestExplicitQuit = () => {
  isQuitting = true;
  app.quit();
};

let playbackServer: PlaybackServer | null = null;
const playbackRuntimeBridge = new PlaybackRuntimeBridge(fetch, undefined, logger);

// #25 "uploads while a video plays": tells the runtime this computer's mode while mpv is alive.
// Armed after the first-start detection (armUploadPlaybackPolicy); Settings changes arrive live.
const uploadPlaybackPolicy = createUploadPlaybackPolicy({
  isMpvAlive: isExternalMpvAlive,
  send: (message) => playbackRuntimeBridge.sendUploadPolicy(message),
  mode: "full",
  log: (line) => logger.info(line),
});
const armUploadPlaybackPolicy = () => {
  void deviceSettings
    .getUploadsDuringPlayback()
    .then((settings) => {
      uploadPlaybackPolicy.setMode(settings.mode);
      deviceSettings.onUploadsDuringPlaybackChange((next) => uploadPlaybackPolicy.setMode(next.mode));
      uploadPlaybackPolicy.start();
    })
    .catch((err: unknown) => {
      logger.error({ err: String(err) }, "[upload-playback] could not read the uploads-while-playing setting; uploads keep full speed");
    });
};
/**
 * #928: delay after the first page load before the first-start hardware probe
 * (ffmpeg test encodes). A cold start on a 2-core Celeron keeps
 * both cores busy ~10 s (runtime spawn, renderer boot, Defender scans).
 */
const STARTUP_PROBE_DELAY_MS = 10_000;
const ffmpegRuntimeBridge = new FfmpegRuntimeBridge();
let mainWindow: BrowserWindow | null = null;
const appTray = createAppTray({
  createTray: (iconPath) => new Tray(iconPath),
  buildMenu: (items) => Menu.buildFromTemplate(items),
  buildActions: () =>
    buildTrayActions({
      showMainWindow: () => showMainWindow(),
      requestQuit: () => requestExplicitQuit(),
      labels: trayLabelsFor(MAIN_SHELL_STRINGS[mainUiLanguage()], appIdentity.name),
    }),
  onUnavailable: (error) => logger.warn({ error: error instanceof Error ? error.message : String(error) }, "tray unavailable"),
});
if (process.env.SF_E2E === "1") registerTrayTestIpc(ipcMain, appTray);
let toolAccessBridge: { stop: () => void; setAuthToken: (token: string | null) => void } | null = null;
let handoffBridge: HandoffRuntimeBridge | null = null;
const windowProcessingState = new Map<number, boolean>();
const skipProcessingCloseConfirm =
  process.env.NODE_ENV === "test" || process.env.SF_SKIP_PROCESSING_CLOSE_CONFIRM === "1";
let quitConfirmed = false;
let isQuitting = false;

const hasActiveProcessing = () => {
  for (const active of windowProcessingState.values()) {
    if (active) return true;
  }
  return false;
};

const showMainWindow = () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    // Startup creates the first window once the session is decrypted; a
    // second-instance / activate during startup must not open one earlier.
    if (!sessionStoreLoaded) return;
    createWindow();
    return;
  }
  revealWindow(mainWindow);
  markAppWindowVisibility(mainWindow, false, "show-main-window");
};

// PLAT-DESK-11: macOS gets the minimal app / Edit / Window menu bar with "Quit Badger"; Linux and Windows have
// no menu bar, in dev builds too.
let applicationMenuInstalled = false;
const installApplicationMenu = () => {
  applicationMenuInstalled = true;
  applyApplicationMenu({
    menu: Menu,
    hasGlobalMenuBar: getDesktopPlatform().shell.applicationMenu,
    appName: app.getName(),
    requestQuit: requestExplicitQuit,
    strings: MAIN_SHELL_STRINGS[mainUiLanguage()],
  });
};

/** The renderer reports the language it shows (UX-I18N-01); the tray and app menus follow it. */
ipcMain.on("sf-ui-language", (_event, language: unknown) => {
  if (!setMainUiLanguage(language)) return;
  logger.info({ language: mainUiLanguage() }, "main-process UI language changed; rebuilding menus");
  appTray.refresh();
  if (applicationMenuInstalled) installApplicationMenu();
});

/** `show: false` (PLAT-WEB-05): created for a `badger://` start or a hand-off, the window stays hidden. */
const createWindow = (options: { show?: boolean } = {}) => {
  const show = options.show !== false;
  const appRoot = app.getAppPath();
  const devServerUrl = process.env.VITE_DEV_SERVER_URL ?? process.env.SF_DEV_SERVER_URL;
  if (!process.env.SF_APP_ROOT) {
    process.env.SF_APP_ROOT = appRoot;
  }
  const { binaries } = getDesktopPlatform();
  if (!process.env.SF_FFMPEG_PATH) {
    const resolved = binaries.resolve("ffmpeg", { appRoot, resourcesPath: process.resourcesPath })?.path;
    if (resolved) process.env.SF_FFMPEG_PATH = resolved;
  }
  if (!process.env.SF_FFPROBE_PATH) {
    const resolved = binaries.resolve("ffprobe", { appRoot, resourcesPath: process.resourcesPath })?.path;
    if (resolved) process.env.SF_FFPROBE_PATH = resolved;
  }

  logger.info({
    ffmpeg: process.env.SF_FFMPEG_PATH ?? null,
    ffprobe: process.env.SF_FFPROBE_PATH ?? null,
    mpvKind: resolveExternalMpvTarget().kind,
  }, "binary resolution");

  // Validate all required binaries are present before creating the window.
  // A missing binary is logged as an error and startup continues (MPV-BIN-01):
  // a modal is invisible to agents and blocks headless runs, logs reach everyone.
  const missingReport = missingBinariesReport({
    ffmpegPath: process.env.SF_FFMPEG_PATH,
    ffprobePath: process.env.SF_FFPROBE_PATH,
    mpvKind: resolveExternalMpvTarget().kind,
  });
  if (missingReport) {
    logger.error(missingReport, MISSING_BINARIES_MESSAGE);
  }

  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
  const toolbarMinWidth = Number.parseInt(process.env.SF_WINDOW_MIN_WIDTH ?? "", 10);
  const minWidth = Number.isFinite(toolbarMinWidth) && toolbarMinWidth > 0
    ? Math.min(Math.floor(toolbarMinWidth), screenWidth)
    : Math.min(1200, screenWidth);
  const width = Math.max(minWidth, Math.min(1600, Math.floor(screenWidth * 0.85)));
  const height = Math.min(1000, Math.floor(screenHeight * 0.85));

  const iconPath = resolveIconPath(appRoot);
  const win = new BrowserWindow({
    width,
    height,
    minWidth,
    minHeight: 600,
    backgroundColor: "#090b10",
    icon: iconPath,
    show,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      spellcheck: !shouldDisableSpellcheck(process.env),
      preload: join(mainOutDir, "../preload/index.cjs"),
    },
  });

  installApplicationMenu();
  if (devServerUrl) {
    // No menu: reload and the developer tools stay on their usual keys in dev builds (PLAT-DESK-11).
    attachDevShortcuts(win.webContents);
    win.loadURL(devServerUrl);
  } else {
    win.loadFile(join(mainOutDir, "../renderer/index.html"));
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    // A dev stack's API (loopback http) may also send the sign-in stand-in's loopback page (REL-ENV-39).
    if (isAllowedExternalUrl(url, getApiBaseUrl())) void shell.openExternal(url);
    else logger.warn({ url }, "window.open refused: only https and mailto open outside the app");
    return { action: "deny" };
  });
  mainWindow = win;
  trackAppWindowVisibility(win);
  forwardEscapeKey(win.webContents);
  if (!show) markAppWindowVisibility(win, true, "handoff-background-start");
  appTray.create(trayIconPathFor(appRoot, iconPath));
  attachCloseToTray(win, {
    // RT-LIFE-02: the window hides at once and is destroyed once the renderer flushed its cold-start caches
    // (win.destroy() skips pagehide, issue #25); the app keeps running (window-all-closed quits only when quitting).
    background: "destroy",
    isQuitting: () => isQuitting,
    hasTray: () => appTray.active,
    hasActiveProcessing,
    beforeDestroy: () => requestRendererFlush({ webContents: win.webContents, ipcMain }),
    onDestroyCancelled: (outcome) => logger.info({ outcome }, "close-to-tray cancelled: window re-shown during flush"),
  });
  const webContentsId = win.webContents.id;
  win.on("closed", () => {
    windowProcessingState.delete(webContentsId);
    if (mainWindow === win) {
      mainWindow = null;
    }
  });
  return win;
};

app.whenReady().then(async () => {
  logger.info({ osLocale: app.getLocale(), language: seedMainUiLanguage(app.getLocale()) }, "main-process UI language seeded from the OS");
  // META-ANON-14: the renderer's lookups (POST <metadata service>/lookup) leave with the one neutral User-Agent, not
  // Chromium's, which names the app and its Electron build. A page cannot set it itself (CORS allows two headers).
  electronSession.defaultSession.webRequest.onBeforeSendHeaders({ urls: ["*://*/lookup"] }, (details, callback) => {
    callback({ requestHeaders: details.method === "POST" ? { ...details.requestHeaders, "User-Agent": NEUTRAL_USER_AGENT } : details.requestHeaders });
  });
  const sessionLoaded = sessionStore.load().then(() => {
    sessionStoreLoaded = true;
  });
  // Skip the guardian when an external runtime is provided (e.g., e2e tests),
  // or when using direct SQLite mode (no runtime needed).
  // Resolve and propagate the API base URL BEFORE spawning the runtime,
  // so the child process inherits SF_API_BASE_URL in its environment.
  const apiBaseUrl = initializeApiBaseUrl();
  const externalRuntime = runtimeSpawnMode !== "source" && isExternalRuntimeUrl(process.env.SF_RUNTIME_BASE_URL);
  const directSqlite = process.env.SF_LIBRARY_DB_DIRECT_SQLITE === "1";
  logger.info({
    apiBaseUrl,
    dbMode: directSqlite ? "direct-sqlite" : "runtime-proxy",
    externalRuntime: Boolean(externalRuntime),
  }, "app startup");
  if (!externalRuntime && !directSqlite) {
    // #928: do not hold the window for the runtime spawn (~17 s on a 2-core
    // Celeron). The renderer sees "restarting" and library/runtime calls wait
    // on the restart gate until the guardian's first "ready" (or "lost").
    noteRuntimeStarting();
    broadcastRuntimeStatus("restarting");
    void runtimeGuardian.start().catch((err) => {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, "runtime guardian start failed (guardian keeps retrying in the background)");
      // A start that failed before the guardian reported anything (e.g. preparing
      // its data folder) has no background recovery: release waiting calls now
      // instead of holding them for the full guardian wait.
      if (!runtimeGuardianReported) {
        broadcastRuntimeStatus("lost");
        noteRuntimeLost();
      }
    });
  }
  const playbackSaturation = registerPlaybackSaturation(ipcMain, () => mainWindow);
  playbackServer = new PlaybackServer({
    getTraffic: getStorageTraffic,
    onPlaybackStart: playbackSaturation.reset,
    onPlaybackTraffic: playbackSaturation.observe,
    onPlaybackRefused: playbackSaturation.noteRefused,
    onPlaybackStopped: playbackSaturation.noteStopped,
    onPlaybackProfileRefused: (code) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("sf-playback-profile-refused", { code });
    },
    onSignedUrlRequest: (increment) => {
      playbackRuntimeBridge.recordSignedUrlRequest(increment);
    },
  });
  await playbackServer.start();
  // Test seam (#25): SF_PLAYBACK_THROTTLE_CONTROL=1 → globalThis.__sfPlaybackThrottle.
  if (installPlaybackThrottleControl(playbackServer)) {
    logger.info({ throttleKbps: playbackServer.getThrottleKbps() }, "playback throttle control installed");
  }
  registerPlaybackIpc(ipcMain, {
    playbackServer,
    runtimeBridge: playbackRuntimeBridge,
    onAuthTokenChanged: (token) => {
      toolAccessBridge?.setAuthToken(token);
      handoffBridge?.setAuthToken(token);
      ffmpegRuntimeBridge.setBackendToken(token);
      void import("./runtimeJobsIpc").then(({ setRuntimeJobsBackendToken }) => {
        setRuntimeJobsBackendToken(token);
      }).catch(() => undefined);
    },
  });
  ipcMain.handle("sf-auth-set-token", (_event, token: string | null) => {
    toolAccessBridge?.setAuthToken(token ?? null);
    handoffBridge?.setAuthToken(token ?? null);
    ffmpegRuntimeBridge.setBackendToken(token ?? null);
    void import("./runtimeJobsIpc").then(({ setRuntimeJobsBackendToken }) => {
      setRuntimeJobsBackendToken(token ?? null);
    }).catch(() => undefined);
  });
  registerFfmpegIpc(ipcMain, {
    runtimeBridge: ffmpegRuntimeBridge,
  });
  ipcMain.handle(
    "sf-upload-subtitle",
    async (_event, payload: { token: string; path: string; placementId?: string | null }) => {
      if (!payload?.token) {
        throw new Error("AUTH_REQUIRED");
      }
      if (!payload?.path) {
        throw new Error("PATH_REQUIRED");
      }
      // Per-media silo placement (#145): the renderer passes the id parsed from
      // the media's existing keys; legacy/absent keys get a fresh placement.
      const placementId =
        payload.placementId && isValidPlacementId(payload.placementId) ? payload.placementId : randomUUID();
      console.info("[sf-upload-subtitle] placement", {
        placementId,
        reused: placementId === payload.placementId,
      });
      return uploadEncryptedFile(payload.token, payload.path, { placementId, counting: { role: "subtitle" } });
    }
  );
  // "Get subtitles" (PLAY-SUBGET-01): the subtitle text comes from the metadata service, not a file the user picked.
  // It is written to a private temp file only so it goes through the same encrypt-and-upload path as an added file.
  ipcMain.handle(
    "sf-upload-subtitle-content",
    async (_event, payload: { token: string; content: string; format: string; placementId?: string | null }) => {
      if (!payload?.token) {
        throw new Error("AUTH_REQUIRED");
      }
      if (typeof payload.content !== "string" || !payload.content) {
        throw new Error("CONTENT_REQUIRED");
      }
      const format = /^(srt|ass|ssa|vtt)$/.test(payload.format) ? payload.format : "srt";
      const placementId =
        payload.placementId && isValidPlacementId(payload.placementId) ? payload.placementId : randomUUID();
      const dir = await mkdtemp(join(tmpdir(), "sf-subtitle-"));
      const path = join(dir, `subtitle.${format}`);
      try {
        await writeFile(path, payload.content, { encoding: "utf8", mode: 0o600 });
        console.info("[sf-upload-subtitle-content] placement", {
          placementId,
          reused: placementId === payload.placementId,
          bytes: Buffer.byteLength(payload.content),
        });
        return await uploadEncryptedFile(payload.token, path, { placementId, counting: { role: "subtitle" } });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  );
  ipcMain.handle("sf-media-set-key", (_event, libraryKeyBase64: string | null) => {
    if (!libraryKeyBase64) {
      setMediaMasterKey(null);
      return;
    }
    const normalized = libraryKeyBase64.trim().replace(/\s+/g, "");
    const raw = Buffer.from(normalized, "base64");
    if (raw.length !== 32) {
      throw new Error("media_key_invalid");
    }
    setMediaMasterKey(deriveMediaMasterKey(raw));
  });
  ipcMain.handle("sf-media-forward-key-to-runtime", async (_event, payload: { userId: string; keyBase64: string }) => {
    await forwardKeyToRuntime(payload.userId, payload.keyBase64);
  });
  ipcMain.on("sf-window-processing-state", (event, payload: { active?: boolean } | null) => {
    const active = Boolean(payload?.active);
    const senderId = event.sender.id;
    windowProcessingState.set(senderId, active);
  });
  ipcMain.handle("sf-api-base-url-get", () => ({
    apiBaseUrl: getApiBaseUrl(),
    customApiBaseUrl: getCustomApiBaseUrl(),
    defaultApiBaseUrl: getDefaultApiBaseUrl(),
    metadataUrl: getMetadataUrlOverride(),
  }));
  ipcMain.handle(
    "sf-api-base-url-set",
    (_event, payload: { apiBaseUrl?: string | null; baseUrl?: string | null } | null) => {
      const hasLegacyBase = payload && typeof payload.baseUrl === "string";
      const hasApi = payload && Object.prototype.hasOwnProperty.call(payload, "apiBaseUrl");
      const next = setCustomHosts({
        apiBaseUrl: hasApi
          ? payload?.apiBaseUrl ?? null
          : hasLegacyBase
            ? payload?.baseUrl ?? null
            : undefined,
      });
      return {
        ...next,
        defaultApiBaseUrl: getDefaultApiBaseUrl(),
      };
    }
  );
  registerAppWindowVisibilityIpc(ipcMain);
  registerExternalMpv(ipcMain, () => mainWindow, showMainWindow, {
    onPlaybackClosed: (reason) => {
      playbackServer?.clearObjectPayloadCache(reason);
      handoffBridge?.onPlaybackClosed(reason);
    },
    isHandoffPlayback: () => handoffBridge?.isHandoffPlayback() === true,
    onPlaybackProperty: (name, value) => handoffBridge?.onPlaybackProperty(name, value),
    onPlaybackLaunched: () => handoffBridge?.onPlaybackLaunched(),
    getTraffic: getStorageTraffic,
    onTrafficChange: onStorageTrafficChange,
    getPlaybackBaseUrl: () => playbackServer?.getBaseUrl() ?? null,
    getPreviewStatus: (formatId) => playbackRuntimeBridge.getPreviewStatus(formatId),
  });
  if (process.env.SF_LIBRARY_DB_DIRECT_SQLITE === "1") {
    registerLibraryDbIpc(ipcMain, () => mainWindow);
  } else {
    registerLibraryDbRuntimeProxy(ipcMain, () => mainWindow);
  }
  registerFileSystemIpc(ipcMain);
  toolAccessBridge = registerToolAccessIpc(ipcMain, () => mainWindow);
  handoffBridge = registerHandoffIpc(ipcMain, {
    getWindow: () => mainWindow,
    // A hand-off never brings the app forward: a missing window (closed to the tray) comes back hidden.
    ensureHiddenWindow: () => {
      if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
      if (!sessionStoreLoaded) return null;
      console.info("[handoff] no app window: creating one hidden for the hand-off");
      return createWindow({ show: false });
    },
  });
  registerPairingIpc();
  // In-app updates (REL-UPD-01), from `<api>/desktop/badger/`. `getWindow` is resolved lazily so a recreated window
  // still receives update events. The renderer arms the background check by pushing its `autoUpdate` setting (ON by
  // default) once it has loaded.
  createDesktopUpdater({
    app: "badger",
    electron: { app, ipcMain },
    loadAutoUpdater: () => electronUpdater.autoUpdater,
    getApiBaseUrl,
    getPlatformId: () => getDesktopPlatform().id,
    logger: scopeLogger("updater"),
    // REL-UPD-07: a .deb/.rpm/.pacman copy updates through /usr/lib/spacebadger/system-update.
    linuxPackageName: "spacebadger",
    // The windows close instead of going to the tray; `before-quit` still asks about work in progress.
    onQuitForUpdate: () => {
      isQuitting = true;
    },
  }).register(() => mainWindow);

  await sessionLoaded;
  const launchVisibility = decideLaunchVisibility({ argv: process.argv, openUrlBeforeWindow });
  if (launchVisibility === "background") {
    console.info("[handoff] started through a badger:// link: main window created hidden", {
      argvLink: findBadgerLink(process.argv),
      openUrlBeforeWindow,
    });
  }
  const win = createWindow({ show: launchVisibility === "foreground" });
  // #25: detect this computer's hardware on its first start (after createWindow
  // resolved SF_FFMPEG_PATH). #928: the probe runs ffmpeg test encodes; start it
  // once the first page has loaded and the startup burst is over, so it does not
  // compete with the runtime spawn and the first paint. Anything that needs the
  // result earlier (device settings, ingest) triggers the same memoized detection.
  let startupProbesRan = false;
  // A stored (or forced) mode only reads a setting: armed at once so uploads never run at full speed
  // during early playback. On a first start reading it runs the hardware probe, so it waits for the deferred one.
  const armUploadPolicyNow = !deviceSettings.uploadsDuringPlaybackNeedsDetection();
  const runStartupProbes = () => {
    if (startupProbesRan) return;
    startupProbesRan = true;
    detectOnFirstStart(deviceSettings);
    if (!armUploadPolicyNow) armUploadPlaybackPolicy();
  };
  const deferStartupProbes = () => setTimeout(runStartupProbes, STARTUP_PROBE_DELAY_MS).unref();
  win.webContents.once("did-finish-load", deferStartupProbes);
  win.webContents.once("did-fail-load", deferStartupProbes);
  if (armUploadPolicyNow) armUploadPlaybackPolicy();

  // Dock click (macOS): reopen the window whether it was closed to the tray
  // (destroyed), is still hidden while its renderer flushes, or is minimized
  // (PLAT-DESK-06). showMainWindow covers all three.
  // PLAT-WEB-05: opening a badger:// link can raise `activate` too; right after a link the window stays hidden.
  app.on("activate", () => {
    if (!shouldShowOnActivate({ now: Date.now(), lastLinkAt: lastBadgerLinkAt })) {
      console.info("[handoff] activate right after a badger:// link: window kept hidden");
      return;
    }
    showMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (shouldQuitWhenAllWindowsClosed({ isQuitting, quitWhenAllWindowsClosed: getDesktopPlatform().shell.quitWhenAllWindowsClosed })) {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  if (!quitConfirmed && !skipProcessingCloseConfirm && hasActiveProcessing()) {
    event.preventDefault();
    const strings = mainUiStrings();
    const options = {
      type: "warning" as const,
      title: strings.quitTitle,
      message: strings.quitMessage,
      detail: strings.quitDetail,
      buttons: [strings.quitKeep, strings.quitAnyway],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    const response = mainWindow
      ? dialog.showMessageBoxSync(mainWindow, options)
      : dialog.showMessageBoxSync(options);
    if (response !== 1) {
      isQuitting = false;
      return;
    }
    quitConfirmed = true;
    isQuitting = true;
    app.quit();
    return;
  }
  isQuitting = true;
  stopExternalMpvProcess();
  disposeMpvPreviewPictures();
  try {
    getActiveLibraryDb()?.close();
  } catch {
    // Best-effort flush.
  }
  void playbackRuntimeBridge.flushSignedUrlRequests();
  void uploadPlaybackPolicy.stop();
  toolAccessBridge?.stop();
  toolAccessBridge = null;
  handoffBridge?.stop();
  handoffBridge = null;
  appTray.destroy();
  void runtimeGuardian.stop();
});

// Last-resort safety net: kill the runtime synchronously on process exit.
// This handles cases where before-quit's async stop() didn't complete in time.
// Same for mpv: before-quit's dispose() escalation timers die with Electron,
// so a hung mpv would outlive the app (issue #25 P21).
process.on("exit", () => {
  runtimeGuardian.killSync();
  killAllMpvProcessGroupsSync();
  // MPV-PREV-01: the decrypted preview pictures' private temp dir never outlives the app.
  disposeMpvPreviewPictures();
});
