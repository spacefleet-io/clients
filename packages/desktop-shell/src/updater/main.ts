/**
 * Main-process side of the in-app desktop updater shared by Badger and Parrot desktop (REL-UPD-01, REL-UPD-02).
 *
 * Wraps electron-updater's `autoUpdater` on every OS: AppImageUpdater / Deb / Rpm / PacmanUpdater on Linux (it picks
 * the installed format from `resources/package-type`), NsisUpdater on Windows (publisher check from app-update.yml,
 * REL-INST-03), MacUpdater (Squirrel.Mac, the signed `-mac.zip`) on macOS.
 *
 * Feed: the API serves the electron-updater "generic" feed at `<api>/desktop/<app>/` (`latest-linux.yml`,
 * `latest.yml`, `latest-mac.yml` and the files they list). The API host can change at runtime, so the feed URL is set
 * before every check.
 *
 * Automatic updates (the user's setting, ON by default): a check at start and every 6 hours; a found update downloads
 * in the background and installs when the app quits, or at once through "Restart to update". An update never installs
 * while the app is running, so never during playback. With the setting off the user checks, downloads and restarts by
 * hand from Settings.
 *
 * REL-UPD-07: a Linux copy installed by the system's package manager (.deb, .rpm, .pacman) or as a Flatpak never runs
 * electron-updater. It checks release-status on the same schedule and behind the same setting, naming its install
 * channel (`pacman`, `deb`, `rpm`, `flatpak`) so the API answers with the version its own repository already serves,
 * and the window asks the user in a modal; "Install now" opens the desktop's password dialog for the package's own
 * update helper (systemPackage.ts), which updates that one package, and the app then quits and starts its new version
 * by itself. A Flatpak is only told the `flatpak update` command.
 *
 * electron-updater only works inside a packaged app: every entry point short-circuits when `!app.isPackaged` (except
 * the E2E test mode) and answers "unsupported".
 */
import { compareVersions } from "@space/shared/appVersion";
import {
  canAskPassword,
  detectLinuxInstall,
  manualCommand,
  nodeSystemProbe,
  runSystemUpdate,
  type LinuxInstall,
  type SystemProbe,
} from "./systemPackage";
import {
  AUTO_UPDATE_INTERVAL_MS,
  INITIAL_UPDATER_STATE,
  UPDATER_CHANNELS,
  reduceUpdaterState,
  type DesktopUpdaterApp,
  type UpdaterCheckResult,
  type UpdaterEvent,
  type UpdaterState,
} from "./types";

// Structural slices of Electron and electron-updater: this package imports neither. Each app passes its own
// `app`/`ipcMain` and a loader for electron-updater's `autoUpdater` (Badger ships electron-updater as a runtime
// dependency, Parrot bundles it).

/** The part of electron-updater's `UpdateInfo` read here. */
export type UpdaterUpdateInfo = {
  version: string;
  releaseNotes?: string | ReadonlyArray<{ note?: string | null }> | null;
};

/** What electron-updater's `checkForUpdates` resolves to (the part read here). */
export type UpdaterCheckForUpdatesResult = {
  isUpdateAvailable: boolean;
  updateInfo: UpdaterUpdateInfo;
  /** With `autoDownload` on, the download the check started; electron-updater never awaits it. */
  downloadPromise?: Promise<unknown> | null;
} | null;

