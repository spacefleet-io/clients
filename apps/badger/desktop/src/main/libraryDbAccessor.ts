/**
 * Unified library DB accessor that works in both direct-SQLite and
 * runtime-proxy modes. When the local DB is available (direct mode),
 * calls go directly. When using the runtime proxy, calls go through
 * the runtime via the validated runtime-client.
 */
import { getActiveLibraryDb, emitLibrarySnapshot } from "./libraryDbIpc";
import { badgerDbCall } from "@space/runtime-contracts/badger/db";
import { createRuntimeSession, type RuntimeSessionHandle } from "@space/runtime-client/session";
import { createRuntimeCommandClient } from "@space/runtime-client/command";
import { scopeLogger } from "./logger";
import { runtimeOwnerSecretProvider } from "./runtimeOwnerSecret";

const logger = scopeLogger("library-db-accessor");

const RUNTIME_BASE_URL = String(process.env.SF_RUNTIME_BASE_URL ?? "http://127.0.0.1:3020")
  .trim()
  .replace(/\/+$/, "");

let session: RuntimeSessionHandle | null = null;
let client: ReturnType<typeof createRuntimeCommandClient> | null = null;

export const setLibraryDbAccessorToken = (token: string | null) => {
  if (!token) {
    session?.reset();
    session = null;
    client = null;
    return;
  }
  if (session) {
    session.setBackendToken(token);
  } else {
    session = createRuntimeSession({
      runtimeBaseUrl: RUNTIME_BASE_URL,
      backendToken: token,
      apps: ["badger"],
      ownerSecret: runtimeOwnerSecretProvider,
    });
    client = createRuntimeCommandClient({
      session,
      runtimeBaseUrl: RUNTIME_BASE_URL,
      requestIdPrefix: "accessor",
    });
  }
};

/** Methods that modify library state and should trigger a snapshot refresh. */
const WRITE_METHODS = new Set([
  "setSyncEnabled", "clearPendingSync", "addMediaFromCatalog", "refreshShowEpisodes", "removeEpisodesNotInCatalog", "moveEpisodeToSlot", "updateMediaMetadata", "applyArtworkCopies", "replaceMediaTitleArt",
  "replaceMediaTrailers", "setSetting", "addMediaEdition", "linkFileToMedia", "markMediaPlayable", "deleteMediaFile",
  "setProgress", "addMediaFormat", "setMediaFormatChunks", "removeMediaFormat",
  "setMediaFileDesiredFormats", "addAudioTracksForFile", "addSubtitleTracksForFile",
  "addSubtitleTrack", "removeSubtitleTrack", "removeAudioTrack", "updateAudioTrack",
  "updateSubtitleTrack", "setDefaultAudioTrack", "setDefaultSubtitleTrack",
  "setTrackPrefs", "addAudioTrackWithChunks", "addSubtitleTrackWithObject",
  "addChaptersForFormat", "replaceSkipMarkers", "upsertSkipAnalysis",
  "purgeMissingObjects", "createPlaylist", "deletePlaylist", "addToPlaylist",
  "removeFromPlaylist", "deleteMedia", "wipeProfileViewing", "promoteProfileToMain", "healMainPromotion",
]);

// Methods whose snapshot push the user is waiting on synchronously and
// for which the 200ms emit throttle would create a perceptible lag.
// Today this is just `setProgress` (called from the mpv-exit listener
// after playback stops; the user navigates straight back to the title
// and expects to see their resume position). For these, force-flush
// the snapshot bypassing the trailing-edge throttle so the renderer
// observes the new state with sub-frame latency.
const FORCE_FLUSH_METHODS = new Set(["setProgress"]);

const callViaRuntime = async (method: string, args: unknown[] = []): Promise<unknown> => {
  if (!client) throw new Error("LIBRARY_DB_ACCESSOR_NO_TOKEN");
  const result = await client.sendCommand(badgerDbCall, { method, args });
  // After write methods, bring the renderer's snapshot up to date. This
  // mirrors the IPC handler in libraryDbRuntimeProxy.ts: the write's own
  // `badger.library.updated` frame normally delivers the change (#671: as a
  // delta fetch + merge), so this costs a version check, not a full snapshot
  // fetch (#25).
  if (WRITE_METHODS.has(method)) {
    const force = FORCE_FLUSH_METHODS.has(method);
    void import("./libraryDbRuntimeProxy")
      .then((mod) => mod.refreshAndEmitProxySnapshot({ force, reason: method }))
      .catch((error) => {
        logger.warn({
          event: "post_write_snapshot_refresh_failed",
          method,
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }
  return result;
};

/**
 * Call a library DB method. Uses direct SQLite if available, otherwise
 * delegates to the runtime service.
 */
export const callLibraryDb = async (method: string, ...args: unknown[]): Promise<unknown> => {
  const directDb = getActiveLibraryDb();
  if (directDb) {
    const fn = (directDb as unknown as Record<string, unknown>)[method];
    if (typeof fn !== "function") throw new Error(`UNKNOWN_METHOD:${method}`);
    return (fn as (...a: unknown[]) => unknown).apply(directDb, args);
  }
  return callViaRuntime(method, args);
};

/**
 * Get media details — optimized for the hot path used by finalization.
 */
export const getMediaDetails = async (mediaId: string): Promise<unknown> => {
  return callLibraryDb("getMediaDetails", mediaId);
};

/**
 * Emit a library snapshot update to the renderer.
 * In runtime proxy mode, the snapshot push is handled by the proxy's
 * WebSocket subscription, so this is a no-op.
 */
export const emitLibrarySnapshotSafe = () => {
  const directDb = getActiveLibraryDb();
  if (directDb) {
    emitLibrarySnapshot();
    return;
  }
  // Proxy mode: fetch fresh snapshot from runtime and emit to renderer.
  // Dynamic import to avoid circular dependency (libraryDbRuntimeProxy imports from this file).
  logger.info({ event: "emit_snapshot_safe_proxy_start" });
  void import("./libraryDbRuntimeProxy")
    .then((mod) => mod.refreshAndEmitProxySnapshot())
    .then(() => {
      logger.info({ event: "emit_snapshot_safe_proxy_success" });
    })
    .catch((error) => {
      logger.warn({
        event: "emit_snapshot_safe_proxy_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    });
};
