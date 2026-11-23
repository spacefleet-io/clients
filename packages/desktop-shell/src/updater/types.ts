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
  /** main → renderer: one `UpdaterEvent`. */
  event: "sf-updater-event",
} as const;

/** The 6-hour cadence of the automatic background check (REL-UPD-01). */
export const AUTO_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;

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
  | { kind: "restart-requested" };

export type UpdaterCheckResult =
  | { status: "available"; version: string }
  | { status: "up-to-date" }
  | { status: "unsupported" }
  | { status: "error"; message: string };

/**
 * `idle` resting; `downloaded` sticks until restart; `unsupported` = no working updater in this build (unpackaged
 * dev build, non-semver version), the UI hides update affordances.
 */
export type UpdaterPhase = "idle" | "checking" | "available" | "downloading" | "downloaded" | "error" | "unsupported";

export type UpdaterState = {
  phase: UpdaterPhase;
  /** Available/downloaded version, when known. */
  version: string | null;
  releaseNotes: string | null;
  /** 0–100 while downloading. */
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
};

/** Fold one event into the state. Shared by main (`getState`) and the renderer hook so both agree. */
export const reduceUpdaterState = (prev: UpdaterState, event: UpdaterEvent): UpdaterState => {
  switch (event.kind) {
    case "checking":
      // A background re-check never hides a finished download.
      return prev.phase === "downloaded" ? prev : { ...prev, phase: "checking", errorMessage: null };
    case "update-available": {
      const lastCheckedAt = event.checkedAt ?? prev.lastCheckedAt;
      return prev.phase === "downloaded" && prev.version === event.version
        ? { ...prev, lastCheckedAt }
        : { ...prev, phase: "available", version: event.version, releaseNotes: event.releaseNotes, lastCheckedAt };
    }
    case "update-not-available": {
      const lastCheckedAt = event.checkedAt ?? prev.lastCheckedAt;
      return prev.phase === "downloaded" ? { ...prev, lastCheckedAt } : { ...prev, phase: "idle", lastCheckedAt };
    }
    case "download-progress":
      return { ...prev, phase: "downloading", progress: event.percent };
    case "update-downloaded":
      return { ...prev, phase: "downloaded", version: event.version, progress: 100, errorMessage: null };
    case "error":
      // A failed background check after a finished download keeps the download installable.
      return prev.phase === "downloaded" ? prev : { ...prev, phase: "error", errorMessage: event.message };
    case "mandatory-update":
      return {
        ...prev,
        mandatory: true,
        version: prev.version ?? event.latestVersion,
        phase: prev.phase === "idle" ? "available" : prev.phase,
      };
    case "restart-requested":
      return prev;
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
};
