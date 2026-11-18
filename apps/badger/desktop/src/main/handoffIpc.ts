/**
 * PLAT-WEB-05: the desktop's side of the web player hand-off. The web player asks the local runtime to play a movie
 * here (`playOnDesktop`); the runtime publishes `badger.handoff.play` on the `badger.handoff` channel to app sessions
 * only. This bridge holds Badger's runtime session (same session as the tool access bridge: badger scope, owner
 * secret), makes sure a main window exists WITHOUT showing it, asks the renderer to play the movie, and reports the
 * playback back to the runtime (`POST /runtime/handoff/:id/state`) from the external mpv messages:
 * `starting` → `playing` (position / duration, at most once a second) → `closed` (last position) or `failed`.
 * The web player shows those states; the user stays in the browser, so the app window never comes forward.
 * Electron is imported as types only so the bridge stays unit-testable.
 */
import type { BrowserWindow, IpcMain } from "electron";
import {
  DESKTOP_HANDOFF_CHANNEL,
  DESKTOP_HANDOFF_PLAY_EVENT,
  desktopHandoffPlayPayloadSchema,
  desktopHandoffReportSchema,
  type DesktopHandoffReport,
} from "@space/tool-access/contracts";
import { createRuntimeSession, type RuntimeSessionHandle } from "@space/runtime-client/session";
import { createRuntimeEventStream, type RuntimeEventStreamHandle } from "@space/runtime-client/events";
import { runtimeOwnerSecretProvider } from "./runtimeOwnerSecret";

const DEFAULT_RUNTIME_BASE_URL = "http://127.0.0.1:3020";

export const HANDOFF_IPC = {
  /** main → renderer: play `{ handoffId, mediaId }`. */
  play: "sf-handoff-play",
  /** renderer → main: `{ handoffId, error }`, the playback could not start. */
  failed: "sf-handoff-failed",
  /** renderer → main (invoke): the hand-off sent before the renderer listened (window still loading), or null. */
  pending: "sf-handoff-pending",
} as const;

/** `playing` reports are throttled to one per this many ms. */
export const HANDOFF_PLAYING_REPORT_INTERVAL_MS = 1_000;
/** A play the renderer has not picked up after this long is no longer handed to a renderer that mounts late. */
export const HANDOFF_PENDING_TTL_MS = 20_000;
/** Max length of a reported error (desktopHandoffReportSchema). */
const MAX_ERROR_LENGTH = 200;
const MAX_REPORTED_SECONDS = 1_000_000;

export type HandoffPlayRequest = { handoffId: string; mediaId: string };

export type HandoffBridgeDeps = {
  /** The main window, or null. Never shown by the bridge. */
  getWindow: () => BrowserWindow | null;
  /** Creates the main window HIDDEN when there is none (destroyed or never created); never shows it. */
  ensureHiddenWindow: () => BrowserWindow | null;
  runtimeBaseUrl?: string;
  fetchImpl?: typeof fetch;
  createSession?: typeof createRuntimeSession;
  createStream?: typeof createRuntimeEventStream;
  now?: () => number;
};

type ActiveHandoff = HandoffPlayRequest & {
  receivedAt: number;
  /** An mpv was launched (or reported a position) for this hand-off: from then on an mpv exit / stop closes it. */
  launched: boolean;
  /** The renderer pulled it through `sf-handoff-pending` (or it was pushed to a loaded page). */
  delivered: boolean;
  positionSeconds: number | null;
  durationSeconds: number | null;
  lastPlayingReportAt: number | null;
};

const log = (message: string, details?: Record<string, unknown>) => {
  console.info(`[handoff] ${message}`, details ?? {});
};

const finiteSeconds = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(value, MAX_REPORTED_SECONDS) : null;

export class HandoffRuntimeBridge {
  private readonly runtimeBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly createSession: typeof createRuntimeSession;
  private readonly createStream: typeof createRuntimeEventStream;
  private readonly now: () => number;
  private session: RuntimeSessionHandle | null = null;
  private eventStream: RuntimeEventStreamHandle | null = null;
  private backendToken: string | null = null;
  private active: ActiveHandoff | null = null;

