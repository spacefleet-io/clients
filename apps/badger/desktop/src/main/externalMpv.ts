import { app, ipcMain, nativeImage } from "electron";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { join } from "node:path";
import {
  buildExternalMpvArgs,
  buildExternalMpvEnv,
  buildExternalMpvTargetEnv,
  planExternalMpvLaunch,
  resolveExternalMpvTarget,
  capMpvStreamCacheSecs,
  resolveMpvStreamCacheSecs,
  resolveExternalMpvWindow,
} from "@space/mpv";
import type { StorageTrafficSnapshot } from "@space/shared/storageTunnel";
import { getDesktopPlatform } from "@space/desktop-platform";
import {
  buildLaunchTrackArgs,
  buildScriptMessageCommand,
  type LoadfileTrackSelection,
  LUA_OUTBOUND_CHANNELS,
  type MpvExternalMessage,
  type MpvProperty,
  type ScriptMessageCommand,
  type OscActionFile,
  type SubtitleEntry,
} from "@space/mpv-protocol";
import { isAppWindowMarkedHidden, markAppWindowVisibility } from "./appWindowVisibility";
import { shouldCreateWindowOnExternalMpvShow } from "./externalMpvWindow";
import { shouldForwardMpvMessage, shouldForwardScriptMessage } from "./externalMpvMessageRouting";
import { installE2eFrameDropInjector } from "./e2eFrameDropInjector";
import { scopeLogger } from "./logger";
import { cacheMpvBackdrop } from "./mpvBackdropCache";
import { createMpvExecWarmup } from "./mpvExecWarmup";
import { warmMpvBundleFontCache } from "./mpvFontCacheWarmup";
import { createMpvGpuMemoryStore, planMpvVo, prepareMpvGpuMemory, type MpvBinaryStamp } from "./mpvGpuMemory";
import {
  AUDIO_STALL_PROPERTIES,
  AUDIO_STALL_PTS_THROTTLE_MS,
  AUDIO_STALL_TICK_MS,
  createMpvAudioStallWatch,
  requestsNullAo,
} from "./mpvAudioStall";
import { createMpvRenderPathReporter, isProcessAlive, planMpvLaunchLogFile, sweepStaleMpvLaunchLogs } from "./mpvRenderPathLog";
import { UnixSocketMpvClient, initializeOscActionFile } from "./mpvSocketClient";
import { PendingOscActionSlot } from "./pendingOscAction";
import { waitForMpvWindowShown } from "./mpvWindowShown";
import {
  createMpvPreviewPictures,
  decodeSheetWithNativeImage,
  fetchSheetFromPlaybackServer,
  sweepStalePreviewDirs,
  type MpvPreviewPictures,
  type PreviewStatusAnswer,
} from "./mpvPreviewPictures";
import { TIME_POS_HIDDEN_EMIT_MS, TIME_POS_VISIBLE_EMIT_MS } from "./timePosEmitGate";

/**
 * Singleton holding the currently-active external mpv client. Replaces
 * the 8 module-globals previously held here (mpvProcess, mpvSocketPath,
 * mpvDataDir, oscActionFilePath, oscActionPollTimer, lastOscActionPayload,
 * activeLaunchId, requestSeq) — every per-launch piece of state now lives
 * inside the client instance. Rapid-relaunch protection becomes an
 * object-identity check (`if (currentClient !== thisClient) return`),
 * which is the OOP equivalent of the previous launchId comparison.
 */
let currentClient: UnixSocketMpvClient | null = null;
/** Properties mpv pushes to the renderer's PreloadMpvClient (Tier-4 push pipeline). */
const RENDERER_PUSH_PROPERTIES: readonly MpvProperty[] = ["time-pos", "duration", "pause", "mute", "volume", "eof-reached"];
// The newest launched client; a stop does not clear it, so the stopped
// client's final lifecycle pushes still reach the renderer (see
// shouldForwardMpvMessage).
let lifecycleOwner: UnixSocketMpvClient | null = null;
// Bumped per `sf-mpv-external-play` and per `sf-mpv-external-stop`. A launch
// awaiting its backdrop fetch must not start mpv once a newer launch came in
// (two mpv windows) or the user stopped (orphan window).
let playLaunchSeq = 0;

// Durable osc_action delivery (@bugfix next-episode-osc-action-dropped-on-
// listener-churn). The next_episode action sf.lua writes is delivered over an
// edge-triggered IPC; if the renderer's listener is detached when it arrives
// (a render-churn teardown window), it is lost and never retried. We retain
// the last action + a main-monotonic seq so a re-subscribing renderer can pull
// it via `sf-get-pending-osc-action` and replay it (deduped by seq). The slot
// is bound to the mpv client that produced the action (issue #25 P14): it is
// cleared when that client exits, on ack, or after the TTL, and an action
// from a stale client is never stored or returned.
const pendingOscAction = new PendingOscActionSlot<UnixSocketMpvClient>();

// Seek-bar preview pictures (MPV-PREV-01); its private temp dir is removed by disposeMpvPreviewPictures at app exit.
let previewPictures: MpvPreviewPictures | null = null;

export const disposeMpvPreviewPictures = () => {
  previewPictures?.disposeSync();
};

const logger = scopeLogger("mpv-external");

/**
 * Subtitle cache entry shape — unified with the wire-side
 * `subtitleEntrySchema` so the cache and the renderer-side payload are
 * the same type. `selected: true` is the field plumbed by commit
 * 7d42d8ff to fix the refresh-seek loop; sf.lua reads it and uses mpv's
 * "select" sub-add flag instead of "auto" so sid is fixed before the
 * first decoded frame.
 */
type SubtitleCacheEntry = SubtitleEntry;

const DEFAULT_SUBTITLE_CACHE_MAX_BYTES = 1024 * 1024 * 1024;

const resolveMpvBinary = () => resolveExternalMpvTarget();

const resolveSubtitleCacheDir = () => joinPath(app.getPath("userData"), "mpv", "subtitles");
const resolveSubtitleCacheMaxBytes = () => {
  const fromEnv = Number(process.env.SF_MPV_SUBTITLE_CACHE_MAX_BYTES);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  return DEFAULT_SUBTITLE_CACHE_MAX_BYTES;
};

