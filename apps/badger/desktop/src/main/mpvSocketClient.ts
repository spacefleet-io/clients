/**
 * UnixSocketMpvClient — main-process implementation of {@link MpvClient}
 * for the SpaceBadger external-mpv pipeline.
 *
 * Tier-3 of the @space/mpv-protocol consolidation. This file collapses the
 * 8 module-globals previously held in externalMpv.ts:15-22 into class
 * instance fields so each launch owns its own state explicitly:
 *
 *   - mpvProcess, socketPath, dataDir
 *   - oscActionFilePath, oscActionPollTimer, lastOscActionPayload
 *   - launchId (instance-local for log correlation)
 *   - requestSeq (per-instance JSON-IPC request counter)
 *
 * The migrator (task D) replaces externalMpv.ts's module-globals + helper
 * functions with a `currentClient: UnixSocketMpvClient | null` singleton.
 * Rapid-relaunch protection moves from `isCurrentExternalMpvLaunch(activeLaunchId, launchId)`
 * to plain object-identity checks (`if (currentClient !== thisClient) return`),
 * which is the cleaner OOP equivalent.
 *
 * The wire protocol inside `request()` is the same as the previous
 * `sendRequest`: open a Unix-domain socket connection per request, write
 * the JSON payload terminated with `\n`, correlate the response by
 * `request_id`, end the socket on resolution or timeout. Behavior MUST be
 * byte-identical to the prior implementation — Tier-3 only collapses
 * state, not the protocol.
 *
 * Observe is stubbed (`observe_not_implemented`) for Tier-4 to fill in
 * with `observe_property` push events + the multiplexed
 * `sf-mpv-external-message` channel. Engine callers keep polling.
 */

import { ChildProcess, spawn, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, unlinkSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { promises as fs } from "node:fs";
import type { Socket } from "node:net";
import { getDesktopPlatform } from "@space/desktop-platform";

import {
  buildGetPropertyCommand,
  createTrailingThrottle,
  getProperty as getPropertyHelper,
  isExternalMpvResponseReady,
  oscActionFileSchema,
  reduce as reduceLifecycle,
  setProperty as setPropertyHelper,
  type LifecycleEvent,
  type LifecycleState,
  type MpvClient,
  type MpvClientState,
  type MpvCommand,
  type MpvObserveCallback,
  type MpvObserveOptions,
  type MpvObserveUnsubscribe,
  type MpvProperty,
  type MpvPropertyValue,
  type MpvResponse,
  type OscActionFile,
  type SubscribeLifecycleCallback,
  type SubscribeLifecycleUnsubscribe,
} from "@space/mpv-protocol";

import { scopeLogger } from "./logger";
import { TIME_POS_VISIBLE_EMIT_MS, TimePosEmitGate } from "./timePosEmitGate";
import {
  isMpvProcessGroupAlive,
  signalMpvProcessGroup,
  trackMpvProcessGroup,
  untrackMpvProcessGroup,
} from "./mpvProcessGroup";

const logger = scopeLogger("mpv-external-client");

/** Cap for queries and for commands whose answer a caller acts on (loadfile, quit). */
const REQUEST_TIMEOUT_MS = 1000;
/** Cap for mpv's ACK of a `script-message`, see {@link UnixSocketMpvClient.command}. */
const SCRIPT_MESSAGE_ACK_TIMEOUT_MS = 5000;
// sf.lua writes the OSC action file in place (io.open "w"). It is watched, so a
// write is read at once; this interval is only the safety net for lost watch
// events (network / bind-mounted filesystems). Without a watcher the 150 ms
// poll stays the only trigger so action latency does not regress (issue #25).
const OSC_POLL_INTERVAL_MS = 150;
const OSC_WATCHED_FALLBACK_POLL_INTERVAL_MS = 1000;
// Issue #25 P9 (s1 c016): a fixed 5 s wait failed the first play on a
// throttled 2-CPU slice while mpv was alive and still starting. The wait is
// readiness-based: it ends when the socket accepts a connection, at once when
// the mpv process exits, or at this cap — far above a healthy start (p50
// 76 ms) so only a genuinely wedged mpv hits it.
const SOCKET_WAIT_MAX_MS = 20_000;
const SOCKET_WAIT_INTERVAL_MS = 50;
const SOCKET_PROBE_TIMEOUT_MS = 500;
const READY_ATTEMPTS = 12;
const READY_BASE_DELAY_MS = 150;
const READY_DELAY_INCREMENT_MS = 25;
// Grace between escalation steps in dispose(): after `quit` → SIGTERM the
// group, after SIGTERM → SIGKILL the group (issue #25 P21).
const KILL_TIMEOUT_MS = 700;

export type MpvSocketWaitFailure = "process_exited" | "timeout";

export type MpvSocketWaitResult =
  | { ready: true; waitedMs: number }
  | { ready: false; failure: MpvSocketWaitFailure; waitedMs: number; socketFileSeen: boolean };

/** True when something accepts a connection on `socketPath`. */
// Executor form: the tsconfig lib (ES2022) predates Promise.withResolvers.
const probeSocket = (socketPath: string): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = getDesktopPlatform().mpvIpc.connect(socketPath);
    const done = (ok: boolean) => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.on("error", () => undefined);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), SOCKET_PROBE_TIMEOUT_MS);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });

/**
 * Wait until mpv's IPC socket accepts a connection. Gives up at once when
 * `isProcessAlive()` turns false (mpv exited: no socket will ever come), or
 * after `maxMs`.
 */
