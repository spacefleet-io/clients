// MUST stay the first import: prepares the data dir before any store reads it (see the module).
import "./prepareDataDir";
import crypto from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { ServerWebSocket } from "bun";
import { getDesktopPlatform } from "@space/desktop-platform";
import { createApp, setRuntimeJobsV2Handler } from "./app";
import { guardRequest, resolveCorsAcaoOrigin } from "./requestGuard";
import { getRuntimeConfig } from "./config";
import { readBearerToken } from "./auth";
import { lifecycleManager, ownerLoginGate, runtimeState } from "./runtime";
import { publishOwnerSecret, type OwnerSecretFile } from "./core/ownerSecret";
import { WS_CLOSE_SESSION_EXPIRED } from "./state";
import { isValidWsServerFrame, parseWsClientFrame } from "./validation";
import type { RuntimeEventFrame } from "./types";
import { createEngineV2, type EngineV2 } from "./core/jobs/engineV2";
import { getEffectiveCpuCount } from "@space/ffmpeg/hostCpu";
import {
  assertNoRuntimeAlready,
  releaseRuntimePidFile,
} from "./runtimePidGuard";
import {
  createEventLog,
  type EventLog,
} from "./core/jobs/eventLog";
import { createSqliteEventLogDeps } from "./core/jobs/sqliteEventLogDeps";
import {
  createSqliteRuntimeJobsStore,
  type SqliteRuntimeJobsStore,
} from "./core/jobs/sqliteStore";
import {
  createRuntimeJobsV2Handler,
  type RuntimeJobsV2Handler,
} from "./routes/runtimeJobsV2";
import { registerBadgerStepHandlers } from "./modules/badger/steps";
import { getApiBaseUrl } from "@space/library-db-runtime";
import {
  getBadgerSessionUserId,
  setBadgerSessionChangedListener,
  setEngineV2ForBadgerIngest,
  shutdownBadgerModule,
} from "./modules";
import {
  setEngineV2BootStatus,
  resolveEngineV2UnavailableError,
} from "./core/jobs/engineV2BootStatus";
import { runtimeEventLoopMonitor } from "./core/eventLoopMonitor";
import { runShutdownDrain } from "./core/shutdown";
import { armShutdownWatchdog } from "./core/shutdownWatchdog";
import { uploadPlaybackGate } from "@space/content-core/storageTransport";
import { encodePlaybackGate } from "@space/ffmpeg/playbackGate";
import { bindEncodeGateToPlaybackLease } from "./core/encodePlaybackBinding";

// The compiled runtime cannot resolve bun's drizzle adapter through the library-db loader's createRequire.
// Imported only under Bun: vitest (Node) imports this entry and has no bun:sqlite.
if (typeof Bun !== "undefined") {
  (await import("@space/library-db-runtime/bunSqlite")).registerBunSqlite();
}

const app = createApp();
const config = getRuntimeConfig();

// Transcode ffmpegs obey the same playback lease as the upload pool (#25):
// one core under `throttle`, frozen under `pause`, full again when it ends.
bindEncodeGateToPlaybackLease(uploadPlaybackGate, encodePlaybackGate);

// ---------------------------------------------------------------------------
// EngineV2 is the default ingestion path. The legacy lab-queue path remains
// in the codebase as a fallback for emergency rollback only — set
// `RUNTIME_ENGINE_V2=0` (or `=false`) to disable v2 boot. The legacy module
// still runs alongside v2 either way; consumers route by feature flag.
// ---------------------------------------------------------------------------
const isEngineV2Enabled = (): boolean => {
  const raw = process.env.RUNTIME_ENGINE_V2?.trim().toLowerCase();
  // Default ON; explicit "0" / "false" / "off" / "no" disables.
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
};

let engineV2: EngineV2 | null = null;
let v2EventLog: EventLog | null = null;
let v2EventLogStore: SqliteRuntimeJobsStore | null = null;
let v2Handler: RuntimeJobsV2Handler | null = null;

