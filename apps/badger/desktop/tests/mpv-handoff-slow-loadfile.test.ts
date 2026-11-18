/**
 * @bugfix mpv-handoff-slow-loadfile-reply-killed-mpv
 * @regression-proof
 *
 * Issue #25 P17 (ultimate confirmation run, seed 1791373829836). On a loaded
 * 4-core PC the backdrop handoff's `loadfile ... replace` reply took longer
 * than UnixSocketMpvClient's 1 s request budget. The request rejected with
 * `mpv_request_timeout`, the renderer classified that as "loadfile rejected",
 * stopped mpv and threw `playback_handoff_load_failed`: all 29 failed swaps
 * had swapMs >= 1000, and mpv logged the `loadfile` AFTER the app had sent
 * `quit` (S1 mpv-5 log). About 9 % of Play presses failed.
 *
 * Fix: a timed-out reply is UNKNOWN. `awaitHandoffLoadfile` keeps waiting for
 * mpv's `file-loaded` (success) or `end-file reason=error` (failure); only an
 * error reply or an end-file error fails the handoff.
 *
 * These tests drive the REAL UnixSocketMpvClient against a fake mpv socket
 * that answers `loadfile` late, through the same reply mapping as main's
 * `sf-mpv-external-command` IPC handler, into the renderer's decision helper.
 * Real timers on purpose: the bug IS the race between mpv's late reply on a
 * real Unix socket and the client's real 1 s request timer, plus socket I/O
 * that fake timers do not drive. Delays are kept to ~1.5 s per case.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  awaitHandoffLoadfile,
  classifyExternalLoadSignal,
  type ExternalLoadVerdict,
} from "@space/desktop-mpv-playback";
import { buildLoadfileCommand } from "@space/mpv-protocol";
import { UnixSocketMpvClient } from "../src/main/mpvSocketClient";

const TAG = "[mpv-handoff-slow-loadfile]";

type FakeMpvScript = {
  /** Delay before mpv answers `loadfile`. */
  loadfileReplyDelayMs: number;
  /** mpv's reply `error` field for `loadfile`. */
  loadfileReplyError: string;
  /** Events pushed on the event socket, each after its own delay from the loadfile receipt. */
  eventsAfterLoadfile: Array<{ atMs: number; event: Record<string, unknown> }>;
};

type FakeMpv = {
  log: string[];
  eventSocketReady: Promise<void>;
  stop: () => Promise<void>;
};

