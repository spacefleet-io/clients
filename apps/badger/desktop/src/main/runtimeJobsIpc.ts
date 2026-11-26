import type { RuntimeJobLike } from "./hiddenRuntimeJobs";
import { dialog, ipcMain } from "electron";
import type {
  RuntimeJobsAvailabilityResult,
  RuntimeJobsRetryResult,
} from "@space/runtime-contracts/runtime/jobs";
import { createRuntimeSession, type RuntimeSessionHandle } from "@space/runtime-client/session";
import { createRuntimeCommandClient } from "@space/runtime-client/command";
import {
  badgerIngestOpen,
  badgerIngestSubmitSources,
  badgerIngestConfigureScheduling,
  badgerMediaReplanQualities,
  type BadgerIngestSubmitSourceItemInput,
  type BadgerMediaReplanQualitiesPayload,
} from "@space/runtime-contracts/badger/ingest";
import { badgerStorageGc } from "@space/runtime-contracts/badger/storage";
import {
  badgerOfflineEstimateSize,
  badgerOfflineDownloadSubmit,
  badgerOfflineDeleteLocal,
  badgerOfflineListLocal,
  badgerOfflineReconcile,
} from "@space/runtime-contracts/badger/offline";
import {
  badgerExportEstimate,
  badgerExportSubmit,
  type BadgerExportEstimatePayload,
  type BadgerExportSubmitPayload,
} from "@space/runtime-contracts/badger/export";
import { isPickedExportFolder } from "./fileSystem";
import { mainUiStrings } from "./uiStrings";
import { VIDEO_EXTENSIONS } from "../shared/importableMedia";
import { applyFallbackCopyToFormats } from "../shared/transcodeDefault";
import { scopeLogger } from "./logger";
import { runtimeOwnerSecretProvider } from "./runtimeOwnerSecret";

const log = scopeLogger("runtime-jobs-ipc");

// Typed from the runtime contract so every field the renderer sets (skip
// markers, show skip cache, overrides, dedupe key) reaches the runtime. The
// old hand-written list lacked `skipMarkers`/`showSkipCache`, so the metadata service
// markers fetched at import were dropped here (PLAY-NEXT-02).
type SourceItem = BadgerIngestSubmitSourceItemInput;

let runtimeBaseUrl = "http://127.0.0.1:3020";
let backendToken: string | null = null;
let session: RuntimeSessionHandle | null = null;
let commandClient: ReturnType<typeof createRuntimeCommandClient> | null = null;
// Set by registerRuntimeJobsIpc: resolves once the guardian is not starting or restarting the runtime.
let waitForRuntime: () => Promise<void> = async () => {};

const ensureClient = async () => {
  if (!backendToken) throw new Error("RUNTIME_JOBS_AUTH_REQUIRED");
  // #928: the window opens before the runtime's first spawn finishes; a call
  // made meanwhile (attach-auth on a remembered session) waits instead of failing.
  await waitForRuntime();
  if (!backendToken) throw new Error("RUNTIME_JOBS_AUTH_REQUIRED");
  if (!session || !commandClient) {
    session = createRuntimeSession({
      runtimeBaseUrl,
      backendToken,
      apps: ["badger"],
      ownerSecret: runtimeOwnerSecretProvider,
    });
    commandClient = createRuntimeCommandClient({
      session,
      runtimeBaseUrl,
      requestIdPrefix: "desktop-runtime-jobs",
    });
  }
  return { session, commandClient };
};

class RuntimeJobsHttpError extends Error {
  status: number;
  errorCode: string | null;
  detail: string | null;
  constructor(status: number, errorCode: string | null, detail: string | null) {
    super(
      `runtime_jobs_http_${status}: ${errorCode ?? "unknown"}${detail ? ` — ${detail}` : ""}`,
    );
    this.name = "RuntimeJobsHttpError";
    this.status = status;
    this.errorCode = errorCode;
    this.detail = detail;
  }
}