export const waitForMpvSocket = async (
  socketPath: string,
  isProcessAlive: () => boolean,
  maxMs = SOCKET_WAIT_MAX_MS,
  intervalMs = SOCKET_WAIT_INTERVAL_MS,
): Promise<MpvSocketWaitResult> => {
  const startedAt = Date.now();
  let socketFileSeen = false;
  while (true) {
    if (getDesktopPlatform().mpvIpc.exists(socketPath)) {
      socketFileSeen = true;
      if (await probeSocket(socketPath)) return { ready: true, waitedMs: Date.now() - startedAt };
    }
    if (!isProcessAlive()) {
      return { ready: false, failure: "process_exited", waitedMs: Date.now() - startedAt, socketFileSeen };
    }
    if (Date.now() - startedAt >= maxMs) {
      return { ready: false, failure: "timeout", waitedMs: Date.now() - startedAt, socketFileSeen };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
};

export type UnixSocketMpvClientStartOptions = {
  /** Absolute path to the mpv binary. */
  bin: string;
  /**
   * Full argv for mpv. Must include `--input-ipc-server=<socketPath>` — the
   * caller pre-builds this so it has flexibility over launch flags
   * (osc color, hls bitrate, log files, etc.).
   */
  args: string[];
  /** Environment for the spawned mpv process. */
  env: NodeJS.ProcessEnv;
  /**
   * Path to the Unix socket mpv exposes for JSON IPC. Must match
   * `--input-ipc-server=<socketPath>` in `args`. Owned by the client —
   * unlinked on dispose.
   */
  socketPath: string;
  /**
   * Optional data directory created for this launch (e.g. mpv profile).
   * Cleaned up on dispose when `SF_MPV_CLEAN_DATA_DIR_ON_STOP=1`.
   */
  dataDir?: string | null;
  /**
   * Path to the OSC action file sf.lua writes JSON actions to. Watched by
   * the client (1 s safety-net poll; 150 ms poll when it cannot be watched);
   * valid actions are emitted as `osc-action`
   * events. Falsy disables OSC polling.
   */
  oscActionFilePath?: string | null;
  /**
   * stdio mode for the spawned process. Defaults to "ignore". Only entries 0-2:
   * mpv starts with every fd >= 3 closed (`processes.withoutInheritedHandles`).
   */
  stdio?: SpawnOptions["stdio"];
  /**
   * The launch's stream readahead target (`--cache-secs`, @space/mpv
   * resolveMpvStreamCacheSecs). A resume into segment 0's first GOP loads
   * with a shorter prefill (`cache-secs=<window>`, @space/mpv-protocol
   * MPV_RESUME_PREFILL_WINDOW_SECONDS), which mpv would keep for the whole
   * file; the client sets this back on each file's first playback-restart.
   * null / 0 (cache disabled) skips the restore.
   */
  readaheadSecs?: number | null;
};

export type UnixSocketMpvClientEvents = {
  /** mpv process exit. Fires once, after `dispose` or unexpected termination. */
  exit: () => void;
  /** OSC action JSON payload parsed from the action file (next_episode / previous_episode). */
  "osc-action": (action: OscActionFile) => void;
  /** Process emitted a spawn error before mpv came up. */
  "spawn-error": (error: Error) => void;
  /**
   * mpv-side property-change event from the persistent event-stream
   * socket. Forwarded to consumers (externalMpv.ts) so they can route
   * over IPC. Tier-4: only fires for properties currently observed.
   */
  "property-change": (event: { name: MpvProperty; value: unknown }) => void;
  /**
   * Tier-5 — lifecycle reducer state transition. Fired after the pure
   * reducer in `@space/mpv-protocol/lifecycle` ingests an internal event
   * (launch_started, socket_ready, socket_failed, process_exited,
   * user_stop). Consumers (externalMpv.ts) forward to the renderer over
   * `sf-mpv-external-message` so the engine's `useMpvLifecycleStore`
   * hook can replace the 7 lifecycle refs scattered across the engine.
   */
  lifecycle: (state: LifecycleState) => void;
  /**
   * Tier-6 — Lua-emitted script message. mpv's JSON-IPC raises a
   * `"client-message"` event whenever a Lua script calls
   * `mp.commandv("script-message", name, ...args)`. The first arg is the
   * channel name; subsequent args are string params. We surface it as a
   * typed `script-message` event so consumers (externalMpv.ts) can
   * forward to the renderer over `sf-mpv-external-message`. The first
   * production user is sf.lua's `emit_pill_state` writing to the
   * `sf-pill-state` channel for the skip-marker E2E observer; the
   * channel is shape-agnostic so any future Lua→renderer signal flows
   * here without additional plumbing.
   */
  "script-message": (event: { name: string; args: string[] }) => void;
  /**
   * mpv `end-file` event from the persistent event-stream socket. Surfaced
   * because an IDLE-launched mpv (backdrop handoff, `--idle=yes`) does not
   * exit when a `loadfile` fails: `end-file reason=error` followed by `idle`
   * is the only sign the stream never loaded (issue #25,
   * @bugfix mpv-handoff-load-failure-black-idle-window). `reason` is mpv's
   * string (eof|stop|quit|error|redirect); `fileError` is mpv's `file_error`.
   */
  "end-file": (event: { reason: string | null; fileError: string | null; playlistEntryId: number | null }) => void;
  /**
   * mpv `file-loaded` event: the `loadfile`'d stream opened. The backdrop
   * handoff waits on it when the `loadfile` reply timed out (issue #25 P17).
   */
  "file-loaded": () => void;
  /**
   * mpv's first `playback-restart` of the loaded file: its first frame is
   * up. Later restarts (seeks) do not fire it. The ABR first-frame clock
   * (issue #25 N4).
   */
  "first-playback-restart": () => void;
  /**
   * mpv `start-file` event: a `loadfile`'d entry began opening. Marks where
   * the new file's events start, so an `end-file` of the file it replaces is
   * not read as the new file's failure (issue #25 P15).
   */
  "start-file": (event: { playlistEntryId: number | null }) => void;
};

/**
 * Monotonic per-client launch id source. Each new instance gets a unique
 * number for log correlation only — rapid-relaunch invariants are now
 * enforced by object identity at the consumer.
 */
let nextLaunchId = 1;

/**
 * Internal representation of one subscription on the property-change
 * registry. Each `observe()` call appends one of these and increments
 * the per-property ref count.
 */
type ObserveSubscription = {
  property: MpvProperty;
  // The wrapped, throttle-aware delivery callback. We track the wrapper
  // so unsubscribe + flush can remove this exact instance.
  deliver: (value: unknown) => void;
  // The throttle controller (or null when options.throttleMs is unset).
  throttle: ReturnType<typeof createTrailingThrottle<unknown>> | null;
};

const OBSERVE_BASE_ID = 1_000_000;

export class UnixSocketMpvClient implements MpvClient {
  private _state: MpvClientState = "idle";
  private mpvProcess: ChildProcess | null = null;
  private socketPath: string | null = null;
  private dataDir: string | null = null;
  private oscActionFilePath: string | null = null;
  private oscActionPollTimer: NodeJS.Timeout | null = null;
  private oscActionWatcher: FSWatcher | null = null;
  private lastOscActionPayload: string | null = null;
  /** Bumped on every stop/start of OSC polling; an in-flight poll from an older generation is dropped (issue #25 P14). */
  private oscPollGeneration = 0;
  private readonly launchId: number;
  private requestSeq = 1;
  private readonly emitter = new EventEmitter();
  /**
   * Window (ms) between forwarded `time-pos` "property-change" events, read per
   * push. mpv pushes time-pos per displayed frame; externalMpv.ts relays each
   * emitted event over IPC, so the window is the IPC cadence. The owner swaps
   * it for a longer one while the app window is hidden.
   */
  timePosEmitWindowMs: () => number = () => TIME_POS_VISIBLE_EMIT_MS;
  private readonly timePosGate = new TimePosEmitGate(
    (value) => this.emitter.emit("property-change", { name: "time-pos", value }),
    () => this.timePosEmitWindowMs(),
  );
  private readyPromise: Promise<boolean> | null = null;
  // #25 playable-start: readahead target restored after each file's start
  // seek, and whether the current file's first playback-restart is still due.
  // Pending from launch: the launch file has no file-loaded seen before the
  // event socket may connect.
  private readaheadSecs: number | null = null;
  private readaheadRestorePending = true;

  // Tier-4 — persistent event-stream socket. mpv's JSON-IPC `observe_property`
  // pushes events on whatever socket it was issued from, so we hold one
  // long-lived connection separate from the per-request sockets in `request()`.
  private eventSocket: Socket | null = null;
  // Buffer of partial lines from the event stream — observers emit
  // newline-delimited JSON, and a single read() can split a line.
  private eventBuffer = "";
  // Map of mpv `observe_property` request_id → MpvProperty. Used to
  // correlate the property-change events to a name (mpv echoes both).
  private observeRequestIds = new Map<number, MpvProperty>();
  // The active subscription list, keyed by property. Order within the
  // array is the dispatch order on each event push.
  private subscriptions = new Map<MpvProperty, ObserveSubscription[]>();
  // Counter for `observe_property` request_ids. We carve out a high
  // range so they never collide with the per-request `requestSeq`.
  private observeSeq = OBSERVE_BASE_ID;
  // Backoff state for event-socket reconnect. Bounded so we don't hot-loop
  // when mpv is in the middle of dying.
  private eventReconnectAttempts = 0;
  private eventReconnectTimer: NodeJS.Timeout | null = null;
  // True while we're inside dispose() so the socket-close handler doesn't
  // attempt a reconnect on the way out.
  private disposing = false;
  // True once mpv is on its way out: `quit` sent, `end-file reason=quit` or
  // `shutdown` seen, or the process exited. mpv closes its IPC socket well
  // before the process exits, so reconnecting in that window only produced
  // a storm of ECONNREFUSED / `observe_property write failed` (issue #25 P25).
  private quitRequested = false;
  // Process-group id of the spawned mpv (== its pid; spawned detached).
  // Kept after the leader exits: another group member can outlive it
  // (issue #25 P21).
  private processGroupId: number | null = null;

  // Tier-5 — pure-reducer lifecycle state, dispatched on every internal
  // event source (start spawn, socket-ready/failed, process exit, user
  // stop, dispose). The reducer lives in @space/mpv-protocol/lifecycle
  // and is the SAME pure function exercised by the 26 trace fixtures so
  // renderer subscribers see byte-identical transitions to the spec.
  // Subscriber callbacks are stored on a dedicated Set rather than the
  // shared EventEmitter so subscribeLifecycle can deliver the current
  // state synchronously on registration without races.
  private lifecycleState: LifecycleState = { kind: "idle" };
  private readonly lifecycleSubscribers = new Set<SubscribeLifecycleCallback>();

  constructor() {
    this.launchId = nextLaunchId++;
  }

  /**
   * Push one event through the lifecycle reducer, update the cached
   * state, and notify subscribers + the EventEmitter so consumers
   * (externalMpv.ts, the renderer) can react. The reducer is PURE
   * state-transition only — side effects (window hide/show, OSC polling,
   * process kill) are performed imperatively in `start()` / `dispose()` /
   * the process-exit handler, never driven by the reducer.
   *
   * State transitions are NEVER skipped: even when the reducer returns the
   * same state (no-op events like a duplicate socket_ready or a stray
   * socket_failed), subscribers still receive a notification — but
   * `useSyncExternalStore` rejects identity-equal snapshots so it won't
   * trigger a renderer re-render in that case.
   */
  private dispatchLifecycle(event: LifecycleEvent): void {
    const state = reduceLifecycle(this.lifecycleState, event);
    this.lifecycleState = state;
    this.emitter.emit("lifecycle", state);
    for (const subscriber of this.lifecycleSubscribers) {
      try {
        subscriber(state);
      } catch (error) {
        logger.warn(
          {
            launchId: this.launchId,
            error: error instanceof Error ? error.message : String(error),
          },
          "lifecycle subscriber threw",
        );
      }
    }
  }

  get state(): MpvClientState {
    return this._state;
  }

  getLaunchId(): number {
    return this.launchId;
  }

  on<E extends keyof UnixSocketMpvClientEvents>(
    event: E,
    listener: UnixSocketMpvClientEvents[E],
  ): this {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  off<E extends keyof UnixSocketMpvClientEvents>(
    event: E,
    listener: UnixSocketMpvClientEvents[E],
  ): this {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
    return this;
  }

  subscribeLifecycle(
    callback: SubscribeLifecycleCallback,
  ): SubscribeLifecycleUnsubscribe {
    this.lifecycleSubscribers.add(callback);
    // Deliver the current state synchronously so subscribers don't race
    // the first transition (matches the useSyncExternalStore precedent
    // at packages/desktop-shell/src/services/notifications.ts:131-136).
    try {
      callback(this.lifecycleState);
    } catch (error) {
      logger.warn(
        {
          launchId: this.launchId,
          error: error instanceof Error ? error.message : String(error),
        },
        "lifecycle subscriber threw on initial delivery",
      );
    }
    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      this.lifecycleSubscribers.delete(callback);
    };
  }

  /** Test-only accessor for the current lifecycle reducer state. */
  __getLifecycleStateForTests(): LifecycleState {
    return this.lifecycleState;
  }

  /**
   * Spawn the mpv process and wait until its IPC socket accepts a
   * connection. Returns early with `failure: "process_exited"` when mpv
   * exits first, and `failure: "timeout"` after SOCKET_WAIT_MAX_MS.
   *
   * Throws synchronously if spawn fails; the caller decides what UI
   * recovery to do (e.g. show the app window again).
   */
  async start(
    options: UnixSocketMpvClientStartOptions,
  ): Promise<{ socketReady: boolean; failure?: MpvSocketWaitFailure }> {
    if (this._state !== "idle") {
      throw new Error(`mpv_client_invalid_state:${this._state}`);
    }
    this._state = "connecting";
    this.socketPath = options.socketPath;
    this.dataDir = options.dataDir ?? null;
    this.readaheadSecs = options.readaheadSecs ?? null;
    // Best-effort: clear any stale socket file before mpv tries to bind.
    getDesktopPlatform().mpvIpc.remove(options.socketPath);

    // Tier-5 — record the launch in the lifecycle machine BEFORE spawning
    // so any spawn failure path still produces a coherent state trace
    // (launching → idle on the catch below).
    this.dispatchLifecycle({
      type: "launch_started",
      launchId: this.launchId,
      startedAt: Date.now(),
    });

    let process: ChildProcess;
    try {
      const argv = getDesktopPlatform().processes.withoutInheritedHandles(options.bin, options.args, options.env);
      process = spawn(argv.command, argv.args, {
        stdio: options.stdio ?? "ignore",
        ...getDesktopPlatform().processes.spawnOptions({ detached: true }),
        env: options.env,
      });
      getDesktopPlatform().processes.childLifetime.afterSpawn(process.pid);
      process.unref();
    } catch (error) {
      this._state = "idle";
      // Spawn threw before the OS even produced a PID — there is no
      // process to exit, so model the failure as socket_failed which
      // routes the reducer from launching back to idle.
      this.dispatchLifecycle({ type: "socket_failed" });
      throw error;
    }
    this.mpvProcess = process;
    if (process.pid) {
      this.processGroupId = process.pid;
      trackMpvProcessGroup(process.pid);
    }

    if (options.oscActionFilePath) {
      this.startOscActionPolling(options.oscActionFilePath);
    }

    process.on("error", (error) => {
      logger.warn(
        { launchId: this.launchId, error: error instanceof Error ? error.message : String(error) },
        "spawn failed",
      );
      this.emitter.emit("spawn-error", error);
    });

    process.on("exit", (code, signal) => {
      logger.warn({ launchId: this.launchId, code, signal }, "process exited");
      this.quitRequested = true;
      // If the leader died while other group members live on, they are orphans the
      // app no longer talks to: take the whole group down.
      const pgid = this.processGroupId;
      if (pgid !== null) {
        if (isMpvProcessGroupAlive(pgid)) {
          logger.warn({ launchId: this.launchId, pgid }, "mpv leader exited with group members alive; terminating group");
          this.terminateProcessGroup(pgid, "leader_exited", true);
        } else {
          untrackMpvProcessGroup(pgid);
        }
      }
      // Clean up the socket on the way out — caller's `exit` handler
      // shouldn't have to know the path.
      if (this.socketPath) getDesktopPlatform().mpvIpc.remove(this.socketPath);
      this.stopOscActionPolling();
      this.mpvProcess = null;
      this.dispatchLifecycle({ type: "process_exited", code, signal });
      this.emitter.emit("exit");
    });

    // Alive = still our process, spawned (an ENOENT bin never gets a pid and
    // may emit no "exit"), and not exited.
    const isMpvAlive = () =>
      this.mpvProcess === process &&
      process.pid !== undefined &&
      process.exitCode === null &&
      process.signalCode === null;
    const wait = await waitForMpvSocket(options.socketPath, isMpvAlive);
    if (wait.ready) {
      this._state = "ready";
      logger.info({ launchId: this.launchId, waitedMs: wait.waitedMs }, "socket ready");
      this.dispatchLifecycle({ type: "socket_ready" });
      return { socketReady: true };
    }
    logger.error(
      {
        launchId: this.launchId,
        failure: wait.failure,
        waitedMs: wait.waitedMs,
        maxMs: SOCKET_WAIT_MAX_MS,
        socketFileSeen: wait.socketFileSeen,
        socketPath: options.socketPath,
        pid: process.pid ?? null,
      },
      wait.failure === "process_exited"
        ? "mpv exited before its IPC socket was ready"
        : "mpv IPC socket not ready before the start cap; mpv is alive but wedged",
    );
    // Stay in "connecting" — the caller decides whether to dispose.
    this.dispatchLifecycle({ type: "socket_failed" });
    return { socketReady: false, failure: wait.failure };
  }

  /**
   * Fire-and-forget command. Still waits for mpv's ACK so script-message
   * commands aren't lost on socket close — same regression-preserving
   * behavior as the prior `sendCommand` (externalMpv.ts:184).
   *
   * A `script-message` waits up to {@link SCRIPT_MESSAGE_ACK_TIMEOUT_MS} for
   * that ACK, not the 1 s cap. mpv answers only once its core thread has run
   * the command, and on a loaded host that thread is busy for more than a
   * second (file open, video output reconfig). The message still reaches the
   * Lua script; the 1 s cap reported it as failed (`mpv_request_timeout` on
   * `sf-audio-json`). Its ACK carries nothing a caller decides on, so waiting
   * costs nothing. Other commands keep the 1 s cap: loadfile's callers treat a
   * timeout as "unknown" and fall back to mpv's events within a bounded time
   * (issue #25 P17), and dispose's `quit` must signal a hung mpv quickly.
   */
  async command(cmd: MpvCommand): Promise<MpvResponse> {
    const timeoutMs = cmd.command[0] === "script-message" ? SCRIPT_MESSAGE_ACK_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
    return await this.request(cmd, timeoutMs);
  }

  /**
   * Send a JSON-IPC request and resolve with mpv's correlated response.
   * Returns `{ error: "mpv_socket_missing" }` when the socket is gone —
   * preserves the sentinel response consumers already handle.
   */
  async request(cmd: MpvCommand, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<MpvResponse> {
    if (this._state === "disposed") {
      return { error: "mpv_socket_missing" };
    }
    const socketPath = this.socketPath;
    if (!socketPath || !getDesktopPlatform().mpvIpc.exists(socketPath)) {
      return { error: "mpv_socket_missing" };
    }
    if (cmd.command[0] === "quit") {
      // mpv closes the IPC socket as soon as it processes this; the event
      // socket must not chase it (issue #25 P25).
      this.quitRequested = true;
    }
    const requestId = this.requestSeq++;
    const payload = JSON.stringify({ ...(cmd as object), request_id: requestId });
    return await new Promise<MpvResponse>((resolve, reject) => {
      let buffer = "";
      const socket = getDesktopPlatform().mpvIpc.connect(socketPath, () => {
        socket.write(`${payload}\n`, (err) => {
          if (err) {
            reject(err);
            socket.end();
          }
        });
      });
      const timeout = setTimeout(() => {
        socket.end();
        reject(new Error("mpv_request_timeout"));
      }, timeoutMs);
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const message = JSON.parse(line) as MpvResponse;
            if (message?.request_id === requestId) {
              clearTimeout(timeout);
              socket.end();
              resolve(message);
              return;
            }
          } catch {
            // ignore parse errors
          }
        }
      });
      socket.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      socket.on("close", () => {
        clearTimeout(timeout);
      });
    });
  }

  async getProperty<P extends MpvProperty>(
    property: P,
    _signal?: AbortSignal,
  ): Promise<MpvPropertyValue<P> | null> {
    // AbortSignal accepted for forward-compat (Tier-4+); ignored in Tier-3.
    return await getPropertyHelper(this.request.bind(this), property);
  }

  async setProperty<P extends MpvProperty>(
    property: P,
    value: MpvPropertyValue<P>,
    _signal?: AbortSignal,
  ): Promise<boolean> {
    return await setPropertyHelper(this.request.bind(this), property, value);
  }

  /**
   * Change the launch's readahead target (`cache-secs`) mid-session: a gateway
   * high-traffic period lowers it, normal traffic restores it (STOR-BW-01).
   * No-op without a launch target (disabled defaults) or when unchanged. While
   * the current file's first-GOP prefill is still pending, only the target
   * is recorded: the first playback-restart applies it, so the short prefill
   * is not stretched.
   */
  async setReadaheadSecs(secs: number): Promise<boolean> {
    if (this.readaheadSecs === null || this.readaheadSecs === secs) return true;
    this.readaheadSecs = secs;
    if (this.readaheadRestorePending) return true;
    return await this.setProperty("cache-secs", secs);
  }

  /**
   * Subscribe to property-change push events for the given property.
   *
   * Tier-4 — replaces the prior Tier-3 stub. mpv's JSON-IPC `observe_property`
   * pushes events on the socket where it was issued, so we hold a
   * persistent event-stream socket separate from the per-request sockets
   * in `request()`. Ref-counted by property: the first subscribe issues
   * `observe_property` over the wire, the last unsubscribe issues
   * `unobserve_property`. Idempotent — registering the same callback
   * twice still produces one event delivery per push.
   *
   * `options.throttleMs` wraps the callback in a trailing-throttle so
   * high-rate properties like `time-pos` deliver at most once per window.
   * The trailing value is delivered when the window closes; on
   * unsubscribe, the throttle is cancelled to drop the pending value.
   *
   * Returns an unsubscribe function. Calling it twice is safe; the
   * second call is a no-op.
   */
  observe<P extends MpvProperty>(
    property: P,
    callback: MpvObserveCallback<P>,
    options: MpvObserveOptions = {},
  ): MpvObserveUnsubscribe {
    if (this._state === "disposed") {
      // Disposed clients should not register observers; return a no-op
      // unsubscribe so callers can still safely invoke it in cleanup
      // paths without a try/catch.
      return () => undefined;
    }
    const throttleMs = options.throttleMs ?? 0;
    const typedCallback = callback as (value: unknown) => void;
    const throttle =
      throttleMs > 0
        ? createTrailingThrottle<unknown>(typedCallback, throttleMs)
        : null;
    const deliver: (value: unknown) => void = throttle
      ? throttle.next
      : typedCallback;
    const subscription: ObserveSubscription = { property, deliver, throttle };
    const existing = this.subscriptions.get(property);
    if (existing && existing.length > 0) {
      // Re-use the existing wire observation — just append to the
      // local subscriber list.
      existing.push(subscription);
    } else {
      this.subscriptions.set(property, [subscription]);
      // First subscriber: ensure the persistent event socket is open,
      // then issue `observe_property` to mpv.
      this.ensureEventSocket();
      this.issueObserveProperty(property);
    }
    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      // Drop pending throttled value so the trailing flush doesn't fire
      // after the consumer unsubscribed.
      if (subscription.throttle) {
        subscription.throttle.cancel();
      }
      const list = this.subscriptions.get(property);
      if (!list) return;
      const index = list.indexOf(subscription);
      if (index >= 0) list.splice(index, 1);
      if (list.length === 0) {
        this.subscriptions.delete(property);
        // Last subscriber for this property: tell mpv we no longer care.
        this.issueUnobserveProperty(property);
      }
    };
  }

  /**
   * Open (or re-open) the persistent event-stream socket and start
   * routing newline-delimited JSON. Idempotent — repeated calls while
   * the socket is alive return without doing anything.
   *
   * On socket-close, this method schedules a reconnect via setTimeout
   * (capped backoff) — unless mpv is on its way out (`quitRequested`, or the
   * spawned process is no longer alive): mpv closes its IPC socket before
   * the process exits, and chasing it produced ~12 failed reconnects per
   * launch (issue #25 P25). Once a reconnect actually CONNECTS it re-issues
   * every active `observe_property` from the subscription registry and
   * delivers `null` to subscribers, which matches the engine's existing
   * "soft-failure → re-query" pattern. Nothing is written or delivered for
   * an attempt that never connected.
   */
  private ensureEventSocket(onConnect?: () => void): void {
    if (this.eventSocket) return;
    if (this.eventReconnectTimer) return; // already scheduled
    if (this.disposing || this.quitRequested) return;
    const socketPath = this.socketPath;
    if (!socketPath || !getDesktopPlatform().mpvIpc.exists(socketPath)) return;
    let socket: Socket;
    try {
      socket = getDesktopPlatform().mpvIpc.connect(socketPath);
    } catch (error) {
      logger.warn(
        {
          launchId: this.launchId,
          error: error instanceof Error ? error.message : String(error),
        },
        "event-socket connect threw",
      );
      this.scheduleEventReconnect();
      return;
    }
    this.eventSocket = socket;
    this.eventBuffer = "";
    socket.once("connect", () => {
      // Reset the backoff only on a real connection; resetting on every
      // attempt kept the delay pinned at 50 ms while mpv was dying.
      this.eventReconnectAttempts = 0;
      onConnect?.();
    });
    socket.on("data", (chunk) => {
      this.eventBuffer += chunk.toString();
      const lines = this.eventBuffer.split("\n");
      this.eventBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          this.routeEventLine(JSON.parse(line));
        } catch {
          // mpv occasionally writes partial bytes during shutdown;
          // ignore parse errors instead of crashing the consumer.
        }
      }
    });
    socket.on("error", (err) => {
      logger.warn(
        {
          launchId: this.launchId,
          error: err instanceof Error ? err.message : String(err),
        },
        "event-socket error",
      );
    });
    socket.on("close", () => {
      this.eventSocket = null;
      this.eventBuffer = "";
      this.observeRequestIds.clear();
      if (this.disposing) return;
      if (this.subscriptions.size === 0) return; // nothing to recover
      if (this.isMpvGoingAway()) {
        logger.info(
          { launchId: this.launchId, quitRequested: this.quitRequested },
          "event-socket closed while mpv is quitting; not reconnecting",
        );
        return;
      }
      this.scheduleEventReconnect();
    });
  }

  /**
   * True when a closed event socket will not come back: quit was requested
   * or seen, or the spawned mpv process is gone. A client attached to a
   * socket without spawning (tests) has no process to probe and keeps the
   * reconnect path.
   */
  private isMpvGoingAway(): boolean {
    if (this.quitRequested) return true;
    return this.processGroupId !== null && !this.isAlive();
  }

  private scheduleEventReconnect(): void {
    if (this.eventReconnectTimer) return;
    if (this.disposing || this.isMpvGoingAway()) return;
    const attempt = this.eventReconnectAttempts++;
    // 50ms + attempt × 50ms, capped at 500ms. mpv's socket comes back
    // almost immediately when this fires legitimately (the path-missing
    // case is handled by ensureEventSocket's existsSync gate).
    const delay = Math.min(500, 50 + attempt * 50);
    this.eventReconnectTimer = setTimeout(() => {
      this.eventReconnectTimer = null;
      if (this.disposing || this.isMpvGoingAway()) return;
      if (this.subscriptions.size === 0) return;
      this.ensureEventSocket(() => {
        logger.info(
          { launchId: this.launchId, properties: [...this.subscriptions.keys()] },
          "event-socket reconnected; re-observing",
        );
        // Re-issue every active observation on the connected socket.
        for (const [property, subs] of this.subscriptions) {
          this.issueObserveProperty(property);
          // Force-fire null so subscribers re-query if they need fresh state.
          // Mirrors the engine's `mpv_socket_missing` reset-then-re-poll path.
          for (const sub of subs) sub.deliver(null);
        }
      });
    }, delay);
  }

  /**
   * Send `observe_property` for the given property over the persistent
   * event socket. The request_id is recorded so we can drop the ACK
   * when it echoes back without forwarding it as a property-change.
   */
  private issueObserveProperty(property: MpvProperty): void {
    const socket = this.eventSocket;
    if (!socket || socket.destroyed) return;
    const requestId = this.observeSeq++;
    this.observeRequestIds.set(requestId, property);
    const payload = JSON.stringify({
      command: ["observe_property", requestId, property],
      request_id: requestId,
    });
    socket.write(`${payload}\n`, (err) => {
      if (err) {
        logger.warn(
          {
            launchId: this.launchId,
            property,
            error: err instanceof Error ? err.message : String(err),
          },
          "observe_property write failed",
        );
      }
    });
  }

  /**
   * Send `unobserve_property` for the given property. mpv requires the
   * id we issued on observe_property; we look it up in the reverse map
   * we built when registering.
   */
  private issueUnobserveProperty(property: MpvProperty): void {
    const socket = this.eventSocket;
    if (!socket || socket.destroyed) return;
    // Find the observe id that we issued for this property (the first
    // entry whose property matches). mpv's `unobserve_property` takes
    // the id we passed to `observe_property`.
    let observeId: number | null = null;
    for (const [id, prop] of this.observeRequestIds.entries()) {
      if (prop === property) {
        observeId = id;
        break;
      }
    }
    if (observeId === null) return;
    this.observeRequestIds.delete(observeId);
    const payload = JSON.stringify({
      command: ["unobserve_property", observeId],
    });
    socket.write(`${payload}\n`, (err) => {
      if (err) {
        logger.warn(
          {
            launchId: this.launchId,
            property,
            observeId,
            error: err instanceof Error ? err.message : String(err),
          },
          "unobserve_property write failed",
        );
      }
    });
  }

  /**
   * Route a single parsed JSON message from the event socket.
   *   - `event === "property-change"` → dispatch to subscribers AND
   *     forward through the EventEmitter so externalMpv.ts can route
   *     over IPC.
   *   - `event === "client-message"` → re-emit as a typed `script-message`
   *     event so externalMpv.ts can forward to the renderer. mpv raises
   *     this whenever a Lua script calls
   *     `mp.commandv("script-message", name, ...args)` — the first arg
   *     is the channel name, the rest are string params.
   *   - `end-file` / `file-loaded` → re-emitted for externalMpv.ts;
   *     `shutdown` marks the quit. A file's first `playback-restart`
   *     restores the `cache-secs` readahead (#25 playable-start).
   *   - everything else (later `playback-restart`s, the ACK echoes from
   *     observe_property/unobserve_property) is ignored.
   *
   * Crucially we DO NOT throw on unknown events — mpv emits a parade of
   * unsolicited events and this layer is shape-agnostic.
   */
  private routeEventLine(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const evt = (message as { event?: unknown }).event;
    // Events that must stay ordered after the exact position (seek landing,
    // file boundaries) release a coalesced time-pos first.
    if (
      evt === "end-file" ||
      evt === "start-file" ||
      evt === "file-loaded" ||
      evt === "playback-restart"
    ) {
      this.timePosGate.flush();
    }
    if (evt === "property-change") {
      const name = (message as { name?: unknown }).name;
      if (typeof name !== "string") return;
      if (!this.subscriptions.has(name as MpvProperty)) return;
      const property = name as MpvProperty;
      const value = (message as { data?: unknown }).data;
      const subs = this.subscriptions.get(property);
      if (!subs) return;
      for (const sub of subs) {
        try {
          sub.deliver(value);
        } catch (error) {
          logger.warn(
            {
              launchId: this.launchId,
              property,
              error: error instanceof Error ? error.message : String(error),
            },
            "observer threw",
          );
        }
      }
      // Forward to the EventEmitter so externalMpv.ts can route over
      // sf-mpv-external-message for the renderer-side PreloadMpvClient.
      // time-pos is rate-limited (trailing value kept); pause / eof-reached
      // release the pending position first and then go out at once.
      if (property === "time-pos") {
        this.timePosGate.push(value);
        return;
      }
      if (property === "pause" || property === "eof-reached") this.timePosGate.flush();
      this.emitter.emit("property-change", { name: property, value });
      return;
    }
    if (evt === "client-message") {
      // mpv's `client-message` event surfaces every Lua-side
      // `mp.commandv("script-message", name, ...args)` call. The payload
      // shape is `{event: "client-message", args: [name, ...stringArgs]}`.
      // First arg is the channel name (which `mp.register_script_message`
      // matches on); the remaining args are the string params the Lua
      // script passed.
      const rawArgs = (message as { args?: unknown }).args;
      if (!Array.isArray(rawArgs) || rawArgs.length === 0) {
        console.info("[mpv-script-message] client-message dropped (empty args)", {
          launchId: this.launchId,
        });
        return;
      }
      const [rawName, ...rest] = rawArgs;
      if (typeof rawName !== "string") {
        console.info("[mpv-script-message] client-message dropped (non-string name)", {
          launchId: this.launchId,
          rawName,
        });
        return;
      }
      // Coerce every arg to a string. mpv only ever emits strings here
      // but defensively normalize so downstream JSON-parse paths don't
      // hit `undefined`.
      const stringArgs: string[] = rest.map((value) =>
        typeof value === "string" ? value : value == null ? "" : String(value),
      );
      // Debug, and the only per-message log on this path: sf.lua's
      // sf-pill-state used to arrive per frame and was logged at info twice
      // (here + externalMpv), stalling main on loaded PCs (#25
      // NEW-pill-state-flood). @bugfix mpv-pill-state-ipc-flood
      logger.debug({ launchId: this.launchId, name: rawName, argsCount: stringArgs.length }, "mpv script-message received");
      this.emitter.emit("script-message", { name: rawName, args: stringArgs });
      return;
    }
    if (evt === "end-file") {
      const reason = "reason" in message && typeof message.reason === "string" ? message.reason : null;
      const fileError = "file_error" in message && typeof message.file_error === "string" ? message.file_error : null;
      const playlistEntryId =
        "playlist_entry_id" in message && typeof message.playlist_entry_id === "number"
          ? message.playlist_entry_id
          : null;
      const log = reason === "error" ? logger.warn.bind(logger) : logger.info.bind(logger);
      log({ launchId: this.launchId, reason, fileError, playlistEntryId }, "mpv end-file event");
      if (reason === "quit") this.quitRequested = true;
      this.emitter.emit("end-file", { reason, fileError, playlistEntryId });
      return;
    }
    if (evt === "shutdown") {
      logger.info({ launchId: this.launchId }, "mpv shutdown event");
      this.quitRequested = true;
      return;
    }
    if (evt === "start-file") {
      const playlistEntryId =
        "playlist_entry_id" in message && typeof message.playlist_entry_id === "number"
          ? message.playlist_entry_id
          : null;
      logger.info({ launchId: this.launchId, playlistEntryId }, "mpv start-file event");
      this.emitter.emit("start-file", { playlistEntryId });
      return;
    }
    if (evt === "file-loaded") {
      // The backdrop handoff's load confirmation when the `loadfile` reply
      // itself timed out on a loaded PC (issue #25 P17).
      logger.info({ launchId: this.launchId }, "mpv file-loaded event");
      this.readaheadRestorePending = true;
      this.emitter.emit("file-loaded");
      return;
    }
    if (evt === "playback-restart") {
      // mpv's order is file-loaded → demuxer-cache-wait → `start=` seek →
      // playback-restart, so the first restart after file-loaded is the
      // first moment a first-GOP prefill (`cache-secs=<window>`) is done.
      // Restoring at file-loaded would stretch that prefill back to the
      // full readahead. Later restarts (user seeks) leave cache-secs alone.
      if (!this.readaheadRestorePending) return;
      this.readaheadRestorePending = false;
      this.emitter.emit("first-playback-restart");
      if (!this.readaheadSecs) return;
      const readaheadSecs = this.readaheadSecs;
      logger.info({ launchId: this.launchId, readaheadSecs }, "mpv first playback-restart of the file: restoring cache-secs readahead");
      void this.setProperty("cache-secs", readaheadSecs).then(
        (ok) => {
          if (!ok) logger.warn({ launchId: this.launchId, readaheadSecs }, "restoring cache-secs readahead failed (mpv rejected)");
        },
        (error: unknown) => {
          logger.warn(
            { launchId: this.launchId, readaheadSecs, error: error instanceof Error ? error.message : String(error) },
            "restoring cache-secs readahead failed",
          );
        },
      );
      return;
    }
  }

  /**
   * Poll `time-pos` until mpv responds with a usable shape, up to 12
   * attempts with 150 ms + attempt × 25 ms backoff. Mirrors
   * externalMpvController.ts:58 `ensureExternalReady`. Idempotent —
   * concurrent callers share the same in-flight promise.
   *
   * The timeoutMs argument caps the total wall time; the per-attempt
   * backoff is still applied for the first 12 attempts.
   */
  async waitForReady(timeoutMs: number): Promise<boolean> {
    if (this.readyPromise) return await this.readyPromise;
    this.readyPromise = (async () => {
      const deadline = Date.now() + timeoutMs;
      for (let attempt = 0; attempt < READY_ATTEMPTS; attempt += 1) {
        if (Date.now() >= deadline) break;
        try {
          const result = await this.request(buildGetPropertyCommand("time-pos"));
          if (isExternalMpvResponseReady(result)) {
            return true;
          }
        } catch {
          // wait and retry
        }
        const sleepFor = Math.min(
          READY_BASE_DELAY_MS + attempt * READY_DELAY_INCREMENT_MS,
          Math.max(0, deadline - Date.now()),
        );
        if (sleepFor <= 0) break;
        await new Promise((resolve) => setTimeout(resolve, sleepFor));
      }
      return false;
    })();
    try {
      return await this.readyPromise;
    } finally {
      this.readyPromise = null;
    }
  }

  /**
   * Idempotent teardown:
   *   1. Send `quit` to mpv (best-effort).
   *   2. No success reply (error, timeout, socket gone): SIGTERM the mpv
   *      process GROUP now and SIGKILL it after 700 ms.
   *      Success reply: SIGTERM the group after 700 ms if it is still
   *      alive, SIGKILL after another 700 ms.
   *   3. Unlink the socket file.
   *   4. Stop OSC polling and unlink the action file.
   *   5. Optionally remove the data dir (SF_MPV_CLEAN_DATA_DIR_ON_STOP=1).
   *   6. Flip state to "disposed".
   *
   * Signals go to the group, not the spawned pid: the retired AppImage build
   * put a wrapper chain above the real mpv and a hung mpv outlived the app by
   * ~20 min (issue #25 P21); the group still covers every surviving member. The escalation timers die with
   * Electron, so `killAllMpvProcessGroupsSync` (process exit) backs them up.
   */
  async dispose(): Promise<void> {
    if (this._state === "disposed") return;
    // Tier-5 — model dispose() as a user-initiated stop so the lifecycle
    // reducer's transition table runs (e.g. playing → stopping with
    // hide_window/stop_osc_polling/kill effects). The actual side effects
    // are still performed by the imperative code below; the dispatch
    // here keeps the reducer state in sync so subscribers see a coherent
    // transition before the process_exited path fires below.
    this.dispatchLifecycle({ type: "user_stop" });
    // Mark disposing first so the event-socket close handler doesn't
    // try to reconnect on the way out.
    this.disposing = true;
    // Tear down the persistent event-stream socket + subscription
    // registry. Flushing any pending throttled callbacks would push
    // stale state into a disposed client, so we cancel them instead.
    if (this.eventReconnectTimer) {
      clearTimeout(this.eventReconnectTimer);
      this.eventReconnectTimer = null;
    }
    if (this.eventSocket) {
      try {
        this.eventSocket.end();
      } catch {
        // ignore
      }
      this.eventSocket = null;
    }
    this.eventBuffer = "";
    this.observeRequestIds.clear();
    this.timePosGate.cancel();
    for (const subs of this.subscriptions.values()) {
      for (const sub of subs) {
        if (sub.throttle) sub.throttle.cancel();
      }
    }
    this.subscriptions.clear();
    const processToStop = this.mpvProcess;
    const pgid = this.processGroupId;
    if (processToStop && pgid !== null) {
      const result = await this.command({ command: ["quit"] }).catch((error: unknown) => {
        logger.warn(
          { launchId: this.launchId, error: error instanceof Error ? error.message : String(error) },
          "quit request failed",
        );
        return null;
      });
      const quitAcknowledged = result?.error === "success";
      logger.info({ launchId: this.launchId, pgid, quitAcknowledged, reply: result?.error ?? null }, "dispose: quit sent");
      this.terminateProcessGroup(pgid, quitAcknowledged ? "quit_acknowledged" : "quit_unanswered", !quitAcknowledged);
      this.mpvProcess = null;
    }

    const stoppedSocketPath = this.socketPath;
    if (stoppedSocketPath) {
      getDesktopPlatform().mpvIpc.remove(stoppedSocketPath);
      this.socketPath = null;
    }

    if (this.dataDir && process.env.SF_MPV_CLEAN_DATA_DIR_ON_STOP === "1") {
      try {
        rmSync(this.dataDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    this.dataDir = null;

    this.stopOscActionPolling();
    this._state = "disposed";
  }

  /**
   * Drive the mpv process group to death. `sigtermNow` sends SIGTERM at
   * once (mpv did not answer `quit`, or the leader already died); otherwise
   * mpv gets KILL_TIMEOUT_MS to exit on its own before SIGTERM. SIGKILL
   * follows KILL_TIMEOUT_MS after the SIGTERM. Each step re-probes the
   * group and untracks it once empty, so the exit safety net never signals
   * a recycled pgid.
   */
  private terminateProcessGroup(pgid: number, reason: string, sigtermNow: boolean): void {
    const launchId = this.launchId;
    const stepOrDone = (signal: "SIGTERM" | "SIGKILL"): boolean => {
      if (!isMpvProcessGroupAlive(pgid)) {
        untrackMpvProcessGroup(pgid);
        logger.info({ launchId, pgid, reason }, "mpv process group gone");
        return true;
      }
      logger.warn({ launchId, pgid, reason, signal }, "mpv process group still alive; signalling");
      signalMpvProcessGroup(pgid, signal);
      return false;
    };
    const sigtermThenSigkill = () => {
      if (stepOrDone("SIGTERM")) return;
      setTimeout(() => {
        if (stepOrDone("SIGKILL")) return;
        setTimeout(() => {
          if (!isMpvProcessGroupAlive(pgid)) untrackMpvProcessGroup(pgid);
        }, KILL_TIMEOUT_MS);
      }, KILL_TIMEOUT_MS);
    };
    if (sigtermNow) sigtermThenSigkill();
    else setTimeout(sigtermThenSigkill, KILL_TIMEOUT_MS);
  }

  /**
   * True when the underlying mpv process is alive (kill-with-signal-0
   * probe): a video is open (the upload policy's signal).
   */
  isAlive(): boolean {
    const process = this.mpvProcess;
    if (!process || !process.pid) return false;
    try {
      globalThis.process.kill(process.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * True when mpv can still take a command such as `loadfile`: alive and not
   * quitting. Answers `sf-mpv-external-alive`, which picks reuse vs launch.
   * A quit mpv closes its IPC socket at once but its process can take a second
   * or more to exit; a Play in that window used to send `loadfile` to the dead
   * socket, then the late exit closed the player and the Play was lost.
   * @bugfix @regression-proof badger-replay-after-quit
   */
  isAcceptingCommands(): boolean {
    return !this.quitRequested && this.isAlive();
  }

  private startOscActionPolling(filePath: string): void {
    this.stopOscActionPolling();
    this.oscActionFilePath = filePath;
    // @bugfix @regression-proof issue #25 P14: a poll suspended in readFile
    // when polling stops (mpv killed → process exit) used to resume, compare
    // the file's OLD action to the `lastOscActionPayload` stop had just reset
    // to null, and emit it again. Main stored it as the pending action and the
    // next controller mount replayed it: the app jumped an episode. Every
    // poll is bound to the polling generation it started in and drops its
    // result once that generation is over.
    const generation = this.oscPollGeneration;
    let busy = false;
    // A watch event that lands while a read is in flight: the in-flight read may
    // predate the write, so run once more when it finishes.
    let rerun = false;
    const poll = async () => {
      if (busy || !this.oscActionFilePath || !existsSync(this.oscActionFilePath)) return;
      busy = true;
      try {
        const raw = (await fs.readFile(this.oscActionFilePath, "utf8")).trim();
        if (generation !== this.oscPollGeneration) {
          logger.info(
            { launchId: this.launchId, generation, current: this.oscPollGeneration, bytes: raw.length },
            "osc action poll finished after polling stopped; dropping its read",
          );
          return;
        }
        if (!raw || raw === this.lastOscActionPayload) return;
        this.lastOscActionPayload = raw;
        const parseResult = oscActionFileSchema.safeParse(JSON.parse(raw));
        if (!parseResult.success) return;
        logger.info({ launchId: this.launchId, generation, action: parseResult.data }, "osc action read from file");
        this.emitter.emit("osc-action", parseResult.data);
      } catch {
        // ignore transient read/parse errors while sf.lua is writing
      } finally {
        busy = false;
        if (rerun) {
          rerun = false;
          if (generation === this.oscPollGeneration) void poll();
        }
      }
    };
    let pollIntervalMs = OSC_POLL_INTERVAL_MS;
    try {
      // persistent:false — the watcher must never keep the process alive.
      this.oscActionWatcher = watch(filePath, { persistent: false }, () => {
        if (busy) rerun = true;
        else void poll();
      });
      this.oscActionWatcher.on("error", (error) => {
        logger.warn(
          { launchId: this.launchId, error: error instanceof Error ? error.message : String(error) },
          "osc action watcher failed; back to the 150 ms poll",
        );
        this.oscActionWatcher?.close();
        this.oscActionWatcher = null;
        if (generation !== this.oscPollGeneration) return;
        if (this.oscActionPollTimer) clearInterval(this.oscActionPollTimer);
        this.oscActionPollTimer = setInterval(() => {
          void poll();
        }, OSC_POLL_INTERVAL_MS);
      });
      pollIntervalMs = OSC_WATCHED_FALLBACK_POLL_INTERVAL_MS;
    } catch (error) {
      logger.warn(
        { launchId: this.launchId, error: error instanceof Error ? error.message : String(error) },
        "osc action file cannot be watched; polling every 150 ms",
      );
    }
    this.oscActionPollTimer = setInterval(() => {
      void poll();
    }, pollIntervalMs);
  }

  private stopOscActionPolling(): void {
    this.oscPollGeneration += 1;
    if (this.oscActionPollTimer) {
      clearInterval(this.oscActionPollTimer);
      this.oscActionPollTimer = null;
    }
    this.oscActionWatcher?.close();
    this.oscActionWatcher = null;
    this.lastOscActionPayload = null;
    if (this.oscActionFilePath) {
      try {
        unlinkSync(this.oscActionFilePath);
      } catch {
        // ignore
      }
      this.oscActionFilePath = null;
    }
  }

  /**
   * Allow tests / hot-reload scenarios to recreate the global instance
   * counter. Production code should never call this — every long-running
   * counter naturally wraps around well before causing issues.
   */
  static __resetLaunchIdForTests(): void {
    nextLaunchId = 1;
  }
}

/**
 * Write an empty OSC action file in advance so the polling loop has
 * something to read. Mirrors the writeFileSync at externalMpv.ts:454.
 * Exposed for use by the launch flow in externalMpv.ts (task D).
 */
export const initializeOscActionFile = (filePath: string): void => {
  writeFileSync(filePath, "", "utf8");
};
