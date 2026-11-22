import { app, BrowserWindow, dialog, ipcMain, Menu, powerMonitor, shell, Tray } from "electron";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import {
  ApiError,
  approvePairing,
  completeStancerPayment,
  denyPairing,
  getBillingStatus,
  getFounderStatus,
  getMe,
  markFounderNoticeSeen,
  getLibraryMeta,
  getLibraryMetaForKeyStep,
  getSubscription,
  listProfiles,
  createProfile,
  updateProfile,
  deleteProfile,
  lookupPairing,
  login,
  completeProviderSignIn,
  listSignInProviders,
  startProviderSignIn,
  type SignInProvider,
  logout,
  resendVerification,
  requestPasswordReset,
  confirmPasswordReset,
  signup,
  verifyEmail,
  sendFeedback,
  setApiBaseUrl,
  setApiClientType,
  resetLibrary,
  startCheckout,
  updateSettings,
  updateSubscription,
} from "@space/shared/api";
import { paymentPageLang } from "@space/shared/billingCheckout";
import { findPaymentReturn, parsePaymentReturnLink } from "@space/shared/checkoutReturn";
import {
  createProviderReturnMailbox,
  findProviderReturn,
  parseProviderReturnLink,
  providerReturnAddress,
  type ProviderReturn,
} from "@space/shared/providerSignIn";
import { generateLibraryKeyWords } from "@space/shared/libraryKeyWords";
import { isPlanId, type BillingPeriod } from "@space/shared/storagePlans";
import { isAllowedExternalUrl } from "@space/desktop-shell/externalUrl";
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
import { getDesktopPlatform } from "@space/desktop-platform";
import { probeHostCapacity } from "@space/desktop-platform/host-capacity";
import { decideFallbackCopy, fallbackCopyReason } from "@space/shared/transcodeHardware";
import { PRODUCTION_API_BASE_URL } from "@space/shared/productionApi";
import { accountLanguageOf } from "@space/shared/accountLanguage";
import { isAccountLanguage } from "@space/shared/i18n";
import { mainProfileId as pickMainProfileId } from "@space/shared/profiles";
import { isProfileAvatarId, type ProfileAvatarId } from "@space/shared/profileAvatars";
import { isAppFeatureId, isAppFeatureState, type ProfileFeatures } from "@space/shared/appFeatures";
import { classifySignInError, retryAfterMinutes, signInErrorDetails, type SignInFailure } from "@space/shared/signInError";
import { classifyResendVerificationError, classifySignUpError, classifyVerifyEmailError } from "@space/shared/signUp";
import { asksKeySavedBeforeSignOut, type SignedOutReason } from "@space/shared/keptLibraryKey";
import { fetchLibrarySnapshot, publishLibrarySnapshot, type FetchedLibrarySnapshot } from "@space/library-db-runtime/snapshotTransport";
import { deleteStorageObjects, downloadStorageObjectViaTunnel, uploadStorageObjectViaTunnel } from "@space/library-db-runtime/api";
import { decryptBase64ToBytes } from "@space/library-db-runtime/crypto";
import { checkKeyAgainstAccount, makeAccountKey } from "./libraryKeyCheck";
import { createParrotExportJobs } from "./exportJobs";
import { checkKeptLibraryKey } from "@space/desktop-shell/library-kept-key";
import { serveStorageUnitBase } from "@space/desktop-shell/storage-units";
import { createPasswordResetActions } from "@space/desktop-shell/password-reset";
import { eraseAccountLibrary } from "./libraryErase";
import { parseParrotTracklist, type ParrotLibraryOp } from "@space/parrot-library-db-definition";
import { PARROT_OP_STREAM_VERSION } from "@space/parrot-library-db-definition/ops";
import {
  createParrotCopyPicker,
  fetchParrotLyrics,
  parrotLookupSuggestions,
  parrotMusicSuggestQuery,
  isKeptKind,
  parrotCoverThumbKey,
  parrotPlaylistEditOps,
  parrotAlbumEditValues,
  parrotTrackEditValues,
  planParrotDelete,
  planParrotTrackLoudness,
  saveParrotEdit,
  matchParrotImport,
  parrotImportLibraryAlbums,
  planParrotTrackPlacements,
  runParrotRetryUnidentified,
  PARROT_EDIT_IDS,
  parrotAutoLyricsOnError,
  runParrotAutoLyrics,
  createParrotLyricsPending,
  parrotLyricsOrSearching,
  queueParrotAutoLyrics,
  parrotArtistPictureCredit,
  parrotArtistPictureThumbKey,
  rebaseParrotArtistPictureOps,
  runParrotAutoArtistPictures,
  rebaseParrotAlbumCoverOps,
  runParrotAutoAlbumCovers,
  type ParrotAlbumCoversAsked,
  rebaseParrotCopyRefreshOps,
  runParrotCopyChanges,
  type ParrotCopyCheck,
  type ParrotLibraryQuery,
  type RawTrackFileRow,
  toTrackFileRow,
  PARROT_COPY_TICKET_FLOOR,
  TRACK_FILES_SQL,
  type ParrotEditCover,
  type ParrotEditSuggestQuery,
  type ParrotLyricsFetch,
  type ParrotManageTarget,
  type ParrotPlaylistEdit,
  type ParrotTrackPlacement,
  createParrotChunkReads,
  isParrotCoverCrop,
  parrotCoverMime,
  type ParrotCoverCopies,
  type ParrotCoverCrop,
  type ParrotImportLibraryAlbum,
} from "@space/parrot-core";
import { createSessionMetadata, metadataTicketsForBuild, NEUTRAL_USER_AGENT, refillLogLine, resolveMetadataUrl } from "@space/metadata-client";
import { createFileKeyValueStorage } from "@space/metadata-client/fileStorage";
import { fetchSourceCredits } from "@space/metadata-client/credits";
import { ticketKeysForBuild } from "@space/privacy-pass";
import { SPACE_APP_HEADER } from "@space/shared/appScope";
import { getAppUpdateRequired, onAppUpdateRequired, setClientIdentity } from "@space/shared/appVersion";
import { logFailedApiCalls, recentFailedRequestIds } from "@space/shared/apiFailure";
import { desktopClientIdentity } from "@space/desktop-shell/client-identity";
import {
  applyParrotOps,
  backfillParrotLightCopies,
  defaultParrotImportTransport,
  uploadParrotFile,
  createParrotChunkLoader,
  createParrotCoverLoader,
  createParrotKeptFiles,
  openParrotLibraryCopy,
  saveParrotLibraryCopy,
  serializeParrotLibrary,
  type ParrotKeptFiles,
  parrotEditedReader,
  scanParrotImport,
  type ParrotImportEdit,
  type ParrotCoverImage,
  type ParrotImportScan,
  getParrotFile,
  importParrotFiles,
  listParrotAlbums,
  listParrotArtists,
  listParrotPlaylists,
  getParrotLyrics,
  listParrotTracks,
  openParrotLibrary,
  makeParrotCoverCopies,
  parrotCoverDecodable,
  parrotCoverPreview,
  parrotCoverProblem,
  readParrotTrackInfo,
  PARROT_COVER_MAX_BYTES,
  PARROT_APP_ID,
  PARROT_AUDIO_FORMATS,
  uploadParrotCover,
  publishParrotEdits,
  clearParrotExportPartials,
  exportParrotSongs,
  listParrotExportSongs,
  parrotExportFreeBytes,
  type ParrotLibraryDb,
} from "@space/parrot-ingest";
import {
  PARROT_IPC,
  type ParrotBackgroundWork,
  type ParrotImportJob,
  type ParrotBillingResult,
  type ParrotCheckoutInput,
  type ParrotCreateKeyResult,
  type ParrotCoverCutRequest,
  type ParrotImportAlbumSearch,
  type ParrotImportAlbumMatch,
  type ParrotImportArtistPhoto,
  type ParrotImportMatchedAlbum,
  type ParrotImportPicture,
  type ParrotImportSelection,
  type ParrotImportStatus,
  type ParrotKeyResult,
  type ParrotDeletePreview,
  type ParrotEditValues,
  type ParrotFetchLyricsResult,
  type ParrotEditSuggestResult,
  type ParrotLibraryResult,
  type ParrotMeasuredLoudness,
  type ParrotPairedSignIn,
  type ParrotPlanOptions,
  type ParrotProfilesResult,
  type ParrotProviderCompleteResult,
  type ParrotProviderStartResult,
  type ParrotSetupState,
  type ParrotResendVerificationResult,
  type ParrotSignInResult,
  type ParrotSignUpResult,
  type ParrotVerifyEmailResult,
  type ParrotState,
  type ParrotSubscription,
  type ParrotLibrary,
} from "../shared/ipc";
import { diffParrotLibrary, parrotLibraryPatchSize } from "../shared/libraryPatch";
import { startParrotPlaybackServer, type ParrotPlaybackServer } from "./playbackServer";
import { openParrotStore, parrotLanguageFor, type ParrotStore } from "./store";
import { createDesktopKeeping, type DesktopKeeping } from "./kept";
import { createDesktopLightCopyEncoder } from "./lightCopy";
import { createParrotErrorReports, createSetupSaver, reapplyStartAtLoginAtLaunch } from "./errorReports";
import { requestFlatpakAutostart } from "./flatpakAutostart";
import { createParrotPairingApprover } from "./pairingApprove";
import { completeParrotKeyPairing, completeParrotPairedSignIn, type ParrotPairedSignInDeps } from "./pairedSignIn";
import { createDesktopStreamSlots } from "./streamSlot";
import { importCoverOf, PARROT_MUSIC_ID, searchParrotImportAlbums } from "./importSearch";
import { importEnded, importStopError, restoreImportJobs, type StoredImportJob } from "./importJobs";
import { createDesktopPairingClient, pairingRefusalOf, resolveDeviceName } from "@space/desktop-shell/pairing-main";
import { SIBLING_SIGN_IN_ARG, armSiblingHiddenQuit, isSiblingSignInLaunch, type SiblingHiddenQuit } from "@space/desktop-shell/sibling-main";
import { SIBLING_IPC, type SiblingSignInResult } from "@space/desktop-shell/sibling";
import { createParrotSiblingHost, parrotSiblingAccount, setupStepAfterSiblingSignIn } from "./siblingSignIn";
import { createDesktopUpdater } from "@space/desktop-shell/updater-main";
// electron-updater is CommonJS (bundled here: Parrot ships no node_modules): read `autoUpdater` off the default import.
import electronUpdater from "electron-updater";
import { pairingModeOf, type PairingMode, type PairingPollResult, type PairingStartResult } from "@space/desktop-shell/pairing";
import { createDesktopFeedbackSender, type DesktopFeedbackInput } from "@space/error-report/desktop-feedback";
import { registerErrorReportsIpc } from "@space/error-report/desktop-main";
import { createErrorLog } from "@space/error-report/error-log";
import { rendererConsoleLine } from "./rendererConsole";
import { createLibraryDbs } from "./libraryDbs";
import { createLoudnessGate } from "./loudnessGate";
import { createQuitGuard, createSaveChain, QUIT_SAVE_TIMEOUT_MS } from "./saveChain";

/** The client type Parrot's sessions and uploads carry (shown in the account's devices list and the API logs). */
const CLIENT_TYPE = "parrot-desktop";

// A development build (`electron-vite dev`, or `build:test` with VITE_SF_DEV_TICKET_KEY=1) talks to the local dev
// stack; a release package always talks to production (ACCT-AUTH-09, REL-LAUNCH-03). SF_API_BASE_URL overrides both
// for a hand test of a packaged build against the dev stack.
const isDevBuild = import.meta.env.DEV === true || import.meta.env.VITE_SF_DEV_TICKET_KEY === "1";
const apiBaseUrl = (process.env.SF_API_BASE_URL?.trim() || (isDevBuild ? "http://localhost:3000" : PRODUCTION_API_BASE_URL)).replace(/\/+$/, "");
// The library-db-runtime transport reads the address from the environment (its default is another app's server).
process.env.SF_API_BASE_URL = apiBaseUrl;
setApiBaseUrl(apiBaseUrl);
setApiClientType(CLIENT_TYPE);
// REL-CD-29: every API call says which build is calling (`parrot/desktop/0.1.3`, `+flatpak`/`+appimage`/`+system` on
// Linux). The window reaches the API only through this process, so the main process alone states it.
setClientIdentity(
  desktopClientIdentity({ app: "parrot", version: app.getVersion(), packaged: app.isPackaged, os: process.platform, env: process.env }),
);

app.setPath("userData", process.env.SF_USER_DATA_PATH?.trim() || join(app.getPath("appData"), "spaceparrot"));
const userDataDir = app.getPath("userData");
mkdirSync(join(userDataDir, "logs"), { recursive: true });
const logFile = join(userDataDir, "logs", "parrot-main.log");
// The main log, cut back to nothing at start when it passed 5 MB: it holds no token, key or file content, only what
// happened; the window's warnings and errors go in scrubbed (REL-LOG-06).
if (existsSync(logFile) && statSync(logFile).size > 5 * 1024 * 1024) rmSync(logFile, { force: true });

const log = (line: string) => {
  const stamped = `${new Date().toISOString()} ${line}`;
  console.log(stamped);
  try {
    appendFileSync(logFile, `${stamped}\n`);
  } catch {
    // The console line is enough when the log file cannot be written.
  }
};
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
// REL-LOG-31: one line per failed API call of this process (the window reaches the API only through it), with the
// server's request id so the server's line about it is found by one search. The main log only, never a report.
logFailedApiCalls(({ status, code, requestId }) => log(`[api] call failed status=${status} code=${code} requestId=${requestId}`));
// UX-SUP-05: the newest warning and error lines (scrubbed as recorded), sent only with feedback the user attaches it to.
const errorLog = createErrorLog();
/** A failure line: the main log, and the error log feedback can carry. */
const fail = (line: string) => {
  log(line);
  errorLog.record("error", "main", line);
};

log(`[parrot] start v${app.getVersion()} ${process.platform}-${process.arch} api=${apiBaseUrl} devBuild=${isDevBuild} userData=${userDataDir}`);
// STOR-UNIT-01: storage figures follow this computer's file manager (1024 on Windows and KDE, 1000 elsewhere); the
// preload reads the base synchronously so the window sets it before its first render.
serveStorageUnitBase(ipcMain, { platform: process.platform, desktop: process.env.XDG_CURRENT_DESKTOP, log });
// REL-ENV-36: an agent's lane run or a test launch (SF_SILENT=1) never sends a sound stream to the sound server, even
// when started without the harness's Chromium flags (an AppImage by hand). The user's own run is untouched.
const silentSwitches = applySilentAudio(app.commandLine, process.env);
if (silentSwitches.length) log(`[parrot] silent: SF_SILENT=${process.env.SF_SILENT} chromium switches=${silentSwitches.join(",")} PULSE_SINK=${process.env.PULSE_SINK ?? "(unset)"}`);

// REL-LOG-06: error reports stay off until the user says yes in setup; a build without a reporting address never
// starts them. The answer lives in its own small file so it applies before any window exists.
const errorReports = createParrotErrorReports({
  userDataDir,
  dsn: __SF_BUGSINK_DSN__,
  release: app.getVersion(),
  forcedRaw: process.env.SF_ERROR_REPORTS,
  log,
  fail,
});
void errorReports.start();

const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) {
  log("[parrot] another Parrot is already running: handing over to it");
  app.quit();
}

// ACCT-PAY-05: `parrot://billing/return?payment=<id>` brings the browser back to Parrot after paying on Stancer's page
// (through the website's hand-off page). Windows / Linux: in the argv of a second launch, delivered to this instance by
// `second-instance` (or in this launch's argv if Parrot was not running); macOS: `open-url`, registered before `ready`.
// Tests (SF_E2E=1) never rewrite the machine's `parrot:` handler: they hand the link over in a second launch's argv.
if (primaryInstance && process.env.SF_E2E !== "1") {
  // A dev run (`electron <main.js>`) registers the Electron binary plus its main script, else the OS starts a bare Electron.
  const registered = process.defaultApp && process.argv[1]
    ? app.setAsDefaultProtocolClient("parrot", process.execPath, [resolve(process.argv[1])])
    : app.setAsDefaultProtocolClient("parrot");
  log(`[billing] parrot:// link registered: ${registered}`);
}
/** A return link that arrived before the window existed (Parrot started by the link): completed once signed in. */
let launchPaymentReturn: string | null = findPaymentReturn("parrot", process.argv);
// ACCT-SIGNIN-05: a Google, Apple or Microsoft sign-in comes back through `parrot://auth/provider`. The outcome waits
// here until the sign-in screen pulls it (PARROT_IPC.providerTakeReturn), so a window still loading, or created by the
// link (Parrot started by it: the outcome is in this launch's argv), gets it once.
const providerReturns = createProviderReturnMailbox();
const launchProviderReturn = findProviderReturn("parrot", process.argv);
if (launchProviderReturn !== null) {
  log(`[provider-sign-in] started through a return link: ${"code" in launchProviderReturn ? "code" : launchProviderReturn.error}`);
  providerReturns.put(launchProviderReturn);
}
app.on("open-url", (event, url) => {
  event.preventDefault();
  const providerReturn = parseProviderReturnLink("parrot", url);
  if (providerReturn !== null) return receiveProviderReturn(providerReturn, "open-url");
  const paymentId = parsePaymentReturnLink("parrot", url);
  if (paymentId === null) return log("[billing] open-url ignored: not a payment or sign-in return link");
  receivePaymentReturn(paymentId, "open-url");
});

const mainOutDir = dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
let store: ParrotStore;

// ACCT-PAIR-07: same-device sign-in with Badger (siblingSignIn.ts). `--sibling-sign-in`: Badger started this run only
// to sign itself in; it opens no window and quits soon after answering.
const siblingHiddenStart = isSiblingSignInLaunch(process.argv);
let siblingHiddenQuit: SiblingHiddenQuit | null = null;
const siblingHost = createParrotSiblingHost({ getApiBaseUrl: () => apiBaseUrl, dev: isDevBuild, log, onAnswered: () => siblingHiddenQuit?.answered() });
app.on("will-quit", () => void siblingHost.close());
/** Signed in: Badger on this computer can offer this account (the key is read when Badger asks). */
const publishSiblingAccount = () => void siblingHost.setAccount(parrotSiblingAccount(store));

/** REL-UPD-01: new versions install themselves, from `<api>/desktop/parrot/`; the setting lives in the store. */
const updaterLogLine = (level: string) => (fields: Record<string, unknown>, message: string) =>
  log(`[updater] ${level === "info" ? "" : `${level}: `}${message} ${JSON.stringify(fields)}`);
const updater = createDesktopUpdater({
  app: "parrot",
  electron: { app, ipcMain },
  loadAutoUpdater: () => electronUpdater.autoUpdater,
  getApiBaseUrl: () => apiBaseUrl,
  getPlatformId: () => getDesktopPlatform().id,
  // REL-UPD-07: a .deb/.rpm/.pacman copy updates through /usr/lib/spaceparrot/system-update.
  linuxPackageName: "spaceparrot",
  logger: { info: updaterLogLine("info"), warn: updaterLogLine("warn"), error: updaterLogLine("error") },
  onAutoUpdateChange: (enabled) => {
    void store.setAutoUpdate(enabled).catch((error: unknown) => fail(`[store] automatic updates setting not saved: ${errorText(error)}`));
  },
  onQuitForUpdate: async () => {
    // PAR-PL-05: save before `quitAndInstall`, which starts the installer at once on Windows and closes the windows
    // before `before-quit` on macOS. Only the saves: if the install fails without quitting (a cancelled pkexec, a
    // failed dpkg), Parrot stays usable and a later quit still waits for its saves.
    await quitGuard.saveNow("restart to update");
    isQuitting = true;
  },
});
let playback: ParrotPlaybackServer | null = null;