// Single retry-on-401 budget. Mirrors `packages/runtime-client/src/command.ts`
// (line ~65) — when the runtime says the token is no longer recognised,
// invalidate the session client's cache and retry the request ONCE with a
// freshly-issued token. A second 401 in a row is a genuine auth failure and
// propagates as a `RuntimeJobsHttpError(401)`. This is the reactive half of
// the session-resilience pair; the proactive half is the `expiresAt`-aware
// cache in `@space/runtime-client/session` (commit pair to this one).
//
// Why this layer specifically: the desktop main process is the only place
// that knows when a runtime call fails authentication. The session client
// does not retry by itself because not every consumer wants to retry — but
// every runtime-jobs IPC handler does.
const httpFetch = async (
  path: string,
  init: RequestInit = {},
  attempt = 0,
): Promise<unknown> => {
  const { session: s } = await ensureClient();
  const token = await s.getToken();
  const url = `${runtimeBaseUrl.replace(/\/+$/, "")}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json",
    },
  });
  if (res.status === 401 && attempt === 0) {
    log.warn(
      { path, attempt },
      "runtime_jobs_http_401_invalidate_and_retry",
    );
    s.invalidate();
    return httpFetch(path, init, attempt + 1);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    };
    throw new RuntimeJobsHttpError(
      res.status,
      body.error ?? null,
      body.message ?? res.statusText ?? null,
    );
  }
  return res.json();
};

// Serialize runtime errors into a structured payload so the renderer
// can show actionable banners instead of treating them as empty state.
const toRendererError = (err: unknown) => {
  if (err instanceof RuntimeJobsHttpError) {
    return {
      __runtimeJobsError: true as const,
      status: err.status,
      errorCode: err.errorCode,
      message: err.detail,
    };
  }
  return {
    __runtimeJobsError: true as const,
    status: 0,
    errorCode: "runtime_jobs_unreachable",
    message: err instanceof Error ? err.message : String(err),
  };
};

export const setRuntimeJobsBackendToken = (token: string | null | undefined) => {
  const next = token?.trim() ?? null;
  if (next === backendToken) return;
  backendToken = next;
  if (!next) {
    session = null;
    commandClient = null;
    return;
  }
  if (session) session.setBackendToken(next);
  else {
    session = null;
    commandClient = null;
  }
};

/**
 * Read-only accessor for the cached backend bearer. Used by
 * `forwardKeyToRuntime` (apps/badger/desktop/src/main/index.ts) so its
 * runtime-session login carries the REAL bearer instead of the
 * `"desktop-key-forward"` placeholder. The placeholder was harmless when
 * `attachAuth` always ran first (the IngestUserState.config.token took
 * precedence in getActiveIngestToken), but after a runtime restart the
 * ingest-user entry is gone and the fallback would hand the placeholder
 * to the API — an inevitable 401. See plan
 * `all-newly-added-jobs-cuddly-cookie`, Fix 2b.
 */
export const getRuntimeJobsBackendToken = (): string | null => backendToken;

/** UX-NOTICE-06: the runtime's jobs for main's hidden-window watch; null when signed out or the runtime is down. */
export const listRuntimeJobsForMain = async (): Promise<RuntimeJobLike[] | null> => {
  if (!backendToken) return null;
  try {
    const snap = (await httpFetch("/runtime/jobs/v2/list", { method: "POST", body: JSON.stringify({ filter: {} }) })) as {
      jobs?: RuntimeJobLike[];
    } | null;
    return Array.isArray(snap?.jobs) ? snap.jobs : null;
  } catch (err) {
    log.debug({ error: String(err) }, "hidden_watch_list_failed");
    return null;
  }
};

export const registerRuntimeJobsIpc = (config: {
  runtimeBaseUrl: string;
  /** This computer's "fallback 360p copy" value (main/deviceSettings.ts). */
  getFallbackCopy: () => Promise<boolean>;
  /** Resolves when the runtime is not being started or restarted by the guardian (libraryDbRuntimeProxy). */
  waitForRuntime?: () => Promise<void>;
}) => {
  runtimeBaseUrl = config.runtimeBaseUrl;
  if (config.waitForRuntime) waitForRuntime = config.waitForRuntime;

  ipcMain.handle("sf-runtime-jobs-stream-url", async () => {
    const { session: s } = await ensureClient();
    const token = await s.getToken();
    const httpBase = runtimeBaseUrl.replace(/\/+$/, "");
    return {
      url: `${httpBase}/runtime/events/jobs/v2/stream?token=${encodeURIComponent(token)}`,
      httpBaseUrl: httpBase,
      token,
    };
  });

  ipcMain.handle(
    "sf-runtime-jobs-list",
    async (_event, payload: { filter?: { mediaId?: string; includeDismissed?: boolean } }) => {
      const filter = payload?.filter ?? {};
      try {
        return await httpFetch("/runtime/jobs/v2/list", {
          method: "POST",
          body: JSON.stringify({ filter }),
        });
      } catch (err) {
        log.warn({ error: String(err) }, "list_failed");
        return toRendererError(err);
      }
    }
  );

  ipcMain.handle(
    "sf-runtime-jobs-cancel",
    async (_event, payload: { jobId: string; reason?: string }) => {
      return httpFetch("/runtime/jobs/v2/cancel", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    }
  );

  ipcMain.handle(
    "sf-runtime-jobs-dismiss",
    async (_event, payload: { jobId: string }) => {
      return httpFetch("/runtime/jobs/v2/dismiss", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    }
  );

  // UX-JOBS-03: "Upload again" / "Process again". The renderer never sends a file path here: a moved
  // source is only re-pointed through `sf-runtime-jobs-find-file`, where main owns the picker.
  ipcMain.handle(
    "sf-runtime-jobs-retry",
    async (_event, payload: { jobId: string; mode?: "upload" | "process" }) => {
      const body = { jobId: payload.jobId, ...(payload.mode ? { mode: payload.mode } : {}) };
      log.info(body, "runtime_jobs_retry_requested");
      return httpFetch("/runtime/jobs/v2/retry", {
        method: "POST",
        body: JSON.stringify(body),
      });
    }
  );

  // UX-JOBS-03: which single action each failed job offers, from what is still on disk.
  ipcMain.handle(
    "sf-runtime-jobs-availability",
    async (_event, payload: { jobIds: string[] }) => {
      return httpFetch("/runtime/jobs/v2/availability", {
        method: "POST",
        body: JSON.stringify({ jobIds: payload.jobIds }),
      }) as Promise<RuntimeJobsAvailabilityResult>;
    }
  );

  // UX-JOBS-03 "Find the file": the source moved. The user picks it again; the runtime checks the
  // picked file is the same video (size + sampled hash) before processing it again from there.
  ipcMain.handle(
    "sf-runtime-jobs-find-file",
    async (_event, payload: { jobId: string }): Promise<RuntimeJobsRetryResult | { cancelled: true }> => {
      const videoExtensions = Array.from(VIDEO_EXTENSIONS).map((e) => e.replace(".", ""));
      const picked = await dialog.showOpenDialog({
        properties: ["openFile"],
        filters: [{ name: mainUiStrings().filterVideos, extensions: videoExtensions }],
      });
      const [path] = picked.filePaths;
      if (picked.canceled || !path) {
        log.info({ jobId: payload.jobId }, "runtime_jobs_find_file_cancelled");
        return { cancelled: true };
      }
      log.info({ jobId: payload.jobId, path }, "runtime_jobs_find_file_picked");
      return httpFetch("/runtime/jobs/v2/retry", {
        method: "POST",
        body: JSON.stringify({ jobId: payload.jobId, mode: "relocate", path }),
      }) as Promise<RuntimeJobsRetryResult>;
    }
  );

  ipcMain.handle(
    "sf-runtime-jobs-cancel-by-group",
    async (_event, payload: { groupId: string; reason?: string }) => {
      return httpFetch("/runtime/jobs/v2/cancel-by-group", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    }
  );

  // Forward the desktop-side backend bearer token into the runtime's badger
  // module. Without this, ingest steps (Extract, Upload) read
  // `getActiveIngestToken()` and find null because the runtime's IngestUserState
  // never received the token. Symptom: jobs fail at the Extracting step ~150ms
  // in with "BADGER_AUTH_NOT_READY: no backend token for userId=…".
  //
  // Re-uses the existing `badger.ingest.open` command which merges
  // `{ config: { token } }` into the per-user IngestUserState and sets it as
  // active. The renderer fires this whenever the auth token changes (login,
  // logout, refresh) — see auth.tsx.
  ipcMain.handle(
    "sf-badger-runtime-attach-auth",
    async (_event, payload: { userId: string; token: string }) => {
      // Ensure the local runtime-client session knows the new token before we
      // try to send a command — the renderer-side auth effect can race the
      // playback-IPC onAuthTokenChanged path that normally calls
      // setRuntimeJobsBackendToken.
      setRuntimeJobsBackendToken(payload.token);
      const { commandClient: c } = await ensureClient();
      const result = await c.sendCommand(badgerIngestOpen, {
        userId: payload.userId,
        config: { token: payload.token },
      });
      log.info(
        { userId: payload.userId, totalJobs: (result as { totalJobs?: number })?.totalJobs ?? null },
        "badger_runtime_attach_auth_ok",
      );
      return { ok: true } as const;
    },
  );

  // Storage GC bridge — exposes badger.storage.gc to the renderer so the
  // Account/Storage UI can offer a Recompute action (dry-run preview followed
  // by an opt-in real run). Routes through commandClient.sendCommand so the
  // typed Zod contract enforces payload + result shape end-to-end. See
  // packages/runtime-contracts/src/badger/storage.ts.
  ipcMain.handle(
    "sf-badger-storage-gc",
    async (_event, payload: { dryRun?: boolean } = {}) => {
      const { commandClient: c } = await ensureClient();
      try {
        return await c.sendCommand(badgerStorageGc, {
          dryRun: payload?.dryRun === true,
        });
      } catch (err) {
        log.warn({ error: String(err), dryRun: payload?.dryRun }, "badger_storage_gc_failed");
        throw err;
      }
    },
  );

  // Ingest concurrency bridge — binds the desktop `maxParallelTranscodes`
  // (engineV2 format lane) and `maxParallelExtractions` (engineV2 source lane)
  // settings to the live engine via the typed `configure_scheduling` contract.
  // The renderer fires this on app mount and on every change to either value.
  // Routes through commandClient.sendCommand so the Zod contract enforces the
  // 1..3 payload bounds end-to-end (no raw fetch).
  ipcMain.handle(
    "sf-runtime-jobs-configure-scheduling",
    async (
      _event,
      payload: { maxParallelTranscodes: number; maxParallelExtractions: number },
    ) => {
      const { commandClient: c } = await ensureClient();
      try {
        return await c.sendCommand(badgerIngestConfigureScheduling, {
          maxParallelTranscodes: payload.maxParallelTranscodes,
          maxParallelExtractions: payload.maxParallelExtractions,
        });
      } catch (err) {
        log.warn(
          {
            error: String(err),
            maxParallelTranscodes: payload?.maxParallelTranscodes,
            maxParallelExtractions: payload?.maxParallelExtractions,
          },
          "configure_scheduling_failed",
        );
        return toRendererError(err);
      }
    },
  );

  // Post-ingest re-plan bridge — exposes badger.media.replan_qualities so the
  // renderer can add/remove transcoded qualities on a committed media file.
  // Routes through commandClient.sendCommand so the typed Zod contract validates
  // payload + result end-to-end (no raw fetch). See
  // packages/runtime-contracts/src/badger/ingest.ts and the post-ingest-qualities
  // plan, Phase 4 and Phase 8.
  ipcMain.handle(
    "sf-badger-media-replan-qualities",
    async (_event, payload: BadgerMediaReplanQualitiesPayload) => {
      const { commandClient: c } = await ensureClient();
      try {
        return await c.sendCommand(badgerMediaReplanQualities, payload);
      } catch (err) {
        log.warn(
          {
            error: String(err),
            mediaId: payload?.mediaId,
            fileId: payload?.fileId,
            addCount: payload?.addQualities?.length ?? 0,
            removeCount: payload?.removeFormatIds?.length ?? 0,
          },
          "replan_qualities_failed",
        );
        return toRendererError(err);
      }
    },
  );

  ipcMain.handle(
    "sf-runtime-jobs-submit-sources",
    async (_event, payload: { userId: string; sources: SourceItem[] }) => {
      const { commandClient: c } = await ensureClient();
      // #25: the fallback 360p copy is decided per computer (device-settings.json),
      // whatever ladder the renderer sent. Explicit requests (replan) bypass this.
      const fallbackCopy = await config.getFallbackCopy();
      return c.sendCommand(badgerIngestSubmitSources, {
        userId: payload.userId,
        sources: payload.sources.map((s) => {
          const requested = s.desiredFormats ?? [];
          const desiredFormats = applyFallbackCopyToFormats(requested, fallbackCopy);
          log.info(
            { filename: s.filename, requested, desiredFormats, fallbackCopy },
            `[transcode-default] ingest ladder fallbackCopy=${fallbackCopy ? "on" : "off"}`,
          );
          log.info(
            {
              filename: s.filename,
              season: s.hints?.season ?? null,
              episode: s.hints?.episode ?? null,
              skipMarkers: s.skipMarkers === undefined ? "absent" : s.skipMarkers.length,
              showSkipCache: s.showSkipCache
                ? { showCatalogId: s.showSkipCache.showCatalogId, coverage: s.showSkipCache.coverage.length }
                : "absent",
            },
            "[skip-markers] forwarding import markers to runtime",
          );
          // Spread first: every contract field the renderer set is forwarded
          // (the zod schema strips anything unknown), then normalise.
          return {
            ...s,
            sizeMb: s.sizeMb ?? null,
            desiredFormats,
            // Bug #4 (audio language override dropped): without forwarding these
            // here, the runtime never sees the user's language picks even though
            // the renderer + contract are correct end-to-end. The override
            // arrays come from FileIngestionDialog → fileIngestionV2Translate;
            // we strip empty arrays to keep the wire payload minimal.
            audioOverrides: s.audioOverrides && s.audioOverrides.length > 0 ? s.audioOverrides : undefined,
            subtitleOverrides: s.subtitleOverrides && s.subtitleOverrides.length > 0 ? s.subtitleOverrides : undefined,
          };
        }),
      });
    }
  );

  // ---------------------------------------------------------------------
  // Export bridges ("Download everything", ACCT-EXPORT-01, OFFL-FILE-01):
  // the whole library as plain files into a folder the user picked. Only a
  // folder picked in `sf-pick-export-folder` is accepted.
  // ---------------------------------------------------------------------

  const exportFolderRefused = {
    __runtimeJobsError: true as const,
    status: 0,
    errorCode: "dest_not_picked",
    message: "The export folder was not picked in the folder dialog",
  };

  ipcMain.handle("sf-badger-export-estimate", async (_event, payload: BadgerExportEstimatePayload) => {
    if (!isPickedExportFolder(payload?.destDir)) return exportFolderRefused;
    const { commandClient: c } = await ensureClient();
    try {
      return await c.sendCommand(badgerExportEstimate, payload);
    } catch (err) {
      log.warn({ error: String(err), container: payload.container }, "badger_export_estimate_failed");
      return toRendererError(err);
    }
  });

  ipcMain.handle("sf-badger-export-submit", async (_event, payload: BadgerExportSubmitPayload) => {
    if (!isPickedExportFolder(payload?.destDir)) return exportFolderRefused;
    const { commandClient: c } = await ensureClient();
    try {
      return await c.sendCommand(badgerExportSubmit, payload);
    } catch (err) {
      log.warn({ error: String(err), container: payload.container }, "badger_export_submit_failed");
      return toRendererError(err);
    }
  });

  // ---------------------------------------------------------------------
  // Offline-mode bridges — exposes the badger.offline.* commands to the
  // renderer for save-to-disk / delete-from-local / list / reconcile.
  // Routes through commandClient.sendCommand so the typed Zod contracts
  // validate payload + result end-to-end (no raw fetch). See
  // packages/runtime-contracts/src/badger/offline.ts and the offline-mode
  // plan, Layer C (renderer UI).
  // ---------------------------------------------------------------------

  ipcMain.handle(
    "sf-badger-offline-estimate",
    async (
      _event,
      payload: {
        mediaIds: string[];
        quality?: string;
        container: "mkv" | "mp4";
        fileIds?: string[];
      },
    ) => {
      const { commandClient: c } = await ensureClient();
      try {
        return await c.sendCommand(badgerOfflineEstimateSize, payload);
      } catch (err) {
        log.warn(
          {
            error: String(err),
            mediaIds: payload?.mediaIds?.length ?? 0,
            fileIds: payload?.fileIds?.length ?? null,
            container: payload?.container,
          },
          "badger_offline_estimate_failed",
        );
        return toRendererError(err);
      }
    },
  );

  ipcMain.handle(
    "sf-badger-offline-download-submit",
    async (
      _event,
      payload: {
        mediaIds: string[];
        quality?: string;
        container: "mkv" | "mp4";
        skipAlreadyLocal?: boolean;
        fileIds?: string[];
      },
    ) => {
      const { commandClient: c } = await ensureClient();
      try {
        return await c.sendCommand(badgerOfflineDownloadSubmit, {
          ...payload,
          skipAlreadyLocal: payload.skipAlreadyLocal ?? true,
        });
      } catch (err) {
        log.warn(
          {
            error: String(err),
            mediaIds: payload?.mediaIds?.length ?? 0,
            fileIds: payload?.fileIds?.length ?? null,
            container: payload?.container,
          },
          "badger_offline_download_submit_failed",
        );
        return toRendererError(err);
      }
    },
  );

  ipcMain.handle(
    "sf-badger-offline-delete-local",
    async (
      _event,
      payload: {
        scope:
          | { type: "media"; mediaId: string }
          | { type: "season"; mediaId: string; seasonNumber: number }
          | { type: "file"; fileId: string };
      },
    ) => {
      const { commandClient: c } = await ensureClient();
      try {
        return await c.sendCommand(badgerOfflineDeleteLocal, payload);
      } catch (err) {
        log.warn(
          { error: String(err), scopeType: payload?.scope?.type },
          "badger_offline_delete_local_failed",
        );
        return toRendererError(err);
      }
    },
  );

  ipcMain.handle(
    "sf-badger-offline-list-local",
    async (_event, payload: { mediaIds?: string[] } = {}) => {
      const { commandClient: c } = await ensureClient();
      try {
        return await c.sendCommand(badgerOfflineListLocal, payload);
      } catch (err) {
        log.warn(
          { error: String(err), mediaIds: payload?.mediaIds?.length ?? null },
          "badger_offline_list_local_failed",
        );
        return toRendererError(err);
      }
    },
  );

  ipcMain.handle(
    "sf-badger-offline-reconcile",
    async (_event, payload: { mediaIds?: string[] } = {}) => {
      const { commandClient: c } = await ensureClient();
      try {
        return await c.sendCommand(badgerOfflineReconcile, payload);
      } catch (err) {
        log.warn(
          { error: String(err), mediaIds: payload?.mediaIds?.length ?? null },
          "badger_offline_reconcile_failed",
        );
        return toRendererError(err);
      }
    },
  );
};
