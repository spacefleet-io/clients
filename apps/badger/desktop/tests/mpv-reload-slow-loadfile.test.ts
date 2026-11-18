/**
 * @bugfix mpv-reload-slow-loadfile-closed-playback
 * @regression-proof
 *
 * Issue #25 P15 (ultimate s3 x018 ABR 1080p→360p, x042). The alive-mpv
 * reload (quality / ABR switch) sent `loadfile ... replace` through the
 * boolean `sendExternalCommand`. On a loaded 4-core PC mpv's reply missed
 * UnixSocketMpvClient's 1 s request budget, the boolean came back false, and
 * the engine read that as "mpv is dead": it threw
 * `playback_external_loadfile_failed` and the player closed with "We couldn't
 * start playback". mpv was alive: its log (shard-3 mpv-15, lines 905-909)
 * shows the late `loadfile` running.
 *
 * Fix: `awaitReloadLoadfile`. mpv is dead only when its process exited, its
 * socket is gone (a transport failure that survives the re-sends), or mpv
 * itself rejected the file / reported an end-file error. A timed-out reply
 * waits for `file-loaded` / `end-file` / exit; at the deadline one
 * `idle-active` probe tells a hung mpv (no reply → fail) from a slow one.
 *
 * These tests drive the REAL UnixSocketMpvClient against a fake mpv socket,
 * through the same reply mapping as main's `sf-mpv-external-command` /
 * `sf-mpv-external-request` IPC handlers. Real timers on purpose: the bug IS
 * the race between mpv's late reply on a real Unix socket and the client's
 * real 1 s request timer, which fake timers do not drive. Fake-mpv delays
 * stay at ~1.5 s per case.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  awaitReloadLoadfile,
  classifyExternalLoadSignal,
  createNewEntryEndFileFilter,
  type ExternalLoadVerdict,
} from "@space/desktop-mpv-playback";
import { buildGetPropertyCommand, buildLoadfileCommand } from "@space/mpv-protocol";
import { UnixSocketMpvClient } from "../src/main/mpvSocketClient";

const TAG = "[mpv-reload-slow-loadfile]";

type FakeMpvScript = {
  /** Delay before mpv answers `loadfile`. */
  loadfileReplyDelayMs: number;
  /** Events pushed on the event socket, each after its own delay from the loadfile receipt. */
  eventsAfterLoadfile: Array<{ atMs: number; event: Record<string, unknown> }>;
  /** `idle-active` value mpv answers with; `"hang"` = never answer the probe. */
  idleActive: boolean | "hang";
  /** When set, the "process" exits this long after the loadfile receipt: sockets close, `onExit` fires. */
  exitAtMs?: number;
};

type FakeMpv = {
  log: string[];
  eventSocketReady: Promise<void>;
  exited: Promise<string>;
  stop: () => Promise<void>;
};

const cleanupSocket = (path: string) => {
  if (!existsSync(path)) return;
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
};