// PLAT-DESK-10: the tray and close-to-tray Badger has, from the same shared module. Closing the window hides it (the
// player plays inside it, so the music goes on); only Quit, in the tray or Cmd+Q, quits.
let isQuitting = false;
const requestExplicitQuit = () => {
  isQuitting = true;
  app.quit();
};
// `store` opens once the app is ready; a second-instance wake before that shows English.
const shellStrings = () => MAIN_SHELL_STRINGS[store?.setup.language ?? "en"];
const showMainWindow = () => {
  if (!mainWindow) return createWindow();
  revealWindow(mainWindow);
};
const appTray = createAppTray({
  createTray: (iconPath) => new Tray(iconPath),
  buildMenu: (items) => Menu.buildFromTemplate(items),
  buildActions: () =>
    buildTrayActions({ showMainWindow, requestQuit: requestExplicitQuit, labels: trayLabelsFor(shellStrings(), "Parrot") }),
  onUnavailable: (error) => log(`[tray] unavailable: ${errorText(error)}`),
});
if (process.env.SF_E2E === "1") registerTrayTestIpc(ipcMain, appTray);
// The window and tray icons: packaged in resources/, in installer/ when run from the source tree (out/main/../..).
const sourceInstallerDir = join(mainOutDir, "..", "..", "installer");
const appIconPath = () =>
  [join(process.resourcesPath ?? sourceInstallerDir, "icon.png"), join(sourceInstallerDir, "icon.png")].find((candidate) =>
    existsSync(candidate),
  );
// PLAT-DESK-11: no menu bar on Linux and Windows; the minimal app / Edit / Window menu on macOS.
const installApplicationMenu = () =>
  applyApplicationMenu({
    menu: Menu,
    hasGlobalMenuBar: getDesktopPlatform().shell.applicationMenu,
    appName: app.getName(),
    requestQuit: requestExplicitQuit,
    strings: shellStrings(),
  });
let library: { db: ParrotLibraryDb; version: number | null } | null = null;
/** The opened libraries: one is closed only once neither the window nor a save still reads it. */
const libraryDbs = createLibraryDbs<ParrotLibraryDb>((db) => db.close(), log);
const setLibrary = (next: { db: ParrotLibraryDb; version: number | null } | null) => {
  library = next;
  libraryDbs.setCurrent(next?.db ?? null);
  // OFFL-FILE-01: an export waits while no library is open (sign-out) and goes on once one is.
  if (next) exportJobs.resume();
  else exportJobs.pause();
};
/** Songs kept on this computer (PAR-OFFL-03): sealed under userData/offline, set up once the store is open. */
const offlineDir = join(userDataDir, "offline");
let keptFiles: ParrotKeptFiles | null = null;
let keeping: DesktopKeeping | null = null;
let sessionChecked: Promise<void> | null = null;
const importAbort = new AbortController();

/** Reads one sealed chunk for an export: kept on this computer, else downloaded, retried a few times (OFFL-FILE-01). */
const readSealedForExport = async (objectKey: string, signal: AbortSignal): Promise<Uint8Array> => {
  const kept = await keptFiles?.readSealed(objectKey);
  if (kept) return kept;
  for (let attempt = 1; ; attempt++) {
    signal.throwIfAborted();
    try {
      // `export` downloads stay allowed once the account is unpaid (#145).
      return await downloadStorageObjectViaTunnel(store.token() ?? "", objectKey, { clientType: CLIENT_TYPE, purpose: "export" }, PARROT_APP_ID);
    } catch (error) {
      if (attempt >= 4) throw error;
      log(`[export] chunk ${objectKey} download failed (try ${attempt}): ${errorText(error)}`);
      await sleep(1000 * 2 ** attempt, undefined, { signal });
    }
  }
};

/** "Download everything" (OFFL-FILE-01, ACCT-EXPORT-01): the queue, kept in userData. */
const exportJobs = createParrotExportJobs({
  file: join(userDataDir, "export-jobs.json"),
  userId: () => store?.user?.id ?? "",
  db: () => library?.db ?? null,
  listSongs: listParrotExportSongs,
  pickFolder: async () => {
    if (!mainWindow) return null;
    const picked = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory", "createDirectory"] });
    return picked.canceled ? null : (picked.filePaths[0] ?? null);
  },
  freeBytes: parrotExportFreeBytes,
  run: ({ db, songs, dest, signal, onProgress, onSongDone }) =>
    libraryDbs.hold(db, async () => {
      // What an export stopped by a crash left half-written in that folder (OFFL-SAFE-01).
      await clearParrotExportPartials(dest);
      return exportParrotSongs({
        db,
        songs,
        dest,
        libraryKeyBase64: () => store.libraryKey() ?? "",
        readSealed: readSealedForExport,
        signal,
        onProgress,
        onSongDone,
        log,
      });
    }),
  emit: (jobs) => mainWindow?.webContents.send(PARROT_IPC.exportJobsEvent, jobs),
  log,
});

/** The running scan or upload's own stop, for the Jobs panel's X (UX-JOBS-02); null while none runs. */
let importRun: AbortController | null = null;

const musicFolder = (): string | null => {
  try {
    const folder = app.getPath("music");
    return existsSync(folder) ? folder : null;
  } catch {
    return null;
  }
};

const defaultSetup = (): ParrotSetupState => {
  const music = musicFolder();
  return {
    step: "language",
    done: false,
    language: parrotLanguageFor(app.getLocale()),
    folders: music ? [music] : [],
    startAtLogin: true,
    errorReports: false,
  };
};

/** Starts Parrot when the user logs in (UX-SETUP-06 step 5). Only a packaged app registers itself. */
const applyStartAtLogin = (on: boolean) => {
  if (!app.isPackaged) {
    log(`[login-item] start at login=${on} not applied: not a packaged app`);
    return;
  }
  if (process.platform === "linux" && process.env.FLATPAK_ID) {
    // The sandbox's autostart dir is not the host's: the Background portal writes the host entry (REL-DIST-11).
    requestFlatpakAutostart(on, { log, fail });
    return;
  }
  if (process.platform === "linux") {
    const autostartDir = join(process.env.XDG_CONFIG_HOME?.trim() || join(app.getPath("home"), ".config"), "autostart");
    const entry = join(autostartDir, "spaceparrot.desktop");
    if (on) {
      // An AppImage runs from a temporary mount: start the AppImage file itself.
      const exec = process.env.APPIMAGE || process.execPath;
      mkdirSync(autostartDir, { recursive: true });
      writeFileSync(entry, `[Desktop Entry]\nType=Application\nName=Parrot\nExec="${exec}" --hidden\nX-GNOME-Autostart-enabled=true\n`);
    } else {
      rmSync(entry, { force: true });
    }
  } else {
    app.setLoginItemSettings({ openAtLogin: on });
  }
  log(`[login-item] start at login=${on}`);
};

const closeLibrary = () => setLibrary(null);

const resetToSignIn = (reason: SignedOutReason) => {
  void store.signOut(reason).catch((error: unknown) => fail(`[store] signed-out state not saved: ${errorText(error)}`));
  // ACCT-PAIR-07: signed out, Badger on this computer is offered nothing.
  void siblingHost.setAccount(null);
  closeLibrary();
  stopLookup();
  // A new account starts from a first check, which only records where the copies stand (PAR-COPY-01).
  rmSync(copyChangesCheckFile, { force: true });
  void coverLoader.clear().then(() => log("[covers] kept covers removed"), (error) => fail(`[covers] could not remove the kept covers: ${errorText(error)}`));
  void keeping?.clear().catch((error: unknown) => fail(`[kept] could not remove the kept songs: ${errorText(error)}`));
  // Sign-in is its own screen before setup now; the next sign-in resumes setup after the language (UX-SETUP-06).
  void store.updateSetup({ done: false, step: "libraryKey" }).catch((error: unknown) => fail(`[store] setup step not saved: ${errorText(error)}`));
};

/** The account's main profile, asked once per session token: playback names it (STOR-BW-11). */
let mainProfile: { token: string; id: Promise<string | null> } | null = null;
const mainProfileId = (): Promise<string | null> => {
  const token = store.token() ?? "";
  if (mainProfile?.token !== token) {
    const id = listProfiles(token).then(({ profiles }) => pickMainProfileId(profiles));
    id.then((found) => log(`[profile] playback profile ${found ?? "none"}`)).catch((error) => {
      fail(`[profile] could not list the profiles: ${errorText(error)}`);
      mainProfile = null;
    });
    mainProfile = { token, id };
  }
  return mainProfile.id;
};

/** ACCT-STREAM-01..04: the profile's streams, asked for before a song starts; the window draws the question. */
const streamSlots = createDesktopStreamSlots({
  apiBaseUrl,
  token: () => store.token(),
  profileId: mainProfileId,
  isKept: (trackId) => keeping?.isKept(trackId) ?? false,
  onState: (state) => mainWindow?.webContents.send(PARROT_IPC.streamStateEvent, state),
  log,
});

/** Which copy of each song plays, from how fast the chunks of the songs before it arrived (PAR-PLAY-02, PAR-PLAY-04). */
const copyPicker = createParrotCopyPicker(log);

const chunkLoader = createParrotChunkLoader({
  token: () => store.token() ?? "",
  libraryKeyBase64: () => store.libraryKey() ?? "",
  profileId: mainProfileId,
  clientType: CLIENT_TYPE,
  readKept: (objectKey) => keptFiles?.readSealed(objectKey) ?? Promise.resolve(null),
  onDownloaded: (bytes, ms) => copyPicker.record(bytes, ms),
  log,
});

/**
 * The chunks the loudness pass reads whole songs through (PAR-PLAY-03): its own small cache, and its downloads are not
 * the player's, so they neither fill the player's cache nor count toward the speed that picks copies (PAR-PLAY-02).
 */
const readingChunkLoader = createParrotChunkLoader({
  token: () => store.token() ?? "",
  libraryKeyBase64: () => store.libraryKey() ?? "",
  profileId: mainProfileId,
  clientType: CLIENT_TYPE,
  readKept: (objectKey) => keptFiles?.readSealed(objectKey) ?? Promise.resolve(null),
  maxBytes: 8 * 1024 * 1024,
  log,
});

/** The stored chunks the loopback server is reading now: a file's replaced chunks are removed only once free (PAR-FMT-01). */
const chunkReads = createParrotChunkReads();

/**
 * The file a song plays from, picked once when its address is asked for (the song starting, or the gapless player
 * readying it as the one before ends), never again during it (PAR-PLAY-04): the original while the connection keeps up
 * with it, else the lighter copy that does (PAR-PLAY-02). A song kept on this computer plays its kept copy.
 */
const playbackFileFor = (fileId: string): string => {
  const db = library?.db;
  const file = db ? getParrotFile(db, fileId) : null;
  if (!db || !file || keeping?.isKept(file.trackId)) return fileId;
  const files = (db.prepare(TRACK_FILES_SQL).all(file.trackId) as RawTrackFileRow[]).map(toTrackFileRow);
  const track = db.prepare("SELECT duration_ms AS durationMs FROM tracks WHERE id = ?").get(file.trackId) as { durationMs: number | null } | undefined;
  return copyPicker.pick(files, track?.durationMs ?? null)?.id ?? fileId;
};

/** Songs imported before light copies existed get theirs in the background, once per start and account (PAR-FMT-02). */
const lightCopies = createDesktopLightCopyEncoder({ mainOutDir, appVersion: app.getVersion(), log });
// Songs over 90 minutes get their light copy automatically only on a computer the shared hardware rule calls strong
// (Badger's, INGS-FALLBK-01; Parrot has no video encoder to look for), PAR-FMT-02.
const lightCopyHardware = { ...probeHostCapacity(), hwEncoder: "none" };
const lightCopyLongSongs = decideFallbackCopy(lightCopyHardware);
log(
  `[light-copy] ${lightCopyHardware.cores} cores, ${lightCopyHardware.ramGB} GB: songs over 90 minutes ` +
    (lightCopyLongSongs ? "get their light copy automatically" : `wait for a stronger computer (${fallbackCopyReason(lightCopyHardware)})`)
);
const lightCopyAbort = new AbortController();
let lightCopyBackfillFor: string | null = null;
const startLightCopyBackfill = () => {
  const token = store.token();
  const key = store.libraryKey();
  const user = store.user;
  if (!token || !key || !user || lightCopyBackfillFor === user.id) return;
  lightCopyBackfillFor = user.id;
  const libraryKey = Buffer.from(key, "base64");
  void backfillParrotLightCopies({
    token,
    libraryKeyBase64: key,
    transport: defaultParrotImportTransport,
    load: chunkLoader,
    make: lightCopies.make,
    longSongs: lightCopyLongSongs,
    upload: ({ fileId, fileHash, bytes }) =>
      uploadParrotFile({
        token,
        userId: user.id,
        libraryKey,
        fileId,
        fileHash,
        bytes,
        clientType: CLIENT_TYPE,
        upload: defaultParrotImportTransport.upload,
        openUploadSession: defaultParrotImportTransport.openUploadSession,
        signal: lightCopyAbort.signal,
      }),
    log,
    signal: lightCopyAbort.signal,
  }).then(
    async (result) => {
      // The player picks among the new copies from now on.
      if (result.made > 0 && store.token() === token) await loadLibrary();
      // Some failed: the next start tries them again.
    },
    (error: unknown) => {
      if (!lightCopyAbort.signal.aborted) fail(`[light-copy] backfill stopped: ${errorText(error)}`);
    }
  );
};

/** Album covers (PAR-META-04), from the user's storage, kept sealed under userData/covers (PAR-COPY-01). */
const coverLoader = createParrotCoverLoader({
  token: () => store.token() ?? "",
  libraryKeyBase64: () => store.libraryKey() ?? "",
  clientType: CLIENT_TYPE,
  cacheDir: join(userDataDir, "covers"),
  appId: PARROT_APP_ID,
  log,
});

/** The loopback server for songs and covers, started the first time the window needs either. */
let playbackStarting: Promise<ParrotPlaybackServer> | null = null;
const ensurePlayback = (): Promise<ParrotPlaybackServer> => {
  playbackStarting ??= startParrotPlaybackServer({
    findFile: (id) => (library ? getParrotFile(library.db, keeping?.playableFileId(id) ?? id) : null),
    load: chunkLoader,
    loadForReading: readingChunkLoader,
    loadCover: (objectKey) => coverLoader.load(objectKey),
    reads: chunkReads,
    log,
  }).then(
    (server) => (playback = server),
    (error: unknown) => {
      // The next song or cover tries again.
      playbackStarting = null;
      throw error;
    }
  );
  return playbackStarting;
};

/**
 * Checks the saved session once per start. A server that does not answer keeps it (Parrot works offline later).
 * UX-I18N-07: the account's one language wins over this computer's, so a change made on another device shows here.
 * PRIV-KEY-01: a kept key that is no longer the account's (the vault was erased from any app or device) is forgotten,
 * and setup goes back to the key step, which offers the new key or a fresh one, never the erased one.
 */
const checkSession = async () => {
  const token = store.token();
  if (!store.user || !token) return;
  try {
    const { user } = await getMe(token);
    log(`[auth] session ok for user ${user.id}`);
    const account = accountLanguageOf(user);
    if (account && account !== store.setup.language) {
      log(`account_language.applied ${JSON.stringify({ from: store.setup.language, to: account, source: "auth_me" })}`);
      void store.updateSetup({ language: account }).catch((error: unknown) => fail(`[store] account language not saved: ${errorText(error)}`));
      appTray.refresh();
      installApplicationMenu();
    }
    await forgetStaleLibraryKey(token);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      log("[auth] the saved session was refused (401): back to sign-in");
      resetToSignIn("sessionRejected");
      return;
    }
    fail(`[auth] could not check the saved session, keeping it: ${errorText(error)}`);
  }
};

const forgetStaleLibraryKey = async (token: string) => {
  const key = store.libraryKey();
  if (!key) return;
  const verdict = await checkKeptLibraryKey(key, {
    readKeyProbe: async () => (await getLibraryMeta(token, PARROT_APP_ID)).keyProbe ?? null,
    decryptProbe: decryptBase64ToBytes,
    // An account from before key probes: the key is the account's when it opens a library of either app.
    opensAccountLibrary: async (kept) => {
      let found = false;
      for (const appId of [PARROT_APP_ID, "badger"] as const) {
        try {
          if (await fetchLibrarySnapshot({ token, keyBase64: kept, appId })) return true;
        } catch (error) {
          if (errorText(error) !== "DECRYPT_FAILED") throw error;
          found = true;
        }
      }
      return found ? false : null;
    },
    log,
  });
  if (verdict === "stale") await forgetLibraryKeyHere();
};

const currentState = async (): Promise<ParrotState> => {
  sessionChecked ??= checkSession();
  await sessionChecked;
  const signedIn = Boolean(store.user && store.token());
  return {
    setup: store.setup,
    user: signedIn ? store.user : null,
    hasLibraryKey: signedIn && Boolean(store.libraryKey()),
    asksKeySavedBeforeSignOut: signedIn && asksKeySavedBeforeSignOut(store.libraryKey()),
    apiBaseUrl,
    isDevBuild,
    musicFolder: musicFolder(),
    appVersion: app.getVersion(),
  };
};

const idleImport: ParrotImportStatus = {
  running: false,
  phase: "idle",
  total: 0,
  done: 0,
  imported: 0,
  skipped: 0,
  failed: 0,
  bytesDone: 0,
  bytesTotal: 0,
  published: 0,
  currentFile: null,
  error: null,
};
let importStatus = idleImport;

/**
 * UX-JOBS-01: every import on this computer, newest first, each tagged with its account, kept in userData across
 * restarts so the Jobs panel still lists finished and failed imports until the user removes them.
 */
const importJobsFile = join(userDataDir, "import-jobs.json");
const IMPORT_JOBS_KEPT = 50;
let importJobs: StoredImportJob[] = (() => {
  if (!existsSync(importJobsFile)) return [];
  try {
    return restoreImportJobs(JSON.parse(readFileSync(importJobsFile, "utf8")), Date.now());
  } catch (error) {
    fail(`[import] jobs list unreadable, starting empty: ${errorText(error)}`);
    return [];
  }
})();
let currentImportJob: StoredImportJob | null = null;

const accountImportJobs = (): ParrotImportJob[] =>
  importJobs.filter((job) => job.userId === (store.user?.id ?? "")).map(({ userId: _userId, ...job }) => job);

/** Tells the window; writes the list only when a job starts, waits for its confirm, ends or leaves (not per piece). */
const sendImportJobs = (save: boolean) => {
  if (save) {
    try {
      writeFileSync(importJobsFile, JSON.stringify(importJobs));
    } catch (error) {
      fail(`[import] jobs list not saved: ${errorText(error)}`);
    }
  }
  mainWindow?.webContents.send(PARROT_IPC.importJobsEvent, accountImportJobs());
};

const startImportJob = (sources: string[]) => {
  const stale = currentImportJob;
  currentImportJob = { id: randomUUID(), userId: store.user?.id ?? "", sources, startedAt: Date.now(), finishedAt: null, status: importStatus, failures: [] };
  importJobs = [currentImportJob, ...importJobs.filter((job) => job !== stale)].slice(0, IMPORT_JOBS_KEPT);
  log(`[import] job ${currentImportJob.id} started from ${sources.length} source(s)`);
};

