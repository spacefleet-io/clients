import { ipcMain } from "electron";
import { LibraryDb, type LibraryAccount } from "@space/library-db-runtime";
import { badgerLibraryUpsertSnapshot, badgerLibraryClear } from "@space/runtime-contracts/badger/library";
import { createRuntimeSession, type RuntimeSessionHandle } from "@space/runtime-client/session";
import { createRuntimeCommandClient } from "@space/runtime-client/command";
import * as sdk from "@space/sdk";
import { getApiBaseUrl } from "./apiHost";
import { BETTER_SQLITE_NATIVE_LOAD_GUIDANCE, isBetterSqliteNativeMismatchError } from "./nativeDeps";
import { scopeLogger } from "./logger";
import { runtimeOwnerSecretProvider } from "./runtimeOwnerSecret";
import { setActivePlaybackProfileId } from "./activePlaybackProfile";
import { parseActiveProfileArg, type ActiveProfileArg } from "./activeProfileArg";

type LibraryDbHandle = "default";

/** `userId`: the signed-in account, whose own library dir is opened (LIB-STORE-06). */
type OpenPayload = {
  token: string;
  keyBase64: string;
  userId?: string;
};
type LibraryOpener = (token: string, keyBase64: string, account: LibraryAccount) => Promise<LibraryDb>;

type CallPayload = {
  handle?: LibraryDbHandle;
  method: string;
  args?: unknown[];
};

type IpcCallNotReady = { __sfIpcError: "LIBRARY_DB_NOT_READY" };

let activeDb: LibraryDb | null = null;
let getWindow: (() => Electron.BrowserWindow | null) | null = null;
let datasetUnsubscribe: (() => void) | null = null;
let lastOpenError: { channel: string; message: string; at: number } | null = null;
let openInFlight: Promise<LibraryDb> | null = null;
let openQueue: Promise<void> = Promise.resolve();
let notReadyLogAt = 0;
let notReadySuppressed = 0;
let writeGuardIssueCache: { value: string | null; expiresAt: number } | null = null;
const logger = scopeLogger("library-db-ipc");
const CONTRACT_CACHE_TTL_MS = 30_000;
const RUNTIME_BASE_URL = String(process.env.SF_RUNTIME_BASE_URL ?? "http://127.0.0.1:3020")
  .trim()
  .replace(/\/+$/, "");
let currentBackendToken: string | null = null;
let runtimeSession: RuntimeSessionHandle | null = null;
let runtimeClient: ReturnType<typeof createRuntimeCommandClient> | null = null;
let runtimeMirrorInFlight: Promise<void> | null = null;
let runtimeMirrorDebounceTimer: NodeJS.Timeout | null = null;
const RUNTIME_MIRROR_DEBOUNCE_MS = 250;
const WRITE_METHODS = new Set([
  "setSyncEnabled",
  "clearPendingSync",
  "addMediaFromTmdb",
  "refreshShowEpisodes",
  "removeEpisodesNotOnTmdb",
  "moveEpisodeToSlot",
  "updateMediaMetadata",
  "applyArtworkCopies",
  "replaceMediaTitleArt",
  "replaceMediaTrailers",
  "setSetting",
  "addMediaEdition",
  "linkFileToMedia",
  "markMediaPlayable",
  "deleteMediaFile",
  "setProgress",
  "addMediaFormat",
  "setMediaFormatChunks",
  "removeMediaFormat",
  "setMediaFileDesiredFormats",
  "addAudioTracksForFile",
  "addSubtitleTracksForFile",
  "addSubtitleTrack",
  "removeSubtitleTrack",
  "removeAudioTrack",
  "updateAudioTrack",
  "updateSubtitleTrack",
  "setDefaultAudioTrack",
  "setDefaultSubtitleTrack",
  "setTrackPrefs",
  "addAudioTrackWithChunks",
  "addSubtitleTrackWithObject",
  "addChaptersForFormat",
  "replaceSkipMarkers",
  "upsertSkipAnalysis",
  "purgeMissingObjects",
  "createPlaylist",
  "deletePlaylist",
  "addToPlaylist",
  "removeFromPlaylist",
  "deleteMedia",
  "wipeProfileViewing",
  "promoteProfileToMain",
  "healMainPromotion",
  "listViewingProfileIds",
]);