const resolveSubtitleExtension = (format?: string | null) => {
  const value = (format ?? "").toLowerCase();
  if (!value) return "bin";
  if (value.includes("subrip") || value === "srt") return "srt";
  if (value.includes("webvtt") || value === "vtt") return "vtt";
  if (value.includes("ass")) return "ass";
  if (value.includes("ssa")) return "ssa";
  if (value.includes("pgs") || value.includes("sup") || value.includes("hdmv")) return "sup";
  if (value.includes("matroska") || value === "mkv") return "mkv";
  if (value.includes("vobsub") || value.includes("dvd_subtitle") || value === "sub") return "sub";
  if (value.includes("txt")) return "txt";
  return "bin";
};

/**
 * Build a stable cache key from the subtitle URL.
 *
 * Subtitle URLs are of the form `http://127.0.0.1:<runtimePort>/playback/object/<key>`.
 * The runtime port is chosen randomly on each runtime launch, so hashing the
 * raw URL forces the entire cache (up to ~1 GB for PGS-heavy releases) to be
 * re-fetched every session. We strip the origin and hash only the stable
 * `/playback/object/<key>` path so subtitles persist across runtime restarts.
 *
 * Falls back to the full URL for any input that doesn't match the expected
 * runtime shape (defensive — keeps externally-served subs working).
 */
export const stableSubtitleCacheKey = (url: string): string => {
  const idx = url.indexOf("/playback/object/");
  if (idx >= 0) {
    return url.slice(idx);
  }
  return url;
};

/** Downloads in flight, by cache file path: the launch's late fill and the subtitle effect ask for the same sidecar. */
const subtitleFetches = new Map<string, Promise<void>>();