const cleanupSocket = (path: string) => {
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // ignore
    }
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
        note(`received ${name} request_id=${String(parsed.request_id)}`);
        if (name === "observe_property") {
          eventSocket = conn;
          eventSocketReady.resolve();
          conn.write(`${JSON.stringify({ request_id: parsed.request_id, error: "success" })}\n`);
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
          timers.push(
            setTimeout(() => {
              note(`reply loadfile error=${script.loadfileReplyError} (socket destroyed=${conn.destroyed})`);
              if (!conn.destroyed) {
                conn.write(`${JSON.stringify({ request_id: parsed.request_id, error: script.loadfileReplyError })}\n`);
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

/**
 * Run one handoff swap the way production does: main's IPC handler maps a
 * thrown request error to `{ error: message }`, and the renderer arms the
 * file-loaded / end-file listeners before sending.
 */
const runHandoffSwap = async (client: UnixSocketMpvClient, deadlineMs?: number) => {
  const fileLoaded = new Promise<void>((resolve) => client.on("file-loaded", () => resolve()));
  const endFileFailure = new Promise<ExternalLoadVerdict>((resolve) => {
    client.on("end-file", (event) => {
      const verdict = classifyExternalLoadSignal({ kind: "end_file", reason: event.reason, fileError: event.fileError });
      console.info(`${TAG} renderer saw end-file ${JSON.stringify(event)} verdict=${JSON.stringify(verdict)}`);
      if (verdict.failed) resolve(verdict);
    });
  });
  const startedAt = Date.now();
  const reply = client
    .command(buildLoadfileCommand("https://example.invalid/master.m3u8", "replace", { startSeconds: 12, paused: false }))
    .catch((error: unknown) => ({ error: error instanceof Error ? error.message : "mpv_command_failed" }));
  void reply.then((value) => console.info(`${TAG} loadfile reply after ${Date.now() - startedAt}ms: ${JSON.stringify(value)}`));
  const outcome = await awaitHandoffLoadfile({ reply, fileLoaded, endFileFailure, deadlineMs });
  console.info(`${TAG} handoff outcome after ${Date.now() - startedAt}ms: ${JSON.stringify(outcome)}`);
  return { outcome, elapsedMs: Date.now() - startedAt, reply: await reply };
};

describe("backdrop handoff with a slow loadfile reply (issue #25 P17)", () => {
  let socketPath: string;
  let fake: FakeMpv | null = null;
  let client: UnixSocketMpvClient | null = null;

  beforeEach(() => {
    socketPath = join(tmpdir(), `test-mpv-slow-loadfile-${process.pid}-${Date.now()}.sock`);
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
    // @ts-expect-error — exercising the live-launch state without spawn.
    client.socketPath = socketPath;
    // @ts-expect-error — same.
    client._state = "ready";
    // Main observes properties as soon as the socket is up; that is what
    // connects the event socket the file-loaded / end-file events arrive on.
    client.observe("time-pos", () => undefined);
    await fake.eventSocketReady;
    return client;
  };

  it("@bugfix @regression-proof a loadfile answered after 1.5 s with file-loaded at 1.3 s is a successful handoff", async () => {
    const mpv = await attachClient({
      loadfileReplyDelayMs: 1500,
      loadfileReplyError: "success",
      eventsAfterLoadfile: [
        { atMs: 1200, event: { event: "start-file", playlist_entry_id: 1 } },
        { atMs: 1300, event: { event: "file-loaded" } },
      ],
    });
    const { outcome, reply } = await runHandoffSwap(mpv);
    // The transport still times out at 1 s — that is the condition the
    // handoff used to treat as a failure.
    expect(reply).toEqual({ error: "mpv_request_timeout" });
    expect(outcome.verdict.failed).toBe(false);
    expect(outcome.settledBy).toBe("file_loaded");
  });

  it("@bugfix @regression-proof a timed-out loadfile followed by end-file reason=error still aborts the handoff", async () => {
    const mpv = await attachClient({
      loadfileReplyDelayMs: 1500,
      loadfileReplyError: "success",
      eventsAfterLoadfile: [
        { atMs: 1200, event: { event: "start-file", playlist_entry_id: 1 } },
        { atMs: 1300, event: { event: "end-file", reason: "error", file_error: "loading failed", playlist_entry_id: 1 } },
      ],
    });
    const { outcome } = await runHandoffSwap(mpv);
    expect(outcome.settledBy).toBe("end_file");
    expect(outcome.verdict).toMatchObject({ failed: true, cause: "end_file_error" });
  });

  it("an error reply from mpv fails the handoff at once (no waiting)", async () => {
    const mpv = await attachClient({
      loadfileReplyDelayMs: 20,
      loadfileReplyError: "invalid parameter",
      eventsAfterLoadfile: [],
    });
    const { outcome, elapsedMs } = await runHandoffSwap(mpv);
    expect(outcome.settledBy).toBe("reply");
    expect(outcome.verdict).toMatchObject({ failed: true, cause: "loadfile_rejected" });
    expect(elapsedMs).toBeLessThan(1000);
  });

  it("a timed-out loadfile with no later event gives up waiting at the deadline without failing (idle-active check decides)", async () => {
    const mpv = await attachClient({
      loadfileReplyDelayMs: 60_000,
      loadfileReplyError: "success",
      eventsAfterLoadfile: [],
    });
    const { outcome, elapsedMs } = await runHandoffSwap(mpv, 600);
    expect(outcome.settledBy).toBe("deadline");
    expect(outcome.verdict).toMatchObject({ failed: false, unconfirmed: true });
    // 1 s request timeout + 600 ms deadline, with slack for a loaded runner.
    expect(elapsedMs).toBeGreaterThanOrEqual(1500);
    expect(elapsedMs).toBeLessThan(5000);
  });
});

describe("backdrop handoff wiring (renderer + main source guards, issue #25 P17)", () => {
  const engine = readFileSync(new URL("../src/renderer/src/lib/useMpvPlaybackEngine.ts", import.meta.url), "utf8");
  const main = readFileSync(new URL("../src/main/externalMpv.ts", import.meta.url), "utf8");

  it("the handoff settles the loadfile through awaitHandoffLoadfile, not the old boolean", () => {
    const needles = [
      { where: "engine", token: "awaitHandoffLoadfile({", mustExist: true },
      { where: "engine", token: 'msg.type === "file_loaded"', mustExist: true },
      { where: "engine", token: '{ kind: "loadfile_command", ok: swapOk }', mustExist: false },
      { where: "main", token: 'client.on("file-loaded"', mustExist: true },
      { where: "main", token: 'type: "file_loaded"', mustExist: true },
    ];
    const results = needles.map((n) => ({ ...n, present: (n.where === "engine" ? engine : main).includes(n.token) }));
    const wrong = results.filter((r) => r.present !== r.mustExist);
    console.info(`${TAG} wiring needles=${results.length} wrong=${wrong.length} ${JSON.stringify(results)}`);
    expect(wrong).toEqual([]);
  });
});