const ensureRuntimeClient = (backendToken: string) => {
  if (runtimeSession) {
    runtimeSession.setBackendToken(backendToken);
  } else {
    runtimeSession = createRuntimeSession({
      runtimeBaseUrl: RUNTIME_BASE_URL,
      backendToken,
      apps: ["badger"],
      ownerSecret: runtimeOwnerSecretProvider,
    });
    runtimeClient = createRuntimeCommandClient({
      session: runtimeSession,
      runtimeBaseUrl: RUNTIME_BASE_URL,
      requestIdPrefix: "ipc",
    });
  }
  return runtimeClient!;
};

const buildSnapshotSummary = (db: LibraryDb) => {
  const version = db.getVersion();
  const { mediaCount, playlistCount } = db.getCountSummary();
  return {
    snapshotId: `desktop-${version}`,
    version,
    mediaCount,
    playlistCount,
    stateHash: null,
    updatedAt: new Date().toISOString(),
  };
};

// Coalesce bursts of writes into one mirror RPC. Previously every write
// (e.g. a single track-editor radio click triggers setDefaultSubtitleTrack
// + updates) synchronously called db.getSnapshot() — which walks the entire
// library with N+1 getMediaDetails — blocking the main process event loop
// for 5–10s and freezing renderer IPC. Now we (a) use cheap COUNT(*) helpers
// and (b) debounce the RPC, so a write burst yields at most one push.
const mirrorBadgerLibrarySnapshot = (db: LibraryDb, backendToken: string | null, reason: string) => {
  if (!backendToken) return;
  if (runtimeMirrorDebounceTimer) {
    clearTimeout(runtimeMirrorDebounceTimer);
  }
  runtimeMirrorDebounceTimer = setTimeout(() => {
    runtimeMirrorDebounceTimer = null;
    const runner = async () => {
      try {
        const client = ensureRuntimeClient(backendToken);
        const summary = buildSnapshotSummary(db);
        await client.sendCommand(badgerLibraryUpsertSnapshot, summary);
      } catch (error) {
        logger.warn({
          event: "runtime_badger_library_mirror_failed",
          reason,
          message: error instanceof Error ? error.message : String(error ?? "unknown_error"),
        });
      }
    };
    runtimeMirrorInFlight = (runtimeMirrorInFlight ?? Promise.resolve()).then(runner, runner);
    void runtimeMirrorInFlight;
  }, RUNTIME_MIRROR_DEBOUNCE_MS);
};

const resolveContractIssue = (payload: unknown): string | null => {
  const appContract = (payload as { apps?: { badger?: {
    supported?: boolean;
    migrationRequired?: boolean;
    migrationReason?: string | null;
  } } })?.apps?.badger;
  if (!appContract) return null;
  if (appContract.supported === false) {
    return appContract.migrationReason ?? "unsupported_app";
  }
  if (appContract.migrationRequired === true) {
    return appContract.migrationReason ?? "migration_required";
  }
  return null;
};

const getWriteGuardIssue = async () => {
  const now = Date.now();
  if (writeGuardIssueCache && writeGuardIssueCache.expiresAt > now) {
    return writeGuardIssueCache.value;
  }
  try {
    const payload = await sdk
      .unwrap(sdk.getSystemContract({ client: sdk.createSpaceClient({ baseUrl: getApiBaseUrl() }) }))
      .catch((error: unknown) => {
        throw error instanceof sdk.ApiError ? new Error(`contract_${error.status}`) : error;
      });
    const issue = resolveContractIssue(payload);
    writeGuardIssueCache = {
      value: issue,
      expiresAt: now + CONTRACT_CACHE_TTL_MS,
    };
    return issue;
  } catch (error) {
    logger.warn({
      event: "write_guard_contract_unavailable",
      message: error instanceof Error ? error.message : String(error ?? "unknown_error"),
    });
    writeGuardIssueCache = {
      value: null,
      expiresAt: now + Math.min(5_000, CONTRACT_CACHE_TTL_MS),
    };
    return null;
  }
};