const fetchSubtitleTo = async (entry: SubtitleCacheEntry, filePath: string) => {
  logger.info({ url: entry.url, format: entry.format, filePath, lang: entry.lang }, "sub-pipeline: fetching");
  const startedAt = Date.now();
  const response = await fetch(entry.url);
  const contentType = response.headers.get("content-type");
  const contentLength = response.headers.get("content-length");
  if (!response.ok) {
    logger.warn({ url: entry.url, status: response.status, contentType, contentLength }, "sub-pipeline: fetch failed");
    throw new Error(`subtitle_fetch_failed_${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(filePath, buffer);
  const preview = buffer.slice(0, 64).toString("utf8").replace(/[^\x20-\x7e]/g, ".");
  logger.info({
    url: entry.url,
    filePath,
    bytes: buffer.length,
    elapsedMs: Date.now() - startedAt,
    contentType,
    contentLength,
    preview,
  }, "sub-pipeline: cached");
};

/**
 * The sidecar's cached file path, downloading it first unless `cachedOnly` (then null when it is not on disk yet).
 * mpv only ever gets these paths at launch (PLAY-TRACK-07 interim): a raw proxy URL holds its picture while it reads.
 */
const cacheSubtitle = async (entry: SubtitleCacheEntry, cachedOnly: boolean) => {
  if (!entry.url) {
    throw new Error("subtitle_url_missing");
  }
  const cacheDir = resolveSubtitleCacheDir();
  await fs.mkdir(cacheDir, { recursive: true });
  const ext = resolveSubtitleExtension(entry.format);
  const hash = createHash("sha1").update(stableSubtitleCacheKey(entry.url)).digest("hex");
  const filePath = joinPath(cacheDir, `${hash}.${ext}`);
  if (!existsSync(filePath)) {
    if (cachedOnly) {
      logger.debug({ url: entry.url, filePath }, "sub-pipeline: not cached yet (cachedOnly)");
      return null;
    }
    let inFlight = subtitleFetches.get(filePath);
    if (inFlight) {
      logger.debug({ url: entry.url, filePath }, "sub-pipeline: joining download in flight");
    } else {
      inFlight = fetchSubtitleTo(entry, filePath).finally(() => subtitleFetches.delete(filePath));
      subtitleFetches.set(filePath, inFlight);
    }
    await inFlight;
  } else {
    const stat = await fs.stat(filePath).catch(() => null);
    logger.debug({ url: entry.url, filePath, bytes: stat?.size ?? null }, "sub-pipeline: cache hit");
  }
  return {
    url: filePath,
    title: entry.title ?? "",
    lang: entry.lang ?? "",
    selected: entry.selected ?? false,
  };
};

const clearSubtitleCache = async () => {
  const cacheDir = resolveSubtitleCacheDir();
  try {
    await fs.rm(cacheDir, { recursive: true, force: true });
  } catch {
    // Ignore cache cleanup errors.
  }
};

const pruneSubtitleCache = async (protectedPaths: Set<string>) => {
  const maxBytes = resolveSubtitleCacheMaxBytes();
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return;
  const cacheDir = resolveSubtitleCacheDir();
  let entries: Array<{ path: string; size: number; mtimeMs: number }> = [];
  try {
    const dirEntries = await fs.readdir(cacheDir, { withFileTypes: true });
    entries = await Promise.all(
      dirEntries
        .filter((entry) => entry.isFile())
        .map(async (entry) => {
          const filePath = joinPath(cacheDir, entry.name);
          const stats = await fs.stat(filePath);
          return { path: filePath, size: stats.size, mtimeMs: stats.mtimeMs };
        })
    );
  } catch {
    return;
  }
  let totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (totalBytes <= maxBytes) return;
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const entry of entries) {
    if (totalBytes <= maxBytes) break;
    if (protectedPaths.has(entry.path)) continue;
    try {
      await fs.unlink(entry.path);
      totalBytes -= entry.size;
    } catch {
      // ignore cleanup errors
    }
  }
};

const disposeCurrentClient = async (): Promise<void> => {
  const client = currentClient;
  if (!client) return;
  // Detach the singleton first so concurrent callers see "no current
  // client" while dispose completes.
  currentClient = null;
  await client.dispose();
};

/** True while the external mpv process is alive (a video is open): the "uploads while a video plays" signal (#25). */
export const isExternalMpvAlive = (): boolean => currentClient?.isAlive() ?? false;

export const stopExternalMpvProcess = (): void => {
  void disposeCurrentClient();
};

/**
 * E2E-only fault injection, gated on SF_E2E=1 (never reachable in production):
 * when `SF_E2E_STREAM_LOADFILE_OVERRIDE_URL` is set in the main process env,
 * every `loadfile` command's URL is rewritten to it. The backdrop-handoff e2e
 * points it at a 404 to prove a failed stream load closes mpv, shows the app
 * window and surfaces the playback error (issue #25,
 * @bugfix mpv-handoff-load-failure-black-idle-window). Read per call so the
 * test can set/clear it at runtime via `electronApp.evaluate`.
 */
const applyE2eLoadfileOverride = (command: unknown): unknown => {
  if (process.env.SF_E2E !== "1") return command;
  const overrideUrl = process.env.SF_E2E_STREAM_LOADFILE_OVERRIDE_URL?.trim();
  if (!overrideUrl) return command;
  if (!command || typeof command !== "object" || !("command" in command) || !Array.isArray(command.command)) {
    return command;
  }
  const [name, originalUrl, ...rest] = command.command;
  if (name !== "loadfile") return command;
  logger.warn({ originalUrl, overrideUrl }, "[e2e] rewriting loadfile url (SF_E2E_STREAM_LOADFILE_OVERRIDE_URL)");
  return { ...command, command: [name, overrideUrl, ...rest] };
};

export type ExternalMpvHooks = {
  /**
   * Mpv playback closed: the current mpv exited on its own (user closed it, playback ended)
   * or the renderer asked for a stop. NOT called for anything that keeps mpv open (loadfile
   * reload, quality switch, seek, pause, next episode into the same mpv) nor when a newer
   * launch superseded this mpv: that launch may already have prewarmed its chunks.
   */
  onPlaybackClosed?: (reason: "mpv_exit" | "renderer_stop") => void;
  /** The gateway's current traffic state (STOR-BW-01); omitted = always normal. */
  getTraffic?: () => StorageTrafficSnapshot;
  /** Subscribe to traffic state changes (STOR-BW-01); returns the unsubscribe. */
  onTrafficChange?: (listener: (snapshot: StorageTrafficSnapshot) => void) => () => void;
  /** Base URL of the local playback server (decrypts `/playback/object/<key>`); preview sheets are fetched there. */
  getPlaybackBaseUrl?: () => string | null;
  /** MPV-PREV-06: the runtime's `badger.previews.get_status` for a video with no preview record (null: not reachable). */
  getPreviewStatus?: (formatId: string) => Promise<PreviewStatusAnswer | null>;
  /**
   * PLAT-WEB-05: true while the current playback was started by the web player hand-off. The app window then stays
   * hidden when that mpv exits, is stopped or fails to start: the user returns to the browser, not to the desktop app.
   */
  isHandoffPlayback?: () => boolean;
  /** PLAT-WEB-05: `time-pos` / `duration` of the CURRENT mpv as mpv pushes them (the hand-off reports progress). */
  onPlaybackProperty?: (name: "time-pos" | "duration", value: unknown) => void;
  /** PLAT-WEB-05: a new mpv became the current playback (spawn about to start). */
  onPlaybackLaunched?: () => void;
};

export const registerExternalMpv = (
  ipc: typeof ipcMain,
  getWindow: () => Electron.BrowserWindow | null,
  ensureWindowVisible: () => void,
  hooks: ExternalMpvHooks = {}
) => {
  // STOR-BW-01: while the gateway reports high traffic mpv's readahead is capped to its
  // playbackBufferSeconds (never raised above the normal target), restored when normal.
  const highTrafficBufferSeconds = (): number | null => {
    const traffic = hooks.getTraffic?.();
    return traffic?.state === "high" ? traffic.playbackBufferSeconds : null;
  };
  // Null = defaults disabled: mpv gets no --cache-secs, so there is nothing to cap.
  const readaheadSecsNow = (): number | null =>
    process.env.SF_MPV_EXTERNAL_DISABLE_DEFAULTS === "1"
      ? null
      : capMpvStreamCacheSecs(resolveMpvStreamCacheSecs(), highTrafficBufferSeconds());
  hooks.onTrafficChange?.(() => {
    const secs = readaheadSecsNow();
    if (secs === null || currentClient === null) return;
    const client = currentClient;
    void client.setReadaheadSecs(secs).then(
      (ok) => logger.info({ secs, ok }, "mpv readahead follows the gateway traffic state"),
      (error: unknown) => logger.warn({ secs, error: error instanceof Error ? error.message : String(error) }, "mpv readahead change failed"),
    );
  });
  // Off the play path: build the bundled mpv's font cache now, so the first
  // play does not scan every system font before its first frame (#25 P5/B3).
  const mpvTarget = resolveMpvBinary();
  warmMpvBundleFontCache(mpvTarget);
  // The bundled mpv's first exec (Defender's scan of a new binary) runs in a worker thread, started
  // when playback becomes likely (sf-mpv-warm) and awaited by the launch, so its spawn never blocks main.
  const execWarmup = createMpvExecWarmup();
  // E2E-only (SF_E2E=1 + SF_E2E_INJECT_FRAME_DROPS): null in production.
  const frameDropInjector = installE2eFrameDropInjector();
  if (frameDropInjector) {
    logger.warn(frameDropInjector.state(), "[e2e] frame-drop injector installed (SF_E2E_INJECT_FRAME_DROPS)");
  }
  // MPV-PREV-01: the seekbar hover asks for a picture (sf-preview-hover), answered to the current mpv only.
  const sendToCurrentMpv = (command: ScriptMessageCommand) => {
    const client = currentClient;
    if (!client) return;
    void client.command(command).catch((error: unknown) => {
      logger.warn({ channel: command.command[1], error: error instanceof Error ? error.message : String(error) }, "preview script-message failed");
    });
  };
  const previews = createMpvPreviewPictures({
    fetchSheet: fetchSheetFromPlaybackServer(() => hooks.getPlaybackBaseUrl?.() ?? null),
    decodeSheet: decodeSheetWithNativeImage((jpeg) => nativeImage.createFromBuffer(jpeg)),
    sendSheets: (payload) => sendToCurrentMpv(buildScriptMessageCommand("sf-preview-sheets", payload)),
    previewStatus: async (formatId) => (hooks.getPreviewStatus ? hooks.getPreviewStatus(formatId) : null),
    sendPicture: (payload) => sendToCurrentMpv(buildScriptMessageCommand("sf-preview-picture", payload)),
    log: scopeLogger("mpv-previews"),
  });
  previewPictures = previews;
  // Off the play path too: this machine's GPU identity and whether its GPU vo
  // is remembered to fail, so a no-GPU machine skips the GPU probe (#25).
  const gpuMemory = prepareMpvGpuMemory({
    store: createMpvGpuMemoryStore({ filePath: join(app.getPath("userData"), "mpv-gpu-memory.json"), log: logger }),
    graphicsStack: () => getDesktopPlatform().hardware.graphicsStack(),
    mpvBinary: (): MpvBinaryStamp | null => {
      try {
        const stat = statSync(mpvTarget.bin);
        return { path: mpvTarget.bin, size: stat.size, mtimeMs: stat.mtimeMs };
      } catch {
        return null;
      }
    },
    session: `x11=${process.env.DISPLAY ?? ""} wayland=${process.env.WAYLAND_DISPLAY ?? ""}`,
    log: logger,
  });
  // A crashed or killed app left its transient mpv logs behind (#25).
  void sweepStaleMpvLaunchLogs({ tmp: tmpdir(), isAlive: isProcessAlive, log: logger });
  // Same for the seek-bar preview dirs (decrypted pictures, MPV-PREV-01).
  void sweepStalePreviewDirs({ tmp: tmpdir(), isAlive: isProcessAlive, log: scopeLogger("mpv-previews") });
  // The visibility mark is explicit here (not only via the BrowserWindow
  // hide/show events) so the playback handoff always tells the renderer to go
  // quiet, whatever the platform's event timing (issue #25 P19).
  const hideWindow = () => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    win.setSkipTaskbar(true);
    win.hide();
    markAppWindowVisibility(win, true, "external-mpv-hide");
  };

  const showWindow = () => {
    const win = getWindow();
    if (!win || shouldCreateWindowOnExternalMpvShow({
      hasWindow: Boolean(win),
      isDestroyed: Boolean(win?.isDestroyed()),
    })) {
      ensureWindowVisible();
      return;
    }
    win.setSkipTaskbar(false);
    win.show();
    markAppWindowVisibility(win, false, "external-mpv-show");
    win.focus();
  };

  // PLAT-WEB-05: after a playback ends or fails, the app window comes back, except for a web player hand-off.
  // `handoff` is read by the caller BEFORE onPlaybackClosed (which ends the hand-off).
  const showWindowAfterPlayback = (reason: string, handoff = hooks.isHandoffPlayback?.() === true) => {
    if (handoff) {
      logger.info({ reason }, "[handoff] playback of a web player hand-off ended: app window kept hidden");
      return;
    }
    showWindow();
  };

  ipc.handle("sf-app-hide", () => {
    hideWindow();
  });

  ipc.handle("sf-app-show", () => {
    showWindow();
  });

  // MPV-SHOW-01: the app window (and its loading state) stays up until mpv's
  // own window is on screen, then hides; the renderer's loading modal waits on
  // this handler.
  ipc.handle("sf-mpv-playback-ready", async () => {
    const client = currentClient;
    if (!client) {
      logger.info("playback ready signal received without a current mpv; hiding app window");
      hideWindow();
      return;
    }
    logger.info("playback ready signal received; waiting for mpv's window before hiding the app window");
    const shown = await waitForMpvWindowShown(client);
    if (currentClient !== client) {
      logger.info({ ...shown }, "[handoff] mpv was replaced or stopped while its window came up; app window left as is");
      return;
    }
    if (shown.via === "timeout" || shown.via === "exited") {
      logger.warn({ ...shown }, "[handoff] mpv's window never reported shown; hiding the app window anyway");
    } else {
      logger.info({ ...shown }, "[handoff] mpv's window is shown; hiding app window");
    }
    hideWindow();
  });

  // Durable osc_action recovery: a re-subscribing renderer pulls the last
  // pending action so one dropped in a listener teardown window (or fired
  // before the listener mounted) is replayed instead of lost. Returns null if
  // none, stale (> TTL) or owned by an mpv that is no longer the current one
  // (issue #25 P14). The renderer dedupes by seq and acks on handle.
  ipc.handle("sf-get-pending-osc-action", () => {
    const before = pendingOscAction.peek();
    const taken = pendingOscAction.take(currentClient);
    if (before && !taken) {
      logger.info({ seq: before.seq, ageMs: before.ageMs, hasCurrentClient: currentClient !== null }, "pending osc_action dropped on pull (stale or from a previous mpv)");
    }
    return taken;
  });

  ipc.on("sf-ack-osc-action", (_event, seq: number) => {
    pendingOscAction.ack(seq);
  });

  // E2E-only: seed a pending osc_action WITHOUT a live emit, simulating a
  // next_episode action that was dropped in a listener teardown window. Gated
  // on SF_E2E so it is never reachable in production. Drives the skip-markers
  // durable-recovery regression test.
  if (process.env.SF_E2E === "1") {
    ipc.handle("sf-e2e-set-pending-osc-action", (_event, action: OscActionFile) => {
      const seq = pendingOscAction.record(currentClient, currentClient, action);
      logger.info({ seq }, "[e2e] seeded pending osc_action (no live emit)");
      return seq;
    });
  }

  ipc.handle(
    "sf-mpv-external-play",
    async (
      _event,
      payload: {
        url: string;
        audioUrl?: string | null;
        backdropUrl?: string | null;
        startTime?: number | null;
        paused?: boolean;
        hlsBitrateBps?: number | null;
        audioTrack?: LoadfileTrackSelection | null;
        subtitleTrack?: LoadfileTrackSelection | null;
      }
    ) => {
      if (!payload?.url) {
        throw new Error("mpv_url_missing");
      }
      const handlerStartedAt = Date.now();
      const launchSeq = ++playLaunchSeq;
      await disposeCurrentClient();
      // A new mpv starts without previews until the renderer sends this video's record (sf-mpv-preview-sheets).
      previews.reset();
      const target = resolveMpvBinary();
      // Usually already done (sf-mpv-warm); otherwise it overlaps the launch preparation below.
      const execWarmupDone = execWarmup.warm(target);
      const bin = target.bin;
      const socketPath = getDesktopPlatform().mpvIpc.endpoint(`${process.pid}-${Date.now()}`);
      const appId = process.env.SF_MPV_APP_ID?.trim() || "spacebadger";
      // A Wayland-only session with an mpv that has no Wayland (the bundled one) cannot open any
      // window: mpv would exit at once and the play would fail with nothing said. Tell the user why.
      const mpvWindow = resolveExternalMpvWindow({ appId, target });
      if (mpvWindow.noWindow) {
        logger.error({
          bin,
          kind: target.kind,
          reason: mpvWindow.noWindow,
          DISPLAY: process.env.DISPLAY ?? null,
          WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY ?? null,
          XDG_SESSION_TYPE: process.env.XDG_SESSION_TYPE ?? null,
        }, "no mpv window can open in this session (no X display, mpv without Wayland): not launching");
        throw new Error(mpvWindow.noWindow);
      }
      const envResult = buildExternalMpvEnv({ appId });
      const dataDir = envResult.dataDir ?? null;
      // The bundle gets its lib dirs.
      const env = buildExternalMpvTargetEnv(target, envResult);
      const extra = process.env.SF_MPV_EXTERNAL_ARGS?.trim();
      const logFileEnv = process.env.SF_MPV_EXTERNAL_LOG_FILE?.trim();
      const debugEnabled = process.env.SF_MPV_DEBUG === "1" || process.env.VITE_DEBUG === "1";
      const isDev =
        process.env.NODE_ENV === "development" ||
        process.env.ELECTRON_IS_DEV === "1" ||
        Boolean(process.env.VITE_DEV_SERVER_URL);
      const shouldLog = debugEnabled || isDev || process.env.SF_MPV_EXTERNAL_LOG === "1" || Boolean(logFileEnv);
      const extraArgs: string[] = [];
      // Backdrop handoff: mpv shows the still while the stream loads, opened
      // from a local copy (the bundle has no https; the renderer sends the image as a
      // data URI). No usable copy → mpv opens idle (black) as before. #25 P5/B3.
      const backdropFile = payload.backdropUrl?.trim()
        ? await cacheMpvBackdrop(payload.backdropUrl, { dir: join(app.getPath("userData"), "mpv-backdrops") })
        : null;
      const launchPlan = planExternalMpvLaunch({
        url: payload.url,
        audioUrl: payload.audioUrl,
        backdropUrl: payload.backdropUrl,
        backdropFile,
        startTime: payload.startTime,
        paused: payload.paused,
      });
      const { backdropUsed, launchUrl } = launchPlan;
      // True while the launch file (the backdrop still) is what mpv plays:
      // its file-loaded / end-file are not the stream's (see the listeners).
      let backdropStillShowing = backdropUsed && launchUrl !== null;
      const oscActionFilePath = joinPath(tmpdir(), `sf-mpv-osc-action-${process.pid}-${Date.now()}.json`);
      initializeOscActionFile(oscActionFilePath);
      if (payload.hlsBitrateBps && payload.hlsBitrateBps > 0) {
        extraArgs.push(`--hls-bitrate=${payload.hlsBitrateBps}`);
      }
      // PLAY-TRACK-04: a launch on the stream itself opens on the per-load tracks (a backdrop launch carries them
      // on its handoff loadfile instead). @bugfix @regression-proof #2762
      if (!backdropUsed) extraArgs.push(...buildLaunchTrackArgs(payload));
      logger.info({
        backdropUsed,
        launchUrl,
        backdropFile,
        hasBackdrop: Boolean(payload.backdropUrl),
      }, !backdropUsed
        ? "direct launch on stream url"
        : backdropFile
          ? "backdrop handoff: launching mpv on the local backdrop still"
          : "backdrop handoff: no local backdrop copy; launching mpv idle");
      if (extra) {
        extraArgs.push(...extra.split(" ").filter(Boolean));
      }
      // sf.lua reads `sf-parent_pid` and quits mpv when this (Electron main)
      // process dies by any means. mpv is spawned detached so it is otherwise
      // orphaned by an app SIGKILL/crash (ultimate-stress finding F6).
      // `sf-parent_pidns` is this process's PID-namespace inode: a sandboxed
      // SF_MPV_SYSTEM_BIN (flatpak/bwrap/firejail) runs mpv in its own PID
      // namespace where our pid means nothing, so sf.lua compares namespaces
      // and disables the watchdog with a warning instead of quitting mpv at
      // start (issue #25, @bugfix sf-parent-watchdog-sandboxed-pid-namespace).
      const sfScriptOpts = [`sf-actions_file=${oscActionFilePath}`, `sf-parent_pid=${process.pid}`];
      const parentPidNs = getDesktopPlatform().processes.ownPidNamespace();
      if (parentPidNs) sfScriptOpts.push(`sf-parent_pidns=${parentPidNs}`);
      logger.info({ parentPid: process.pid, parentPidNs }, "parent-watchdog script-opts");
      const scriptOptsIndex = extraArgs.findIndex((arg) => arg.startsWith("--script-opts="));
      if (scriptOptsIndex >= 0) {
        const current = extraArgs[scriptOptsIndex].slice("--script-opts=".length).trim();
        const pieces = current ? current.split(",").filter(Boolean) : [];
        pieces.push(...sfScriptOpts);
        extraArgs[scriptOptsIndex] = `--script-opts=${pieces.join(",")}`;
      } else {
        extraArgs.push(`--script-opts=${sfScriptOpts.join(",")}`);
      }
      // Every launch logs to a file: the render-path line reads the GPU name from it (#25).
      const mpvLog = planMpvLaunchLogFile({ shouldLog, logFileEnv, tmp: tmpdir(), pid: process.pid, now: Date.now() });
      // A machine whose GPU vo is remembered to fail launches straight on the CPU vo (#25).
      const gpuSnapshot = gpuMemory.snapshot();
      const voPlan = planMpvVo({
        envVo: process.env.SF_MPV_EXTERNAL_VO,
        extraArgs: [...launchPlan.extraArgs, ...extraArgs],
        cpuVo: mpvWindow.cpuVo,
        snapshot: gpuSnapshot,
      });
      logger.info({ vo: voPlan.vo ?? null, identity: gpuSnapshot?.identity ?? null }, `mpv vo: ${voPlan.reason}`);
      const rememberIdentity = voPlan.rememberOutcome ? (gpuSnapshot?.identity ?? null) : null;
      const args = buildExternalMpvArgs({
        url: launchPlan.launchUrl,
        audioUrl: launchPlan.audioUrl,
        startTime: launchPlan.startTime,
        paused: launchPlan.paused,
        vo: voPlan.vo,
        hwdec: process.env.SF_MPV_EXTERNAL_HWDEC?.trim() ?? undefined,
        title: process.env.SF_MPV_EXTERNAL_TITLE?.trim() ?? undefined,
        extraArgs: launchPlan.extraArgs.length || extraArgs.length ? [...launchPlan.extraArgs, ...extraArgs] : undefined,
        disableDefaults: process.env.SF_MPV_EXTERNAL_DISABLE_DEFAULTS === "1",
        logFile: mpvLog.path,
        appId,
        playbackBufferSeconds: highTrafficBufferSeconds(),
        target,
      });
      args.unshift(`--input-ipc-server=${socketPath}`);
      const stdio = (process.env.SF_MPV_EXTERNAL_STDIO?.trim() ?? "ignore") as
        | "ignore"
        | "inherit"
        | "pipe";
      logger.info({
        bin,
        kind: target.kind,
        args,
        stdio,
        logFile: mpvLog.path,
        logFileKept: mpvLog.keep,
      }, "launch");
      const warmupWaitStartedAt = Date.now();
      await execWarmupDone;
      const warmupWaitMs = Date.now() - warmupWaitStartedAt;
      if (launchSeq !== playLaunchSeq) {
        logger.info({ launchSeq, newestLaunchSeq: playLaunchSeq }, "launch superseded by a newer play or a stop while preparing; not starting mpv");
        return { bin, args, backdropUsed };
      }

      const client = new UnixSocketMpvClient();
      // time-pos is pushed per frame; its IPC cadence follows the window: ~4 Hz
      // for the visible progress bar, 1 Hz while hidden (the renderer's hidden
      // poll rate). Issue #25.
      client.timePosEmitWindowMs = () => {
        const win = getWindow();
        return win && isAppWindowMarkedHidden(win) ? TIME_POS_HIDDEN_EMIT_MS : TIME_POS_VISIBLE_EMIT_MS;
      };
      // MPV-AUDIO-01: a frozen audio clock (output not taking sound) drops to
      // no sound and shows the OSC notice; MPV-AUDIO-02: so does a sound
      // output that could not be opened (mpv on its null output). Observed
      // once the socket is ready (below); the tick stops when this mpv exits.
      const audioStallLog = scopeLogger("mpv-audio-stall");
      const audioStall = createMpvAudioStallWatch({
        now: () => Date.now(),
        setAid: (value) => client.setProperty("aid", value),
        reloadAo: () => client.command({ command: ["ao-reload"] }),
        intentionalNullAo: requestsNullAo(args),
        notify: (payload) => {
          if (currentClient !== client) return;
          void client.command(buildScriptMessageCommand("sf-audio-stall", payload)).catch((error: unknown) => {
            audioStallLog.warn({ payload, error: error instanceof Error ? error.message : String(error) }, "sf-audio-stall script-message failed");
          });
        },
        log: audioStallLog,
      });
      let audioStallTimer: NodeJS.Timeout | null = null;
      // Multiplexed message channel: exit + osc_action + property_change all
      // flow over `sf-mpv-external-message` keyed by `type`. Tier-4 retired
      // the per-event channels; renderer code (preload `onMpvExternalMessage`)
      // dispatches by `type`. The helper closure captures `client` so the
      // currentClient identity check stays correct across rapid relaunches.
      const sendMpvExternalMessage = (message: MpvExternalMessage) => {
        if (!shouldForwardMpvMessage({ client, currentClient, lifecycleOwner, message })) return;
        const win = getWindow();
        if (!win || win.isDestroyed()) return;
        win.webContents.send("sf-mpv-external-message", message);
      };
      // OSC action events: forward the validated JSON to the renderer. The
      // client watches the action file, with a slow safety-net poll (sf.lua: write_next_episode_action
      // writes here, sf.lua:112+) — startOscActionPolling lives inside the
      // client now, exposed via this event-bus wiring.
      client.on("osc-action", (action) => {
        // Retain as the pending action (durable-delivery recovery) AND emit
        // live, both tagged with a fresh monotonic seq so the renderer can
        // dedupe a live delivery against a later pulled recovery. An action
        // from a client that is no longer current (killed / replaced mpv) is
        // dropped: it must never drive a later player (issue #25 P14).
        const seq = pendingOscAction.record(client, currentClient, action);
        if (seq === null) {
          logger.warn({ action, hasCurrentClient: currentClient !== null }, "osc_action from a stale mpv client dropped");
          return;
        }
        logger.info({ action, seq }, "osc_action forwarded to renderer");
        sendMpvExternalMessage({ type: "osc_action", action, seq });
      });
      // Tier-4 property-change push: the client subscribes to mpv's
      // observe_property events on its persistent event socket and emits
      // a typed event for each one. Forward those to the renderer so the
      // engine's PreloadMpvClient.observe() can dispatch to its
      // subscribers without polling.
      client.on("property-change", (event) => {
        // The audio-stall watch observes more (audio-pts per frame): only
        // the renderer's push properties cross the IPC.
        if (currentClient === client && (event.name === "time-pos" || event.name === "duration")) {
          hooks.onPlaybackProperty?.(event.name, event.value);
        }
        if (!RENDERER_PUSH_PROPERTIES.includes(event.name)) return;
        sendMpvExternalMessage({
          type: "property_change",
          name: event.name,
          value: event.value,
        });
      });
      // Tier-5 lifecycle state forwarding: every dispatchLifecycle()
      // call on the main-side client emits a "lifecycle" EventEmitter
      // event with the new state. Forward to the renderer over the
      // multiplexed message channel so PreloadMpvClient.subscribeLifecycle
      // (and useMpvLifecycleStore) can observe transitions without a
      // separate IPC channel.
      client.on("lifecycle", (state) => {
        sendMpvExternalMessage({ type: "lifecycle", state });
      });
      // Tier-6 Lua → renderer script-message bridge: mpv's IPC raises a
      // `client-message` event for every `mp.commandv("script-message",
      // name, ...args)` call made by a Lua script. The client surfaces
      // it as a typed `script-message` event with { name, args } (and logs
      // it once, at debug); we forward to the renderer over
      // `sf-mpv-external-message` as { type: "script_message", name, args }.
      // Consumers: the renderer's oscTrackPicks (`sf-track-picked`) and, in
      // E2E only, the skipPillObserver (`sf-pill-state`) — see
      // shouldForwardScriptMessage. No per-message log here: sf-pill-state
      // used to be logged twice per frame (#25 NEW-pill-state-flood).
      client.on("script-message", (event) => {
        if (event.name === LUA_OUTBOUND_CHANNELS.AUDIO_RETRY) {
          // MPV-AUDIO-01: "Retry with sound" on the frozen-audio notice.
          if (currentClient === client) audioStall.retry("user");
          return;
        }
        if (event.name === LUA_OUTBOUND_CHANNELS.PREVIEW_HOVER) {
          if (currentClient === client) previews.hover(Number(event.args[0]), Number(event.args[1]));
          return;
        }
        if (event.name === LUA_OUTBOUND_CHANNELS.PREVIEW_SHOWN) {
          if (currentClient === client) previews.shown(Number(event.args[0]));
          return;
        }
        if (!shouldForwardScriptMessage(event.name)) return;
        sendMpvExternalMessage({
          type: "script_message",
          name: event.name,
          args: event.args,
        });
      });
      // mpv end-file -> renderer. An idle-launched mpv (backdrop handoff)
      // stays up as a black idle window when the stream `loadfile` fails;
      // `end-file reason=error` is the signal the renderer acts on (close mpv,
      // show the window, surface the playback error). Issue #25,
      // @bugfix mpv-handoff-load-failure-black-idle-window.
      client.on("end-file", (event) => {
        if (backdropStillShowing) {
          // The launch file was the backdrop still: this end-file is the
          // still leaving (reason=stop on the renderer's loadfile replace, or
          // error for a bad cached image). It says nothing about the stream,
          // so it must not reach the handoff's load-failure watcher.
          backdropStillShowing = false;
          logger.info({ reason: event.reason, fileError: event.fileError, backdropFile }, "end-file: backdrop still ended (not forwarded)");
          if (event.reason === "error" && backdropFile) {
            void fs.rm(backdropFile, { force: true }).catch(() => {});
          }
          return;
        }
        logger.info({
          reason: event.reason,
          fileError: event.fileError,
          playlistEntryId: event.playlistEntryId,
          backdropUsed,
          isCurrent: currentClient === client,
        }, "end-file: forwarding to renderer");
        sendMpvExternalMessage({
          type: "end_file",
          reason: event.reason,
          fileError: event.fileError,
          playlistEntryId: event.playlistEntryId,
        });
      });
      // Logs the render path mpv settled on, once per file (MPV-GPU-02):
      // start-file re-arms it, each file's first playback-restart reports.
      const reportRenderPath = createMpvRenderPathReporter({
        send: (cmd) => client.request(cmd),
        log: logger,
        launchId: client.getLaunchId(),
        logFile: mpvLog.path,
        // Production's transient log exists only for the render-path line.
        closeLog: !mpvLog.keep,
        onRenderPath:
          rememberIdentity === null
            ? undefined
            : (renderClass, description) => void gpuMemory.store.recordOutcome(rememberIdentity, renderClass, description),
      });
      // mpv start-file -> renderer: the reload's marker that the events after
      // it belong to the new entry, not the file it replaces (issue #25 P15).
      client.on("start-file", (event) => {
        logger.info({ playlistEntryId: event.playlistEntryId, isCurrent: currentClient === client }, "start-file: forwarding to renderer");
        sendMpvExternalMessage({ type: "start_file", playlistEntryId: event.playlistEntryId });
        reportRenderPath.startFile();
      });
      // mpv file-loaded -> renderer: the backdrop handoff's load confirmation
      // when the `loadfile` reply timed out on a loaded PC (issue #25 P17).
      // The backdrop still's own file-loaded is not the stream's.
      client.on("file-loaded", () => {
        if (backdropStillShowing) {
          logger.info({ backdropFile }, "file-loaded: backdrop still on screen (not forwarded)");
          return;
        }
        logger.info({ backdropUsed, isCurrent: currentClient === client }, "file-loaded: forwarding to renderer");
        sendMpvExternalMessage({ type: "file_loaded" });
      });
      // mpv's first playback-restart of the stream -> renderer: the ABR
      // first-frame clock (issue #25 N4). The backdrop still's is not it.
      // Each file's first one also logs the render path mpv settled on.
      client.on("first-playback-restart", () => {
        if (backdropStillShowing) {
          logger.info({ backdropFile }, "first playback-restart: backdrop still on screen (not forwarded)");
          return;
        }
        logger.info({ isCurrent: currentClient === client }, "first playback-restart: forwarding to renderer");
        sendMpvExternalMessage({ type: "playback_restart" });
        void reportRenderPath();
      });
      client.on("spawn-error", (error) => {
        logger.warn({ error: error instanceof Error ? error.message : String(error) }, "spawn failed");
        if (currentClient === client) {
          showWindowAfterPlayback("spawn_error");
        }
      });
      client.on("exit", () => {
        if (audioStallTimer) clearInterval(audioStallTimer);
        audioStallTimer = null;
        if (!mpvLog.keep) {
          void fs.rm(mpvLog.path, { force: true }).catch((error: unknown) => {
            logger.warn({ logFile: mpvLog.path, error: error instanceof Error ? error.message : String(error) }, "transient mpv log not removed");
          });
        }
        if (pendingOscAction.clearOwner(client)) {
          logger.info("mpv exited: pending osc_action of this instance cleared");
        }
        if (currentClient !== client) return;
        currentClient = null;
        previews.reset();
        const handoff = hooks.isHandoffPlayback?.() === true;
        hooks.onPlaybackClosed?.("mpv_exit");
        const win = getWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send("sf-mpv-external-message", { type: "exit" } satisfies MpvExternalMessage);
        }
        showWindowAfterPlayback("mpv_exit", handoff);
      });

      // Promote to current BEFORE start so the rapid-relaunch invariant
      // (a second launch coming in while this one is still booting) takes
      // effect: the second launch's `await disposeCurrentClient()` will
      // tear THIS one down before kicking off its own.
      currentClient = client;
      lifecycleOwner = client;
      hooks.onPlaybackLaunched?.();
      // Handler entry → spawn (prepareMs) and spawn → IPC socket ready (startMs): the main-process part of
      // the click → first frame timeline, logged by the renderer with its own stages (#928).
      const prepareMs = Date.now() - handlerStartedAt;
      let startMs: number | null = null;
      try {
        const startCalledAt = Date.now();
        const { socketReady, failure } = await client.start({
          bin,
          args,
          env,
          socketPath,
          dataDir,
          oscActionFilePath,
          stdio,
          // Restored after a first-GOP resume's short prefill (#25
          // playable-start); disabled defaults pass no --cache-secs at all.
          readaheadSecs: readaheadSecsNow(),
        });
        startMs = Date.now() - startCalledAt;
        if (currentClient !== client) {
          // A newer launch superseded this one between start() and here.
          await client.dispose();
          return { bin, args, backdropUsed };
        }
        if (!socketReady) {
          logger.warn({ failure }, "mpv IPC socket never became ready");
          showWindowAfterPlayback("socket_not_ready");
        } else {
          // Tier-4 push-property pipeline: after the socket is up, ask mpv
          // to push property-change events for the push-friendly
          // properties. Without this call, mpv never receives an
          // observe_property request and the renderer-side
          // PreloadMpvClient.observe() listens to a channel that never
          // fires — making the entire Tier-4 push pipeline dead code.
          // The local callback is a no-op because the "property-change"
          // EventEmitter listener wired above forwards the event to the
          // renderer via `sf-mpv-external-message`. The observe() call
          // exists purely to register interest with mpv.
          for (const property of RENDERER_PUSH_PROPERTIES) {
            client.observe(property, () => {
              /* fan-out happens via emitter "property-change" → renderer */
            });
          }
          // MPV-AUDIO-01: the frozen-audio watch reads these in the main
          // process only (the forwarder above drops the ones the renderer
          // does not take). audio-pts and time-pos move per frame: throttled.
          for (const property of AUDIO_STALL_PROPERTIES) {
            client.observe(property, (value) => audioStall.onProperty(property, value), {
              throttleMs: property === "audio-pts" || property === "time-pos" ? AUDIO_STALL_PTS_THROTTLE_MS : 0,
            });
          }
          audioStallTimer = setInterval(() => {
            if (currentClient !== client) {
              if (audioStallTimer) clearInterval(audioStallTimer);
              audioStallTimer = null;
              return;
            }
            audioStall.tick();
          }, AUDIO_STALL_TICK_MS);
          audioStallTimer.unref();
          if (backdropStillShowing) {
            // The still can fail before the event socket connected (its
            // end-file lost); mpv then sits idle and the stream's events must
            // be forwarded. Nothing else ends the still before the renderer's
            // swap, which only starts after this handler returns.
            const idleActive = await client.getProperty("idle-active").catch(() => null);
            logger.info({ idleActive, backdropFile }, "backdrop still: post-connect idle-active check");
            if (idleActive === true) backdropStillShowing = false;
          }
        }
      } catch (error) {
        if (currentClient === client) {
          currentClient = null;
        }
        showWindowAfterPlayback("launch_failed");
        throw error;
      }
      // Note: we no longer hide the app window here — that happens only when
      // the renderer signals "playback ready" via sf-mpv-playback-ready, so the
      // loading modal stays visible until mpv is fully ready (tracks + metadata
      // + first frame). Socket-failure recovery still shows the window.
      return { bin, args, backdropUsed, timings: { prepareMs, warmupWaitMs, startMs } };
    }
  );
  // One answer per entry, in order; `url` "" = not on disk. Never the raw proxy URL (PLAY-TRACK-07 interim).
  ipc.handle(
    "sf-mpv-cache-subtitles",
    async (_event, entries: SubtitleCacheEntry[], options?: { cachedOnly?: boolean }) => {
      if (!Array.isArray(entries)) return [];
      const cachedOnly = options?.cachedOnly === true;
      const results = await Promise.all(
        entries.map(async (entry) => {
          const miss = {
            url: "",
            title: entry?.title ?? "",
            lang: entry?.lang ?? "",
            selected: entry?.selected ?? false,
          };
          try {
            return (await cacheSubtitle(entry, cachedOnly)) ?? miss;
          } catch (error) {
            logger.warn({
              url: entry?.url,
              error: error instanceof Error ? error.message : "subtitle_cache_failed",
            }, "subtitle cache failed");
            return miss;
          }
        })
      );
      const protectedPaths = new Set(results.map((entry) => entry.url).filter((url) => url && existsSync(url)));
      await pruneSubtitleCache(protectedPaths);
      return results;
    }
  );
  ipc.handle("sf-mpv-clear-subtitle-cache", async () => {
    await clearSubtitleCache();
    return { ok: true };
  });
  ipc.handle("sf-mpv-external-request", async (_event, command: unknown) => {
    const client = currentClient;
    if (!client) return { error: "mpv_socket_missing" };
    try {
      const reply = await client.request(command as Parameters<UnixSocketMpvClient["request"]>[0]);
      return frameDropInjector ? await frameDropInjector.apply(command, reply, client) : reply;
    } catch (error) {
      return { error: error instanceof Error ? error.message : "mpv_request_failed" };
    }
  });
  ipc.handle("sf-mpv-external-command", async (_event, command: unknown) => {
    const client = currentClient;
    if (!client) return { error: "mpv_socket_missing" };
    try {
      return await client.command(
        applyE2eLoadfileOverride(command) as Parameters<UnixSocketMpvClient["command"]>[0],
      );
    } catch (error) {
      return { error: error instanceof Error ? error.message : "mpv_command_failed" };
    }
  });
  ipc.handle("sf-mpv-external-stop", () => {
    logger.warn({ hadClient: Boolean(currentClient) }, "renderer requested external mpv stop; disposing mpv and showing app window");
    // Also cancels a launch still awaiting its backdrop fetch: it has no
    // client to dispose yet and would otherwise spawn mpv after the stop.
    playLaunchSeq += 1;
    void disposeCurrentClient();
    previews.reset();
    const handoff = hooks.isHandoffPlayback?.() === true;
    hooks.onPlaybackClosed?.("renderer_stop");
    showWindowAfterPlayback("renderer_stop", handoff);
  });

  // MPV-PREV-01: the playing video's preview record (source format's `previewSheets`, null when it has none). Sent by
  // the renderer after every launch / loadfile; tells the OSC whether the seekbar shows pictures. MPV-PREV-06: with no
  // record, `missing` {formatId, hint} lets the OSC say "Previews are being prepared" while they are still to come.
  ipc.handle("sf-mpv-preview-sheets", (_event, previewSheets: unknown, missing?: unknown) => {
    const m = (missing ?? {}) as { formatId?: unknown; hint?: unknown };
    previews.setPreviews(
      previewSheets,
      typeof m.hint === "string" ? { formatId: typeof m.formatId === "string" ? m.formatId : null, hint: m.hint } : undefined,
    );
  });

  // Reuse vs launch (renderer loadStream): a quitting mpv cannot take a loadfile, so it answers false.
  ipc.handle("sf-mpv-external-alive", () => currentClient?.isAcceptingCommands() ?? false);
  ipc.handle("sf-mpv-warm", async () => {
    await execWarmup.warm(resolveMpvBinary());
  });
};