const startFakeMpv = async (socketPath: string, script: FakeMpvScript): Promise<FakeMpv> => {
  cleanupSocket(socketPath);
  const started = Date.now();
  const log: string[] = [];
  const note = (line: string) => {
    const entry = `+${Date.now() - started}ms ${line}`;
    log.push(entry);
    console.info(`${TAG} fake-mpv ${entry}`);
  };
  const connections: Socket[] = [];
  let eventSocket: Socket | null = null;
  const eventSocketReady = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<string>();
  const timers: NodeJS.Timeout[] = [];
  const server: Server = createServer((conn) => {
    connections.push(conn);
    let buffer = "";
    conn.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const parsed: unknown = JSON.parse(line);
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          !("command" in parsed) ||
          !Array.isArray(parsed.command) ||
          !("request_id" in parsed)
        ) {
          continue;
        }
        const name = String(parsed.command[0]);
        note(`received ${JSON.stringify(parsed.command)} request_id=${String(parsed.request_id)}`);
        if (name === "observe_property") {
          eventSocket = conn;
          eventSocketReady.resolve();
          conn.write(`${JSON.stringify({ request_id: parsed.request_id, error: "success" })}\n`);
          continue;
        }
        if (name === "get_property" && parsed.command[1] === "idle-active") {
          if (script.idleActive === "hang") {
            note("idle-active probe left unanswered (hung mpv)");
            continue;
          }
          note(`reply idle-active=${script.idleActive}`);
          conn.write(`${JSON.stringify({ request_id: parsed.request_id, error: "success", data: script.idleActive })}\n`);
          continue;
        }
        if (name === "loadfile") {
          for (const { atMs, event } of script.eventsAfterLoadfile) {
            timers.push(
              setTimeout(() => {
                note(`push event ${JSON.stringify(event)}`);
                eventSocket?.write(`${JSON.stringify(event)}\n`);
              }, atMs),
            );
          }
          const exitAtMs = script.exitAtMs;
          if (exitAtMs !== undefined) {
            timers.push(
              setTimeout(() => {
                note("process exit: closing every socket");
                for (const c of connections) c.destroy();
                exited.resolve(`fake mpv exited ${exitAtMs}ms after loadfile`);
              }, exitAtMs),
            );
          }
          timers.push(
            setTimeout(() => {
              note(`reply loadfile error=success (socket destroyed=${conn.destroyed})`);
              if (!conn.destroyed) {
                conn.write(`${JSON.stringify({ request_id: parsed.request_id, error: "success" })}\n`);
              }
            }, script.loadfileReplyDelayMs),
          );
          continue;
        }
        conn.write(`${JSON.stringify({ request_id: parsed.request_id, error: "success" })}\n`);
      }
    });
    conn.on("error", () => undefined);
  });
  const listening = Promise.withResolvers<void>();
  server.listen(socketPath, () => listening.resolve());
  await listening.promise;
  return {
    log,
    eventSocketReady: eventSocketReady.promise,
    exited: exited.promise,
    stop: async () => {
      for (const timer of timers) clearTimeout(timer);
      for (const conn of connections) conn.destroy();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
      cleanupSocket(socketPath);
    },
  };
};

/** Main's IPC handlers map a thrown request error to `{ error: message }`. */
const asIpcReply = (request: Promise<unknown>) =>
  request.catch((error: unknown) => ({ error: error instanceof Error ? error.message : "mpv_command_failed" }));

/**
 * Run one alive-mpv reload the way the engine does: arm file-loaded /
 * end-file / exit before sending, re-send on transport failure, probe
 * idle-active at the deadline.
 */
const runReload = async (client: UnixSocketMpvClient, processExited: Promise<string>, deadlineMs?: number) => {
  const fileLoaded = Promise.withResolvers<void>();
  client.on("file-loaded", () => fileLoaded.resolve());
  const endFileFailure = Promise.withResolvers<ExternalLoadVerdict>();
  // Same filter as the engine: only the new entry's end-file judges the load.
  const newEntry = createNewEntryEndFileFilter();
  client.on("start-file", (event) => {
    newEntry.startFile(event.playlistEntryId);
    console.info(`${TAG} engine saw start-file ${JSON.stringify(event)}`);
  });
  client.on("end-file", (event) => {
    if (!newEntry.isNewEntry(event.playlistEntryId)) {
      console.info(`${TAG} engine ignored end-file of the replaced file ${JSON.stringify(event)} filter=${JSON.stringify(newEntry.state())}`);
      return;
    }
    const verdict = classifyExternalLoadSignal({ kind: "end_file", reason: event.reason, fileError: event.fileError });
    console.info(`${TAG} engine saw end-file ${JSON.stringify(event)} verdict=${JSON.stringify(verdict)}`);
    if (verdict.failed) endFileFailure.resolve(verdict);
  });
  const startedAt = Date.now();
  const sendLoadfile = () =>
    asIpcReply(
      client.command(buildLoadfileCommand("https://example.invalid/360p.m3u8", "replace", { startSeconds: 42 })),
    );
  const reply = sendLoadfile();
  void reply.then((value) => console.info(`${TAG} loadfile reply after ${Date.now() - startedAt}ms: ${JSON.stringify(value)}`));
  const outcome = await awaitReloadLoadfile({
    reply,
    resend: sendLoadfile,
    fileLoaded: fileLoaded.promise,
    endFileFailure: endFileFailure.promise,
    processExited,
    probeIdleActive: () => asIpcReply(client.request(buildGetPropertyCommand("idle-active"))),
    deadlineMs,
  });
  const elapsedMs = Date.now() - startedAt;
  console.info(`${TAG} reload outcome after ${elapsedMs}ms: ${JSON.stringify(outcome)}`);
  return { outcome, elapsedMs, reply: await reply };
};