const logNotReadyCall = (method: string) => {
  const now = Date.now();
  if (now - notReadyLogAt < 5000) {
    notReadySuppressed += 1;
    return;
  }
  const suppressed = notReadySuppressed;
  notReadySuppressed = 0;
  notReadyLogAt = now;
  const lastOpen =
    lastOpenError === null
      ? null
      : {
          channel: lastOpenError.channel,
          message: lastOpenError.message,
          ageMs: Math.max(0, now - lastOpenError.at),
        };
  logger.warn({
    event: "call_not_ready",
    method,
    suppressedCalls: suppressed,
    lastOpen,
  });
};

export const getActiveLibraryDb = () => activeDb;

export const resetLibraryDbIpcForTests = () => {
  activeDb?.close();
  activeDb = null;
  getWindow = null;
  datasetUnsubscribe?.();
  datasetUnsubscribe = null;
  lastOpenError = null;
  openInFlight = null;
  openQueue = Promise.resolve();
  notReadyLogAt = 0;
  notReadySuppressed = 0;
  writeGuardIssueCache = null;
  currentBackendToken = null;
  runtimeSession?.reset();
  runtimeSession = null;
  runtimeClient = null;
  runtimeMirrorInFlight = null;
  if (runtimeMirrorDebounceTimer) {
    clearTimeout(runtimeMirrorDebounceTimer);
    runtimeMirrorDebounceTimer = null;
  }
};

export const emitLibrarySnapshot = () => {
  const window = getWindow?.() ?? null;
  if (!window || !activeDb) return;
  try {
    const snapshot = activeDb.getSnapshot();
    window.webContents.send("sf-library-db-snapshot", snapshot);
  } catch {
    // Ignore snapshot errors to avoid breaking queue updates.
  }
};