const dismissImportJob = (id: string): ParrotImportJob[] => {
  const job = importJobs.find((entry) => entry.id === id);
  if (job && job !== currentImportJob) {
    importJobs = importJobs.filter((entry) => entry !== job);
    log(`[import] job ${id} removed from the list`);
    sendImportJobs(true);
  }
  return accountImportJobs();
};

/** The import's state for the window, and the current job's with it; `failures` replaces the job's failed files. */
const setImportStatus = (next: ParrotImportStatus, failures?: ParrotImportJob["failures"]) => {
  importStatus = next;
  mainWindow?.webContents.send(PARROT_IPC.importStatusEvent, next);
  const job = currentImportJob;
  if (!job) return;
  if (next.phase === "idle") {
    // Cancelled in the confirm dialog, or nothing ticked: nothing was imported, so the job leaves the list.
    importJobs = importJobs.filter((entry) => entry !== job);
    currentImportJob = null;
    log(`[import] job ${job.id} dropped: nothing to import`);
    sendImportJobs(true);
    return;
  }
  const phaseChanged = job.status.phase !== next.phase;
  job.status = next;
  if (failures) job.failures = failures;
  // The albums it touched stay on the job after the import ends, for each album's Jobs tab (UX-JOBS-02).
  const newAlbums = (next.importingAlbums ?? []).filter((id) => !job.albumIds?.includes(id));
  if (newAlbums.length > 0) job.albumIds = [...(job.albumIds ?? []), ...newAlbums];
  const albumsChanged = newAlbums.length > 0;
  // The job ends with the final status (no longer running), which carries the counts.
  const ended = importEnded(next.phase) && !next.running;
  if (ended) {
    job.finishedAt = Date.now();
    currentImportJob = null;
    log(`[import] job ${job.id} ${next.phase}: ${next.imported} added, ${next.skipped} already there, ${next.failed} failed`);
  }
  sendImportJobs(phaseChanged || ended || albumsChanged);
};

/** UX-JOBS-02: the lookups running now (lyrics, artist photos), for the Jobs panel's quiet line. */
const backgroundWork = new Map<ParrotBackgroundWork["kind"], ParrotBackgroundWork>();
const setBackgroundWork = (kind: ParrotBackgroundWork["kind"], progress: { done: number; total: number } | null) => {
  if (progress && progress.total > 0) backgroundWork.set(kind, { kind, ...progress });
  else if (!backgroundWork.delete(kind)) return;
  mainWindow?.webContents.send(PARROT_IPC.backgroundWorkEvent, [...backgroundWork.values()]);
};

/** With something kept, the library itself is kept too (sealed), so it opens with no connection (PAR-OFFL-03). */
const keepLibraryCopy = (dbBytes: Uint8Array, version: number | null) => {
  const key = store.libraryKey();
  if (!key || !keeping?.status().entries.length) return;
  void saveParrotLibraryCopy(offlineDir, key, dbBytes, version).then(
    () => log(`[kept] library v${version ?? "none"} kept for offline use`),
    (error: unknown) => fail(`[kept] could not keep the library for offline use: ${errorText(error)}`)
  );
};

const loadLibrary = async (): Promise<ParrotLibraryResult> => {
  const token = store.token();
  const key = store.libraryKey();
  if (!token || !key) return { ok: false, error: "not signed in" };
  const started = Date.now();
  try {
    const snapshot = await fetchLibrarySnapshot({ token, keyBase64: key, appId: PARROT_APP_ID });
    setLibrary({ db: openParrotLibrary(snapshot?.dbBytes ?? null), version: snapshot?.snapshotVersion ?? null });
    if (snapshot) {
      keepLibraryCopy(snapshot.dbBytes, snapshot.snapshotVersion);
      startLightCopyBackfill();
    }
  } catch (error) {
    fail(`[library] could not load the library: ${errorText(error)}`);
    if (!library) {
      const copy = await openParrotLibraryCopy(offlineDir, key);
      if (!copy) return { ok: false, error: errorText(error) };
      log(`[kept] offline: opened the kept library v${copy.version ?? "none"}`);
      setLibrary({ db: openParrotLibrary(copy.dbBytes), version: copy.version });
    }
  }
  // The tickets are asked for once the library loads after sign-in, never by a first lookup (META-ANON-02).
  startLookup();
  void keeping?.reconcile();
  // An import publishes song after song: a lookup pass publishing meanwhile only races it (each side then replays on
  // the other's snapshot). The import's end starts them.
  if (!importStatus.running) {
    autoLyrics();
    autoArtistPictures();
    retryUnidentified();
    autoAlbumCovers();
    autoCopyChanges();
  }
  const result = await libraryResult();
  log(`[library] v${result.library.snapshotVersion ?? "none"}: ${result.library.tracks.length} songs in ${Date.now() - started} ms`);
  return result;
};

const libraryResult = async (): Promise<ParrotLibraryResult & { ok: true }> => {
  // Every row is read before the wait below: a reload may close this database meanwhile.
  const db = library?.db ?? null;
  const snapshotVersion = library?.version ?? null;
  const artists = db ? listParrotArtists(db) : [];
  const albums = db ? listParrotAlbums(db) : [];
  const tracks = db ? listParrotTracks(db) : [];
  const playlists = db ? listParrotPlaylists(db) : [];
  // Covers and artist photos are both served by the local server, by their storage keys.
  const server = albums.some((album) => album.coverObjectKey) || artists.some((artist) => artist.pictureObjectKey)
    ? await ensurePlayback().catch((error: unknown) => {
        fail(`[covers] could not start the local server, albums and artists show drawn pictures: ${errorText(error)}`);
        return null;
      })
    : null;
  const url = (key: string | null) => (key && server ? server.coverUrlFor(key) : null);
  const result = {
    ok: true as const,
    library: {
      snapshotVersion,
      artists: artists.map(({ pictureObjectKey, pictureThumbObjectKey, pictureAuthor, pictureLicence, pictureLicenceUrl, ...artist }) => ({
        ...artist,
        pictureUrl: url(pictureObjectKey),
        pictureThumbUrl: url(parrotArtistPictureThumbKey({ pictureObjectKey, pictureThumbObjectKey })),
        pictureCredit: pictureObjectKey ? parrotArtistPictureCredit({ pictureAuthor, pictureLicence, pictureLicenceUrl }) : null,
      })),
      albums: albums.map(({ coverObjectKey, coverThumbObjectKey, ...album }) => ({
        ...album,
        coverUrl: url(coverObjectKey),
        coverThumbUrl: url(parrotCoverThumbKey({ coverObjectKey, coverThumbObjectKey })),
      })),
      tracks,
      playlists,
    },
  };
  shownLibrary = result.library;
  return result;
};

/** The library as last handed to the window: what an import's publish is told against (#2509). */
let shownLibrary: ParrotLibrary | null = null;
/**
 * An import's publish went out (PAR-UP-03): its library, as published, becomes the one shown, and the window gets only
 * what changed (#2509) instead of reading the whole library back from the server after every song. `db` is already
 * this window's own copy; the calls run one after another so each patch starts where the one before ended.
 */
let libraryShowing: Promise<void> = Promise.resolve();
const takePublishedLibrary = (db: ParrotLibraryDb, version: number) => {
  const step = async () => {
    const started = Date.now();
    const before = shownLibrary;
    setLibrary({ db, version });
    const { library: after } = await libraryResult();
    if (!before) {
      mainWindow?.webContents.send(PARROT_IPC.libraryChangedEvent);
      return;
    }
    const patch = diffParrotLibrary(before, after);
    mainWindow?.webContents.send(PARROT_IPC.libraryPatchEvent, patch);
    log(`[library] v${version}: ${parrotLibraryPatchSize(patch)} row(s) changed, shown in ${Date.now() - started} ms`);
  };
  libraryShowing = libraryShowing.then(step).catch((error: unknown) => fail(`[library] could not show v${version}: ${errorText(error)}`));
  return libraryShowing;
};

const isPlaylistEdit = (value: unknown): value is ParrotPlaylistEdit => {
  if (!value || typeof value !== "object") return false;
  const edit = value as Record<string, unknown>;
  const text = (key: string) => typeof edit[key] === "string";
  const ids = (key: string) => Array.isArray(edit[key]) && (edit[key] as unknown[]).every((id) => typeof id === "string");
  switch (edit.kind) {
    case "create":
      return text("id") && text("name") && (edit.trackIds === undefined || ids("trackIds"));
    case "rename":
      return text("id") && text("name");
    case "delete":
      return text("id");
    case "add":
      return text("id") && ids("trackIds");
    case "remove":
      return text("id") && text("trackId") && Number.isInteger(edit.position);
    case "like":
      return text("trackId") && typeof edit.liked === "boolean";
    default:
      return false;
  }
};

// One save at a time: each one builds on the library the previous one left. A quit waits for it (PAR-PL-05).
const librarySaves = createSaveChain();

/** Saves playlist and heart edits into the encrypted library; on a concurrent save the same edits are rebuilt on the newer library once (PAR-PL-03). */
const editPlaylists = (edits: unknown): Promise<ParrotLibraryResult> => {
  const run = async (): Promise<ParrotLibraryResult> => {
    if (!Array.isArray(edits) || !edits.every(isPlaylistEdit)) return { ok: false, error: "invalid playlist edit" };
    const token = store.token();
    const key = store.libraryKey();
    if (!token || !key) return { ok: false, error: "not signed in" };
    if (!library) await loadLibrary();
    if (!library) return { ok: false, error: "library not loaded" };
    const opened = library.db;
    const build = (db: ParrotLibraryDb) => parrotPlaylistEditOps(listParrotPlaylists(db), edits, { now: Date.now(), newId: randomUUID });
    const result = await publishLibraryChange("playlists", `${edits.length} edit(s)`, opened, build(opened), build, token, key);
    if (result.ok && library) {
      keepLibraryCopy(serializeParrotLibrary(library.db), library.version);
      void keeping?.reconcile();
    }
    return result;
  };
  return librarySaves.run(run, Array.isArray(edits) ? edits.length : 1);
};

const isManageTarget = (value: unknown): value is ParrotManageTarget => {
  if (typeof value !== "object" || value === null) return false;
  const { kind, id } = value as Record<string, unknown>;
  return (kind === "track" || kind === "album" || kind === "artist") && typeof id === "string" && id.length > 0;
};

const libraryQuery = (db: ParrotLibraryDb): ParrotLibraryQuery => (sql, params = []) => db.prepare(sql).all(...params) as never[];
/** Reads whichever library is current at each query: for lookups that outlive a library replaced meanwhile. */
const currentLibraryQuery: ParrotLibraryQuery = (sql, params = []) => (library ? libraryQuery(library.db)(sql, params) : []);

const planDelete = (db: ParrotLibraryDb, target: ParrotManageTarget) => planParrotDelete(libraryQuery(db), target, { now: Date.now(), newId: randomUUID });

/** What a delete would remove, for the confirm dialog (PAR-LIB-03): nothing is changed. */
const previewDelete = async (target: unknown): Promise<ParrotDeletePreview> => {
  if (!isManageTarget(target)) return { ok: false, error: "invalid delete target" };
  if (!library) await loadLibrary();
  if (!library) return { ok: false, error: "library not loaded" };
  const opened = library.db;
  const plan = await libraryDbs.hold(opened, () => planDelete(opened, target));
  return { ok: true, trackCount: plan.trackCount, albumCount: plan.albumCount };
};

/**
 * PAR-LIB-03: deletes a song, an album or an artist. The stored files go first: if storage refuses, nothing is removed
 * and the library still points at files that exist. Then the rows go, and the library is published. Shares the save
 * chain with playlist edits, so each builds on the library the previous one left.
 */
const deleteFromLibrary = (target: unknown): Promise<ParrotLibraryResult> => {
  const run = async (): Promise<ParrotLibraryResult> => {
    if (!isManageTarget(target)) return { ok: false, error: "invalid delete target" };
    const token = store.token();
    const key = store.libraryKey();
    if (!token || !key) return { ok: false, error: "not signed in" };
    if (!library) await loadLibrary();
    if (!library) return { ok: false, error: "library not loaded" };
    const opened = library.db;
    // Held across the storage call: an import may replace the current library meanwhile.
    return libraryDbs.hold(opened, async () => {
      const plan = await planDelete(opened, target);
      log(`[delete] ${target.kind} ${target.id}: ${plan.trackCount} song(s), ${plan.albumCount} album(s), ${plan.objectKeys.length} stored object(s), ${plan.ops.length} op(s)`);
      if (plan.ops.length === 0) return libraryResult();
      try {
        if (plan.objectKeys.length > 0) {
          const removed = await deleteStorageObjects(token, plan.objectKeys, PARROT_APP_ID);
          log(`[delete] storage removed ${removed.deleted ?? 0} of ${plan.objectKeys.length} object(s)`);
        }
      } catch (error) {
        fail(`[delete] storage refused, nothing removed: ${errorText(error)}`);
        return { ok: false, error: errorText(error) };
      }
      return publishLibraryChange("delete", `${target.kind} ${target.id}`, opened, plan.ops, async (db) => (await planDelete(db, target)).ops, token, key);
    });
  };
  return librarySaves.run(run);
};

/**
 * Applies `ops` to the opened library and publishes it; on a concurrent publish `build` plans the change again on the
 * newer library. A failed publish goes back to the server's library, since the local copy may hold what it never got.
 */
const publishLibraryChange = (
  label: string,
  what: string,
  opened: ParrotLibraryDb,
  ops: ParrotLibraryOp[],
  build: (db: ParrotLibraryDb) => ParrotLibraryOp[] | Promise<ParrotLibraryOp[]>,
  token: string,
  key: string
): Promise<ParrotLibraryResult> => {
  // The opened library stays open for this whole save, even when a reload or a replay replaces it meanwhile.
  return libraryDbs.hold(opened, async (): Promise<ParrotLibraryResult> => {
    const state = { db: opened, baseVersion: library?.version ?? 0 };
    try {
      applyParrotOps(state.db, ops);
      const version = await publishParrotEdits(state, build, {
        transport: { fetchSnapshot: fetchLibrarySnapshot, publishSnapshot: publishLibrarySnapshot },
        token,
        libraryKeyBase64: key,
        log,
        close: libraryDbs.retire,
      });
      log(`[${label}] ${what} published as library v${version}`);
      // A reload during the save replaced the library: read it again rather than keep the older copy.
      if (library?.db !== opened) return loadLibrary();
      setLibrary({ db: state.db, version });
      return libraryResult();
    } catch (error) {
      fail(`[${label}] could not publish ${what}: ${errorText(error)}`);
      // The local copy may hold what the server never got: go back to the server's library.
      const reloaded = await loadLibrary();
      if (!reloaded.ok) fail(`[${label}] could not reload the library after the failed publish: ${reloaded.error}`);
      return { ok: false, error: errorText(error) };
    } finally {
      // The library a replay ended on, when the window does not read it.
      if (state.db !== library?.db) libraryDbs.retire(state.db);
    }
  });
};

/** The details the edit dialog opens with (PAR-META-16): a song's or an album's current values, year and genre included. */
const getEditValues = async (target: unknown): Promise<ParrotEditValues> => {
  if (!isManageTarget(target) || target.kind === "artist") return null;
  if (!library) await loadLibrary();
  if (!library) return null;
  const query = currentLibraryQuery;
  if (target.kind === "track") {
    const edit = await parrotTrackEditValues(query, target.id);
    return edit && { kind: "track", edit };
  }
  const values = await parrotAlbumEditValues(query, target.id);
  if (!values) return null;
  const { coverObjectKey: _cover, ...edit } = values;
  return { kind: "album", edit };
};

/**
 * PAR-META-16: saves the user's edits to a song or an album through the shared `saveParrotEdit`; this side wires
 * storage, the publish and the save chain shared with playlist edits and deletes.
 */
const editDetails = (target: unknown, cover: unknown): Promise<ParrotLibraryResult> => {
  const run = async (): Promise<ParrotLibraryResult> => {
    const token = store.token();
    const key = store.libraryKey();
    if (!token || !key) return { ok: false, error: "not signed in" };
    if (!library) await loadLibrary();
    if (!library) return { ok: false, error: "library not loaded" };
    const opened = library.db;
    const what = isManageTarget(target) ? `${target.kind} ${target.id}` : "edit";
    // Held across the cover upload: an import may replace the current library meanwhile.
    const result = await libraryDbs.hold(opened, () => saveParrotEdit({
      target,
      cover,
      db: opened,
      query: libraryQuery,
      // PAR-META-22: an album's new cover is cut to the square the user framed, else its centre one.
      makeCoverCopies: (bytes, crop) => albumCoverCopies({ bytes, mime: parrotCoverMime(bytes) ?? "" }, crop),
      storeCover: (bytes) =>
        uploadParrotCover({ token, libraryKeyBase64: key, bytes, clientType: CLIENT_TYPE, appId: PARROT_APP_ID, upload: uploadStorageObjectViaTunnel }),
      publish: (ops, build) => publishLibraryChange("edit", what, opened, ops, build, token, key),
      deleteObjects: (keys) => deleteStorageObjects(token, keys, PARROT_APP_ID),
      newId: randomUUID,
      log,
      fail,
    }));
    return result === "unchanged" ? libraryResult() : result;
  };
  return librarySaves.run(run);
};

/**
 * The anonymous lookup of this signed-in session (META-ANON-01/02): tickets are kept in `<userData>/metadata-tickets`
 * and asked for once the library loads after sign-in (`startLookup`). Sign-out stops it and drops them.
 */
/** META-ANON-06: a dev run (`import.meta.env.DEV`) sends no tickets unless built with VITE_METADATA_TICKETS=on; a package always does. */
const metadataTickets = metadataTicketsForBuild({ devBuild: import.meta.env.DEV === true, flag: import.meta.env.VITE_METADATA_TICKETS });
// SF_METADATA_URL wins, then the build-time VITE_METADATA_URL (the dev launcher's and the dev stack's target,
// META-ANON-09); otherwise the service of the API the tickets come from (META-ANON-08), not the build flavour.
// An electron-vite dev run with tickets off must name one of the two (META-ANON-06).
const metadataUrl = () =>
  resolveMetadataUrl({
    METADATA_URL: process.env.SF_METADATA_URL?.trim() || undefined,
    VITE_METADATA_URL: import.meta.env.VITE_METADATA_URL,
    apiBaseUrl,
    tickets: metadataTickets,
  });
const metadata = createSessionMetadata({
  storage: createFileKeyValueStorage(join(userDataDir, "metadata-tickets")),
  // META-ANON-14: Node's fetch would otherwise send its own User-Agent.
  fetch: (url, init) => fetch(url, init),
  userAgent: NEUTRAL_USER_AGENT,
  // Only the issuance request (to the API) carries the session; the lookups themselves carry one ticket each.
  getAuth: () => {
    const token = store.token();
    return token ? { token, headers: { [SPACE_APP_HEADER]: "parrot" } } : null;
  },
  apiBaseUrl: () => apiBaseUrl,
  tickets: metadataTickets,
  metadataUrl,
  pinnedKeys: ticketKeysForBuild(isDevBuild),
  // Counts and public key ids only, never a ticket or a title. A key_mismatch names both keys (META-ANON-07).
  onRefill: (result) => log(`[lookup] ticket ${refillLogLine(result, ticketKeysForBuild(isDevBuild)).line}`),
});
let metadataStarted: Promise<unknown> | null = null;
/** META-ANON-02: starts the reserve's refill schedule once per signed-in session (sign-out resets it). */
const startLookup = () => {
  metadataStarted ??= metadata.start();
};
/** The lookup client once the refill runs: a lookup waits for its first batch, never for all 600 tickets (META-ANON-10). */
const lookupClient = async () => {
  startLookup();
  await metadata.scheduleRunning();
  return metadata.client;
};
const stopLookup = () => {
  autoLyricsStop?.abort();
  autoLyricsStop = null;
  lyricsPending.clear();
  autoArtistPicturesStop?.abort();
  autoArtistPicturesStop = null;
  retryUnidentifiedStop?.abort();
  retryUnidentifiedStop = null;
  retryUnidentifiedTried.clear();
  autoAlbumCoversStop?.abort();
  autoAlbumCoversStop = null;
  autoCopyChangesStop?.abort();
  autoCopyChangesStop = null;
  metadataStarted = null;
  void metadata.stop().catch((error: unknown) => fail(`[lookup] could not drop the tickets: ${errorText(error)}`));
};

