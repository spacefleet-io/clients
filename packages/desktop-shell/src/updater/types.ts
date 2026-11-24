/**
 * In-app desktop updater shared by Badger and Parrot desktop (REL-UPD-01): IPC channels, the events the main process
 * forwards, the bridge the preload exposes, and the one state reducer both the main process (to answer `getState`)
 * and the renderer hook use. No Electron or React import here: preload, main and renderer all read this file.
 */

/** Desktop apps with an update feed at `<api>/desktop/<app>/`. */
export type DesktopUpdaterApp = "badger" | "parrot";

export const UPDATER_CHANNELS = {
  /** invoke: explicit check (Settings "Check for updates"). */
  check: "sf-updater-check",
  /** invoke: download the available update (only needed when automatic updates are off). */
  download: "sf-updater-download",
  /** invoke: quit, install the downloaded update and relaunch ("Restart to update"). */
  install: "sf-updater-install",
  /** invoke: switch automatic updates on or off (the user's setting). */
  setAuto: "sf-updater-set-auto",
  /** invoke: current `UpdaterState`, so a window opened late still shows a finished download. */
  state: "sf-updater-state",
  /** invoke: "Remind me later" in the update modal: the offered version is not prompted again for a day (this run only). */
  remindLater: "sf-updater-remind-later",
  /** invoke: "Ignore" in the update modal: the offered version is never prompted nor installed on quit (kept on disk). */
  ignore: "sf-updater-ignore",
  /** main → renderer: one `UpdaterEvent`. */
  event: "sf-updater-event",
} as const;

/** The 4-hour cadence of the automatic background check (REL-UPD-01). */
export const AUTO_UPDATE_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** REL-UPD-08: the first automatic check waits this long after launch, so it never competes with the app starting up. */
export const AUTO_UPDATE_START_DELAY_MS = 30 * 1000;

/**
 * REL-UPD-08: the computer woke up from sleep: check again when the last automatic check is at least this old, so a
 * laptop closed overnight learns of a release the moment it opens.
 */
export const AUTO_UPDATE_MIN_GAP_MS = 30 * 60 * 1000;

/**
 * REL-UPD-08: the window coming back to the front checks again only when the user was away from it (no window of the
 * app focused) at least this long.
 */
export const AUTO_UPDATE_FOCUS_GAP_MS = 60 * 60 * 1000;

/** REL-UPD-08: "Remind me later" hides the update modal for this version this long (or until the app restarts). */
export const UPDATE_REMIND_LATER_MS = 24 * 60 * 60 * 1000;

/** Lifecycle events forwarded to the renderer over `UPDATER_CHANNELS.event`. */
export type UpdaterEvent =
  | { kind: "checking" }
  // `checkedAt` (epoch ms): when the check that produced this answer finished, shown as "checked <time>" in Settings.
  | { kind: "update-available"; version: string; releaseNotes: string | null; checkedAt?: number }
  | { kind: "update-not-available"; checkedAt?: number }
  | { kind: "download-progress"; percent: number }
  | { kind: "update-downloaded"; version: string }
  | { kind: "error"; message: string }
  // The API `release-status` reports this build is below `minClientVersion`: a server-driven mandatory update.
  | { kind: "mandatory-update"; latestVersion: string; minClientVersion: string }
  // E2E only (SF_UPDATER_TEST_MODE): the install IPC fired; the real quitAndInstall would kill the test's connection.
  | { kind: "restart-requested" }
  // REL-UPD-07 (channels "system" and "flatpak"): the password dialog (or Flatpak's "Update {app}?" question) is up,
  // or the package manager / the Flatpak portal is updating.
  | { kind: "system-installing" }
  // Channel "flatpak": the portal's progress of the whole update (0–100).
  | { kind: "system-progress"; percent: number }
  // The update installed `version`; the app quits and starts it by itself ("Restart {app}" in Settings if not).
  | { kind: "system-installed"; version: string }
  // The user closed the password dialog (or refused Flatpak's question): back to "available", nothing changed.
  | { kind: "system-dismissed" }
  | { kind: "system-failed"; failure: SystemUpdateFailure; detail: string | null; manualCommand: string | null }
  // REL-UPD-08: "Remind me later" in the update modal: `version` is not prompted again before `until` (epoch ms).
  | { kind: "prompt-snoozed"; version: string; until: number }
  // REL-UPD-08: "Ignore" in the update modal: `version` is never prompted again nor installed on quit.
  | { kind: "prompt-ignored"; version: string }
  // REL-UPD-01: the automatic-updates setting the main process applied. The renderer's first state snapshot can be
  // taken before the window pushed its stored setting; without this the modal would read it as off for the session.
  | { kind: "auto-update"; enabled: boolean };