const logBootBanner = (lines: string[]): void => {
  const bar = "=".repeat(78);
  console.error(`\n${bar}`);
  for (const line of lines) console.error(line);
  console.error(`${bar}\n`);
};

// ---------------------------------------------------------------------------
// Round-11 K3 (L1): port-bind pre-flight. Refuse to boot a second runtime
// when the runtime port is already serving — the dual-spawn race (round-10
// forensics) torches in-flight ingest jobs by ticking the engine once with
// an empty in-memory cache before crashing on EADDRINUSE.
//
// L1 probes the TCP port (not PID liveness): ports release immediately on
// process exit, so this is racing-respawn-safe under RuntimeGuardian. The
// PID file is still written (kill-target observability) but does not gate
// the boot decision — port-bind is the source of truth.
//
// The probe happens here (the data dir was prepared by ./prepareDataDir) because the rest of the boot may short-circuit
// out via process.exit(0) inside the helper. We tolerate VITEST because
// tests don't want to touch a shared global TCP port.
// ---------------------------------------------------------------------------
if (!process.env.VITEST) {
  const pidPath = path.join(config.runtimeDataDir, "runtime.pid");
  await assertNoRuntimeAlready({ pidPath, runtimePort: config.port });
}

// RT-SEC-05: the owner secret login requires. It is published (owner-only) right after the port is bound, see the
// end of this file: a runtime that fails to bind (a concurrent start that lost the port race) must never overwrite
// the winner's secret. The login gate holds the secret in memory from boot and refuses everything meanwhile.
let ownerSecretFile: OwnerSecretFile | null = null;