/**
 * PAR-COPY-01: the background copy passes (lyrics, album covers, artist photos) stop at the ticket floor, so the
 * tickets left are kept for what the user asks. It is read once the sign-in refill ended and its random delay passed
 * (META-ANON-13); a dev build whose lookups carry no ticket (META-ANON-06) has no floor and no delay.
 */
const aboveTicketFloor = async (): Promise<boolean> => {
  if (!metadataTickets) return true;
  startLookup();
  await metadataStarted;
  await metadata.backgroundReady();
  return (await metadata.reserve.count()) > PARROT_COPY_TICKET_FLOOR;
};

/**
 * PAR-LYR-01: after the library loads (sign-in, an import, any reload), every song never looked up gets its lyrics
 * looked up on its own, one at a time; found words and "no lyrics" are published in batches through the same save
 * chain as edits, and the playing song's lyrics are read again. One pass at a time; a load during a pass asks for
 * another pass after it, and its songs never looked up are pending from then on. Sign-out stops it. The songs a pass
 * still has to settle are `lyricsPending`: `getLyrics` answers "searching" for them (PAR-LYR-06), and the window reads
 * its song again each time that set changes.
 */
const lyricsPending = createParrotLyricsPending();
lyricsPending.onChange(() => mainWindow?.webContents.send(PARROT_IPC.lyricsChangedEvent));
let autoLyricsStop: AbortController | null = null;
let autoLyricsAgain = false;
const autoLyrics = () => {
  if (autoLyricsStop) {
    autoLyricsAgain = true;
    void queueParrotAutoLyrics(currentLibraryQuery, lyricsPending).catch((error: unknown) => fail(`[lyrics:auto] could not queue the next pass: ${errorText(error)}`));
    return;
  }
  const token = store.token();
  const key = store.libraryKey();
  if (!token || !key || !library) {
    // No pass can start: the songs queued or wanted for it would otherwise stay "Looking for lyrics…" (PAR-LYR-06).
    lyricsPending.takeQueue();
    lyricsPending.dropWanted();
    return;
  }
  const stop = new AbortController();
  autoLyricsStop = stop;
  autoLyricsAgain = false;
  const songExists = (db: ParrotLibraryDb, trackId: string) => db.prepare("SELECT 1 FROM tracks WHERE id = ?").all(trackId).length > 0;
  const publish = (ops: ParrotLibraryOp[]) => {
    const run = async (): Promise<boolean> => {
      if (stop.signal.aborted || !library) return false;
      const keep = (db: ParrotLibraryDb) => ops.filter((op) => op.type === "lyrics.set" && songExists(db, op.payload.trackId));
      if (keep(library.db).length === 0) return true;
      const result = await publishLibraryChange("lyrics", `${ops.length} song(s) looked up`, library.db, keep(library.db), keep, token, key);
      if (result.ok) mainWindow?.webContents.send(PARROT_IPC.lyricsChangedEvent);
      return result.ok;
    };
    return librarySaves.run(run);
  };
  void runParrotAutoLyrics({
    query: () => currentLibraryQuery,
    lookup: async (question) => (await lookupClient()).musicLyrics(question),
    publish,
    onError: (error, failedInARow) => {
      fail(`[lyrics:auto] lookup failed (${failedInARow} in a row): ${errorText(error)}`);
      return parrotAutoLyricsOnError(error, failedInARow);
    },
    now: Date.now,
    newId: randomUUID,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    signal: stop.signal,
    pending: lyricsPending,
    canSpend: aboveTicketFloor,
    onProgress: (done, total) => setBackgroundWork("lyrics", { done, total }),
  }).then(
    (report) => {
      if (report.asked > 0 || report.stopped) log(`[lyrics:auto] asked ${report.asked}: ${report.found} found, ${report.none} none, ${report.failed} failed${report.stopped ? ", stopped" : ""}`);
    },
    (error: unknown) => fail(`[lyrics:auto] could not run: ${errorText(error)}`)
  ).finally(() => {
    if (autoLyricsStop !== stop) return;
    autoLyricsStop = null;
    setBackgroundWork("lyrics", null);
    if ((autoLyricsAgain || lyricsPending.hasWanted()) && !stop.signal.aborted) autoLyrics();
  });
};

/**
 * PAR-COPY-01: the window shows only the library's own lyrics and never looks a song up itself. A playing song never
 * looked up is handed to the automatic pass, which asks it next (paced, ticket floor) and keeps the answer in the
 * library; it says "Looking for lyrics…" meanwhile (PAR-LYR-05/06).
 */
const wantLyrics = (trackId: unknown) => {
  if (typeof trackId !== "string" || !trackId) return;
  lyricsPending.want(trackId);
  if (!autoLyricsStop) autoLyrics();
};

/**
 * PAR-META-15: after the library loads, every artist with an id in the metadata and no photo is asked for one on its own,
 * one at a time (`runParrotAutoArtistPictures`); found photos are stored as an album cover's two sealed copies and
 * published in batches through the same save chain as edits, then the window reads the library again. One pass at a
 * time; a load during a pass asks for another pass after it. Sign-out stops it.
 */
let autoArtistPicturesStop: AbortController | null = null;
let autoArtistPicturesAgain = false;
const autoArtistPictures = () => {
  if (autoArtistPicturesStop) {
    autoArtistPicturesAgain = true;
    return;
  }
  const token = store.token();
  const key = store.libraryKey();
  if (!token || !key || !library) return;
  const stop = new AbortController();
  autoArtistPicturesStop = stop;
  autoArtistPicturesAgain = false;
  const publish = (ops: ParrotLibraryOp[]) => {
    const run = async (): Promise<boolean> => {
      if (stop.signal.aborted || !library) return false;
      const opened = library.db;
      return libraryDbs.hold(opened, async () => {
        const kept = await rebaseParrotArtistPictureOps(libraryQuery(opened), ops);
        if (kept.length === 0) return true;
        const result = await publishLibraryChange(
          "artist-pictures",
          `${kept.length} artist(s) looked up`,
          opened,
          kept,
          (db) => rebaseParrotArtistPictureOps(libraryQuery(db), ops),
          token,
          key
        );
        if (result.ok) mainWindow?.webContents.send(PARROT_IPC.libraryChangedEvent);
        return result.ok;
      });
    };
    return librarySaves.run(run);
  };
  void runParrotAutoArtistPictures({
    query: () => currentLibraryQuery,
    lookup: async (artistId) => (await lookupClient()).musicArtistImage(artistId),
    // PAR-META-15: an artist without an id gets the one of its matched album or song first.
    albums: async (question) => (await lookupClient()).musicAlbums(question),
    recordings: async (question) => (await lookupClient()).musicRecordings(question),
    fromBase64: (base64) => new Uint8Array(Buffer.from(base64, "base64")),
    makeCopies: (bytes) => makeParrotCoverCopies(bytes, log),
    store: (bytes) => uploadParrotCover({ token, libraryKeyBase64: key, bytes, clientType: CLIENT_TYPE, appId: PARROT_APP_ID, upload: uploadStorageObjectViaTunnel }),
    publish,
    onError: (error, failedInARow) => {
      fail(`[artist-pictures:auto] lookup failed (${failedInARow} in a row): ${errorText(error)}`);
      return parrotAutoLyricsOnError(error, failedInARow);
    },
    now: Date.now,
    newId: randomUUID,
    sleep: (ms) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, ms);
      return promise;
    },
    signal: stop.signal,
    canSpend: aboveTicketFloor,
    onProgress: (done, total) => setBackgroundWork("artistPhotos", { done, total }),
  })
    .then(
      (report) => {
        if (report.asked > 0 || report.stopped)
          log(`[artist-pictures:auto] asked ${report.asked}: ${report.found} found, ${report.none} none, ${report.failed} failed${report.stopped ? ", stopped" : ""}`);
      },
      (error: unknown) => fail(`[artist-pictures:auto] could not run: ${errorText(error)}`)
    )
    .finally(() => {
      if (autoArtistPicturesStop !== stop) return;
      autoArtistPicturesStop = null;
      setBackgroundWork("artistPhotos", null);
      if (autoArtistPicturesAgain && !stop.signal.aborted) autoArtistPictures();
    });
};

/**
 * PAR-META-20: after the library loads, every album with no cover whose identity is known is asked for one on its own
 * (`runParrotAutoAlbumCovers`), so a cover an import could not fetch arrives later. Found covers are stored as two
 * sealed copies and published through the same save chain as edits. The albums still to ask are sent to the window,
 * whose tiles shimmer for them instead of showing "no cover". When this device last got an answer is kept in
 * `album-covers-asked.json`, so an album with no cover anywhere is asked again only after a month.
 */
const albumCoversAskedFile = join(userDataDir, "album-covers-asked.json");
const albumCoversAskedAt = (() => {
  try {
    const stored: unknown = JSON.parse(readFileSync(albumCoversAskedFile, "utf8"));
    return new Map(Object.entries(stored && typeof stored === "object" ? stored : {}).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
  } catch {
    return new Map<string, number>();
  }
})();
const albumCoversAsked: ParrotAlbumCoversAsked = {
  at: (albumId) => albumCoversAskedAt.get(albumId) ?? null,
  mark: (albumId, at) => {
    albumCoversAskedAt.set(albumId, at);
    try {
      writeFileSync(albumCoversAskedFile, JSON.stringify(Object.fromEntries(albumCoversAskedAt)));
    } catch (error) {
      fail(`[album-covers:auto] could not remember the lookup: ${errorText(error)}`);
    }
  },
};
let albumCoversWaiting: string[] = [];
let autoAlbumCoversStop: AbortController | null = null;
let autoAlbumCoversAgain = false;
const autoAlbumCovers = () => {
  if (autoAlbumCoversStop) {
    autoAlbumCoversAgain = true;
    return;
  }
  const token = store.token();
  const key = store.libraryKey();
  if (!token || !key || !library) return;
  const stop = new AbortController();
  autoAlbumCoversStop = stop;
  autoAlbumCoversAgain = false;
  const publish = (ops: ParrotLibraryOp[]) =>
    librarySaves.run(async (): Promise<boolean> => {
      if (stop.signal.aborted || !library) return false;
      const opened = library.db;
      return libraryDbs.hold(opened, async () => {
        const kept = await rebaseParrotAlbumCoverOps(libraryQuery(opened), ops);
        if (kept.length === 0) return true;
        const result = await publishLibraryChange("album-covers", `${kept.length} album cover(s) found`, opened, kept, (db) => rebaseParrotAlbumCoverOps(libraryQuery(db), ops), token, key);
        if (result.ok) mainWindow?.webContents.send(PARROT_IPC.libraryChangedEvent);
        return result.ok;
      });
    });
  void runParrotAutoAlbumCovers({
    query: () => currentLibraryQuery,
    lookup: async (albumId, size) => (await lookupClient()).musicCover(albumId, size),
    fromBase64: (base64) => new Uint8Array(Buffer.from(base64, "base64")),
    // PAR-META-22: an album's cover is cut to its centre square.
    makeCopies: (bytes) => albumCoverCopies({ bytes, mime: parrotCoverMime(bytes) ?? "" }, null),
    store: (bytes) => uploadParrotCover({ token, libraryKeyBase64: key, bytes, clientType: CLIENT_TYPE, appId: PARROT_APP_ID, upload: uploadStorageObjectViaTunnel }),
    publish,
    asked: albumCoversAsked,
    onError: (error, failedInARow) => {
      fail(`[album-covers:auto] lookup failed (${failedInARow} in a row): ${errorText(error)}`);
      return parrotAutoLyricsOnError(error, failedInARow);
    },
    onWaiting: (albumIds) => {
      albumCoversWaiting = [...albumIds];
      mainWindow?.webContents.send(PARROT_IPC.coversWaitingEvent, albumCoversWaiting);
    },
    now: Date.now,
    newId: randomUUID,
    sleep: (ms) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, ms);
      return promise;
    },
    signal: stop.signal,
    canSpend: aboveTicketFloor,
    onProgress: (done, total) => setBackgroundWork("covers", { done, total }),
  })
    .then(
      (report) => {
        if (report.asked > 0 || report.stopped)
          log(`[album-covers:auto] asked ${report.asked}: ${report.found} found, ${report.none} none, ${report.failed} failed${report.stopped ? ", stopped" : ""}`);
      },
      (error: unknown) => fail(`[album-covers:auto] could not run: ${errorText(error)}`)
    )
    .finally(() => {
      if (autoAlbumCoversStop !== stop) return;
      autoAlbumCoversStop = null;
      setBackgroundWork("covers", null);
      if (autoAlbumCoversAgain && !stop.signal.aborted) autoAlbumCovers();
    });
};

/**
 * PAR-COPY-01: when a new music copy changed albums this library holds, they follow it, unless edited by hand
 * (`runParrotCopyChanges`). At library load, at most once a day, the device asks ONE list shared by every user — the
 * albums each copy changed since the one it last saw — and looks up only the held albums on it, by their id. What it
 * last saw is kept in `copy-changes-check.json`, removed at sign-out.
 */
const copyChangesCheckFile = join(userDataDir, "copy-changes-check.json");
const copyChangesCheck = {
  read: (): ParrotCopyCheck => {
    try {
      const stored = JSON.parse(readFileSync(copyChangesCheckFile, "utf8")) as Partial<ParrotCopyCheck>;
      return {
        checkedAt: typeof stored.checkedAt === "number" ? stored.checkedAt : null,
        version: typeof stored.version === "string" ? stored.version : null,
      };
    } catch {
      return { checkedAt: null, version: null };
    }
  },
  write: (next: ParrotCopyCheck) => {
    try {
      writeFileSync(copyChangesCheckFile, JSON.stringify(next));
    } catch (error) {
      fail(`[copy-changes] could not remember the check: ${errorText(error)}`);
    }
  },
};
let autoCopyChangesStop: AbortController | null = null;
const autoCopyChanges = () => {
  if (autoCopyChangesStop) return;
  const token = store.token();
  const key = store.libraryKey();
  if (!token || !key || !library) return;
  const stop = new AbortController();
  autoCopyChangesStop = stop;
  const publish = (ops: ParrotLibraryOp[]) =>
    librarySaves.run(async (): Promise<boolean> => {
      if (stop.signal.aborted || !library) return false;
      const opened = library.db;
      return libraryDbs.hold(opened, async () => {
        const kept = await rebaseParrotCopyRefreshOps(libraryQuery(opened), ops);
        if (kept.length === 0) return true;
        const result = await publishLibraryChange("copy-changes", `${kept.length} album detail(s) refreshed`, opened, kept, (db) => rebaseParrotCopyRefreshOps(libraryQuery(db), ops), token, key);
        if (result.ok) mainWindow?.webContents.send(PARROT_IPC.libraryChangedEvent);
        return result.ok;
      });
    });
  void runParrotCopyChanges({
    query: () => currentLibraryQuery,
    changes: async (since) => (await lookupClient()).musicCopyChanges(since),
    albums: async (question) => (await lookupClient()).musicAlbums(question),
    publish,
    memory: copyChangesCheck,
    onError: (error, failedInARow) => {
      fail(`[copy-changes] lookup failed (${failedInARow} in a row): ${errorText(error)}`);
      return parrotAutoLyricsOnError(error, failedInARow);
    },
    now: Date.now,
    newId: randomUUID,
    sleep: (ms) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, ms);
      return promise;
    },
    signal: stop.signal,
    canSpend: aboveTicketFloor,
  })
    .then(
      (report) => {
        if (report.checked || report.stopped)
          log(
            `[copy-changes] copy ${report.version ?? "none"}: ${report.listed} listed, ${report.held} held, ${report.refreshed} refreshed, ${report.unchanged} unchanged, ${report.edited} edited, ${report.failed} failed${report.stopped ? ", stopped" : ""}`
          );
      },
      (error: unknown) => fail(`[copy-changes] could not run: ${errorText(error)}`)
    )
    .finally(() => {
      if (autoCopyChangesStop === stop) autoCopyChangesStop = null;
    });
};

/**
 * PAR-UP-05 (issue #2531): after the library loads and after an import, the songs kept as is are matched again on
 * their own (`runParrotRetryUnidentified`), with the library as context; a confident match moves the song onto its
 * track through the same save chain as edits, anything else leaves it as is. A song is asked once per session; one
 * the lookup failed for is asked at the next pass. One pass at a time; sign-out stops it.
 */
const retryUnidentifiedTried = new Set<string>();
let retryUnidentifiedStop: AbortController | null = null;
let retryUnidentifiedAgain = false;
const retryUnidentified = () => {
  if (retryUnidentifiedStop) {
    retryUnidentifiedAgain = true;
    return;
  }
  const token = store.token();
  const key = store.libraryKey();
  if (!token || !key || !library) return;
  const stop = new AbortController();
  retryUnidentifiedStop = stop;
  retryUnidentifiedAgain = false;
  const publish = (placements: ParrotTrackPlacement[]) => {
    const run = async (): Promise<boolean> => {
      if (stop.signal.aborted || !library) return false;
      const opened = library.db;
      const plan = (db: ParrotLibraryDb) => planParrotTrackPlacements(libraryQuery(db), placements, { now: Date.now(), newId: randomUUID, ids: PARROT_EDIT_IDS });
      const first = await libraryDbs.hold(opened, () => plan(opened));
      if (first.ops.length === 0) return true;
      const result = await publishLibraryChange("retry-unidentified", `${placements.length} song(s) identified`, opened, first.ops, async (db) => (await plan(db)).ops, token, key);
      if (!result.ok) return false;
      mainWindow?.webContents.send(PARROT_IPC.libraryChangedEvent);
      if (first.objectKeys.length > 0) {
        await deleteStorageObjects(token, first.objectKeys, PARROT_APP_ID).then(
          (removed) => log(`[retry-unidentified] storage removed ${removed.deleted ?? 0} unused object(s)`),
          (error: unknown) => fail(`[retry-unidentified] unused objects stay in storage: ${errorText(error)}`)
        );
      }
      return true;
    };
    return librarySaves.run(run);
  };
  void runParrotRetryUnidentified({
    query: () => currentLibraryQuery,
    recordings: async (question) => (await lookupClient()).musicRecordings(question),
    albums: async (question) => (await lookupClient()).musicAlbums(question),
    publish,
    tried: retryUnidentifiedTried,
    sleep: (ms) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, ms);
      return promise;
    },
    log,
    signal: stop.signal,
  })
    .then(
      (report) => {
        if (report.asked > 0 || report.failed > 0)
          log(`[retry-unidentified] asked ${report.asked}: ${report.placed} placed, ${report.unsure} unsure, ${report.none} none, ${report.failed} failed${report.stopped ? ", stopped" : ""}`);
      },
      (error: unknown) => fail(`[retry-unidentified] could not run: ${errorText(error)}`)
    )
    .finally(() => {
      if (retryUnidentifiedStop !== stop) return;
      retryUnidentifiedStop = null;
      if (retryUnidentifiedAgain && !stop.signal.aborted) retryUnidentified();
    });
};