  constructor(private readonly deps: HandoffBridgeDeps) {
    this.runtimeBaseUrl = (deps.runtimeBaseUrl ?? process.env.SF_RUNTIME_BASE_URL ?? DEFAULT_RUNTIME_BASE_URL)
      .trim()
      .replace(/\/+$/, "");
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.createSession = deps.createSession ?? createRuntimeSession;
    this.createStream = deps.createStream ?? createRuntimeEventStream;
    this.now = deps.now ?? Date.now;
  }

  setAuthToken(token: string | null) {
    this.backendToken = token?.trim() || null;
    if (!this.backendToken) {
      // Signed out: no session, no subscription (the runtime then reports no desktop player to the web player).
      log("signed out: hand-off subscription stopped", { hadSession: Boolean(this.session) });
      this.stop();
      this.session = null;
      return;
    }
    if (this.session) {
      this.session.setBackendToken(this.backendToken);
    } else {
      this.session = this.createSession({
        runtimeBaseUrl: this.runtimeBaseUrl,
        backendToken: this.backendToken,
        apps: ["badger"],
        ownerSecret: runtimeOwnerSecretProvider,
      });
    }
    this.ensureEventStream();
  }

  stop() {
    this.eventStream?.stop();
    this.eventStream = null;
  }

  /** True while the current playback belongs to a web player hand-off (the app window then stays hidden). */
  isHandoffPlayback(): boolean {
    return this.active !== null;
  }

  /** The runtime asked to play. A newer play supersedes the active one (the runtime already closed it). */
  async handlePlay(request: HandoffPlayRequest): Promise<void> {
    const previous = this.active;
    if (previous) {
      log("play supersedes the active hand-off", { previous: previous.handoffId, next: request.handoffId });
    }
    this.active = {
      ...request,
      receivedAt: this.now(),
      launched: false,
      delivered: false,
      positionSeconds: null,
      durationSeconds: null,
      lastPlayingReportAt: null,
    };
    const win = this.deps.getWindow();
    const target = win && !win.isDestroyed() ? win : this.deps.ensureHiddenWindow();
    if (!target || target.isDestroyed()) {
      log("no app window could be created: hand-off failed", { handoffId: request.handoffId });
      await this.fail(request.handoffId, "no_window");
      return;
    }
    const loading = target.webContents.isLoading();
    log("play received", {
      handoffId: request.handoffId,
      mediaId: request.mediaId,
      windowRecreated: target !== win,
      windowVisible: target.isVisible(),
      pageLoading: loading,
    });
    // A page still loading has no listener yet: the renderer pulls the play from `sf-handoff-pending` when it mounts.
    if (!loading) {
      target.webContents.send(HANDOFF_IPC.play, { handoffId: request.handoffId, mediaId: request.mediaId });
      this.active.delivered = true;
    }
    await this.report(request.handoffId, { state: "starting" });
  }

  /** The renderer mounted its listener: the play it may have missed, once. */
  takePending(): HandoffPlayRequest | null {
    const active = this.active;
    if (!active || active.delivered || active.launched) return null;
    if (this.now() - active.receivedAt > HANDOFF_PENDING_TTL_MS) {
      log("pending play too old for a late renderer: dropped", { handoffId: active.handoffId });
      return null;
    }
    active.delivered = true;
    log("pending play handed to the renderer", { handoffId: active.handoffId });
    return { handoffId: active.handoffId, mediaId: active.mediaId };
  }

  /** A new mpv became the current playback. */
  onPlaybackLaunched() {
    if (!this.active || this.active.launched) return;
    this.active.launched = true;
    log("mpv launched for the hand-off", { handoffId: this.active.handoffId });
  }

  /** `time-pos` / `duration` pushed by the current mpv. */
  onPlaybackProperty(name: "time-pos" | "duration", value: unknown) {
    const active = this.active;
    if (!active) return;
    const seconds = finiteSeconds(value);
    if (seconds === null) return;
    active.launched = true;
    if (name === "duration") {
      active.durationSeconds = seconds;
      return;
    }
    active.positionSeconds = seconds;
    const now = this.now();
    if (active.lastPlayingReportAt !== null && now - active.lastPlayingReportAt < HANDOFF_PLAYING_REPORT_INTERVAL_MS) return;
    active.lastPlayingReportAt = now;
    void this.report(active.handoffId, {
      state: "playing",
      positionSeconds: seconds,
      ...(active.durationSeconds === null ? {} : { durationSeconds: active.durationSeconds }),
    });
  }