/** The part of electron-updater's `AppUpdater` (`autoUpdater`) used here. */
export type AutoUpdaterLike = {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  forceDevUpdateConfig: boolean;
  disableDifferentialDownload: boolean;
  logger: unknown;
  setFeedURL: (options: { provider: "generic"; url: string }) => void;
  checkForUpdates: () => Promise<UpdaterCheckForUpdatesResult>;
  downloadUpdate: () => Promise<unknown>;
  quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => void;
  on(event: "checking-for-update" | "update-not-available", listener: () => void): unknown;
  on(event: "update-available" | "update-downloaded", listener: (info: UpdaterUpdateInfo) => void): unknown;
  on(event: "download-progress", listener: (progress: { percent: number }) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
};

/** `quit`: the relaunch after a system-package update (REL-UPD-07) quits, and `relaunchAfterExit` starts the new binary. */
export type UpdaterElectronApp = { isPackaged: boolean; getVersion: () => string; quit: () => void };
export type UpdaterIpcMain = { handle: (channel: string, listener: (event: unknown, ...args: any[]) => unknown) => void };
/** The window events go to (Electron's `BrowserWindow`). */
export type UpdaterWindow = { isDestroyed: () => boolean; webContents: { send: (channel: string, payload: UpdaterEvent) => void } };

type LogFn = (fields: Record<string, unknown>, message: string) => void;
export type UpdaterLogger = { info: LogFn; warn: LogFn; error: LogFn };

export type DesktopUpdaterOptions = {
  app: DesktopUpdaterApp;
  electron: { app: UpdaterElectronApp; ipcMain: UpdaterIpcMain };
  /**
   * Returns electron-updater's `autoUpdater`. Reading it builds the OS updater (and throws on a bad version), so it is
   * read lazily, inside the registration guard. electron-updater is CommonJS: read it off the default import.
   */
  loadAutoUpdater: () => AutoUpdaterLike;
  getApiBaseUrl: () => string;
  /** `linux` | `windows` | `macos`, sent to release-status. */
  getPlatformId: () => string;
  logger: UpdaterLogger;
  /** Persist the setting when the window changes it (Parrot keeps it in main; Badger in the window's own settings). */
  onAutoUpdateChange?: (enabled: boolean) => void;
  /**
   * Runs just before "Restart to update" quits, and the quit waits for it. The app marks itself as quitting here: on
   * macOS the native updater closes the windows before `before-quit`, and a close-to-tray window would otherwise only
   * hide and stop the quit. Parrot also saves its queued edits here (PAR-PL-05).
   */
  onQuitForUpdate: () => void | Promise<void>;
  /** The app's .deb/.rpm/.pacman package name (`spacebadger`, `spaceparrot`): its update helper is `/usr/lib/<name>/system-update`. */
  linuxPackageName: string;
  /** Test seam: the OS calls of systemPackage.ts. */
  systemProbe?: SystemProbe;
};

export type DesktopUpdater = {
  /** Register the IPC handlers once; `getWindow` is read on every event so a recreated window still gets them. */
  register: (getWindow: () => UpdaterWindow | null) => void;
  /** Apply the user's automatic-updates setting: arms (check now + every 6 h) or disarms the background check. */
  setAutoUpdate: (enabled: boolean) => void;
};

/** API `GET /desktop/<app>/release-status` (untrusted wire data: every field is validated where read). */
type ReleaseStatus = { latestVersion: string | null; minClientVersion: string; mandatory: boolean };

// Strict semver 2.0.0: electron-updater's updaters throw from their constructor on anything else.
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * E2E escape hatch (`SF_UPDATER_TEST_MODE=1`, never set in a release): runs the updater in an unpackaged build
 * against a mock feed (`forceDevUpdateConfig`, no differential download) and replaces `quitAndInstall` with a
 * `restart-requested` event, since a real relaunch would cut the test's connection.
 */
const isUpdaterTestMode = (): boolean => process.env.SF_UPDATER_TEST_MODE === "1";

/** Shortest cadence `SF_UPDATER_CHECK_INTERVAL_MS` may set. */
const MIN_TEST_INTERVAL_MS = 1_000;

/** REL-UPD-07: how long "installed, restarting" shows before the app quits and starts its new version. */
export const SYSTEM_RELAUNCH_DELAY_MS = 1_500;

/**
 * REL-UPD-07: after the package manager answered "nothing newer" for a version release-status offered (the
 * repository's metadata not refreshed yet on this computer or a mirror), that version is not offered again for this
 * long: the user sees "A new version is on its way" once, not the same failing offer at every check. One hour covers
 * the metadata's 60-second cache and the 30-minute repository publish.
 */
export const SYSTEM_UPDATE_HOLD_MS = 60 * 60 * 1000;

/**
 * E2E hook (`SF_UPDATER_CHECK_INTERVAL_MS`, never set in a release): the automatic background check runs on this
 * cadence instead of every 6 hours, so the update e2e can watch the real timer fire in a packaged app. Anything but a
 * whole number of at least 1000 ms keeps 6 hours.
 */
const autoCheckIntervalMs = (logger: UpdaterLogger): number => {
  const value = process.env.SF_UPDATER_CHECK_INTERVAL_MS?.trim() ?? "";
  if (value === "") return AUTO_UPDATE_INTERVAL_MS;
  const ms = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (Number.isSafeInteger(ms) && ms >= MIN_TEST_INTERVAL_MS) return ms;
  logger.warn({ value }, `SF_UPDATER_CHECK_INTERVAL_MS ignored (not a whole number ≥ ${MIN_TEST_INTERVAL_MS} ms) — checking every 6 hours`);
  return AUTO_UPDATE_INTERVAL_MS;
};

/**
 * REL-DIST-10: on Linux only the AppImage runs electron-updater (the AppImage runtime sets `APPIMAGE` to the file's
 * path). A copy installed from the SpaceFleet APT/DNF/pacman repositories or a Flatpak is updated through the system's
 * package manager (REL-UPD-07, `registerPackageManagerHandlers`).
 */
const isSystemPackagedLinux = (platformId: string): boolean =>
  platformId === "linux" && !process.env.APPIMAGE && !isUpdaterTestMode();

const releaseNotesToText = (notes: UpdaterUpdateInfo["releaseNotes"]): string | null => {
  if (!notes) return null;
  if (typeof notes === "string") return notes;
  return notes.map((entry) => entry.note ?? "").filter((note) => note.length > 0).join("\n\n") || null;
};

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export const createDesktopUpdater = ({
  app: appId,
  electron: { app, ipcMain },
  loadAutoUpdater,
  getApiBaseUrl,
  getPlatformId,
  logger,
  onAutoUpdateChange,
  onQuitForUpdate,
  linuxPackageName,
  systemProbe = nodeSystemProbe,
}: DesktopUpdaterOptions): DesktopUpdater => {
  let registered = false;
  let windowGetter: (() => UpdaterWindow | null) | null = null;
  let updater: AutoUpdaterLike | null = null;
  let autoEnabled = false;
  let autoTimer: ReturnType<typeof setInterval> | null = null;
  let state: UpdaterState = INITIAL_UPDATER_STATE;
  /** REL-UPD-07: set once a package-manager or Flatpak install is detected; electron-updater is never built then. */
  let packageInstall: Extract<LinuxInstall, { kind: "system" | "flatpak" }> | null = null;
  /** REL-UPD-07: a version the package manager could not find yet, not offered again until `until`. */
  let heldBack: { version: string; until: number } | null = null;
  /** Settles when the install type is known; the IPC handlers wait for it so the window never sees a half state. */
  let ready: Promise<void> = Promise.resolve();

  const canRun = (): boolean =>
    (app.isPackaged || isUpdaterTestMode()) && (packageInstall !== null || !isSystemPackagedLinux(getPlatformId()));
  const feedUrl = (): string => `${getApiBaseUrl().replace(/\/+$/, "")}/desktop/${appId}`;

  const emit = (event: UpdaterEvent): void => {
    state = reduceUpdaterState(state, event);
    const win = windowGetter?.();
    if (win && !win.isDestroyed()) win.webContents.send(UPDATER_CHANNELS.event, event);
  };

  /**
   * REL-UPD-07: release-status `channel`, how this Linux copy updates, so the API answers with the version its own
   * repository serves (the feed announces a release up to 30 minutes before the repositories have it).
   */
  const releaseChannel = (): string | null => {
    if (getPlatformId() !== "linux") return null;
    if (!packageInstall) return "appimage";
    if (packageInstall.kind === "flatpak") return "flatpak";
    return packageInstall.manager === "pacman" ? "pacman" : packageInstall.manager === "apt" ? "deb" : "rpm";
  };

  /** API release-status for this build (throws when the API can't be reached or answers an error). */
  const fetchReleaseStatus = async (): Promise<Partial<ReleaseStatus> | null> => {
    const channel = releaseChannel();
    const url = `${feedUrl()}/release-status?currentVersion=${encodeURIComponent(app.getVersion())}&platform=${getPlatformId()}${channel ? `&channel=${channel}` : ""}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`release-status answered HTTP ${response.status}`);
    return (await response.json()) as Partial<ReleaseStatus> | null;
  };

  const emitMandatory = (status: Partial<ReleaseStatus> | null): void => {
    if (status?.mandatory === true && typeof status.latestVersion === "string" && typeof status.minClientVersion === "string") {
      emit({ kind: "mandatory-update", latestVersion: status.latestVersion, minClientVersion: status.minClientVersion });
    }
  };

  /** Best-effort mandatory-update signal from release-status, on top of electron-updater's own check. */
  const checkReleaseStatus = async (): Promise<void> => {
    try {
      emitMandatory(await fetchReleaseStatus());
    } catch (err) {
      logger.warn({ message: errorMessage(err) }, "release-status check failed");
    }
  };

  /** REL-UPD-07: the check of a package-manager or Flatpak copy: release-status's latest version against this build. */
  const checkPackageFeed = async (): Promise<UpdaterCheckResult> => {
    if (state.phase === "installing" || state.phase === "installed") {
      logger.info({ phase: state.phase, version: state.version }, "update check skipped — system update in progress or done");
      return state.version ? { status: "available", version: state.version } : { status: "up-to-date" };
    }
    emit({ kind: "checking" });
    try {
      const status = await fetchReleaseStatus();
      emitMandatory(status);
      const latest = typeof status?.latestVersion === "string" && SEMVER_PATTERN.test(status.latestVersion) ? status.latestVersion : null;
      const current = app.getVersion();
      logger.info({ latest, current, channel: packageInstall?.kind, channelParam: releaseChannel(), heldBack }, "package update check");
      if (latest && heldBack?.version === latest && Date.now() < heldBack.until) {
        logger.info({ latest, until: new Date(heldBack.until).toISOString() }, "package update held back — the package manager did not have it yet");
        emit({ kind: "update-not-available", checkedAt: Date.now() });
        return { status: "up-to-date" };
      }
      if (latest && compareVersions(latest, current) > 0) {
        emit({ kind: "update-available", version: latest, releaseNotes: null, checkedAt: Date.now() });
        return { status: "available", version: latest };
      }
      emit({ kind: "update-not-available", checkedAt: Date.now() });
      return { status: "up-to-date" };
    } catch (err) {
      logger.warn({ message: errorMessage(err) }, "package update check failed");
      emit({ kind: "error", message: errorMessage(err) });
      return { status: "error", message: errorMessage(err) };
    }
  };

  /** Point the updater at the live feed and apply the automatic-updates setting to it. */
  const prepare = (au: AutoUpdaterLike): void => {
    au.setFeedURL({ provider: "generic", url: feedUrl() });
    // Automatic: a found update downloads at once and installs when the app quits. Manual: the user clicks.
    au.autoDownload = autoEnabled;
    au.autoInstallOnAppQuit = autoEnabled;
  };

  /**
   * With automatic updates on, `checkForUpdates` starts the download and hands back its promise unawaited. A failed
   * download is already reported through the "error" event (logged, shown in Settings), so its rejection is caught
   * here: left alone it reached the error reporter as an unhandled rejection (e.g. macOS Squirrel refusing an app
   * started from a read-only volume, REL-UPD-05).
   */
  const settleAutoDownload = (result: UpdaterCheckForUpdatesResult): void => {
    result?.downloadPromise?.catch((err: unknown) =>
      logger.warn({ message: errorMessage(err) }, "automatic update download failed — reported through the updater's error event"),
    );
  };

  const backgroundCheck = (): void => {
    if (packageInstall) {
      void checkPackageFeed();
      return;
    }
    const au = updater;
    if (!au) return;
    // A finished download waits for the restart; checking again would only download it again.
    if (state.phase === "downloaded" || state.phase === "downloading") {
      logger.info({ phase: state.phase, version: state.version }, "scheduled update check skipped — update already in hand");
      return;
    }
    prepare(au);
    void checkReleaseStatus();
    au.checkForUpdates()
      .then(settleAutoDownload)
      .catch((err: unknown) => logger.warn({ message: errorMessage(err) }, "scheduled update check failed"));
  };

  const armAutoChecks = (): void => {
    if (autoTimer) {
      clearInterval(autoTimer);
      autoTimer = null;
    }
    if (updater) {
      updater.autoDownload = autoEnabled;
      updater.autoInstallOnAppQuit = autoEnabled;
    }
    if (!autoEnabled || !canRun()) return;
    if (!updater && !packageInstall) {
      logger.warn({ version: app.getVersion() }, "automatic update checks skipped — in-app updater unavailable");
      return;
    }
    const intervalMs = autoCheckIntervalMs(logger);
    logger.info({ intervalMs, feed: feedUrl() }, "automatic update checks armed");
    backgroundCheck();
    autoTimer = setInterval(backgroundCheck, intervalMs);
  };

  const registerUnavailableHandlers = (): void => {
    state = { ...INITIAL_UPDATER_STATE, phase: "unsupported" };
    ipcMain.handle(UPDATER_CHANNELS.check, (): UpdaterCheckResult => ({ status: "unsupported" }));
    ipcMain.handle(UPDATER_CHANNELS.download, () => ({ ok: false, message: "unsupported" }));
    ipcMain.handle(UPDATER_CHANNELS.install, () => ({ ok: false }));
  };

  let relaunching = false;
  /**
   * REL-UPD-07: after the package manager replaced this app's files, quit and start the new binary (same path, same
   * arguments) once this process has exited. Runs once; the install IPC (Settings' "Restart {app}") reaches it too.
   */
  const relaunchAfterSystemUpdate = async (): Promise<void> => {
    if (relaunching) return;
    relaunching = true;
    logger.info({ version: state.version, execPath: process.execPath }, "relaunch after system update");
    try {
      await onQuitForUpdate();
    } catch (err) {
      logger.warn({ message: errorMessage(err) }, "pre-quit step failed — relaunching anyway");
    }
    systemProbe.relaunchAfterExit(process.execPath, process.argv.slice(1));
    app.quit();
  };

  /** REL-UPD-07: "Install" on a package-manager copy: the password dialog, then the package's own update helper. */
  const installFromPackageManager = async (): Promise<{ ok: boolean; message?: string }> => {
    const install = packageInstall;
    if (install?.kind !== "system") return { ok: false, message: install ? "manual" : "unsupported" };
    if (state.phase === "installing") return { ok: false, message: "busy" };
    if (!state.canInstall) {
      logger.info({ helper: install.helperPath }, "system update: no password dialog here (pkexec or display missing) — manual command only");
      emit({ kind: "system-failed", failure: "noPasswordDialog", detail: null, manualCommand: manualCommand(install) });
      return { ok: false, message: "noPasswordDialog" };
    }
    const version = state.version;
    emit({ kind: "system-installing" });
    logger.info({ helper: install.helperPath, manager: install.manager, from: app.getVersion(), to: version }, "system update: pkexec");
    const outcome = await runSystemUpdate(install.helperPath, systemProbe);
    logger.info({ outcome }, "system update finished");
    switch (outcome.result) {
      case "updated":
        emit({ kind: "system-installed", version: version ?? outcome.after ?? "" });
        // Chris 2026-11-21: the app restarts itself on the new version, no "Restart" click. The pause lets the modal
        // say "installed, restarting" first.
        setTimeout(() => void relaunchAfterSystemUpdate(), SYSTEM_RELAUNCH_DELAY_MS);
        return { ok: true };
      case "dismissed":
        emit({ kind: "system-dismissed" });
        return { ok: false, message: "dismissed" };
      case "failed":
        // The repository this computer reads does not list the offered version yet (a race with the publish or a
        // mirror's cache): the modal says it is on its way, and the version is not offered again for an hour.
        if (outcome.failure === "notNewer" && version) {
          heldBack = { version, until: Date.now() + SYSTEM_UPDATE_HOLD_MS };
          logger.info({ version, until: new Date(heldBack.until).toISOString() }, "system update: repository not ready — version held back");
        }
        emit({
          kind: "system-failed",
          failure: outcome.failure,
          detail: outcome.detail || null,
          manualCommand: manualCommand(install, outcome.failure),
        });
        return { ok: false, message: outcome.failure };
    }
  };

  /** REL-UPD-07: a Linux copy without electron-updater. Until the install type is known it reads as unsupported. */
  const registerPackageManagerHandlers = (): void => {
    state = { ...INITIAL_UPDATER_STATE, phase: "unsupported" };
    ready = detectLinuxInstall(linuxPackageName, systemProbe)
      .then((install) => {
        if (install.kind !== "system" && install.kind !== "flatpak") {
          logger.info({ install, version: app.getVersion() }, "in-app updates off — this Linux copy is not from SpaceFleet's packages");
          return;
        }
        packageInstall = install;
        const canInstall = install.kind === "system" && canAskPassword(systemProbe);
        state = { ...state, phase: "idle", channel: install.kind, canInstall, manualCommand: manualCommand(install) };
        logger.info({ install, canInstall, version: app.getVersion() }, "updates through the system's package manager");
        armAutoChecks();
      })
      .catch((err: unknown) => logger.error({ message: errorMessage(err) }, "install type detection failed — in-app updates off"));
    ipcMain.handle(UPDATER_CHANNELS.check, async (): Promise<UpdaterCheckResult> => {
      await ready;
      return packageInstall ? checkPackageFeed() : { status: "unsupported" };
    });
    ipcMain.handle(UPDATER_CHANNELS.download, async () => {
      await ready;
      return installFromPackageManager();
    });
    ipcMain.handle(UPDATER_CHANNELS.install, async (): Promise<{ ok: boolean }> => {
      await ready;
      if (state.phase !== "installed") return { ok: false };
      await relaunchAfterSystemUpdate();
      return { ok: true };
    });
  };

  const register = (getWindow: () => UpdaterWindow | null): void => {
    if (registered) return;
    registered = true;
    windowGetter = getWindow;

    ipcMain.handle(UPDATER_CHANNELS.setAuto, (_event: unknown, enabled: unknown) => {
      setAutoUpdate(Boolean(enabled));
      onAutoUpdateChange?.(Boolean(enabled));
      return { ok: true };
    });
    // The installed version rides every snapshot, also when the updater is unavailable: Settings always shows it.
    ipcMain.handle(UPDATER_CHANNELS.state, async (): Promise<UpdaterState> => {
      await ready;
      return { ...state, autoUpdate: autoEnabled, currentVersion: app.getVersion() };
    });

    if (isSystemPackagedLinux(getPlatformId())) {
      registerPackageManagerHandlers();
      return;
    }

    // REL-UPD-02: a broken updater never stops the window from opening. A dev or e2e launch of the bare script
    // reports version "0.0", which electron-updater's constructors reject: skip with one log line.
    const version = app.getVersion();
    if (!SEMVER_PATTERN.test(version)) {
      logger.warn({ version, packaged: app.isPackaged }, "in-app updater skipped — app version is not valid semver (dev launch without package.json?)");
      registerUnavailableHandlers();
      return;
    }
    let au: AutoUpdaterLike;
    try {
      au = loadAutoUpdater();
    } catch (err) {
      logger.error({ version, packaged: app.isPackaged, message: errorMessage(err) }, "in-app updater registration failed — updates disabled for this run");
      registerUnavailableHandlers();
      return;
    }
    updater = au;
    au.autoDownload = autoEnabled;
    au.autoInstallOnAppQuit = autoEnabled;
    if (isUpdaterTestMode()) {
      au.forceDevUpdateConfig = true;
      au.disableDifferentialDownload = true;
    }
    au.logger = {
      info: (m: unknown) => logger.info({ msg: String(m) }, "autoUpdater"),
      warn: (m: unknown) => logger.warn({ msg: String(m) }, "autoUpdater"),
      error: (m: unknown) => logger.error({ msg: String(m) }, "autoUpdater"),
      debug: () => undefined,
    };
    au.on("checking-for-update", () => emit({ kind: "checking" }));
    au.on("update-available", (info) => {
      logger.info({ version: info.version, current: app.getVersion(), autoDownload: au.autoDownload }, "update available");
      emit({ kind: "update-available", version: info.version, releaseNotes: releaseNotesToText(info.releaseNotes), checkedAt: Date.now() });
    });
    au.on("update-not-available", () => emit({ kind: "update-not-available", checkedAt: Date.now() }));
    au.on("download-progress", (progress) => emit({ kind: "download-progress", percent: Math.round(progress.percent) }));
    au.on("update-downloaded", (info) => {
      logger.info({ version: info.version, installOnQuit: au.autoInstallOnAppQuit }, "update downloaded — installs on restart");
      emit({ kind: "update-downloaded", version: info.version });
    });
    au.on("error", (err) => {
      logger.error({ message: err.message }, "updater error");
      emit({ kind: "error", message: err.message || "update_failed" });
    });

    ipcMain.handle(UPDATER_CHANNELS.check, async (): Promise<UpdaterCheckResult> => {
      if (!canRun()) {
        logger.info({}, "update check skipped — app is not packaged");
        return { status: "unsupported" };
      }
      // A downloaded update waits for the restart. Checking again makes electron-updater re-stage it (on macOS
      // Squirrel then drops the staged bundle and a restart in that window silently relaunches the old build).
      if (state.phase === "downloaded" && state.version) {
        logger.info({ version: state.version }, "update check skipped — update already downloaded");
        return { status: "available", version: state.version };
      }
      void checkReleaseStatus();
      try {
        prepare(au);
        const result = await au.checkForUpdates();
        settleAutoDownload(result);
        const found = result?.isUpdateAvailable ? result.updateInfo.version : null;
        return found ? { status: "available", version: found } : { status: "up-to-date" };
      } catch (err) {
        logger.error({ message: errorMessage(err) }, "update check failed");
        return { status: "error", message: errorMessage(err) };
      }
    });

    ipcMain.handle(UPDATER_CHANNELS.download, async (): Promise<{ ok: boolean; message?: string }> => {
      if (!canRun()) return { ok: false, message: "unsupported" };
      if (state.phase === "downloaded" && state.version) {
        // Nothing to fetch: re-announce the download so a renderer that just asked for it leaves "downloading".
        emit({ kind: "update-downloaded", version: state.version });
        return { ok: true };
      }
      try {
        au.setFeedURL({ provider: "generic", url: feedUrl() });
        await au.downloadUpdate();
        return { ok: true };
      } catch (err) {
        logger.error({ message: errorMessage(err) }, "update download failed");
        return { ok: false, message: errorMessage(err) };
      }
    });

    ipcMain.handle(UPDATER_CHANNELS.install, async (): Promise<{ ok: boolean }> => {
      if (!canRun()) return { ok: false };
      if (isUpdaterTestMode()) {
        emit({ kind: "restart-requested" });
        return { ok: true };
      }
      logger.info({ version: state.version }, "restart to update");
      await onQuitForUpdate();
      // isSilent: no installer window on Windows (the one-click NSIS installer runs with /S); isForceRunAfter: relaunch.
      au.quitAndInstall(true, true);
      return { ok: true };
    });

    logger.info({ packaged: app.isPackaged, version, feed: feedUrl() }, "updater registered");
    armAutoChecks();
  };

  const setAutoUpdate = (enabled: boolean): void => {
    if (enabled === autoEnabled && (autoTimer !== null || !enabled)) return;
    autoEnabled = enabled;
    logger.info({ enabled }, "automatic updates setting applied");
    armAutoChecks();
  };

  return { register, setAutoUpdate };
};