/**
 * PAR-LYR-05: asks our lyrics library for the words of a song whose file has none, keeps them in the library (the
 * same save chain as edits), and answers with what the Lyrics tab shows now. The song is pending from the call until
 * its answer is kept (PAR-LYR-06), also while it waits its turn behind other saves (the album card's "Fetch lyrics"
 * asks all its songs at once), so its Lyrics tab says "Looking for lyrics…" and never "No lyrics" meanwhile.
 */
const fetchLyrics = (trackId: unknown): Promise<ParrotFetchLyricsResult> => {
  const run = async (): Promise<ParrotFetchLyricsResult> => {
    const token = store.token();
    const key = store.libraryKey();
    if (!token || !key) return { ok: false, error: "not signed in" };
    if (typeof trackId !== "string") return { ok: false, error: "invalid song" };
    if (!library) await loadLibrary();
    if (!library) return { ok: false, error: "library not loaded" };
    const opened = library.db;
    let found: ParrotLyricsFetch;
    try {
      const client = await lookupClient();
      found = await libraryDbs.hold(opened, () => fetchParrotLyrics({ query: libraryQuery(opened), trackId, lookup: (question) => client.musicLyrics(question), now: Date.now, newId: randomUUID }));
    } catch (error) {
      fail(`[lyrics] lookup for song ${trackId} failed: ${errorText(error)}`);
      return { ok: false, error: errorText(error) };
    }
    log(`[lyrics] song ${trackId}: ${found.kind}`);
    // "No lyrics" is kept too, so every device shows it as final (PAR-LYR-04); a later "Fetch lyrics" asks again.
    if (found.kind === "found" || found.kind === "none") {
      const op = found.op;
      const published = await publishLibraryChange("lyrics", `song ${trackId}`, opened, [op], () => [op], token, key);
      if (!published.ok) return { ok: false, error: published.error };
    }
    const lyrics = library ? getParrotLyrics(library.db, trackId) : null;
    return { ok: true, outcome: found.kind === "found" || found.kind === "present" ? "found" : "none", lyrics };
  };
  // Its own hold: a pass ending meanwhile never clears it, and it never clears a song a pass still asks.
  const hold = typeof trackId === "string" ? lyricsPending.hold([trackId]) : null;
  return librarySaves.run(run).finally(() => hold?.release());
};

const isMeasuredLoudness = (value: unknown): value is ParrotMeasuredLoudness => {
  const entry = value as Partial<ParrotMeasuredLoudness> | null;
  return (
    !!entry &&
    typeof entry.trackId === "string" &&
    typeof entry.gainDb === "number" &&
    Number.isFinite(entry.gainDb) &&
    typeof entry.peak === "number" &&
    Number.isFinite(entry.peak)
  );
};

/**
 * PAR-PLAY-03 item 2: keeps the loudness the renderer measured from the decoded audio of songs that had none (no
 * ReplayGain tag in the file), as one publish through the same save chain as edits. Rebuilt against the published
 * library, so a value that arrived meanwhile (another computer measured it) wins.
 */
const saveLoudness = (measured: ParrotMeasuredLoudness[]): Promise<ParrotLibraryResult> => {
  const run = async (): Promise<ParrotLibraryResult> => {
    const token = store.token();
    const key = store.libraryKey();
    if (!token || !key) return { ok: false, error: "not signed in" };
    if (!library) await loadLibrary();
    if (!library) return { ok: false, error: "library not loaded" };
    const opened = library.db;
    const plan = async (db: ParrotLibraryDb) => {
      const query = libraryQuery(db);
      const ops: ParrotLibraryOp[] = [];
      for (const entry of measured) {
        const op = await planParrotTrackLoudness(query, entry.trackId, entry, { now: Date.now(), newId: randomUUID });
        if (op) ops.push(op);
      }
      return ops;
    };
    const ops = await libraryDbs.hold(opened, () => plan(opened));
    if (ops.length === 0) return libraryResult();
    log(`[loudness] keeping the measured loudness of ${ops.length} song(s)`);
    return publishLibraryChange("loudness", `${ops.length} song(s)`, opened, ops, plan, token, key);
  };
  return librarySaves.run(run);
};

// An import pauses it (confirmImport) and its end resumes it.
const loudnessGate = createLoudnessGate({ save: saveLoudness, heldResult: libraryResult, log });

/** How many results the edit dialog asks the lookup for at a time (PAR-META-18). */
const EDIT_SUGGEST_LIMIT = 12;

/**
 * PAR-META-18: the metadata service's suggestions for what is typed in the edit dialog, ranked against all its
 * fields; the dialog ranks the library's own beside them. Nothing is written. A lookup that can't answer (none
 * configured: 501) says why; the dialog keeps the library's suggestions.
 */
const suggestEdit = async (asked: unknown): Promise<ParrotEditSuggestResult> => {
  const q = (asked ?? {}) as Partial<ParrotEditSuggestQuery>;
  const fields = (q.fields ?? {}) as Partial<ParrotEditSuggestQuery["fields"]>;
  const field = q.field === "title" || q.field === "artist" || q.field === "album" ? q.field : null;
  if ((q.kind !== "track" && q.kind !== "album") || !field || typeof q.text !== "string") return { ok: false, error: "invalid question" };
  const query: ParrotEditSuggestQuery = {
    kind: q.kind,
    field,
    text: q.text,
    fields: { title: String(fields.title ?? ""), artist: String(fields.artist ?? ""), ...(fields.album === undefined ? {} : { album: String(fields.album) }) },
  };
  if (query.text.trim() === "") return { ok: true, results: [] };
  try {
    const { results } = await (await lookupClient()).musicSuggest(parrotMusicSuggestQuery(query, EDIT_SUGGEST_LIMIT));
    log(`[metadata] suggest ${query.kind} ${query.field} (${query.text.length} chars typed): ${results.length} result(s)`);
    return { ok: true, results: parrotLookupSuggestions(results, query) };
  } catch (error) {
    fail(`[metadata] suggest ${query.kind} ${query.field} failed: ${errorText(error)}`);
    return { ok: false, error: errorText(error) };
  }
};

/** PAR-META-18: the cover of an album picked in the edit dialog, kept with the album only when the dialog is saved. */
const suggestEditCover = async (coverId: unknown): Promise<ParrotEditCover | null> => {
  if (typeof coverId !== "string" || coverId === "") return null;
  try {
    const { cover } = await (await lookupClient()).musicCover(coverId, 500);
    log(`[metadata] edit cover ${coverId}: ${cover ? cover.mime : "none"}`);
    return cover ? { kind: "file", bytes: new Uint8Array(Buffer.from(cover.base64, "base64")), mime: cover.mime } : null;
  } catch (error) {
    fail(`[metadata] edit cover ${coverId} failed: ${errorText(error)}`);
    return null;
  }
};

/** The scan waiting in the confirm dialog (PAR-UP-05): only its files can be imported. */
let pendingScan: ParrotImportScan | null = null;
/** The library's albums every album's lookup weighs (PAR-META-03), read once per scan. */
let pendingLibraryAlbums: Promise<ParrotImportLibraryAlbum[]> | null = null;
/** The review's albums still looking up, by the review's album id: "Import as is" stops one (PAR-UP-08). */
let pendingAlbumLookups = new Map<string, AbortController>();
/**
 * The pictures the review can make an album's cover (PAR-UP-08): those built into the scanned files and the image
 * files the user picked, by id; the import takes the chosen one's bytes from here, never from the window.
 */
let pendingPictures = new Map<string, ParrotCoverImage>();
/** The picture id built into each scanned file already read, so a second look at an album reads no file again. */
let pendingFilePictures = new Map<string, string | null>();

/** Forgets everything the review of the waiting scan asked: its lookups are stopped. */
const forgetImportReview = () => {
  for (const lookup of pendingAlbumLookups.values()) lookup.abort();
  pendingAlbumLookups = new Map();
  pendingLibraryAlbums = null;
  pendingPictures = new Map();
  pendingFilePictures = new Map();
  pendingArtistPhotos = new Map();
  pendingCovers = new Map();
};

/**
 * PAR-UP-08 (Chris v3 approval, 2026-11-21): one album of the waiting scan looks itself up, on its own, as soon as the
 * review shows it from its files' tags: each of its files is matched (title, artist and length, the album tag as a
 * hint, through the session's anonymous lookup) and placed on the album it really is, with its full tracklist. Covers
 * are not waited for (#2509): the review asks each one afterwards (`importCover`). "Import as is" stops the lookup
 * (`stopImportAlbumMatch`): its answer is `stopped` and the album is imported from its tags. When the lookup can't be
 * reached (none configured: 501) every file is `lookup-failed`: the review keeps those as is, so it never stops the
 * import.
 */
const matchImportAlbum = async (question: unknown): Promise<ParrotImportAlbumMatch> => {
  const scan = pendingScan;
  const asked = (question ?? {}) as { id?: unknown; files?: unknown };
  const id = typeof asked.id === "string" ? asked.id : "";
  const files = new Set(Array.isArray(asked.files) ? asked.files.map(String) : []);
  const entries = scan ? scan.entries.filter((entry) => files.has(entry.file)) : [];
  if (!scan || !id || entries.length === 0) return { kind: "stopped" };
  pendingAlbumLookups.get(id)?.abort();
  const lookup = new AbortController();
  pendingAlbumLookups.set(id, lookup);
  // A stopped lookup answers no more questions: the matcher takes each as a failed one and finishes at once.
  const stopped = new Promise<never>((_resolve, reject) =>
    lookup.signal.addEventListener("abort", () => reject(new Error("stopped by Import as is")), { once: true })
  );
  stopped.catch(() => undefined);
  const unlessStopped = <T>(ask: () => Promise<T>): Promise<T> => (lookup.signal.aborted ? stopped : Promise.race([ask(), stopped]));
  try {
    const client = await lookupClient().catch((error: unknown) => {
      fail(`[import] music lookup unavailable: ${errorText(error)}`);
      return null;
    });
    if (!client) return { kind: "found", albums: [], unidentified: entries.map((entry) => ({ file: entry.file, reason: "lookup-failed" as const })) };
    pendingLibraryAlbums ??= parrotImportLibraryAlbums(currentLibraryQuery);
    const library = await pendingLibraryAlbums;
    const matched = await matchParrotImport(entries, {
      recordings: (q) => unlessStopped(() => client.musicRecordings(q)),
      albums: (q) => unlessStopped(() => client.musicAlbums(q)),
      log,
      // PAR-META-03: the library's albums pull a song into their empty slots and keep their edition.
      library,
    });
    if (lookup.signal.aborted || pendingScan !== scan) {
      log(`[import] match ${id}: stopped, ${entries.length} song(s) imported as is`);
      return { kind: "stopped" };
    }
    const albums: ParrotImportMatchedAlbum[] = matched.albums.map((found) => ({ album: found.album, cover: null, tracklistKnown: found.tracklistKnown, files: found.files }));
    const unsure = albums.filter((found) => found.files.some((file) => !file.sure)).length;
    log(`[import] match ${id}: ${albums.length} album(s) (${unsure} to check), ${matched.unidentified.length} as is of ${entries.length} song(s)`);
    return { kind: "found", albums, unidentified: matched.unidentified };
  } finally {
    if (pendingAlbumLookups.get(id) === lookup) pendingAlbumLookups.delete(id);
  }
};

/** PAR-UP-08 "Import as is": stops one album's lookup; what it already found is dropped. */
const stopImportAlbumMatch = (id: unknown) => {
  const lookup = typeof id === "string" ? pendingAlbumLookups.get(id) : undefined;
  if (!lookup) return;
  log(`[import] match ${String(id)}: Import as is`);
  lookup.abort();
};

/** A picture kept for the review under its id, as the window shows it (PAR-UP-08); null when it can't be read. */
const reviewPicture = (bytes: Uint8Array, mime: string, files: number): ParrotImportPicture | null => {
  const preview = parrotCoverPreview(bytes);
  if (!preview) return null;
  const id = `picture:${createHash("sha256").update(bytes).digest("hex")}`;
  pendingPictures.set(id, { bytes, mime });
  return { id, data: `data:${preview.mime};base64,${Buffer.from(preview.bytes).toString("base64")}`, width: preview.width, height: preview.height, files };
};

/**
 * PAR-UP-08: the different pictures built into an album's files, for its cover menu, each once with how many of the
 * files carry it. Only the waiting scan's files are read.
 */
const importAlbumPictures = async (files: unknown): Promise<ParrotImportPicture[]> => {
  const scan = pendingScan;
  if (!scan || !Array.isArray(files)) return [];
  const scanned = new Set(scan.entries.map((entry) => entry.file));
  const counts = new Map<string, number>();
  const shown = new Map<string, ParrotImportPicture>();
  for (const file of files.map(String).filter((file) => scanned.has(file))) {
    let id = pendingFilePictures.get(file);
    if (id === undefined) {
      id = null;
      try {
        const { cover } = await readParrotTrackInfo(file);
        if (cover && !parrotCoverProblem(cover)) {
          const picture = reviewPicture(cover.bytes, cover.mime, 0);
          if (picture) {
            id = picture.id;
            shown.set(id, picture);
          }
        }
      } catch (error) {
        fail(`[import] picture of ${file} not read: ${errorText(error)}`);
      }
      if (pendingScan !== scan) return [];
      pendingFilePictures.set(file, id);
    }
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const pictures: ParrotImportPicture[] = [];
  for (const [id, count] of counts) {
    const picture = shown.get(id) ?? (pendingPictures.has(id) ? reviewPicture(pendingPictures.get(id)!.bytes, pendingPictures.get(id)!.mime, 0) : null);
    if (picture) pictures.push({ ...picture, files: count });
  }
  log(`[import] pictures of ${files.length} file(s): ${pictures.length} different`);
  return pictures;
};

/** PAR-UP-08 "Choose an image file…": an image the user picks for an album's cover, kept for the import. */
const pickImportCoverImage = async (): Promise<ParrotImportPicture | null> => {
  if (!pendingScan || !mainWindow) return null;
  const picked = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp", "gif"] }],
  });
  const file = picked.canceled ? undefined : picked.filePaths[0];
  if (!file) return null;
  try {
    const { size } = await stat(file);
    if (size > PARROT_COVER_MAX_BYTES) {
      fail(`[import] picked cover ${file} skipped: ${size} bytes, at most ${PARROT_COVER_MAX_BYTES}`);
      return null;
    }
    const bytes = new Uint8Array(await readFile(file));
    const picture = reviewPicture(bytes, parrotCoverMime(bytes) ?? "", 0);
    log(`[import] picked cover ${file}: ${picture ? `${picture.width} × ${picture.height}` : "not a picture"}`);
    return picture;
  } catch (error) {
    fail(`[import] picked cover ${file} not read: ${errorText(error)}`);
    return null;
  }
};

/**
 * PAR-META-22: a picture neither JPEG nor PNG (WebP, GIF) is cut to its square by the window, which decodes every
 * picture the app shows (Main 2026-11-21): it draws the square on a canvas (a GIF's first frame) and answers a JPEG,
 * or a PNG when the picture is see-through, at most 1200 px. Null when there is no window or it can't.
 */
const coverCuts = new Map<string, (bytes: Uint8Array | null) => void>();
const COVER_CUT_TIMEOUT_MS = 30_000;
const cutCoverInWindow = (cover: ParrotCoverImage, crop: ParrotCoverCrop | null): Promise<Uint8Array | null> => {
  const window = mainWindow;
  if (!window || window.isDestroyed()) return Promise.resolve(null);
  const id = randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => answer(null), COVER_CUT_TIMEOUT_MS);
    const answer = (bytes: Uint8Array | null) => {
      clearTimeout(timer);
      coverCuts.delete(id);
      resolve(bytes);
    };
    coverCuts.set(id, answer);
    const request: ParrotCoverCutRequest = { id, bytes: cover.bytes, mime: cover.mime, crop };
    window.webContents.send(PARROT_IPC.coverCutEvent, request);
  });
};

/**
 * PAR-META-22: the copies of an album cover, cut to its square, `crop` else the centre one, whatever its source (the
 * files, our music library, a picked image). Here for a JPEG or PNG; by the window for any other picture.
 */
const albumCoverCopies = async (cover: ParrotCoverImage, crop: ParrotCoverCrop | null): Promise<ParrotCoverCopies | null> => {
  if (parrotCoverDecodable(cover.bytes)) return makeParrotCoverCopies(cover.bytes, log, { square: true, crop });
  const cut = await cutCoverInWindow(cover, crop);
  if (!cut) {
    fail(`[covers] ${cover.mime || "unknown"} picture: the window could not cut it to a square`);
    return makeParrotCoverCopies(cover.bytes, log, { square: true, crop });
  }
  log(`[covers] ${cover.mime || "unknown"} picture cut to a square by the window: ${parrotCoverMime(cut)}, ${cut.length} bytes`);
  return makeParrotCoverCopies(cut, log, { square: true });
};

/**
 * PAR-META-04: the covers of the albums the confirmed songs were matched to, at the 1200 px size (PAR-META-07), one
 * album at a time, and the pictures the review chose (PAR-UP-08). The import stores each on its album; a cover the
 * lookup can't give is left out, and the album then takes the picture built into its files, if any.
 */
const importCovers = async (edits: ParrotImportEdit[], pictures: ReadonlyMap<string, ParrotCoverImage>): Promise<Map<string, ParrotCoverImage>> => {
  const covers = new Map<string, ParrotCoverImage>();
  for (const edit of edits) {
    const picture = edit.coverPicture ? pictures.get(edit.coverPicture) : undefined;
    if (picture) covers.set(edit.coverPicture!, picture);
  }
  const ids = [...new Set(edits.flatMap((edit) => (edit.coverId && !edit.coverPicture ? [edit.coverId] : [])))];
  if (ids.length === 0) return covers;
  const client = await lookupClient().catch((error: unknown) => {
    fail(`[import] music lookup unavailable for covers: ${errorText(error)}`);
    return null;
  });
  if (!client) return covers;
  for (const id of ids) {
    try {
      const { cover } = await client.musicCover(id, 1200);
      if (cover) covers.set(id, { bytes: new Uint8Array(Buffer.from(cover.base64, "base64")), mime: cover.mime });
      log(`[import] cover for ${id}: ${cover ? `${cover.mime}, ${Math.round((cover.base64.length * 3) / 4)} bytes` : "none"}`);
    } catch (error) {
      fail(`[import] cover for ${id} failed: ${errorText(error)}`);
    }
  }
  return covers;
};

/**
 * PAR-UP-08 "Wrong album? Search": asks our music library for the albums matching what the user typed, with their
 * full tracklists; each cover is asked afterwards by the dialog (`importCover`). A failing lookup answers `failed`;
 * nothing changes in the review.
 */
const searchImportAlbums = async (question: unknown): Promise<ParrotImportAlbumSearch> => {
  const asked = (question ?? {}) as { artist?: unknown; album?: unknown };
  const artist = String(asked.artist ?? "").trim();
  const album = String(asked.album ?? "").trim();
  if (!artist && !album) return { kind: "found", results: [] };
  try {
    return { kind: "found", results: await searchParrotImportAlbums(await lookupClient(), { artist, album }, log) };
  } catch (error) {
    fail(`[import] album search failed: ${errorText(error)}`);
    return { kind: "failed" };
  }
};