/**
 * How this copy gets a new version (REL-UPD-07): `self` electron-updater (AppImage, Windows, macOS); `system` the
 * system's package manager through the password dialog (.deb, .rpm, .pacman); `flatpak` the Flatpak portal
 * (flatpakPortal.ts), or `flatpak update` by hand when the portal can't.
 */
export type UpdateChannel = "self" | "system" | "flatpak";

/**
 * Why a system-package update did not happen (systemPackage.ts maps the helper's and pkexec's exit codes; `network` is a
 * package-manager failure whose output shows SpaceFleet's repository could not be reached).
 */
export type SystemUpdateFailure =
  | "notNewer"
  | "repoMissing"
  | "needsSystemUpdate"
  | "network"
  | "packageManager"
  | "notAuthorized"
  | "noPasswordDialog"
  | "other";

export type UpdaterCheckResult =
  | { status: "available"; version: string }
  | { status: "up-to-date" }
  | { status: "unsupported" }
  | { status: "error"; message: string };

/**
 * `idle` resting; `downloaded` sticks until restart; `unsupported` = no working updater in this build (unpackaged
 * dev build, non-semver version), the UI hides update affordances. Channel `system` goes `available` → `installing`
 * (password dialog, package manager) → `installed`, which sticks until restart like `downloaded`.
 */
export type UpdaterPhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "installed"
  | "error"
  | "unsupported";

export type UpdaterState = {
  phase: UpdaterPhase;
  /** Available/downloaded version, when known. */
  version: string | null;
  releaseNotes: string | null;
  /** 0–100 while downloading, and while a Flatpak installs its update. */
  progress: number;
  errorMessage: string | null;
  /** Latched once release-status reported this build below `minClientVersion`; never cleared by a dismiss. */
  mandatory: boolean;
  /** The automatic-updates setting the main process runs with (REL-UPD-01: ON unless the user turned it off). */
  autoUpdate: boolean;
  /** The installed app version (`app.getVersion()`), filled by the main process's `getState`; null before it answers. */
  currentVersion: string | null;
  /** When the last check (automatic or by hand) got an answer from the feed (epoch ms); null = not checked this run. */
  lastCheckedAt: number | null;
  /** How this copy updates (REL-UPD-07). */
  channel: UpdateChannel;
  /**
   * Channel `system`: the app can open the password dialog itself (pkexec and a display are there). Channel `flatpak`:
   * the Flatpak portal can update the app (portal version 2 or later).
   */
  canInstall: boolean;
  /** Channels `system`/`flatpak`: the terminal command that does the update by hand (shown with a copy button). */
  manualCommand: string | null;
  /** Channel `system`, phase `error`: why the update did not happen, and the package manager's last lines. */
  failure: SystemUpdateFailure | null;
  failureDetail: string | null;
  /** REL-UPD-08: "Remind me later" holds the modal for this version until `until` (epoch ms); in memory, so a restart asks again. */
  remindLater: { version: string; until: number } | null;
  /** REL-UPD-08: the version the user chose to ignore (kept across restarts); a newer version prompts again. */
  ignoredVersion: string | null;
};

