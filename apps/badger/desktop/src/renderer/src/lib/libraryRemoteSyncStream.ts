import { ApiError, getApiBaseUrl, getLibraryMeta, getMe, type LibraryMeta } from "@/api";
import { READ_OP_STREAM_VERSION } from "@space/library-db-definition/ops";
import type { LibraryDb } from "@/lib/libraryDb";
import { rendererLogger } from "@/logger";

const libraryRemoteSyncLog = rendererLogger.child({ scope: "library-remote-sync" });

export const LIBRARY_STREAM_HEARTBEAT_MS = 25_000;
export const LIBRARY_STREAM_STALE_MS = LIBRARY_STREAM_HEARTBEAT_MS * 3;
export const LIBRARY_STREAM_ERROR_WINDOW_MS = 60_000;
export const LIBRARY_STREAM_DISABLE_MS = 5 * 60_000;
export const LIBRARY_STREAM_FALLBACK_INTERVAL_MS = 30_000;
// One auth probe per outage is enough to distinguish "token revoked" from
// "network blip"; without this gate a flaky stream fires /auth/me on every
// reconnect attempt.
export const LIBRARY_STREAM_AUTH_PROBE_MIN_INTERVAL_MS = 30_000;

type MutableRef<T> = { current: T };

type LibraryRemoteSyncStreamOptions = {
  db: LibraryDb;
  token: string;
  streamRef: MutableRef<EventSource | null>;
  streamTimerRef: MutableRef<number | null>;
  fallbackTimerRef: MutableRef<number | null>;
  lastStreamEventRef: MutableRef<number>;
  streamHealthTimerRef: MutableRef<number | null>;
  externalMpvSessionActiveRef: MutableRef<boolean>;
  refreshSnapshot: (db: LibraryDb) => Promise<void>;
  syncClientConfigFromDb: (db: LibraryDb) => Promise<void>;
  handleForcedLogout: (reason: string) => Promise<void>;
  /**
   * HINT that the remote backend looks unreachable mid-session, fired from the
   * fallback poll's getLibraryMeta failure (a NON-401 rejection; the 401 path
   * keeps its existing forced-logout behaviour). This is the FAILED-OP signal
   * for the online → offline auto-switch: we already needed the backend here and
   * it was unreachable. It is only a HINT — a single failed poll is noisy (one
   * flaky request, a benign reconnect) — so the provider MUST confirm with its
   * own reachability probe (raced vs a timeout, classified by
   * isRemoteUnreachableError) before flipping into offline mode. The provider
   * owns the confirmation + the offline transition; the stream just surfaces the
   * failure it already observes here instead of silently swallowing it. Never
   * fired while an external mpv session is active (#25 M3-obs).
   */
  onBackendUnreachable?: (reason: string) => void;
  externalMpvSessionEvent: string;
  debugStream?: boolean;
};

/**
 * The meta as the sync call needs it: scalar version/hash fields only.
 * `syncFromRemoteIfNewer(meta)` is an IPC call that clones its argument
 * renderer → main → runtime, and the runtime reads nothing but the scalars
 * (version gate, stateHash, lastOpId, exists, syncUnavailable). The history
 * arrays grow with every op since the last snapshot — and an API that still
 * inlines op ciphertext into them (pre-#25) made each meta tens of MB — so
 * they never cross the process boundary.
 */
export const toSyncMeta = (meta: LibraryMeta): LibraryMeta => ({
  ...meta,
  opsHistory: [],
  snapshotHistory: [],
});

