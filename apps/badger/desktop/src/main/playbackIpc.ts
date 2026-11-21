import type { IpcMain } from "electron";
import type { PlaybackServer } from "./playbackServer";
import type { PlaybackRuntimeBridge } from "./playbackRuntimeBridge";

type PlaybackIpcDeps = {
  playbackServer: PlaybackServer;
  runtimeBridge: PlaybackRuntimeBridge;
  onAuthTokenChanged?: (token: string | null) => void;
};

export const registerPlaybackIpc = (ipcMain: IpcMain, deps: PlaybackIpcDeps) => {
  ipcMain.handle("sf-playback-base-url", () => deps.playbackServer.getBaseUrl());
  ipcMain.handle("sf-playback-set-token", (_event, token: string | null) => {
    const normalized = token ?? null;
    deps.playbackServer.setToken(normalized);
    deps.runtimeBridge.setBackendToken(normalized);
    deps.onAuthTokenChanged?.(normalized);
  });
  ipcMain.handle("sf-playback-signed-urls-reset", () => {
    deps.playbackServer.resetSignedUrlMetrics();
    void deps.runtimeBridge.resetSignedUrlMetrics();
  });
  ipcMain.handle("sf-playback-signed-urls-stats", async () => {
    const runtimeMetrics = await deps.runtimeBridge.getSignedUrlMetrics();
    if (runtimeMetrics) return runtimeMetrics;
    return deps.playbackServer.getSignedUrlMetrics();
  });
  ipcMain.handle("sf-playback-stream-create", (_event, payload) => {
    // Never block playback launch on a slow or wedged runtime. The runtime's
    // prepareSession is informational (stats/observability); the local
    // playback server can allocate its own session id immediately. The
    // fire-and-forget mirrorPrepare below notifies the runtime out-of-band.
    const created = deps.playbackServer.createStream(payload);
    void deps.runtimeBridge.mirrorPrepare({
      sessionId: created.id,
      kind: "stream",
      url: created.url,
      totalSize: created.totalSize,
      contentType:
        typeof payload?.contentType === "string" && payload.contentType.trim().length > 0
          ? payload.contentType.trim()
          : null,
    });
    return created;
  });
  ipcMain.handle("sf-playback-stream-release", (_event, streamId: string) => {
    deps.playbackServer.releaseStream(streamId);
    void deps.runtimeBridge.mirrorRelease({
      sessionId: streamId,
      kind: "stream",
    });
  });
  ipcMain.handle("sf-playback-hls-create", (_event, payload) => {
    // Never block playback launch on a slow or wedged runtime. See note above.
    const created = deps.playbackServer.createHlsSession(payload);
    void deps.runtimeBridge.mirrorPrepare({
      sessionId: created.id,
      kind: "hls",
      url: created.url,
      mode: payload?.mode === "event" ? "event" : "vod",
      videoTrackCount: Array.isArray(payload?.videos) ? payload.videos.length : 0,
      audioTrackCount: Array.isArray(payload?.audio) ? payload.audio.length : 0,
    });
    return created;
  });
  ipcMain.handle("sf-playback-hls-release", (_event, sessionId: string) => {
    deps.playbackServer.releaseHlsSession(sessionId);
    void deps.runtimeBridge.mirrorRelease({
      sessionId,
      kind: "hls",
    });
  });
  // Auto quality (#25): upstream link throughput measured over the tunnel
  // fetches of HLS video segments, capped by the test throttle when active.
  ipcMain.handle("sf-playback-link-estimate", () => deps.playbackServer.getLinkEstimate());
  // Offline playback (OFFL-FILE-03): an HLS session over the pieces saved on this device, built from the item's
  // manifest. Released with sf-playback-hls-release. No runtime mirror: offline playback needs neither the runtime nor
  // the backend reachable.
  ipcMain.handle(
    "sf-playback-offline-hls-create",
    async (_event, payload: { fileId: string; manifestPath: string; id?: string }) => {
      return await deps.playbackServer.createOfflineHlsSession(payload);
    },
  );
  // Pre-warm chunks at the resume offset BEFORE launching mpv. Without
  // this, mpv hits the proxy cold for the segment at the resume offset
  // and the on-demand storage fetch takes long enough that mpv's HLS demuxer
  // treats it as a stream error → seeks back → retries → audible 3-10 s
  // segment loop. The renderer awaits this resolution before calling
  // launchExternalMpv.
  // @bugfix mpv-launch-loop-cold-hls-proxy
  ipcMain.handle(
    "sf-playback-hls-prewarm",
    async (
      _event,
      payload: {
        sessionId: string;
        videoId?: string | null;
        audioId?: string | null;
        startSeconds?: number | null;
      },
    ) => {
      if (!payload || typeof payload.sessionId !== "string") {
        throw new Error("hls_prewarm_invalid_payload");
      }
      return await deps.playbackServer.prewarmHlsSession(payload.sessionId, {
        videoId: payload.videoId ?? null,
        audioId: payload.audioId ?? null,
        startSeconds: payload.startSeconds ?? null,
      });
    },
  );
};