export const INITIAL_UPDATER_STATE: UpdaterState = {
  phase: "idle",
  version: null,
  releaseNotes: null,
  progress: 0,
  errorMessage: null,
  mandatory: false,
  autoUpdate: false,
  currentVersion: null,
  lastCheckedAt: null,
  channel: "self",
  canInstall: false,
  manualCommand: null,
  failure: null,
  failureDetail: null,
  remindLater: null,
  ignoredVersion: null,
};

/** Phases that wait for a restart: a background check or failure never replaces them. */
export const awaitsRestart = (phase: UpdaterPhase): boolean => phase === "downloaded" || phase === "installed";

/** Fold one event into the state. Shared by main (`getState`) and the renderer hook so both agree. */
export const reduceUpdaterState = (prev: UpdaterState, event: UpdaterEvent): UpdaterState => {
  switch (event.kind) {
    case "checking":
      // A background re-check never hides a finished download or system update.
      return awaitsRestart(prev.phase) ? prev : { ...prev, phase: "checking", errorMessage: null };
    case "update-available": {
      const lastCheckedAt = event.checkedAt ?? prev.lastCheckedAt;
      return awaitsRestart(prev.phase) && prev.version === event.version
        ? { ...prev, lastCheckedAt }
        : { ...prev, phase: "available", version: event.version, releaseNotes: event.releaseNotes, lastCheckedAt };
    }
    case "update-not-available": {
      const lastCheckedAt = event.checkedAt ?? prev.lastCheckedAt;
      return awaitsRestart(prev.phase) ? { ...prev, lastCheckedAt } : { ...prev, phase: "idle", lastCheckedAt };
    }
    case "download-progress":
      return { ...prev, phase: "downloading", progress: event.percent };
    case "update-downloaded":
      return { ...prev, phase: "downloaded", version: event.version, progress: 100, errorMessage: null };
    case "error":
      // A failed background check after a finished download keeps the download installable.
      return awaitsRestart(prev.phase) ? prev : { ...prev, phase: "error", errorMessage: event.message, failure: null, failureDetail: null };
    case "mandatory-update":
      return {
        ...prev,
        mandatory: true,
        version: prev.version ?? event.latestVersion,
        phase: prev.phase === "idle" ? "available" : prev.phase,
      };
    case "restart-requested":
      return prev;
    case "system-installing":
      return { ...prev, phase: "installing", progress: 0, errorMessage: null, failure: null, failureDetail: null };
    case "system-progress":
      return prev.phase === "installing" ? { ...prev, progress: event.percent } : prev;
    case "system-installed":
      return { ...prev, phase: "installed", version: event.version, errorMessage: null, failure: null, failureDetail: null };
    case "system-dismissed":
      return { ...prev, phase: "available" };
    case "system-failed":
      return {
        ...prev,
        phase: "error",
        errorMessage: event.failure,
        failure: event.failure,
        failureDetail: event.detail,
        manualCommand: event.manualCommand ?? prev.manualCommand,
      };
    case "prompt-snoozed":
      return { ...prev, remindLater: { version: event.version, until: event.until } };
    case "prompt-ignored":
      return { ...prev, ignoredVersion: event.version };
    case "auto-update":
      return { ...prev, autoUpdate: event.enabled };
  }
};

/** What the preload exposes to the renderer (`window.spaceBadger.updater`, `window.parrot.updater`). */
export type UpdaterBridge = {
  check: () => Promise<UpdaterCheckResult>;
  downloadUpdate: () => Promise<{ ok: boolean; message?: string }>;
  installAndRestart: () => Promise<{ ok: boolean }>;
  setAutoUpdate: (enabled: boolean) => Promise<{ ok: boolean }>;
  getState: () => Promise<UpdaterState>;
  onEvent: (listener: (event: UpdaterEvent) => void) => () => void;
  /** REL-UPD-08: "Remind me later" for the offered version (refused for a mandatory update). */
  remindLater: () => Promise<{ ok: boolean }>;
  /** REL-UPD-08: "Ignore" the offered version (refused for a mandatory update). */
  ignoreVersion: () => Promise<{ ok: boolean }>;
};