/** The covers the waiting scan's searches asked for (PAR-UP-05), each asked once until the scan is answered. */
let pendingCovers = new Map<string, Promise<string | null>>();
const importCover = (albumId: unknown): Promise<string | null> => (pendingScan ? importCoverOf(lookupClient, pendingCovers, albumId, log) : Promise.resolve(null));

/** The photos of the waiting scan's artists (PAR-UP-06), each asked once until the scan is answered. */
let pendingArtistPhotos = new Map<string, Promise<ParrotImportArtistPhoto>>();
const NO_ARTIST_PHOTO: ParrotImportArtistPhoto = { photo: null, credit: null };

/**
 * PAR-UP-06 (Chris 2026-11-12): a matched artist's photo for the import review, through the same lookup as the
 * library's artist photos (PAR-META-15), as a data: URL with its credit. None found, or a lookup that fails, answers
 * no photo: the review shows the drawn picture, and the import never waits on it.
 */
const importArtistPhoto = (artistId: unknown): Promise<ParrotImportArtistPhoto> => {
  if (!pendingScan || typeof artistId !== "string" || !PARROT_MUSIC_ID.test(artistId)) return Promise.resolve(NO_ARTIST_PHOTO);
  let asked = pendingArtistPhotos.get(artistId);
  if (!asked) {
    asked = (async () => {
      try {
        const { image } = await (await lookupClient()).musicArtistImage(artistId);
        log(`[import] artist photo ${artistId}: ${image ? `found${image.credit ? " (credited)" : ""}` : "none in any source"}`);
        return image ? { photo: `data:${image.mime};base64,${image.base64}`, credit: image.credit } : NO_ARTIST_PHOTO;
      } catch (error) {
        fail(`[import] artist photo ${artistId} lookup failed: ${errorText(error)}`);
        return NO_ARTIST_PHOTO;
      }
    })();
    pendingArtistPhotos.set(artistId, asked);
  }
  return asked;
};

/**
 * PAR-UP-05: setup and the Import button only scan. The songs found wait in the confirm dialog until the user
 * confirms; nothing is uploaded before that (Chris 2026-11-09).
 */
const scanImport = (folders: string[]): ParrotImportStatus => {
  if (importStatus.running) return importStatus;
  pendingScan = null;
  forgetImportReview();
  startImportJob(folders);
  setImportStatus({ ...idleImport, running: true, phase: "scanning" });
  log(`[import] scan: ${folders.length} folder(s)`);
  const run = new AbortController();
  importRun = run;
  void (async () => {
    try {
      const scan = await scanParrotImport(folders, {
        log,
        signal: AbortSignal.any([importAbort.signal, run.signal]),
        onProgress: (done, total) => setImportStatus({ ...importStatus, done, total }),
      });
      run.signal.throwIfAborted();
      pendingScan = scan;
      log(`[import] scan found ${scan.entries.length} song(s), ${scan.albums} album(s), ${scan.totalBytes} bytes; ${scan.unreadable.length} unreadable; waiting for confirm`);
      setImportStatus({ ...idleImport, phase: "review", total: scan.entries.length, bytesTotal: scan.totalBytes });
    } catch (error) {
      if (run.signal.aborted && !importAbort.signal.aborted) {
        // Stopped with the Jobs panel's X while reading: nothing was uploaded, so the job leaves the list.
        log("[import] scan stopped by the user");
        setImportStatus(idleImport);
      } else {
        fail(`[import] scan stopped: ${errorText(error)}`);
        setImportStatus({ ...idleImport, phase: "failed", error: importStopError(error, importAbort.signal.aborted) });
      }
    } finally {
      if (importRun === run) importRun = null;
    }
  })();
  return importStatus;
};

const cancelImport = (): ParrotImportStatus => {
  if (importRun && importStatus.running) {
    // UX-JOBS-02: the Jobs panel's X stops the running import; what it already published stays.
    log(`[import] stop asked by the user while ${importStatus.phase}: ${importStatus.imported} song(s) already in`);
    importRun.abort();
    return importStatus;
  }
  if (importStatus.phase !== "review") return importStatus;
  log(`[import] cancelled in the confirm dialog: ${pendingScan?.entries.length ?? 0} song(s) not uploaded`);
  pendingScan = null;
  forgetImportReview();
  setImportStatus(idleImport);
  return importStatus;
};

const confirmImport = (selection: ParrotImportSelection): ParrotImportStatus => {
  const scan = pendingScan;
  if (importStatus.running || importStatus.phase !== "review" || !scan) return importStatus;
  const token = store.token();
  const key = store.libraryKey();
  const user = store.user;
  if (!token || !key || !user) {
    setImportStatus({ ...idleImport, phase: "failed", error: "not signed in" });
    return importStatus;
  }
  pendingScan = null;
  // PAR-UP-06: the photos the review already fetched are the import's first answer for those artists.
  const reviewPhotos = pendingArtistPhotos;
  // PAR-UP-08: the pictures the review could choose; the import takes the chosen ones from here.
  const reviewPictures = pendingPictures;
  forgetImportReview();
  // Only files the scan found: the window cannot name any other path.
  const scanned = new Map(scan.entries.map((entry) => [entry.file, entry]));
  const edits = new Map<string, ParrotImportEdit>();
  for (const item of selection) {
    const entry = scanned.get(String(item.file));
    if (!entry) continue;
    const whole = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined);
    const albumArtist = typeof item.albumArtist === "string" && item.albumArtist.trim() ? item.albumArtist : undefined;
    const edit: ParrotImportEdit = {
      artist: String(item.artist ?? ""),
      album: String(item.album ?? ""),
      title: String(item.title ?? ""),
      // The matched release's album artist (PAR-META-04): replaces the file's album-artist tag.
      ...(albumArtist ? { albumArtist, albumArtistMusicId: typeof item.albumArtistMusicId === "string" && PARROT_MUSIC_ID.test(item.albumArtistMusicId) ? item.albumArtistMusicId : null } : {}),
      year: whole(item.year),
      number: whole(item.number),
      disc: whole(item.disc),
      // The matched album's full tracklist (PAR-LIB-05), checked row by row; a file kept as is (PAR-UP-05).
      tracklist: parseParrotTracklist(JSON.stringify(item.tracklist ?? null)) ?? undefined,
      // The matched album's id in the metadata (PAR-COPY-01): the copy-changes refresh and the cover pass find the album by it.
      albumMusicId: typeof item.albumMusicId === "string" && PARROT_MUSIC_ID.test(item.albumMusicId) ? item.albumMusicId : undefined,
      // The matched album's cover the review showed (PAR-META-04), fetched once per album before the upload.
      coverId: typeof item.coverId === "string" && PARROT_MUSIC_ID.test(item.coverId) ? item.coverId : undefined,
      // PAR-UP-08: a picture the review chose instead (built into a scanned file, or picked); only one it was given.
      coverPicture: typeof item.coverPicture === "string" && reviewPictures.has(item.coverPicture) ? item.coverPicture : undefined,
      // PAR-META-22: the square of the chosen cover the user framed.
      coverCrop: isParrotCoverCrop(item.coverCrop) ? { left: item.coverCrop.left, top: item.coverCrop.top, size: item.coverCrop.size } : undefined,
      unidentified: item.unidentified === true || undefined,
    };
    edits.set(entry.file, edit);
    if (edit.artist !== entry.artist || edit.album !== entry.album || edit.title !== entry.title || edit.year || edit.number !== entry.number || edit.disc !== entry.disc) {
      log(`[import] edited ${entry.file}: ${JSON.stringify(edit)}`);
    }
  }
  const files = [...edits.keys()];
  log(`[import] confirmed: ${files.length} of ${scan.entries.length} song(s)`);
  if (files.length === 0) {
    setImportStatus(idleImport);
    return importStatus;
  }
  // UX-JOBS-01: the files the scan could not read are this import's first failed files.
  const unreadable = scan.unreadable;
  setImportStatus({ ...idleImport, running: true, phase: "uploading", total: files.length, failed: unreadable.length }, unreadable);
  loudnessGate.pause();
  const folders = scan.folders;
  // PAR-LYR-06: a song whose lyrics the import could not ask says "Looking for lyrics…" until the pass after it.
  const lyricsHolds: Array<{ release: () => void }> = [];
  const importingAlbums: string[] = [];
  let published = false;
  const run = new AbortController();
  importRun = run;
  void (async () => {
    try {
      const covers = await importCovers([...edits.values()], reviewPictures);
      // PAR-FMT-01: songs are stored in parts only once the API turns it on for this account (`PARROT_SPLIT_ORIGINALS`).
      const { splitOriginals = false } = await getLibraryMeta(token, PARROT_APP_ID);
      const result = await importParrotFiles(files, {
        token,
        roots: folders,
        userId: user.id,
        libraryKeyBase64: key,
        clientType: CLIENT_TYPE,
        splitOriginals,
        readInfo: parrotEditedReader(edits, undefined, covers),
        makeLightCopy: lightCopies.make,
        // PAR-META-22: album covers cut to their square, a WebP or GIF by the window.
        albumCoverCopies,
        lightCopyLongSongs,
        signal: AbortSignal.any([importAbort.signal, run.signal]),
        log,
        // PAR-LYR-01, PAR-META-15, PAR-UP-06: lyrics and artist photos are asked while each song uploads.
        lookupLyrics: async (question) => (await lookupClient()).musicLyrics(question),
        onLyricsUnasked: (trackId) => lyricsHolds.push(lyricsPending.hold([trackId])),
        artistPhoto: async (artistId) => {
          const reviewed = await reviewPhotos.get(artistId);
          const found = reviewed?.photo
            ? { base64: reviewed.photo.slice(reviewed.photo.indexOf(",") + 1), credit: reviewed.credit }
            : (await (await lookupClient()).musicArtistImage(artistId)).image;
          return found ? { bytes: new Uint8Array(Buffer.from(found.base64, "base64")), credit: found.credit } : null;
        },
        onArtistPhotosAsked: (artistIds) => setImportStatus({ ...importStatus, fetchingArtists: artistIds }),
        // The window shows each publish from the importer's own library (#2509), read back from the server no more.
        onPublished: ({ version, db }) => {
          published = true;
          void takePublishedLibrary(openParrotLibrary(serializeParrotLibrary(db)), version);
        },
        onAlbumImporting: (albumId) => {
          importingAlbums.push(albumId);
          setImportStatus({ ...importStatus, importingAlbums: [...importingAlbums] });
        },
        // The importer says "done" once its last publish is through; the import is done only after the reload below,
        // so the window hears "done" once (one "Import finished" notification).
        onProgress: (progress) =>
          setImportStatus({
            ...importStatus,
            ...progress,
            phase: progress.phase === "done" ? "publishing" : progress.phase,
            failed: progress.failed + unreadable.length,
            running: true,
          }),
      });
      for (const failure of result.failed) fail(`[import] failed: ${failure.file}: ${failure.error}`);
      log(`[import] done: ${result.imported.length} imported, ${result.skipped.length} already there, ${result.failed.length} failed`);
      // The library the last publish left is the server's (#2509): kept and filled from here, not read back again.
      if (published && library) {
        await libraryShowing;
        keepLibraryCopy(serializeParrotLibrary(library.db), library.version);
        startLightCopyBackfill();
        void keeping?.reconcile();
      } else await loadLibrary();
      setImportStatus(
        {
          ...importStatus,
          running: false,
          phase: "done",
          currentFile: null,
          importingAlbums: [],
          fetchingArtists: [],
          imported: result.imported.length,
          skipped: result.skipped.length,
          failed: result.failed.length + unreadable.length,
        },
        [...unreadable, ...result.failed]
      );
    } catch (error) {
      if (run.signal.aborted && !importAbort.signal.aborted) {
        log(`[import] stopped by the user: ${importStatus.imported} added, ${importStatus.skipped} already there before the stop`);
        // A publish already taken (#2509) is shown first, so the reload never races its patch.
        if (published) await libraryShowing;
        await loadLibrary();
        setImportStatus({ ...importStatus, running: false, phase: "cancelled", currentFile: null, importingAlbums: [], fetchingArtists: [] });
      } else {
        fail(`[import] stopped: ${errorText(error)}`);
        setImportStatus({ ...importStatus, running: false, phase: "failed", currentFile: null, error: importStopError(error, importAbort.signal.aborted), importingAlbums: [], fetchingArtists: [] });
      }
    } finally {
      if (importRun === run) importRun = null;
    }
    // The lookups and the measured loudness wait for imports (PAR-LYR-01, PAR-META-15, PAR-PLAY-03): they run now,
    // whatever the import's outcome.
    autoLyrics();
    for (const held of lyricsHolds) held.release();
    autoArtistPictures();
    retryUnidentified();
    autoAlbumCovers();
    void loudnessGate.resume().catch((error: unknown) => fail(`[loudness] could not keep the held songs: ${errorText(error)}`));
  })();
  return importStatus;
};

/**
 * Whether `key` is the account's key, checked with `token` (see `checkKeyAgainstAccount`); stores nothing, except
 * that an account with no key at all is claimed: Parrot's first (empty) library is published with the key, which
 * writes the account's key probe, so Badger and every other device check their keys against it (PRIV-KEY-01).
 * `onParrotLibrary` gets the opened Parrot library when there is one (the key step keeps it open).
 */
const verifyLibraryKey = (
  token: string,
  key: string,
  onParrotLibrary?: (snapshot: FetchedLibrarySnapshot) => void,
): Promise<ParrotKeyResult> =>
  checkKeyAgainstAccount(
    key,
    {
      fetchSnapshot: (appId) => fetchLibrarySnapshot({ token, keyBase64: key, appId }),
      fetchKeyProbe: async () => (await getLibraryMetaForKeyStep(token, PARROT_APP_ID)).keyProbe ?? null,
      decryptProbe: decryptBase64ToBytes,
      claimAccount: async (claimed) => {
        const empty = openParrotLibrary(null);
        try {
          const published = await publishLibrarySnapshot({
            token,
            keyBase64: claimed,
            dbBytes: serializeParrotLibrary(empty),
            baseVersion: 0,
            appId: PARROT_APP_ID,
            opStreamVersion: PARROT_OP_STREAM_VERSION,
          });
          log(`[key] first Parrot library published as v${published.version}: the account's key probe is written`);
        } finally {
          empty.close();
        }
      },
      log,
      fail,
    },
    onParrotLibrary,
  );

const storeLibraryKey = async (key: string) => {
  await store.setLibraryKey(key);
  chunkLoader.clear();
  readingChunkLoader.clear();
};

const checkLibraryKey = async (raw: string): Promise<ParrotKeyResult> => {
  const token = store.token();
  if (!token) return { ok: false, error: "network", message: "not signed in" };
  const key = raw.replace(/\s+/g, "");
  const verdict = await verifyLibraryKey(token, key, (snapshot) => {
    setLibrary({ db: openParrotLibrary(snapshot.dbBytes), version: snapshot.snapshotVersion });
  });
  if (!verdict.ok) return verdict;
  await storeLibraryKey(key);
  return { ok: true };
};

/**
 * The key step's first question (UX-KEY-01): an account with no library and no key probe gets a new key's words to
 * show; nothing is kept until the user has written it down and `setLibraryKey` claims the account with it.
 */
const createLibraryKey = async (): Promise<ParrotCreateKeyResult> => {
  const token = store.token();
  if (!token) return { ok: false, error: "network", message: "not signed in" };
  const newKey = generateLibraryKeyWords(store.setup.language);
  return makeAccountKey(newKey, {
    fetchSnapshot: (appId) => fetchLibrarySnapshot({ token, keyBase64: newKey.keyBase64, appId }),
    fetchKeyProbe: async () => (await getLibraryMetaForKeyStep(token, PARROT_APP_ID)).keyProbe ?? null,
    log,
    fail,
  });
};

/** This computer's key and everything kept under it are forgotten; setup goes back to the key step. */
const forgetLibraryKeyHere = async () => {
  store.clearLibraryKey();
  closeLibrary();
  stopLookup();
  chunkLoader.clear();
  readingChunkLoader.clear();
  await coverLoader.clear();
  await keeping?.clear();
  for (const name of ["library.sealed", "library.json"]) rmSync(join(offlineDir, name), { force: true });
  await store.updateSetup({ done: false, step: "libraryKey" });
};

/**
 * PRIV-KEY-01 on the key step: erase the account's whole vault (Badger and Parrot, every profile), then forget this
 * computer's key and everything kept under it, and go back to the key step for a fresh key (Badger desktop's erase).
 */
const eraseLibrary = (password: unknown, twoFactorCode: unknown) => {
  const token = store.token();
  if (!token) return Promise.resolve({ status: "failed", reason: "other", message: "not signed in" } as const);
  return eraseAccountLibrary(String(password ?? ""), typeof twoFactorCode === "string" ? twoFactorCode : undefined, {
    reset: (pass, code) => resetLibrary(token, pass, code),
    clearLocal: forgetLibraryKeyHere,
    log,
    fail,
  });
};

/**
 * A billing call with the session token (ACCT-PAY-01). The API's error code travels back as `code`
 * (an Error thrown across IPC would lose it), with `excessBytes` for a `library_too_large` refusal
 * (ACCT-PLAN-08), so the shared plan change words it as in Badger.
 */
const billingCall = async <T>(name: string, call: (token: string) => Promise<T>): Promise<ParrotBillingResult<T>> => {
  const token = store.token();
  if (!token) return { ok: false, code: "auth_required" };
  try {
    return { ok: true, value: await call(token) };
  } catch (error) {
    const message = errorText(error);
    const code = /^[a-z][a-z0-9_]*$/.test(message) ? message : "request_failed";
    fail(`[billing] ${name} failed: ${code}${code === message ? "" : ` (${message})`}`);
    const excessBytes = error instanceof ApiError ? Number(error.payload.excessBytes) : Number.NaN;
    return Number.isFinite(excessBytes) && excessBytes > 0 ? { ok: false, code, excessBytes } : { ok: false, code };
  }
};

const billingPeriodOf = (value: unknown): BillingPeriod => (value === "monthly" ? "monthly" : "annual");
const addonCountOf = (value: unknown): number => {
  const count = Math.trunc(Number(value));
  return Number.isFinite(count) ? Math.max(count, 0) : 0;
};