export const attachLibraryRemoteSyncStream = ({
  db,
  token,
  streamRef,
  streamTimerRef,
  fallbackTimerRef,
  lastStreamEventRef,
  streamHealthTimerRef,
  externalMpvSessionActiveRef,
  refreshSnapshot,
  syncClientConfigFromDb,
  handleForcedLogout,
  onBackendUnreachable,
  externalMpvSessionEvent,
  debugStream = false,
}: LibraryRemoteSyncStreamOptions) => {
  let closed = false;
  let syncRetryTimer: number | null = null;
  let syncRetryMeta: LibraryMeta | null = null;

  if (streamRef.current) {
    streamRef.current.close();
    streamRef.current = null;
  }
  if (streamTimerRef.current) {
    window.clearTimeout(streamTimerRef.current);
    streamTimerRef.current = null;
  }
  if (fallbackTimerRef.current) {
    window.clearInterval(fallbackTimerRef.current);
    fallbackTimerRef.current = null;
  }

  const markStreamEvent = () => {
    lastStreamEventRef.current = Date.now();
  };

  const isStreamStale = () => {
    if (!lastStreamEventRef.current) return true;
    return Date.now() - lastStreamEventRef.current > LIBRARY_STREAM_STALE_MS;
  };

  let lastStreamErrorLog = 0;
  let streamErrorCount = 0;
  let streamErrorWindowStart = 0;
  let streamDisabledUntil = 0;
  let streamDisabledForSession = false;
  let lastConnectStartedAt = 0;
  let quickFailureCount = 0;
  let lastAuthProbeAt = 0;

  const logStream = (label: string, payload?: Record<string, unknown>) => {
    if (!debugStream) return;
    libraryRemoteSyncLog.warn(payload ?? {}, label);
  };

  const logStreamError = (payload?: Record<string, unknown>) => {
    const now = Date.now();
    if (now - lastStreamErrorLog < 30_000) return;
    lastStreamErrorLog = now;
    if (debugStream) {
      libraryRemoteSyncLog.warn(payload ?? {}, "library.stream.error");
    }
  };

  const scheduleSyncRetry = (meta: LibraryMeta, reason: string) => {
    syncRetryMeta = meta;
    if (syncRetryTimer !== null) return;
    logStream("library.stream.sync.retry", { reason, version: meta.version });
    syncRetryTimer = window.setTimeout(() => {
      syncRetryTimer = null;
      if (closed) return;
      const targetMeta = syncRetryMeta;
      syncRetryMeta = null;
      getLibraryMeta(token)
        .then((freshMeta) => {
          const nextMeta = freshMeta ?? targetMeta;
          if (!nextMeta) return null;
          return db.syncFromRemoteIfNewer(toSyncMeta(nextMeta));
        })
        .then((changed) => {
          if (!changed) return;
          void refreshSnapshot(db);
          void syncClientConfigFromDb(db);
        })
        .catch(() => undefined);
    }, 10_000);
  };

  // #25 P11: SSE-driven syncs are single-flight. Every library version bump
  // pushes one meta; after a relaunch hundreds land while the runtime is still
  // busy opening the library, and each used to start its own
  // syncFromRemoteIfNewer + hasPendingSync round trip renderer → main →
  // runtime, each holding its meta in all three processes until the runtime
  // got to it (135 in flight for up to 62 s in the ultimate c070 relaunch;
  // lockstep ~2 GB growth per process). Now at most one runs; metas arriving
  // meanwhile collapse into the LATEST one (the server's current state — kept
  // even if its version went down, e.g. a library reset), synced once after.
  let streamSyncInFlight = false;
  let queuedStreamMeta: LibraryMeta | null = null;
  let coalescedStreamMetas = 0;

  const enqueueStreamSync = (meta: LibraryMeta) => {
    if (streamSyncInFlight) {
      queuedStreamMeta = meta;
      coalescedStreamMetas += 1;
      logStream("library.stream.sync.coalesced", {
        version: meta.version,
        queuedVersion: queuedStreamMeta.version,
        coalesced: coalescedStreamMetas,
      });
      return;
    }
    streamSyncInFlight = true;
    const localVersionPromise = db.getVersion().catch(() => null);
    const pendingPromise = db.hasPendingSync().catch(() => null);
    db.syncFromRemoteIfNewer(meta)
      .then((changed) => {
        if (changed) {
          logStream("library.stream.sync.changed", { version: meta.version });
          void refreshSnapshot(db);
          void syncClientConfigFromDb(db);
          return;
        }
        return Promise.all([pendingPromise, localVersionPromise]).then(([hasPending, localVersion]) => {
          logStream("library.stream.sync.no_change", {
            version: meta.version,
            localVersion,
            hasPending,
          });
          if (!hasPending) return;
          if (typeof localVersion === "number" && meta.version <= localVersion) return;
          scheduleSyncRetry(meta, "pending_sync");
        });
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error ?? "unknown");
        logStream("library.stream.sync.failed", { version: meta.version, message });
      })
      .finally(() => {
        streamSyncInFlight = false;
        const next = queuedStreamMeta;
        queuedStreamMeta = null;
        if (closed || !next) return;
        logStream("library.stream.sync.drain", { version: next.version, coalesced: coalescedStreamMetas });
        coalescedStreamMetas = 0;
        enqueueStreamSync(next);
      });
  };

  const connect = () => {
    if (closed) return;
    if (streamDisabledForSession) return;
    if (externalMpvSessionActiveRef.current) return;
    if (Date.now() < streamDisabledUntil) {
      const retryIn = Math.max(1000, streamDisabledUntil - Date.now());
      if (streamTimerRef.current) window.clearTimeout(streamTimerRef.current);
      streamTimerRef.current = window.setTimeout(connect, retryIn);
      return;
    }
    // LIB-FMT-13: EventSource sends no headers, so the stream states the op stream this build reads in its query.
    const url = `${getApiBaseUrl()}/library/db/stream?token=${encodeURIComponent(token)}&app=badger&opStream=${READ_OP_STREAM_VERSION}`; // op-stream: read
    logStream("library.stream.connect", { url });
    lastConnectStartedAt = Date.now();
    const es = new EventSource(url);
    streamRef.current = es;

    es.onmessage = (event) => {
      markStreamEvent();
      logStream("library.stream.message", { length: event.data?.length ?? 0 });
      const meta = (() => {
        try {
          return JSON.parse(event.data) as LibraryMeta;
        } catch {
          return null;
        }
      })();
      if (meta) {
        logStream("library.stream.meta", { version: meta.version, exists: meta.exists });
      }
      if (!meta || meta.exists === false) {
        if (meta?.exists === false) {
          logStream("library.stream.meta.exists_false", { version: meta.version });
        }
        return;
      }
      enqueueStreamSync(toSyncMeta(meta));
    };

    es.addEventListener("open", markStreamEvent);
    es.addEventListener("ping", markStreamEvent);

    es.onerror = () => {
      if (externalMpvSessionActiveRef.current) {
        es.close();
        streamRef.current = null;
        return;
      }
      logStreamError();
      es.close();
      if (closed) return;
      const now = Date.now();
      const livedMs = now - lastConnectStartedAt;
      if (livedMs < 15_000) {
        quickFailureCount += 1;
      } else {
        quickFailureCount = 0;
      }
      if (quickFailureCount >= 2) {
        streamDisabledForSession = true;
        streamRef.current = null;
        if (streamTimerRef.current) window.clearTimeout(streamTimerRef.current);
        streamTimerRef.current = null;
        return;
      }
      if (streamErrorWindowStart === 0 || now - streamErrorWindowStart > LIBRARY_STREAM_ERROR_WINDOW_MS) {
        streamErrorWindowStart = now;
        streamErrorCount = 1;
      } else {
        streamErrorCount += 1;
      }
      if (streamErrorCount >= 3) {
        streamDisabledUntil = now + LIBRARY_STREAM_DISABLE_MS;
        streamErrorCount = 0;
        streamErrorWindowStart = 0;
      }
      if (streamTimerRef.current) window.clearTimeout(streamTimerRef.current);
      streamTimerRef.current = window.setTimeout(connect, streamDisabledUntil > now ? streamDisabledUntil - now : 5000);
      if (!navigator.onLine) return;
      if (now - lastAuthProbeAt < LIBRARY_STREAM_AUTH_PROBE_MIN_INTERVAL_MS) return;
      lastAuthProbeAt = now;
      getMe(token)
        .catch((err) => {
          if (err instanceof ApiError && err.status === 401) {
            void handleForcedLogout("stream_error_401");
          }
        })
        .catch(() => undefined);
    };

    return es;
  };

  const handleExternalMpvSession = (event: Event) => {
    const active = Boolean((event as CustomEvent<{ active?: boolean }>).detail?.active);
    externalMpvSessionActiveRef.current = active;
    if (active) {
      streamRef.current?.close();
      streamRef.current = null;
      if (streamTimerRef.current) {
        window.clearTimeout(streamTimerRef.current);
        streamTimerRef.current = null;
      }
      return;
    }
    if (!closed && !streamRef.current) {
      connect();
    }
  };

  window.addEventListener(externalMpvSessionEvent, handleExternalMpvSession as EventListener);

  const es = connect();

  if (streamHealthTimerRef.current) {
    window.clearInterval(streamHealthTimerRef.current);
  }
  streamHealthTimerRef.current = window.setInterval(() => {
    if (closed) return;
    if (!streamRef.current) return;
    if (isStreamStale()) {
      streamRef.current.close();
      streamRef.current = null;
      if (streamTimerRef.current) window.clearTimeout(streamTimerRef.current);
      streamTimerRef.current = window.setTimeout(connect, 1000);
    }
  }, 10_000);

  const onlineHandler = () => {
    db.flushPending().catch(() => undefined);
  };
  window.addEventListener("online", onlineHandler);

  const fallbackInterval = window.setInterval(() => {
    if (streamRef.current && !isStreamStale()) return;
    getLibraryMeta(token)
      .then((meta) => {
        if (meta.exists === false) {
          logStream("library.stream.fallback.exists_false", { version: meta.version });
          return;
        }
        return db.syncFromRemoteIfNewer(toSyncMeta(meta)).then((changed) => {
          if (!changed) return;
          void refreshSnapshot(db);
          void syncClientConfigFromDb(db);
        });
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          void handleForcedLogout("fallback_401");
          return;
        }
        // Any NON-401 failure of the periodic meta poll means the backend looks
        // unreachable mid-session — this is the FAILED-OP signal. We do NOT
        // decide offline mode here (one failed poll is noisy); we hand the hint
        // to the provider, which confirms with its own raced probe before
        // flipping. Only fire while the OS link is up: a genuine OS-offline
        // state is owned by load()'s !online branch, not the offline-mode
        // banner. NOTE: this fallback poll runs every 30s whenever the SSE
        // stream is dead/stale — independent of user activity — so it doubles as
        // the IDLE HEARTBEAT (an idle user whose backend dies still gets a hint
        // within ~30s, with zero extra timers).
        // #25 M3-obs: no hint during an external mpv session. The stream is closed
        // then, so this poll runs every 30 s while the user watches; a confirmed
        // hint reload()s the provider, which closes the open library and unmounts
        // the playback controller under the playing mpv (x058: one slow meta cost
        // 20 s of library, 12 s of it after mpv exited). The first poll after the
        // session hints again if the backend is still unreachable.
        if (navigator.onLine && !externalMpvSessionActiveRef.current) {
          const message = err instanceof Error ? err.message : String(err ?? "unknown");
          logStream("library.stream.fallback.unreachable", { message });
          onBackendUnreachable?.("fallback_poll_failed");
        }
      });
  }, LIBRARY_STREAM_FALLBACK_INTERVAL_MS);
  fallbackTimerRef.current = fallbackInterval;

  return () => {
    closed = true;
    if (syncRetryTimer !== null) window.clearTimeout(syncRetryTimer);
    syncRetryTimer = null;
    syncRetryMeta = null;
    queuedStreamMeta = null;
    es?.close();
    streamRef.current = null;
    if (streamTimerRef.current) window.clearTimeout(streamTimerRef.current);
    streamTimerRef.current = null;
    if (streamHealthTimerRef.current) window.clearInterval(streamHealthTimerRef.current);
    streamHealthTimerRef.current = null;
    window.removeEventListener(externalMpvSessionEvent, handleExternalMpvSession as EventListener);
    window.removeEventListener("online", onlineHandler);
    if (fallbackTimerRef.current) window.clearInterval(fallbackTimerRef.current);
    fallbackTimerRef.current = null;
  };
};