if (isEngineV2Enabled()) {
  try {
    mkdirSync(config.runtimeDataDir, { recursive: true });
    const v2DbPath = path.join(config.runtimeDataDir, "runtime_jobs.db");
    const hostCpu = getEffectiveCpuCount();
    const engine = createEngineV2({
      dbPath: v2DbPath,
      hostCpuCount: hostCpu.count,
      hostCpuSource: hostCpu.source,
      // RT-JOBS-07: a queued job of another account or server waits until its session is the active one again.
      session: { activeUserId: getBadgerSessionUserId, apiOrigin: getApiBaseUrl },
    });
    engineV2 = engine;
    setBadgerSessionChangedListener(() => engine.sessionChanged());
    // Register step handlers BEFORE start() — start() runs the hydration
    // requeue + initial tick(), and an empty handlers Map at that point will
    // hard-fail any queued step with errorCode='no-handler'. Round-4 evidence
    // (2026-05-04, media 37749009) showed an HMR-spawned engineV2 ticking
    // before handler registration and torching the in-flight ingest.
    registerBadgerStepHandlers(engineV2);
    // Wire badger-ingest deps BEFORE start() — same reason as handler registration.
    // start()'s hydration synchronously dispatches queued jobs, which calls into
    // step handlers that pull from getBadgerStepDeps(). If the deps slot is empty
    // at that moment, the handler throws BADGER_STEP_DEPS_NOT_CONFIGURED. Round-9
    // evidence (2026-05-04, source job c03b0c46) reproduced this exact failure.
    // setEngineV2ForBadgerIngest is pure wiring (captures the engine ref into
    // deps + factory); the engine doesn't need to be running yet.
    setEngineV2ForBadgerIngest(engineV2);
    await engineV2.start();

    // Sibling SQLite handle for the v2 WS handler's replay reads. EngineV2's
    // event log is internal; opening a second store at the same path gives the
    // handler access via the same migrated schema (WAL mode allows shared
    // readers; both connections see committed events).
    v2EventLogStore = createSqliteRuntimeJobsStore(v2DbPath);
    v2EventLog = createEventLog(createSqliteEventLogDeps(v2EventLogStore.db));

    v2Handler = createRuntimeJobsV2Handler({
      engine: engineV2,
      eventLog: v2EventLog,
    });
    setRuntimeJobsV2Handler(v2Handler);
    setEngineV2BootStatus({ state: "ready" });
    // Single-line, no object-spread, so the line is atomically flushed to
    // stdout. Object-form logs were observed truncated mid-line by the
    // verifier; downstream tooling needs a deterministic ready signal.
    console.info(`[runtime] engineV2 ready dbPath=${v2DbPath}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error && err.stack ? err.stack : message;
    logBootBanner([
      "[runtime] !!! ENGINE V2 BOOT FAILED !!!",
      "[runtime] Every /runtime/jobs/v2/* and /runtime/events/jobs/v2/stream endpoint",
      "[runtime] will return 503 { error: 'engine_v2_boot_failed' } until the",
      "[runtime] underlying issue is fixed AND the runtime is restarted.",
      "[runtime] Legacy badger.ingest.apply / submit_sources commands will",
      "[runtime] also short-circuit with the same error envelope.",
      "[runtime] Exception:",
      stack,
    ]);
    engineV2 = null;
    v2EventLog = null;
    v2EventLogStore = null;
    v2Handler = null;
    setRuntimeJobsV2Handler(null);
    setEngineV2BootStatus({ state: "boot_failed", message });
  }
} else {
  logBootBanner([
    "[runtime] !!! ENGINE V2 DISABLED !!!",
    "[runtime] RUNTIME_ENGINE_V2 is set to a falsy value. EngineV2 endpoints",
    "[runtime] will return 503 { error: 'engine_v2_disabled' } and badger",
    "[runtime] ingest commands will be inert.",
    "[runtime] To re-enable: unset RUNTIME_ENGINE_V2 (default ON) or set it",
    "[runtime] to '1' and restart the runtime.",
  ]);
  setEngineV2BootStatus({ state: "disabled" });
}

/** Test seam — Phase D glue may need the engineV2 instance for module wiring. */
export const getEngineV2ForBootstrap = (): EngineV2 | null => engineV2;

// ---------------------------------------------------------------------------
// Round-13 #4 (a): the legacy `/runtime/events/jobs/v2` WebSocket endpoint
// was deleted after the SSE migration shipped (round 6+). Only the legacy
// `/runtime/events` channel remains on the WS upgrade path; the v2 channel
// is SSE-only via `/runtime/events/jobs/v2/stream`. There is no rollback
// hatch — if the WS endpoint is ever needed again, revert this commit.
// ---------------------------------------------------------------------------
type LegacyWsData = {
  token: string;
  subscriberId: string;
};
type WsData = LegacyWsData;

function serverLog(message: string, data?: Record<string, unknown>) {
  if (data) {
    console.info(`[runtime] ${message}`, data);
    return;
  }
  console.info(`[runtime] ${message}`);
}

serverLog("listening", { host: config.host, port: config.port });
serverLog("started", { pid: process.pid });

// Event-loop lag monitor (#25 P1): logs `[runtime] event-loop stall` with
// the in-flight commands whenever the loop runs ≥1 s late, and feeds
// /runtime/health + the memory line below. Always on.
runtimeEventLoopMonitor.start();

// Periodic memory line (#25): RSS + heap + the sizes of every RuntimeState
// structure that grows with traffic, so a growing runtime in a stress run
// or a user's log says WHICH structure grew. 60 s default; 0 disables.
const memoryLogMs = Number(process.env.RUNTIME_MEMORY_LOG_MS ?? 60_000);
if (Number.isFinite(memoryLogMs) && memoryLogMs > 0) {
  const toMb = (bytes: number) => Math.round(bytes / 1024 / 1024);
  setInterval(() => {
    const mem = process.memoryUsage();
    // One line of JSON so line-based log captures (desktop main, the
    // ultimate suite's timeline) keep each sample whole and greppable.
    console.info(
      `[runtime] memory ${JSON.stringify({
        rssMb: toMb(mem.rss),
        heapUsedMb: toMb(mem.heapUsed),
        heapTotalMb: toMb(mem.heapTotal),
        externalMb: toMb(mem.external),
        arrayBuffersMb: toMb(mem.arrayBuffers),
        ...runtimeState.getMemoryStats(),
        eventLoop: runtimeEventLoopMonitor.snapshot(),
      })}`,
    );
  }, memoryLogMs).unref();
}

/** Must stay below the guardian's SIGTERM→SIGKILL grace (childKillGraceMs,
 *  5 s) so a slow drain still ends in a clean exit, not a SIGKILL. */
const SHUTDOWN_DEADLINE_MS = Number(process.env.RUNTIME_SHUTDOWN_DEADLINE_MS ?? 3_500) || 3_500;
/** The watchdog (a worker thread) SIGKILLs a runtime whose main thread is
 *  stuck past the deadline (#25 P4); still inside the guardian's 5 s grace. */
const SHUTDOWN_WATCHDOG_MS = SHUTDOWN_DEADLINE_MS + 1_000;
/** What the `badgerModule.shutdown` drain step leaves of SHUTDOWN_DEADLINE_MS
 *  for the listener and the closes after it: its close queues behind in-flight
 *  library calls, so the step gets the time left minus this. */
const BADGER_SHUTDOWN_RESERVE_MS = 1_500;

/** Set once Bun.serve() bound the port (never under vitest). */
let runtimeServer: Bun.Server<WsData> | null = null;

let shuttingDown = false;
const shutdown = (signal: string) => {
  serverLog("shutting down", { signal, pid: process.pid, deadlineMs: SHUTDOWN_DEADLINE_MS, eventLoop: runtimeEventLoopMonitor.snapshot() });
  if (shuttingDown) return;
  shuttingDown = true;
  if (!process.env.VITEST) {
    const armed = armShutdownWatchdog(SHUTDOWN_WATCHDOG_MS, { signal, deadlineMs: SHUTDOWN_DEADLINE_MS });
    serverLog("shutdown watchdog armed", { signal, armed, watchdogMs: SHUTDOWN_WATCHDOG_MS });
  }
  // Best-effort, and always exits by SHUTDOWN_DEADLINE_MS even if a step hangs
  // (the watchdog covers a main thread blocked in a synchronous call).
  void runShutdownDrain(
    [
      // #25: a transcode frozen by the `pause` playback policy ignores
      // SIGTERM, so thaw them first, before the engine aborts them and the
      // shutdown deadline starts running out.
      { name: "encodePlaybackGate.shutdown", run: () => encodePlaybackGate.shutdown() },
      // Requeue in-flight jobs and stop the engine (it closes its own DB
      // handle) BEFORE the port frees: a relaunched runtime must never tick a
      // second engine on runtime_jobs.db while this one still writes.
      { name: "engineV2.stop", run: () => engineV2?.stop() },
      // RT-LIFE-04: stop the Badger module and close the library DB, the only
      // place a scheduled cache persist is flushed. After the engine (its jobs
      // are requeued) and before the port frees, so a relaunched runtime never
      // opens the library cache while this one still writes it.
      // The close waits behind every library call already queued on the DB gate
      // (stress runs recorded 13-336 s waits), so the drain bounds this step to
      // the time left minus BADGER_SHUTDOWN_RESERVE_MS. Past that the close is
      // abandoned (a deferred cache persist may be lost; a late failure is
      // logged) and the listener still frees the port inside the deadline.
      {
        name: "badgerModule.shutdown",
        run: () => shutdownBadgerModule(),
        limitMs: (remainingMs) => remainingMs - BADGER_SHUTDOWN_RESERVE_MS,
      },
      // #25 P4: free the port now. The closes below can block for seconds on
      // a stalled disk (the last connection checkpoints + fsyncs the WAL); a
      // reopened app must not wait for them.
      {
        name: "listener.stop",
        run: () => {
          if (!runtimeServer) return;
          const startedAt = Date.now();
          runtimeServer.stop(true);
          serverLog("shutdown listener closed", { signal, port: config.port, ms: Date.now() - startedAt });
        },
      },
      // RT-SEC-05: the secret dies with the process. Only if the file is still
      // ours (remove() compares content), so a relaunched runtime keeps its own.
      { name: "ownerSecret.remove", run: () => ownerSecretFile?.remove() },
      { name: "v2EventLogStore.close", run: () => v2EventLogStore?.close() },
      // Round-11 K3: drop the PID file so the next runtime boot doesn't see a
      // stale PID and waste a liveness probe. Best-effort — friendly cleanup,
      // not a correctness requirement (the next boot's `process.kill(pid, 0)`
      // probe handles a stale file fine). Only our own pid: a relaunched
      // runtime may already own the file (#25 P4).
      {
        name: "releaseRuntimePidFile",
        run: () => {
          if (!process.env.VITEST) releaseRuntimePidFile(path.join(config.runtimeDataDir, "runtime.pid"), process.pid);
        },
      },
    ],
    {
      signal,
      deadlineMs: SHUTDOWN_DEADLINE_MS,
      exit: (code) => {
        if (!process.env.VITEST) process.exit(code);
      },
    },
  );
};
// Stoppable through the platform's graceful-stop channel (SIGTERM / SIGINT on
// Linux, the `sf-stop-<pid>` named pipe + Ctrl+C on Windows, where SIGTERM
// would be a forced kill that skips this drain).
getDesktopPlatform().processes.gracefulStop.install(shutdown, (reason) =>
  console.error(`[runtime] not gracefully stoppable (${reason}); a stop request will end in a forced kill without the drain`)
);
// No app left after the lifecycle grace: drain like SIGTERM so in-flight
// jobs requeue and their encoders are aborted (#25). shutdown() ignores the
// call if a drain is already running.
lifecycleManager.bindShutdown({
  shutdown,
  getActiveJobIds: async () =>
    engineV2 ? (await engineV2.list({ status: ["running"] })).jobs.map((job) => job.jobId) : [],
});

const sendFrame = (ws: ServerWebSocket<LegacyWsData>, frame: RuntimeEventFrame) => {
  if (!isValidWsServerFrame(frame)) return;
  ws.send(JSON.stringify(frame));
};

/**
 * The live app session behind a stream request: bearer header first, else the
 * `?token=` query that browsers need because `EventSource` and `WebSocket`
 * cannot set headers. `null` for a missing, unknown or expired token, and for
 * a tool session (DEV-LIB-01: tools never get a stream).
 */
const sessionFromStreamRequest = (request: Request, url: URL) => {
  const candidate = readBearerToken(request.headers.get("authorization")) ?? ((url.searchParams.get("token") ?? "").trim() || null);
  const session = candidate ? runtimeState.requireSession(candidate) : null;
  return session?.kind === "app" ? session : null;
};

export const createRuntimeServerDefinition = () => ({
  hostname: config.host,
  port: config.port,
  fetch: async (request: Request, server: Bun.Server<WsData>) => {
    // Host / Origin lockdown (RT-SEC-01): covers the SSE stream and the
    // WebSocket upgrade, which run before the Hono app and its middleware.
    const refused = guardRequest(request);
    if (refused) return refused;
    const url = new URL(request.url);

    // -----------------------------------------------------------------------
    // V2 channel — SSE only. The legacy WebSocket endpoint at
    // `/runtime/events/jobs/v2` was removed in round-13 #4 after the SSE
    // migration shipped in round 6+. SSE is the sole transport for v2.
    //
    // Wire format: each event is a single SSE frame
    //   id: <eventId>\nevent: <eventName>\ndata: <jsonPayload>\n\n
    // The first frame is the handshake; on replay overflow we emit a
    // single `event: replay_overflow` frame and end the stream so the client
    // falls back to a snapshot fetch + reconnect.
    // -----------------------------------------------------------------------
    if (
      url.pathname === "/runtime/events/jobs/v2/stream" &&
      request.method === "GET"
    ) {
      // CORS: this branch runs BEFORE Hono so the cors() middleware does not
      // apply. The renderer (http://localhost:3007) is a different origin
      // from the runtime (http://127.0.0.1:3020) and Chromium's EventSource
      // surfaces a missing ACAO header as a bare `net::ERR_FAILED` with no
      // readable response body. Resolve the echo via the same trust model
      // the Hono middleware uses (apps/runtime/src/app.ts:35), and apply it
      // to every Response returned from this branch — 401, 503, and the
      // 200 stream — so the browser can read the status code regardless.
      const requestOrigin = request.headers.get("origin");
      const allowOrigin = resolveCorsAcaoOrigin(requestOrigin);
      const corsHeaders: Record<string, string> = allowOrigin
        ? {
            "access-control-allow-origin": allowOrigin,
            vary: "Origin",
          }
        : {};

      // Token BEFORE the v2-availability answer (RT-SEC-02): an unauthenticated
      // caller must not learn whether EngineV2 booted.
      const session = sessionFromStreamRequest(request, url);
      if (!session) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json", ...corsHeaders },
        });
      }
      const token = session.token;
      if (!v2Handler) {
        const errorBody = resolveEngineV2UnavailableError() ?? {
          error: "engine_v2_not_ready",
          message: "EngineV2 handler missing despite ready boot status",
        };
        return new Response(JSON.stringify(errorBody), {
          status: 503,
          headers: { "content-type": "application/json", ...corsHeaders },
        });
      }

      // Resolve `lastEventId`. EventSource sends `Last-Event-ID` automatically
      // on reconnect; a `?lastEventId=N` query param is the manual fallback
      // for non-EventSource clients (e.g. our test harness, curl smoke).
      const lastEventIdHeader = request.headers.get("last-event-id");
      const lastEventIdQuery = url.searchParams.get("lastEventId");
      const parseLastEventId = (raw: string | null): number => {
        if (!raw) return 0;
        const n = Number(raw.trim());
        if (!Number.isFinite(n) || n < 0) return 0;
        return Math.floor(n);
      };
      const lastEventId =
        parseLastEventId(lastEventIdHeader) ||
        parseLastEventId(lastEventIdQuery);

      // Bun.serve applies a per-request idle timeout (default 10s) to every
      // request — when the body has had no new bytes written within that
      // window, Bun terminates the chunked-transfer body with no terminating
      // 0-length chunk, surfacing as `net::ERR_INCOMPLETE_CHUNKED_ENCODING`
      // in Chromium. SSE streams are long-lived by design, so we clear the
      // idle timeout for this request specifically before handing off the
      // stream. The 20s heartbeat below is now defence-in-depth (proxies,
      // not Bun itself).
      try {
        server.timeout(request, 0);
      } catch {
        // Older Bun versions may not expose `timeout()` on the test harness;
        // the heartbeat covers that case.
      }

      const encoder = new TextEncoder();
      let sseHandle: { unsubscribe(): void } | null = null;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          let streamClosed = false;
          const writeFrame = (frame: string) => {
            if (streamClosed) return;
            try {
              controller.enqueue(encoder.encode(frame));
            } catch {
              streamClosed = true;
            }
          };
          const closeStream = () => {
            if (streamClosed) return;
            streamClosed = true;
            if (heartbeatTimer) {
              clearInterval(heartbeatTimer);
              heartbeatTimer = null;
            }
            try {
              controller.close();
            } catch {
              // already closed
            }
          };

          // RT-SEC-02: the session is re-checked on every frame and heartbeat;
          // once it is logged out or expired the stream ends (the client
          // re-logs in on reconnect) and nothing more is written.
          const writeWhileSessionLives = (frame: string) => {
            if (streamClosed) return;
            if (!runtimeState.requireSession(token)) {
              try {
                sseHandle?.unsubscribe();
              } catch {
                // best-effort
              }
              sseHandle = null;
              closeStream();
              return;
            }
            writeFrame(frame);
          };

          // Hand off to the route handler. It owns the handshake + replay +
          // live-attach sequencing.
          sseHandle = v2Handler!.handleSseSubscribe({
            lastEventId,
            scopes: [...session.scopes],
            write: writeWhileSessionLives,
            close: closeStream,
          });

          // 20s keep-alive comments. SSE comments start with `:` and are
          // ignored by EventSource clients but keep proxies/load balancers
          // from killing an idle connection. Tests override via
          // `RUNTIME_JOBS_V2_SSE_HEARTBEAT_MS` so we don't need 20s waits.
          const heartbeatRaw =
            process.env.RUNTIME_JOBS_V2_SSE_HEARTBEAT_MS?.trim();
          const heartbeatParsed = Number(heartbeatRaw ?? "");
          const heartbeatMs =
            Number.isFinite(heartbeatParsed) && heartbeatParsed > 0
              ? heartbeatParsed
              : 20_000;
          heartbeatTimer = setInterval(() => {
            writeWhileSessionLives(":heartbeat\n\n");
          }, heartbeatMs);
        },
        cancel() {
          // Client disconnected. Tear down the live subscription + timer.
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
          }
          if (sseHandle) {
            try {
              sseHandle.unsubscribe();
            } catch {
              // best-effort
            }
            sseHandle = null;
          }
        },
      });

      return new Response(stream, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
          "x-accel-buffering": "no",
          ...corsHeaders,
        },
      });
    }

    // -----------------------------------------------------------------------
    // Legacy channel — unchanged.
    // -----------------------------------------------------------------------
    if (url.pathname === "/runtime/events") {
      const session = sessionFromStreamRequest(request, url);
      if (!session) {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
      }
      const token = session.token;
      const subscriberId = crypto.randomUUID();
      const upgraded = server.upgrade(request, {
        data: {
          token,
          subscriberId,
        },
      });
      if (upgraded) return;
      return new Response(JSON.stringify({ error: "upgrade_failed" }), { status: 400 });
    }
    return app.fetch(request);
  },
  websocket: {
    open(ws: ServerWebSocket<WsData>) {
      // Round-13 #4 (a): only the legacy `/runtime/events` channel reaches
      // this handler now — the v2 WS endpoint was deleted in favour of SSE
      // at `/runtime/events/jobs/v2/stream`.
      const data = ws.data;
      runtimeState.addSubscriber(
        data.subscriberId,
        data.token,
        (frame) => sendFrame(ws as ServerWebSocket<LegacyWsData>, frame),
        // A dropped (logged-out / expired) session closes the socket so the
        // client's reconnect loop re-logs in instead of listening to silence.
        () => ws.close(WS_CLOSE_SESSION_EXPIRED, "session_expired")
      );
    },
    message(ws: ServerWebSocket<WsData>, message: string | Buffer) {
      if (typeof message !== "string") {
        ws.send(JSON.stringify({ error: "invalid_payload" }));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(message);
      } catch {
        ws.send(JSON.stringify({ error: "invalid_payload" }));
        return;
      }
      const frame = parseWsClientFrame(parsed);
      if (!frame) {
        ws.send(JSON.stringify({ error: "invalid_payload" }));
        return;
      }
      const data = ws.data;
      const replay = runtimeState.applyClientFrame(data.subscriberId, frame);
      for (const event of replay) {
        sendFrame(ws as ServerWebSocket<LegacyWsData>, event);
      }
    },
    close(ws: ServerWebSocket<WsData>) {
      const data = ws.data;
      runtimeState.removeSubscriber(data.subscriberId);
    },
  },
});

// An explicit server (not Bun's auto-served `export default`) so the shutdown
// drain can close the listener and free the port before its slow steps
// (#25 P4). Tests drive createRuntimeServerDefinition() themselves.
if (!process.env.VITEST) runtimeServer = Bun.serve(createRuntimeServerDefinition());

// RT-SEC-05: publish the owner secret now that this runtime owns the port. Bun.serve() returned synchronously, so no
// request was served yet. When the file cannot be written the runtime refuses to serve: apps could not log in, and
// serving without the gate is not an option.
if (runtimeServer) {
  try {
    ownerSecretFile = publishOwnerSecret({
      dir: config.runtimeDataDir,
      secret: ownerLoginGate.secret,
      paths: getDesktopPlatform().paths,
    });
    console.info(`[runtime] owner secret published at ${ownerSecretFile.path}`);
  } catch (error) {
    console.error(`[runtime] ${error instanceof Error ? error.message : String(error)}; refusing to start`);
    runtimeServer.stop(true);
    process.exit(1);
  }
}