const registerBillingIpc = () => {
  ipcMain.handle(PARROT_IPC.getSubscription, () =>
    billingCall("subscription", async (token): Promise<ParrotSubscription> => {
      const sub = await getSubscription(token);
      return {
        plan: sub.plan,
        storageLimitGb: sub.storageLimitGb,
        storageUsedGb: sub.storageUsedGb,
        storageAddonCount: sub.storageAddonCount ?? 0,
        paidUntil: sub.paidUntil ?? null,
        billingPeriod: sub.billingPeriod ?? null,
        scheduledChange: sub.scheduledChange ?? null,
        renewalHold: sub.renewalHold ?? null,
      };
    }),
  );
  ipcMain.handle(PARROT_IPC.getBillingStatus, () =>
    billingCall("status", async (token) => {
      const status = await getBillingStatus(token);
      log(`[billing] status: provider=${status.provider} checkoutAllowed=${status.checkoutAllowed} reason=${status.checkoutBlockedReason ?? "none"}`);
      return status;
    }),
  );
  // Settings' data credits (META-SRC-09): the lookups' metadata service answers them; the window keeps the last one.
  ipcMain.handle(PARROT_IPC.sourceCredits, (_event, product: unknown, language: unknown) => {
    if (product !== "parrot" && product !== "badger") throw new Error("invalid product");
    return fetchSourceCredits(metadataUrl(), product, typeof language === "string" ? language : "en");
  });
  ipcMain.handle(PARROT_IPC.updateSubscription, (_event, plan: unknown, options: Partial<ParrotPlanOptions> | undefined) => {
    if (!isPlanId(plan)) return { ok: false, code: "invalid_plan" };
    const billingPeriod = billingPeriodOf(options?.billingPeriod);
    const addonCount = plan === "tier3" ? addonCountOf(options?.addonCount) : 0;
    log(`[billing] plan change: ${plan} ${billingPeriod} +${addonCount}`);
    return billingCall("update", async (token) => {
      const result = await updateSubscription(token, plan, { billingPeriod, addonCount });
      log(`[billing] plan change answered: ${result.outcome}${result.effectiveAt ? ` at ${result.effectiveAt}` : ""}`);
      return { outcome: result.outcome, effectiveAt: result.effectiveAt ?? null };
    });
  });
  ipcMain.handle(PARROT_IPC.startCheckout, (_event, input: Partial<ParrotCheckoutInput> | undefined) => {
    const plan: unknown = input?.plan;
    if (!isPlanId(plan) || plan === "free") return { ok: false, code: "invalid_plan" };
    const billingPeriod = billingPeriodOf(input?.billingPeriod);
    const addonCount = plan === "tier3" ? addonCountOf(input?.addonCount) : 0;
    const lang = paymentPageLang(typeof input?.lang === "string" ? input.lang : undefined);
    log(`[billing] checkout: ${plan} ${billingPeriod} +${addonCount}`);
    // ACCT-PAY-05: the payment page comes back to Parrot (`parrot://billing/return`), not to the website.
    return billingCall("checkout", (token) => startCheckout(token, { plan, billingPeriod, addonCount, lang, returnApp: "parrot" }));
  });
  ipcMain.handle(PARROT_IPC.completePayment, (_event, paymentId: unknown) => {
    if (typeof paymentId !== "string" || !paymentId) return { ok: false, code: "payment_not_found" };
    return completePayment(paymentId);
  });
};

const completePayment = (paymentId: string) =>
  billingCall("complete", async (token) => {
    const result = await completeStancerPayment(token, paymentId);
    log(`[billing] payment ${result.outcome}`);
    return result;
  });

/**
 * A profile call with the session token (ACCT-PROF-01, ACCT-PROF-02). The API's status and code travel back as data (an
 * Error thrown across IPC would lose them) so the window's shared store maps `profile_limit` / `last_profile` as Badger
 * does; a network failure comes back as `offline`.
 */
const profilesCall = async <T>(name: string, call: (token: string) => Promise<T>): Promise<ParrotProfilesResult<T>> => {
  const token = store.token();
  if (!token) return { ok: false, status: 401, code: "auth_required" };
  try {
    const value = await call(token);
    log(`[profiles] ${name} ok`);
    return { ok: true, value };
  } catch (error) {
    if (error instanceof ApiError) {
      fail(`[profiles] ${name} refused: ${error.status} ${error.payload.error ?? "request_failed"}`);
      return { ok: false, status: error.status, code: error.payload.error ?? "request_failed" };
    }
    fail(`[profiles] ${name} failed: ${errorText(error)}`);
    return { ok: false, offline: true };
  }
};

const profileText = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * A renderer's profile body, checked field by field; the API validates the values (ACCT-PROF-05). `features` carries
 * the add form's and the "Your profile" step's `{avatars: "set"}` and the update window's "later" (UX-SETUP-10,
 * UX-UPDATE-01); unknown ids and states are dropped here.
 */
const profileBody = (value: unknown): { name?: string; avatarId?: ProfileAvatarId; features?: ProfileFeatures } => {
  const input =
    typeof value === "object" && value !== null ? (value as { name?: unknown; avatarId?: unknown; features?: unknown }) : {};
  const features =
    typeof input.features === "object" && input.features !== null
      ? (Object.fromEntries(
          Object.entries(input.features).filter(([id, state]) => isAppFeatureId(id) && isAppFeatureState(state))
        ) as ProfileFeatures)
      : null;
  return {
    ...(typeof input.name === "string" ? { name: input.name } : {}),
    ...(isProfileAvatarId(input.avatarId) ? { avatarId: input.avatarId } : {}),
    ...(features && Object.keys(features).length > 0 ? { features } : {}),
  };
};

const registerProfilesIpc = () => {
  ipcMain.handle(PARROT_IPC.listProfiles, () => profilesCall("list", listProfiles));
  ipcMain.handle(PARROT_IPC.createProfile, (_event, body: unknown) =>
    profilesCall("create", (token) => createProfile(token, { name: "", ...profileBody(body) })),
  );
  ipcMain.handle(PARROT_IPC.updateProfile, (_event, id: unknown, body: unknown) =>
    profilesCall("update", (token) => updateProfile(token, profileText(id), profileBody(body))),
  );
  ipcMain.handle(PARROT_IPC.deleteProfile, async (_event, id: unknown) => {
    const result = await profilesCall("delete", (token) => deleteProfile(token, profileText(id)));
    // Playback names the main profile (STOR-BW-11): deleting it makes the next oldest main, so ask again.
    if (result.ok) mainProfile = null;
    return result;
  });
};

/**
 * ACCT-PAY-05: the browser came back from the payment page. Parrot comes to the front and the plan screen checks the
 * payment at once (its polling stays the fallback). Before `ready` (Parrot started by the link) the link waits for the
 * store; with no window, no plan screen is waiting, so main completes the payment itself.
 */
const receivePaymentReturn = (paymentId: string, source: "second-instance" | "open-url") => {
  log(`[billing] payment return link received (${source}): ${paymentId}`);
  if (!store) {
    launchPaymentReturn = paymentId;
    return;
  }
  if (!mainWindow) {
    createWindow();
    void completePayment(paymentId);
    return;
  }
  revealWindow(mainWindow);
  mainWindow.webContents.send(PARROT_IPC.paymentReturnEvent, paymentId);
};

/**
 * ACCT-SIGNIN-05: the browser came back from a Google, Apple or Microsoft sign-in. The outcome waits in the mailbox;
 * Parrot comes to the front and a window already there is nudged to pull it (a window created now pulls it when its
 * sign-in screen mounts). Before `ready` (Parrot started by the link) the window created at `ready` pulls it.
 */
const receiveProviderReturn = (outcome: ProviderReturn, source: "second-instance" | "open-url") => {
  const hasWindow = Boolean(mainWindow);
  log(`[provider-sign-in] return link received (${source}): ${JSON.stringify({ outcome: "code" in outcome ? "code" : outcome.error, hasWindow })}`);
  providerReturns.put(outcome);
  if (!store) return;
  showMainWindow();
  if (hasWindow) mainWindow?.webContents.send(PARROT_IPC.providerReturnEvent);
};

const SIGN_IN_PROVIDERS: Record<SignInProvider, true> = { google: true, apple: true, microsoft: true };
/** Completion failures that leave the code usable: the second step, a wrong code, too many attempts, no answer. */
const PROVIDER_RETRYABLE: Partial<Record<SignInFailure, true>> = {
  twoFactorRequired: true,
  twoFactorInvalid: true,
  rateLimited: true,
  timeout: true,
  unreachable: true,
  notApi: true,
  serverError: true,
};