  /** mpv exited or the renderer stopped it. */
  onPlaybackClosed(reason: "mpv_exit" | "renderer_stop") {
    const active = this.active;
    if (!active) return;
    if (!active.launched) {
      // The stop of an earlier playback that this hand-off replaces (its mpv is torn down before the new one starts).
      log("playback closed before the hand-off's mpv started: ignored", { handoffId: active.handoffId, reason });
      return;
    }
    this.active = null;
    log("hand-off playback closed", {
      handoffId: active.handoffId,
      reason,
      positionSeconds: active.positionSeconds,
      durationSeconds: active.durationSeconds,
    });
    void this.report(active.handoffId, {
      state: "closed",
      ...(active.positionSeconds === null ? {} : { positionSeconds: active.positionSeconds }),
      ...(active.durationSeconds === null ? {} : { durationSeconds: active.durationSeconds }),
    });
  }

  /** The renderer could not start the playback (missing item, not signed in, launch failed). */
  async reportRendererFailure(handoffId: string, error: string): Promise<void> {
    log("renderer could not start the hand-off playback", { handoffId, error });
    await this.fail(handoffId, error);
  }

  private async fail(handoffId: string, error: string) {
    if (this.active?.handoffId === handoffId) this.active = null;
    await this.report(handoffId, { state: "failed", error: error.slice(0, MAX_ERROR_LENGTH) || "failed" });
  }

  private async report(handoffId: string, body: DesktopHandoffReport): Promise<void> {
    const parsed = desktopHandoffReportSchema.safeParse(body);
    if (!parsed.success) {
      log("report not sent: invalid body", { handoffId, body, issues: parsed.error.issues.map((i) => i.message) });
      return;
    }
    const response = await this.call(`/runtime/handoff/${encodeURIComponent(handoffId)}/state`, parsed.data);
    log("state reported", { handoffId, ...parsed.data, status: response?.status ?? "unreachable" });
  }

  private async call(path: string, body: unknown): Promise<Response | null> {
    const session = this.session;
    if (!session) return null;
    const send = async () =>
      this.fetchImpl(`${this.runtimeBaseUrl}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${await session.getToken()}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    try {
      let response = await send();
      if (response.status === 401) {
        // The runtime ended this session (restart, expiry): log in again once.
        session.invalidate();
        response = await send();
      }
      return response;
    } catch {
      return null;
    }
  }

  private ensureEventStream() {
    if (this.eventStream || !this.session) return;
    this.eventStream = this.createStream({
      session: this.session,
      runtimeBaseUrl: this.runtimeBaseUrl,
      apps: ["badger"],
      channels: [DESKTOP_HANDOFF_CHANNEL],
    });
    this.eventStream.subscribe((frame) => {
      if (frame.event !== DESKTOP_HANDOFF_PLAY_EVENT) return;
      const parsed = desktopHandoffPlayPayloadSchema.safeParse(frame.payload);
      if (!parsed.success) {
        log("malformed play frame ignored", { payload: frame.payload });
        return;
      }
      void this.handlePlay({ handoffId: parsed.data.handoffId, mediaId: parsed.data.mediaId });
    });
    log("subscribed to the hand-off channel", { runtimeBaseUrl: this.runtimeBaseUrl });
    void this.eventStream.start();
  }
}

const fieldOf = (payload: unknown, key: string): unknown =>
  typeof payload === "object" && payload !== null && key in payload ? Reflect.get(payload, key) : undefined;

export const registerHandoffIpc = (ipc: IpcMain, deps: HandoffBridgeDeps) => {
  const bridge = new HandoffRuntimeBridge(deps);
  ipc.handle(HANDOFF_IPC.pending, () => bridge.takePending());
  ipc.handle(HANDOFF_IPC.failed, async (_event, payload: unknown) => {
    const handoffId = fieldOf(payload, "handoffId");
    const error = fieldOf(payload, "error");
    if (typeof handoffId !== "string" || !handoffId) return { ok: false };
    await bridge.reportRendererFailure(handoffId, typeof error === "string" && error ? error : "playback_failed");
    return { ok: true };
  });
  return bridge;
};