describe("alive-mpv reload with a slow loadfile reply (issue #25 P15)", () => {
  let socketPath: string;
  let fake: FakeMpv | null = null;
  let client: UnixSocketMpvClient | null = null;

  beforeEach(() => {
    socketPath = join(tmpdir(), `test-mpv-reload-slow-${process.pid}-${Date.now()}.sock`);
  });

  afterEach(async () => {
    await client?.dispose();
    client = null;
    console.info(`${TAG} fake mpv log:\n  ${fake?.log.join("\n  ") ?? "(none)"}`);
    await fake?.stop();
    fake = null;
  });

  const attachClient = async (script: FakeMpvScript) => {
    fake = await startFakeMpv(socketPath, script);
    client = new UnixSocketMpvClient();
    // @ts-expect-error — exercising the live-playback state without spawn.
    client.socketPath = socketPath;
    // @ts-expect-error — same.
    client._state = "ready";
    // Main observes properties as soon as the socket is up; that connects the
    // event socket file-loaded / end-file arrive on.
    client.observe("time-pos", () => undefined);
    await fake.eventSocketReady;
    console.info(`${TAG} client attached script=${JSON.stringify(script)}`);
    return { mpv: client, exited: fake.exited };
  };

  it("@bugfix @regression-proof a loadfile answered after 1.5 s with file-loaded at 1.3 s keeps playback (x018)", async () => {
    const { mpv, exited } = await attachClient({
      loadfileReplyDelayMs: 1500,
      eventsAfterLoadfile: [
        { atMs: 1200, event: { event: "start-file", playlist_entry_id: 2 } },
        { atMs: 1300, event: { event: "file-loaded" } },
      ],
      idleActive: false,
    });
    const { outcome, reply } = await runReload(mpv, exited);
    // The transport still times out at 1 s — the condition the reload used
    // to read as "mpv is dead".
    expect(reply).toEqual({ error: "mpv_request_timeout" });
    expect(outcome.settledBy).toBe("file_loaded");
    expect(outcome.verdict.failed).toBe(false);
  });

  it("@bugfix @regression-proof a timed-out loadfile with no event but a live idle-active=false probe keeps playback", async () => {
    const { mpv, exited } = await attachClient({
      loadfileReplyDelayMs: 60_000,
      eventsAfterLoadfile: [],
      idleActive: false,
    });
    const { outcome } = await runReload(mpv, exited, 600);
    expect(outcome.settledBy).toBe("deadline");
    expect(outcome.verdict).toMatchObject({ failed: false, unconfirmed: true });
    expect(outcome.probeReply).toMatchObject({ error: "success", data: false });
  });

  it("@bugfix @regression-proof mpv exiting while the reload settles fails fast as process_exited", async () => {
    const { mpv, exited } = await attachClient({
      loadfileReplyDelayMs: 60_000,
      eventsAfterLoadfile: [],
      idleActive: false,
      exitAtMs: 1300,
    });
    const { outcome, elapsedMs } = await runReload(mpv, exited);
    expect(outcome.settledBy).toBe("end_file");
    expect(outcome.verdict).toMatchObject({ failed: true, cause: "process_exited" });
    // Settles on the exit, not the 10 s deadline.
    expect(elapsedMs).toBeLessThan(5000);
  });

  it("@bugfix @regression-proof a hung mpv (no reply, no event, unanswered probe) fails as mpv_unresponsive", async () => {
    const { mpv, exited } = await attachClient({
      loadfileReplyDelayMs: 60_000,
      eventsAfterLoadfile: [],
      idleActive: "hang",
    });
    const { outcome } = await runReload(mpv, exited, 600);
    expect(outcome.settledBy).toBe("deadline");
    expect(outcome.verdict).toMatchObject({ failed: true, cause: "mpv_unresponsive" });
    expect(outcome.probeReply).toEqual({ error: "mpv_request_timeout" });
  });

  it("@bugfix @regression-proof idle-active=true at the deadline fails (nothing loaded)", async () => {
    const { mpv, exited } = await attachClient({
      loadfileReplyDelayMs: 60_000,
      eventsAfterLoadfile: [],
      idleActive: true,
    });
    const { outcome } = await runReload(mpv, exited, 600);
    expect(outcome.verdict).toMatchObject({ failed: true, cause: "idle_after_loadfile" });
  });

  it("@bugfix @regression-proof an end-file error of the replaced (failing) file does not fail the new rung", async () => {
    const { mpv, exited } = await attachClient({
      loadfileReplyDelayMs: 1500,
      eventsAfterLoadfile: [
        { atMs: 300, event: { event: "end-file", reason: "error", file_error: "loading failed", playlist_entry_id: 1 } },
        { atMs: 1200, event: { event: "start-file", playlist_entry_id: 2 } },
        { atMs: 1300, event: { event: "file-loaded" } },
      ],
      idleActive: false,
    });
    const { outcome } = await runReload(mpv, exited);
    expect(outcome.settledBy).toBe("file_loaded");
    expect(outcome.verdict.failed).toBe(false);
  });

  it("@bugfix @regression-proof the new entry's own end-file error still fails the reload", async () => {
    const { mpv, exited } = await attachClient({
      loadfileReplyDelayMs: 1500,
      eventsAfterLoadfile: [
        { atMs: 100, event: { event: "end-file", reason: "stop", playlist_entry_id: 1 } },
        { atMs: 200, event: { event: "start-file", playlist_entry_id: 2 } },
        { atMs: 1300, event: { event: "end-file", reason: "error", file_error: "loading failed", playlist_entry_id: 2 } },
      ],
      idleActive: true,
    });
    const { outcome } = await runReload(mpv, exited);
    expect(outcome.settledBy).toBe("end_file");
    expect(outcome.verdict).toMatchObject({ failed: true, cause: "end_file_error" });
  });

  it("a socket that is gone (transport failure after the re-sends) fails the reload", async () => {
    const neverExits = Promise.withResolvers<string>().promise;
    const gone = new UnixSocketMpvClient();
    client = gone;
    // @ts-expect-error — a live client whose socket path no longer exists.
    gone.socketPath = join(tmpdir(), `test-mpv-reload-gone-${process.pid}-${Date.now()}.sock`);
    // @ts-expect-error — same.
    gone._state = "ready";
    const { outcome, reply } = await runReload(gone, neverExits);
    console.info(`${TAG} gone-socket first reply=${JSON.stringify(reply)}`);
    expect(outcome.settledBy).toBe("reply");
    expect(outcome.transportRetries).toBe(2);
    expect(outcome.verdict.failed).toBe(true);
  });
});

describe("reload loadfile wiring (engine source guard, issue #25 P15)", () => {
  const engine = readFileSync(new URL("../src/renderer/src/lib/useMpvPlaybackEngine.ts", import.meta.url), "utf8");

  it("@bugfix @regression-proof the reload settles its loadfile through awaitReloadLoadfile, not the timeout-is-dead boolean", () => {
    const needles = [
      { token: "awaitReloadLoadfile({", mustExist: true },
      { token: 'msg.type === "exit"', mustExist: true },
      { token: 'buildGetPropertyCommand("idle-active")', mustExist: true },
      { token: 'msg.type === "start_file"', mustExist: true },
      { token: "reloadEndFileFilter.isNewEntry(", mustExist: true },
      { token: "const loadOk = await sendExternalCommand(", mustExist: false },
    ];
    const results = needles.map((n) => ({ ...n, present: engine.includes(n.token) }));
    const wrong = results.filter((r) => r.present !== r.mustExist);
    console.info(`${TAG} wiring needles=${results.length} wrong=${wrong.length} ${JSON.stringify(results)}`);
    expect(wrong).toEqual([]);
  });
});