const registerIpc = () => {
  registerBillingIpc();
  registerProfilesIpc();
  registerErrorReportsIpc(ipcMain, errorReports);
  ipcMain.handle(PARROT_IPC.getState, () => currentState());
  const saveSetup = createSetupSaver({ store, errorReports, applyStartAtLogin, log, fail });
  ipcMain.handle(PARROT_IPC.saveSetup, async (_event, patch: Partial<ParrotSetupState>) => {
    await saveSetup(patch);
    // The language may have changed: the tray and the menu follow it.
    appTray.refresh();
    installApplicationMenu();
    return currentState();
  });
  // A session the API just handed over (sign-in or a verified new account): another account's local data goes first.
  const acceptSession = async (session: { token: string; user: { id: string; email: string } }) => {
    const previous = store.user;
    if (previous && previous.id !== session.user.id) resetToSignIn("signOut");
    await store.signIn({ id: session.user.id, email: session.user.email }, session.token);
    sessionChecked = Promise.resolve();
    publishSiblingAccount();
    return { id: session.user.id, email: session.user.email };
  };
  ipcMain.handle(PARROT_IPC.signIn, async (_event, input: { email: string; password: string; twoFactorCode?: string }): Promise<ParrotSignInResult> => {
    const email = input.email.trim();
    try {
      const session = await login(email, input.password, input.twoFactorCode?.trim() || undefined, undefined, {
        deviceType: "desktop",
        deviceName: resolveDeviceName(hostname()),
      });
      const user = await acceptSession(session);
      log(`[auth] signed in as user ${session.user.id}`);
      return { ok: true, user };
    } catch (error) {
      const failure = classifySignInError(error);
      log(`[auth] sign-in failed: ${failure} ${JSON.stringify(signInErrorDetails(error))}`);
      return { ok: false, failure, retryAfterMinutes: retryAfterMinutes(error) };
    }
  });
  // ACCT-AUTH-10: a desktop app creates accounts. The account takes this computer's language, so its first email reads
  // in it (ACCT-EMAIL-01); the News box goes with it (ACCT-NEWS-01). The API emails a code (ACCT-AUTH-01).
  ipcMain.handle(PARROT_IPC.signUp, async (_event, input: { email: string; password: string; newsOptIn: boolean }): Promise<ParrotSignUpResult> => {
    const email = input.email.trim();
    try {
      await signup(email, input.password, store.setup.language, input.newsOptIn === true);
      log(`[auth] sign-up sent: code emailed ${JSON.stringify({ language: store.setup.language, newsOptIn: input.newsOptIn === true })}`);
      return { ok: true };
    } catch (error) {
      const failure = classifySignUpError(error);
      log(`[auth] sign-up failed: ${failure} ${JSON.stringify(signInErrorDetails(error))}`);
      return { ok: false, failure, retryAfterMinutes: retryAfterMinutes(error) };
    }
  });
  // The emailed code: accepted, the API answers with a session and this computer is signed in, then setup asks for the
  // library key like after any first sign-in.
  ipcMain.handle(PARROT_IPC.verifyEmail, async (_event, input: { email: string; code: string }): Promise<ParrotVerifyEmailResult> => {
    try {
      const session = await verifyEmail(input.email.trim(), input.code.trim());
      const user = await acceptSession(session);
      log(`[auth] email verified, signed in as new user ${session.user.id}`);
      return { ok: true, user };
    } catch (error) {
      const failure = classifyVerifyEmailError(error);
      log(`[auth] email verification failed: ${failure} ${JSON.stringify(signInErrorDetails(error))}`);
      return { ok: false, failure, retryAfterMinutes: retryAfterMinutes(error) };
    }
  });
  ipcMain.handle(PARROT_IPC.resendVerification, async (_event, email: string): Promise<ParrotResendVerificationResult> => {
    try {
      await resendVerification(String(email).trim());
      log("[auth] verification code sent again");
      return { ok: true };
    } catch (error) {
      const failure = classifyResendVerificationError(error);
      log(`[auth] verification code resend failed: ${failure} ${JSON.stringify(signInErrorDetails(error))}`);
      return { ok: false, failure, retryAfterMinutes: retryAfterMinutes(error) };
    }
  });
  // ACCT-AUTH-05: "Forgot password?" — the same reset calls Badger desktop makes from its window, run here.
  const passwordReset = createPasswordResetActions({ requestPasswordReset, confirmPasswordReset }, log);
  ipcMain.handle(PARROT_IPC.passwordResetRequest, async (_event, email: string) => {
    const result = await passwordReset.request(String(email));
    if (result.ok) log("[auth] password reset code requested");
    return result;
  });
  ipcMain.handle(PARROT_IPC.passwordResetConfirm, async (_event, input: { email: string; code: string; newPassword: string }) => {
    const result = await passwordReset.confirm({ email: String(input.email), code: String(input.code), newPassword: String(input.newPassword) });
    if (result.ok) log("[auth] password reset with the emailed code");
    return result;
  });
  // ACCT-SIGNIN-05: the Google, Apple and Microsoft rows. The window keeps the secret; main asks the API, opens the
  // provider in the system browser (`parrot://auth/provider` brings it back) and keeps the session it trades for.
  ipcMain.handle(PARROT_IPC.providerList, async (): Promise<SignInProvider[]> => {
    try {
      const { providers } = await listSignInProviders();
      log(`[provider-sign-in] providers listed: ${JSON.stringify(providers)}`);
      return providers.filter((provider) => Object.hasOwn(SIGN_IN_PROVIDERS, provider));
    } catch (error) {
      // No list, no rows: the email form still works.
      log(`[provider-sign-in] could not list providers ${JSON.stringify(signInErrorDetails(error))}`);
      return [];
    }
  });
  ipcMain.handle(PARROT_IPC.providerStart, async (_event, provider: unknown, clientChallenge: unknown): Promise<ParrotProviderStartResult> => {
    if (typeof provider !== "string" || !Object.hasOwn(SIGN_IN_PROVIDERS, provider) || typeof clientChallenge !== "string") {
      log("[provider-sign-in] start refused: malformed request from the window");
      return { ok: false, failure: "unknown", retryAfterMinutes: 0 };
    }
    try {
      const { url } = await startProviderSignIn(provider as SignInProvider, {
        returnTo: providerReturnAddress("parrot"),
        surface: "desktop",
        clientChallenge,
        uiLanguage: store.setup.language,
      });
      // A dev stack's API (loopback http) sends the sign-in stand-in's loopback page (REL-ENV-39).
      if (!isAllowedExternalUrl(url, apiBaseUrl)) {
        log(`[provider-sign-in] start refused: the API answered a non-https address (${provider})`);
        return { ok: false, failure: "unknown", retryAfterMinutes: 0 };
      }
      await shell.openExternal(url);
      log(`[provider-sign-in] ${provider} opened in the system browser`);
      return { ok: true };
    } catch (error) {
      const failure = classifySignInError(error);
      log(`[provider-sign-in] start failed (${provider}): ${failure} ${JSON.stringify(signInErrorDetails(error))}`);
      return { ok: false, failure, retryAfterMinutes: retryAfterMinutes(error) };
    }
  });
  ipcMain.handle(PARROT_IPC.providerTakeReturn, (): ProviderReturn | null => {
    const outcome = providerReturns.take();
    log(`[provider-sign-in] sign-in screen pulled the return: ${outcome === null ? "none" : "code" in outcome ? "code" : outcome.error}`);
    return outcome;
  });
  ipcMain.handle(
    PARROT_IPC.providerComplete,
    async (_event, input: { code: string; verifier: string; twoFactorCode?: string; resendTwoFactor?: boolean }): Promise<ParrotProviderCompleteResult> => {
      try {
        const session = await completeProviderSignIn(
          String(input.code),
          String(input.verifier),
          input.twoFactorCode?.trim() || undefined,
          input.resendTwoFactor === true ? true : undefined,
          { deviceType: "desktop", deviceName: resolveDeviceName(hostname()) }
        );
        const user = await acceptSession(session);
        log(`[provider-sign-in] signed in as user ${session.user.id}`);
        return { ok: true, user };
      } catch (error) {
        const apiCode = error instanceof ApiError ? error.payload?.error : undefined;
        log(`[provider-sign-in] completion failed ${JSON.stringify(signInErrorDetails(error))}`);
        if (apiCode === "invalid_code" || apiCode === "account_deletion_pending") return { ok: false, error: apiCode };
        const failure = classifySignInError(error);
        if (!PROVIDER_RETRYABLE[failure]) return { ok: false, error: "provider_failed" };
        const method = error instanceof ApiError && error.payload?.method === "totp" ? "totp" : "email";
        return { ok: false, failure, ...(failure === "twoFactorRequired" ? { method } : {}), retryAfterMinutes: retryAfterMinutes(error) };
      }
    }
  );
  // ACCT-PAIR-01/05: "Sign in with your phone". The asking app is Parrot, so the approving phone reads
  // "Parrot on Linux (<host>) wants to sign in". Token and key stay here; the window only learns the key check.
  // The key step's "Get the key from another device" uses the same client in key mode, with this computer's session.
  const signInPairing = createDesktopPairingClient({
    getApiBaseUrl: () => apiBaseUrl,
    appId: PARROT_APP_ID,
    log: (message, extra) => log(`[pairing] ${message} ${JSON.stringify(extra ?? {})}`),
    sessionToken: () => store.token(),
  });
  let pairingMode: PairingMode = "sign_in";
  const pairedSignInDeps: ParrotPairedSignInDeps = {
    previousUserId: () => store.user?.id ?? null,
    forgetPreviousAccount: () => resetToSignIn("signOut"),
    verifyKey: (token, key) => verifyLibraryKey(token, key),
    signIn: async (user, token) => {
      await store.signIn(user, token);
      sessionChecked = Promise.resolve();
      publishSiblingAccount();
    },
    storeKey: storeLibraryKey,
    log,
  };
  ipcMain.handle(PARROT_IPC.pairingStart, async (_event, options: unknown): Promise<PairingStartResult> => {
    pairingMode = pairingModeOf(options);
    try {
      return { ok: true, ...(await signInPairing.start({ mode: pairingMode })) };
    } catch (error) {
      fail(`[pairing] could not get a sign-in code: ${errorText(error)}`);
      return { ok: false, ...pairingRefusalOf(error) };
    }
  });
  ipcMain.handle(PARROT_IPC.pairingPoll, async (_event, requestId: unknown): Promise<PairingPollResult<ParrotPairedSignIn>> => {
    if (typeof requestId !== "string" || !requestId) return { ok: false, error: "failed" };
    try {
      const poll = await signInPairing.poll(requestId);
      if (poll.status !== "approved") return { ok: true, ...poll };
      // The client keeps the approved answer, so a failed check (network) is retried by the window's next poll.
      const check =
        pairingMode === "key"
          ? await completeParrotKeyPairing(checkLibraryKey, poll, log)
          : await completeParrotPairedSignIn(pairedSignInDeps, poll);
      return { ok: true, status: "approved", check };
    } catch (error) {
      fail(`[pairing] sign-in poll failed: ${errorText(error)}`);
      return { ok: false, ...pairingRefusalOf(error) };
    }
  });
  ipcMain.handle(PARROT_IPC.pairingCancel, () => signInPairing.cancel());
  // ACCT-PAIR-07: "Continue with your Badger account". Token and key stay here; the window learns only the key check.
  ipcMain.handle(SIBLING_IPC.offer, () => siblingHost.offer());
  ipcMain.handle(SIBLING_IPC.signIn, async (): Promise<SiblingSignInResult<ParrotPairedSignIn>> => {
    const result = await siblingHost.signIn();
    if (result.status !== "approved") return result;
    const check = await completeParrotPairedSignIn(pairedSignInDeps, result);
    const step = check === "verified" ? setupStepAfterSiblingSignIn(store.setup.step) : null;
    if (step) {
      await store.updateSetup({ step });
      log(`[sibling] signed in through Badger with its key: setup goes on at ${step}`);
    }
    return { status: "approved", check };
  });
  ipcMain.handle(SIBLING_IPC.cancel, () => siblingHost.cancel());
  // UX-I18N-07: the account's one language, read right after a sign-in and saved when the user picks one while signed in.
  ipcMain.handle(PARROT_IPC.getAccountLanguage, async () => {
    const token = store.token();
    if (!token) return { ok: false };
    try {
      return { ok: true, language: accountLanguageOf((await getMe(token)).user) };
    } catch (error) {
      fail(`account_language.read_failed ${JSON.stringify({ error: errorText(error) })}`);
      return { ok: false };
    }
  });
  ipcMain.handle(PARROT_IPC.saveAccountLanguage, async (_event, value: unknown) => {
    const token = store.token();
    const language = typeof value === "string" ? value : null;
    if (!token || !isAccountLanguage(language)) return false;
    try {
      await updateSettings(token, { preferences: { uiLanguage: language } });
      log(`account_language.saved ${JSON.stringify({ language })}`);
      return true;
    } catch (error) {
      fail(`account_language.save_failed ${JSON.stringify({ language, error: errorText(error) })}`);
      return false;
    }
  });
  // ACCT-NEWS-01: the account's News opt-in, read when the settings page opens and saved by its switch.
  ipcMain.handle(PARROT_IPC.getNewsOptIn, async () => {
    const token = store.token();
    if (!token) return { ok: false };
    try {
      return { ok: true, newsOptIn: (await getMe(token)).user.newsOptIn === true };
    } catch (error) {
      fail(`news_opt_in.read_failed ${JSON.stringify({ error: errorText(error) })}`);
      return { ok: false };
    }
  });
  ipcMain.handle(PARROT_IPC.saveNewsOptIn, async (_event, value: unknown) => {
    const token = store.token();
    if (!token || typeof value !== "boolean") return { ok: false };
    try {
      const { user } = await updateSettings(token, { newsOptIn: value });
      log(`news_opt_in.saved ${JSON.stringify({ newsOptIn: user.newsOptIn === true })}`);
      return { ok: true, newsOptIn: user.newsOptIn === true };
    } catch (error) {
      fail(`news_opt_in.save_failed ${JSON.stringify({ newsOptIn: value, error: errorText(error) })}`);
      return { ok: false };
    }
  });
  // WAIT-FOUND-04: the founder status and its one-time notice, asked with the token that never leaves main.
  ipcMain.handle(PARROT_IPC.getFounderStatus, async () => {
    const token = store.token();
    if (!token) return { ok: false };
    try {
      const status = await getFounderStatus(token);
      log(`founder.status ${JSON.stringify(status)}`);
      return { ok: true, status };
    } catch (error) {
      fail(`founder.status_failed ${JSON.stringify({ error: errorText(error) })}`);
      return { ok: false };
    }
  });
  ipcMain.handle(PARROT_IPC.markFounderNoticeSeen, async () => {
    const token = store.token();
    if (!token) return false;
    try {
      await markFounderNoticeSeen(token);
      log("founder.notice_seen");
      return true;
    } catch (error) {
      fail(`founder.notice_seen_failed ${JSON.stringify({ error: errorText(error) })}`);
      return false;
    }
  });
  ipcMain.handle(PARROT_IPC.signOut, async () => {
    const token = store.token();
    await streamSlots.release().catch((error: unknown) => fail(`[stream] could not give the stream back: ${errorText(error)}`));
    if (token) await logout(token).catch((error: unknown) => fail(`[auth] sign-out on the server failed: ${errorText(error)}`));
    resetToSignIn("signOut");
    log("[auth] signed out");
    return currentState();
  });
  ipcMain.handle(PARROT_IPC.setLibraryKey, (_event, key: string) => checkLibraryKey(String(key)));
  ipcMain.handle(PARROT_IPC.createLibraryKey, () => createLibraryKey());
  ipcMain.handle(PARROT_IPC.eraseLibrary, (_event, password: unknown, twoFactorCode: unknown) => eraseLibrary(password, twoFactorCode));
  ipcMain.handle(PARROT_IPC.pickFolders, async () => {
    const picked = await dialog.showOpenDialog(mainWindow!, { properties: ["openDirectory", "multiSelections"] });
    return picked.canceled ? [] : picked.filePaths;
  });
  // UX-ADD-01: the "+" can also take single song files; the scan reads them like a folder's songs (PAR-UP-05).
  ipcMain.handle(PARROT_IPC.pickFiles, async () => {
    const extensions = Object.keys(PARROT_AUDIO_FORMATS).map((ext) => ext.slice(1));
    const picked = await dialog.showOpenDialog(mainWindow!, { properties: ["openFile", "multiSelections"], filters: [{ name: "Audio", extensions }] });
    return picked.canceled ? [] : picked.filePaths;
  });
  ipcMain.handle(PARROT_IPC.scanImport, (_event, folders: string[]) => scanImport(folders.map(String)));
  ipcMain.handle(PARROT_IPC.getImportScan, () => pendingScan);
  ipcMain.handle(PARROT_IPC.matchImportAlbum, (_event, question: unknown) => matchImportAlbum(question));
  ipcMain.handle(PARROT_IPC.stopImportAlbumMatch, (_event, id: unknown) => stopImportAlbumMatch(id));
  ipcMain.handle(PARROT_IPC.searchImportAlbums, (_event, question: unknown) => searchImportAlbums(question));
  ipcMain.handle(PARROT_IPC.importAlbumPictures, (_event, files: unknown) => importAlbumPictures(files));
  ipcMain.handle(PARROT_IPC.pickImportCoverImage, () => pickImportCoverImage());
  ipcMain.handle(PARROT_IPC.coverCut, (_event, id: unknown, bytes: unknown) => {
    if (typeof id === "string") coverCuts.get(id)?.(bytes instanceof Uint8Array && bytes.length > 0 ? bytes : null);
  });
  ipcMain.handle(PARROT_IPC.importArtistPhoto, (_event, artistId: unknown) => importArtistPhoto(artistId));
  ipcMain.handle(PARROT_IPC.importCover, (_event, albumId: unknown) => importCover(albumId));
  ipcMain.handle(PARROT_IPC.confirmImport, (_event, selection: ParrotImportSelection) =>
    confirmImport(Array.isArray(selection) ? selection : [])
  );
  ipcMain.handle(PARROT_IPC.cancelImport, () => cancelImport());
  ipcMain.handle(PARROT_IPC.getImportStatus, () => importStatus);
  ipcMain.handle(PARROT_IPC.getImportJobs, () => accountImportJobs());
  ipcMain.handle(PARROT_IPC.dismissImportJob, (_event, id: unknown) => dismissImportJob(String(id)));
  ipcMain.handle(PARROT_IPC.previewExport, () => exportJobs.preview());
  ipcMain.handle(PARROT_IPC.exportMusic, () => exportJobs.start());
  ipcMain.handle(PARROT_IPC.getExportJobs, () => exportJobs.list());
  ipcMain.handle(PARROT_IPC.cancelExport, (_event, id: unknown) => exportJobs.cancel(String(id)));
  ipcMain.handle(PARROT_IPC.dismissExportJob, (_event, id: unknown) => exportJobs.dismiss(String(id)));
  ipcMain.handle(PARROT_IPC.getBackgroundWork, () => [...backgroundWork.values()]);
  ipcMain.handle(PARROT_IPC.getLibrary, (_event, refresh: boolean) => (refresh || !library ? loadLibrary() : libraryResult()));
  ipcMain.handle(PARROT_IPC.wantLyrics, (_event, trackId: unknown) => wantLyrics(trackId));
  ipcMain.handle(PARROT_IPC.getLyrics, (_event, trackId: string) => {
    if (!library) return null;
    const id = String(trackId);
    return parrotLyricsOrSearching(getParrotLyrics(library.db, id), lyricsPending.has(id));
  });
  ipcMain.handle(PARROT_IPC.getCoversWaiting, () => albumCoversWaiting);
  ipcMain.handle(PARROT_IPC.editPlaylists, (_event, edits: unknown) => editPlaylists(edits));
  ipcMain.handle(PARROT_IPC.previewDelete, (_event, target: unknown) => previewDelete(target));
  ipcMain.handle(PARROT_IPC.deleteFromLibrary, (_event, target: unknown) => deleteFromLibrary(target));
  ipcMain.handle(PARROT_IPC.getEditValues, (_event, target: unknown) => getEditValues(target));
  ipcMain.handle(PARROT_IPC.editDetails, (_event, target: unknown, cover: unknown) => editDetails(target, cover));
  ipcMain.handle(PARROT_IPC.fetchLyrics, (_event, trackId: unknown) => fetchLyrics(trackId));
  ipcMain.handle(PARROT_IPC.saveLoudness, (_event, measured: unknown) =>
    Array.isArray(measured) && measured.every(isMeasuredLoudness)
      ? loudnessGate.save(measured)
      : Promise.resolve<ParrotLibraryResult>({ ok: false, error: "invalid loudness" })
  );
  ipcMain.handle(PARROT_IPC.suggestEdit, (_event, query: unknown) => suggestEdit(query));
  ipcMain.handle(PARROT_IPC.suggestEditCover, (_event, coverId: unknown) => suggestEditCover(coverId));
  ipcMain.handle(PARROT_IPC.playbackUrl, async (_event, fileId: string) => (await ensurePlayback()).urlFor(playbackFileFor(String(fileId))));
  // The loudness pass reads the song's own file, beside the player: no copy is picked for it (PAR-PLAY-04).
  ipcMain.handle(PARROT_IPC.measureUrl, async (_event, fileId: string) => (await ensurePlayback()).readUrlFor(String(fileId)));
  ipcMain.handle(PARROT_IPC.streamAcquire, (_event, trackId: unknown) => streamSlots.acquire(String(trackId)));
  ipcMain.handle(PARROT_IPC.streamAnswer, (_event, answer: unknown) => streamSlots.answer(answer === "playHere" ? "playHere" : "cancel"));
  ipcMain.handle(PARROT_IPC.streamDismiss, () => streamSlots.dismiss());
  ipcMain.handle(PARROT_IPC.streamRelease, () => streamSlots.release());
  ipcMain.handle(PARROT_IPC.getStreamState, () => streamSlots.state());
  ipcMain.handle(PARROT_IPC.getAppUpdateRequired, () => getAppUpdateRequired());
  ipcMain.handle(PARROT_IPC.getKept, () => keeping!.status());
  ipcMain.handle(PARROT_IPC.getKeptSizes, () => keeping!.sizes());
  ipcMain.handle(PARROT_IPC.keepChoices, (_event, kind: unknown, id: unknown) => (isKeptKind(kind) && typeof id === "string" ? keeping!.choices(kind, id) : []));
  ipcMain.handle(PARROT_IPC.keep, (_event, kind: unknown, id: unknown, choice: unknown) => {
    if (!isKeptKind(kind) || typeof id !== "string") return keeping!.status();
    return keeping!.keep(kind, id, typeof choice === "string" ? choice : null);
  });
  ipcMain.handle(PARROT_IPC.unkeep, (_event, kind: unknown, id: unknown) => (isKeptKind(kind) && typeof id === "string" ? keeping!.unkeep(kind, id) : keeping!.status()));
  const sendFeedbackNow = createDesktopFeedbackSender({
    app: "parrot-desktop",
    token: () => store.token(),
    errorLog,
    appVersion: app.getVersion(),
    platform: `${process.platform} ${release()}`,
    requestIds: recentFailedRequestIds,
    send: sendFeedback,
    log,
    fail,
  });
  ipcMain.handle(PARROT_IPC.sendFeedback, (_event, input: DesktopFeedbackInput) => sendFeedbackNow(input));
  // ACCT-PAIR-01/02: approve another device in main, where the token and the library key live.
  const pairing = createParrotPairingApprover({
    token: () => store.token(),
    libraryKey: () => store.libraryKey(),
    api: {
      lookup: lookupPairing,
      approve: (token, requestId, sealedKey, password, twoFactorCode) =>
        approvePairing(token, requestId, sealedKey, undefined, password, twoFactorCode),
      deny: denyPairing,
    },
    log,
  });
  ipcMain.handle(PARROT_IPC.lookupPairing, (_event, code: string) => pairing.lookup(code));
  ipcMain.handle(PARROT_IPC.approvePairing, (_event, requestId: string, proof: unknown) => pairing.approve(requestId, proof));
  ipcMain.handle(PARROT_IPC.denyPairing, (_event, requestId: string) => pairing.deny(requestId));
};

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 780,
    // The shared top bar shows its actions from 768 px up (PAR-LOOK-01); below that they would vanish. Under 1280 px
    // Refresh, Plan, Pair a device and Send feedback shrink to icons, so the bar fits 800 px in every language (PAR-LOOK-04),
    // like Badger desktop, and a half-screen window on a 1366 or 1440 px laptop still works.
    minWidth: 800,
    minHeight: 560,
    title: "Parrot",
    backgroundColor: "#141726",
    show: !process.argv.includes("--hidden"),
    icon: appIconPath(),
    webPreferences: {
      preload: join(mainOutDir, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // `window.open` (Stancer's hosted payment page, ACCT-PAY-01) goes to the system browser, never an app window;
  // only https pages and mailto links are handed to the OS.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    else log("[window] refused to open a non-https page");
    return { action: "deny" };
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  // PAR-PL-05: Windows' log-off and shutdown skip `before-quit`; with edits still being saved, the session waits for
  // them (Windows lists Parrot as still closing) and Parrot quits once they are saved.
  mainWindow.on("query-session-end", (event) => quitGuard.sessionEnding(event, "Windows session end"));
  appTray.create(
    resolveTrayIconPath({
      trayIcon: getDesktopPlatform().shell.trayIcon,
      appIconPath: appIconPath(),
      templateCandidates: [
        join(process.resourcesPath ?? sourceInstallerDir, "trayTemplate.png"),
        join(sourceInstallerDir, "trayTemplate.png"),
      ],
      exists: existsSync,
    }),
  );
  // Hidden, not destroyed: the music plays in this window's renderer (PAR-PLAY-03).
  attachCloseToTray(mainWindow, { background: "hide", isQuitting: () => isQuitting, hasTray: () => appTray.active });
  mainWindow.webContents.on("console-message", (details) => {
    const line = rendererConsoleLine(details.level, details.message);
    if (!line) return;
    log(line);
    errorLog.record(details.level === "error" ? "error" : "warn", "renderer", details.message);
  });
  installApplicationMenu();
  if (process.env.ELECTRON_RENDERER_URL) {
    attachDevShortcuts(mainWindow.webContents);
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else void mainWindow.loadFile(join(mainOutDir, "../renderer/index.html"));
};

app.on("second-instance", (_event, argv) => {
  if (siblingHiddenStart) {
    // ACCT-PAIR-07: this run has no window (it only answers Badger): the user's launch gets a full Parrot.
    log("[sibling] Parrot launched during a hidden start: relaunching in full");
    app.relaunch({ args: argv.slice(1).filter((arg) => arg !== SIBLING_SIGN_IN_ARG) });
    app.exit(0);
    return;
  }
  // Badger started Parrot to answer it while this one runs: this one already answers on the local channel.
  if (isSiblingSignInLaunch(argv)) return log("[sibling] hidden start while Parrot runs: ignored");
  const providerReturn = findProviderReturn("parrot", argv);
  if (providerReturn !== null) return receiveProviderReturn(providerReturn, "second-instance");
  const paymentId = findPaymentReturn("parrot", argv);
  if (paymentId !== null) return receivePaymentReturn(paymentId, "second-instance");
  showMainWindow();
});

// PAR-PL-05: a quit with edits still being saved (the window already shows them) waits for them, up to
// QUIT_SAVE_TIMEOUT_MS, then quits; `onQuit` is the usual cleanup, run by the quit that goes through.
const quitGuard = createQuitGuard({
  app,
  writes: [
    { name: "library", chain: librarySaves },
    // `store` opens once the app is ready: nothing is queued before.
    { name: "settings", chain: { pending: () => store?.writes.pending() ?? 0, idle: () => store?.writes.idle() ?? Promise.resolve() } },
  ],
  timeoutMs: QUIT_SAVE_TIMEOUT_MS,
  onWait: () => {
    isQuitting = true;
    appTray.destroy();
    // Background lookups give up: what they did not publish is looked up again at the next launch.
    autoLyricsStop?.abort();
    autoArtistPicturesStop?.abort();
    retryUnidentifiedStop?.abort();
    // The app looks gone at once; the music plays in the window (PAR-PLAY-03), so it is muted too.
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.setAudioMuted(true);
      window.hide();
    }
  },
  onQuit: () => {
    isQuitting = true;
    appTray.destroy();
    importAbort.abort();
    exportJobs.pause();
    lightCopyAbort.abort();
    lightCopies.close();
    void streamSlots.release();
    void playback?.close();
  },
  log,
  fail,
});

app.on("before-quit", (event) => quitGuard.beforeQuit(event));

app.on("window-all-closed", () => {
  if (shouldQuitWhenAllWindowsClosed({ isQuitting, quitWhenAllWindowsClosed: getDesktopPlatform().shell.quitWhenAllWindowsClosed })) app.quit();
});

app.on("activate", () => {
  if (store) showMainWindow();
});

void app.whenReady().then(async () => {
  if (!primaryInstance) return;
  store = await openParrotStore({ dir: userDataDir, defaultSetup, log });
  if (siblingHiddenStart) {
    // ACCT-PAIR-07: started by Badger only to answer its sign-in: no window, no library, only the local channel.
    const account = parrotSiblingAccount(store);
    log(`[sibling] hidden start for Badger's sign-in ${JSON.stringify({ signedIn: Boolean(account) })}`);
    if (!account) return app.quit();
    siblingHiddenQuit = armSiblingHiddenQuit({ quit: () => app.quit(), log: (message) => log(`[sibling] ${message}`) });
    await siblingHost.setAccount(account);
    return;
  }
  // ACCT-PAIR-07: signed in, Badger on this computer can offer this account.
  publishSiblingAccount();
  reapplyStartAtLoginAtLaunch({ platform: process.platform, setup: store.setup, applyStartAtLogin, fail });
  keptFiles = await createParrotKeptFiles({ dir: offlineDir, token: () => store.token() ?? "", clientType: CLIENT_TYPE, appId: PARROT_APP_ID, log });
  keeping = await createDesktopKeeping({
    dir: offlineDir,
    files: keptFiles,
    library: () => library?.db ?? null,
    onChange: (status) => mainWindow?.webContents.send(PARROT_IPC.keptEvent, status),
    onKeptAny: (any) => {
      if (any && library) keepLibraryCopy(serializeParrotLibrary(library.db), library.version);
      if (!any) for (const name of ["library.sealed", "library.json"]) rmSync(join(offlineDir, name), { force: true });
    },
    log,
  });
  // PAR-PL-05: a Linux or macOS shutdown with edits still being saved is delayed until they are saved. On Linux,
  // Electron holds a logind "delay" inhibitor, so the hold ends at logind's InhibitDelayMaxSec (5 s by default), not
  // at QUIT_SAVE_TIMEOUT_MS. Electron passes the event though its types declare none.
  powerMonitor.on("shutdown", ((event: Electron.Event) => quitGuard.sessionEnding(event, "system shutdown")) as () => void);
  registerIpc();
  createWindow();
  updater.register(() => mainWindow);
  // REL-CD-29: the first "please update" refusal of any API call reaches the window, which then shows the update screen.
  onAppUpdateRequired((payload) => {
    log(`[parrot] app update required: ${payload.version} is below ${payload.minVersion}`);
    mainWindow?.webContents.send(PARROT_IPC.appUpdateRequiredEvent, payload);
  });
  updater.setAutoUpdate(store.autoUpdate);
  log(`[parrot] ready: setup ${store.setup.done ? "done" : `at ${store.setup.step}`}, signed in=${Boolean(store.user && store.token())}`);
  if (launchPaymentReturn) {
    const paymentId = launchPaymentReturn;
    launchPaymentReturn = null;
    log(`[billing] started by a payment return link: completing ${paymentId}`);
    void completePayment(paymentId);
  }
});