export const registerLibraryDbIpc = (
  ipc: typeof ipcMain,
  windowProvider?: () => Electron.BrowserWindow | null
) => {
  // ACCT-SQUAD-02: the renderer's profile choice, kept across opens until sign-out (a library opens on main).
  let activeProfile: ActiveProfileArg | null = null;
  const subscribeDataset = (db: LibraryDb) => {
    datasetUnsubscribe?.();
    datasetUnsubscribe = db.onDatasetStatus((status) => {
      const window = getWindow?.() ?? null;
      if (!window) return;
      window.webContents.send("sf-library-db-dataset-status", status);
    });
  };

  const runOpen = async (
    channel: "sf-library-db-open" | "sf-library-db-open-local",
    opener: LibraryOpener,
    payload: OpenPayload
  ) => {
    const startedAt = Date.now();
    logger.info({
      event: "open_start",
      channel,
      hadActiveDb: Boolean(activeDb),
      keyLength: payload.keyBase64.length,
      hasUserId: Boolean(payload.userId?.trim()),
    });
    const previousDb = activeDb;
    const queued = openQueue.catch(() => undefined).then(async () => {
      try {
        const opened = await openWithNativeGuidance(opener, payload);
        if (activeProfile) opened.setActiveProfile(activeProfile);
        activeDb = opened;
        currentBackendToken = payload.token;
        previousDb?.close();
        subscribeDataset(opened);
        mirrorBadgerLibrarySnapshot(opened, currentBackendToken, "open");
        lastOpenError = null;
        logger.info({
          event: "open_success",
          channel,
          elapsedMs: Math.max(0, Date.now() - startedAt),
        });
        return opened;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error ?? "unknown_error");
        lastOpenError = { channel, message, at: Date.now() };
        logger.error({ event: "open_failed", channel, message });
        throw error;
      }
    });
    const inFlight = queued.then(() => {
      if (!activeDb) throw new Error("LIBRARY_DB_NOT_READY");
      return activeDb;
    });
    openInFlight = inFlight;
    void inFlight.catch(() => undefined);
    openQueue = queued.then(() => undefined, () => undefined);
    try {
      await queued;
      return { handle: "default" as LibraryDbHandle };
    } finally {
      if (openInFlight === inFlight) {
        openInFlight = null;
      }
    }
  };

  const openWithNativeGuidance = async (opener: LibraryOpener, payload: OpenPayload) => {
    const userId = payload.userId?.trim();
    // LIB-STORE-06: without the account there is no library dir to open; a shared dir would mix accounts.
    if (!userId) throw new Error("LIBRARY_USER_ID_MISSING: the library is opened for a signed-in account only");
    try {
      return await opener(payload.token, payload.keyBase64, { userId });
    } catch (error) {
      if (!isBetterSqliteNativeMismatchError(error)) {
        throw error;
      }
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "better-sqlite3 native binding failed to load"
      );
      throw new Error(BETTER_SQLITE_NATIVE_LOAD_GUIDANCE);
    }
  };

  getWindow = windowProvider ?? null;
  ipc.handle("sf-library-db-open", async (_event, payload: OpenPayload) =>
    runOpen("sf-library-db-open", LibraryDb.open, payload)
  );

  ipc.handle("sf-library-db-open-local", async (_event, payload: OpenPayload) =>
    runOpen("sf-library-db-open-local", LibraryDb.openLocal, payload)
  );

  ipc.handle("sf-library-db-get-local-cache-bytes", async (_event, keyBase64?: string) =>
    LibraryDb.getLocalCacheBytes(keyBase64)
  );

  ipc.handle("sf-library-db-has-local-cache", async () => LibraryDb.hasLocalCache());

  // UX-PROF-01: the picker may answer before the library opens; the choice is applied now or at the next open.
  ipc.handle("sf-library-db-set-active-profile", async (_event, profile: unknown) => {
    const next = parseActiveProfileArg(profile);
    if (next === undefined) {
      logger.warn({ event: "active_profile_refused", arg: typeof profile === "object" ? profile : typeof profile });
      return { applied: false };
    }
    activeProfile = next;
    setActivePlaybackProfileId(activeProfile?.id ?? null);
    if (!activeDb) return { applied: false };
    activeDb.setActiveProfile(activeProfile);
    mirrorBadgerLibrarySnapshot(activeDb, currentBackendToken, "setActiveProfile");
    const window = getWindow?.() ?? null;
    if (window && !window.isDestroyed()) window.webContents.send("sf-library-db-snapshot", activeDb.getSnapshot());
    return { applied: true };
  });

  ipc.handle("sf-library-db-clear-local-cache", async () => {
    logger.info({ event: "clear_local_cache", hadActiveDb: Boolean(activeDb) });
    if (activeDb) {
      activeDb.close();
      activeDb = null;
    }
    activeProfile = null;
    setActivePlaybackProfileId(null);
    datasetUnsubscribe?.();
    datasetUnsubscribe = null;
    await LibraryDb.clearLocalCache();
    try {
      if (currentBackendToken) {
        const client = ensureRuntimeClient(currentBackendToken);
        await client.sendCommand(badgerLibraryClear, {});
      }
    } catch (error) {
      logger.warn({
        event: "runtime_badger_library_clear_failed",
        message: error instanceof Error ? error.message : String(error ?? "unknown_error"),
      });
    }
  });

  ipc.handle("sf-library-db-call", async (_event, payload: CallPayload) => {
    if (!activeDb) {
      if (openInFlight) {
        await openInFlight.catch(() => undefined);
      }
    }
    if (!activeDb) {
      logNotReadyCall(payload.method);
      return { __sfIpcError: "LIBRARY_DB_NOT_READY" } satisfies IpcCallNotReady;
    }
    const db = activeDb;
    const method = (db as unknown as Record<string, unknown>)[payload.method];
    if (typeof method !== "function") {
      throw new Error(`UNKNOWN_METHOD:${payload.method}`);
    }
    if (WRITE_METHODS.has(payload.method)) {
      const issue = await getWriteGuardIssue();
      if (issue) {
        throw new Error(`LIBRARY_WRITE_BLOCKED:${issue}`);
      }
    }
    const result = await (method as (...args: unknown[]) => unknown).apply(db, payload.args ?? []);
    if (WRITE_METHODS.has(payload.method)) {
      mirrorBadgerLibrarySnapshot(db, currentBackendToken, payload.method);
    }
    return result;
  });
};
