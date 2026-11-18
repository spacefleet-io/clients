/**
 * @bugfix mpv-handoff-load-failure-black-idle-window
 * @regression-proof
 *
 * Issue #25 (Opus review of PR #39). Backdrop handoff launches mpv IDLE
 * (`--idle=yes`, no file) and the renderer then swaps the stream in with
 * `loadfile <url> replace`. When that load fails (HTTP 404, dead tunnel,
 * unsupported codec) mpv emits `end-file reason=error` and drops back to
 * idle instead of exiting — observed live on mpv 0.41:
 *   loadfile -> {error: success} ; events: start-file, end-file
 *   {reason: "error", file_error: "loading failed"}, idle ; idle-active=true.
 * The app window was already hidden, so the user was left with a black mpv
 * window, no controls, no error.
 *
 * The fix has three parts, each covered here at the lowest layer that shows it:
 *   1. main: UnixSocketMpvClient surfaces mpv's `end-file` event (it used to
 *      drop every event other than property-change / client-message).
 *   2. pure decision: `classifyExternalLoadSignal` says which signal means
 *      "the load failed and mpv will not exit on its own".
 *   3. renderer wiring: the handoff branch aborts (stop mpv -> window shown ->
 *      playback error) instead of falling through after a failed swap.
 * The end-to-end proof lives in
 * e2e/playback-backdrop-handoff.e2e.test.ts ("@bugfix a stream that fails to
 * load during the handoff ...").
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyExternalLoadSignal, type ExternalLoadSignal } from "@space/desktop-mpv-playback";
import { UnixSocketMpvClient } from "../src/main/mpvSocketClient";

const TAG = "[mpv-handoff-load-failure]";

describe("classifyExternalLoadSignal (decision logic)", () => {
  const cases: Array<{
    name: string;
    signal: ExternalLoadSignal;
    failed: boolean;
    cause?: string;
  }> = [
    {
      name: "end-file reason=error -> failed (idle-launched mpv would sit idle)",
      signal: { kind: "end_file", reason: "error", fileError: "loading failed" },
      failed: true,
      cause: "end_file_error",
    },
    {
      name: "end-file reason=stop (replace of previous file) -> not failed",
      signal: { kind: "end_file", reason: "stop", fileError: null },
      failed: false,
    },
    {
      name: "end-file reason=eof -> not failed",
      signal: { kind: "end_file", reason: "eof", fileError: null },
      failed: false,
    },
    {
      name: "end-file reason=quit -> not failed (exit path owns it)",
      signal: { kind: "end_file", reason: "quit", fileError: null },
      failed: false,
    },
    {
      // @bugfix @regression-proof issue #25 P8 residual (confirm run seed
      // 1791373829836, S1 x002, shard-1/logs/mpv-12-1791384078899.log:505-529):
      // a variant's init section 500'd (source_missing), lavf's HLS open of
      // master.m3u8 failed, mpv's playlist demuxer took over and emitted
      // end-file reason=redirect, then played video-*.m3u8 alone — from 0:00,
      // no audio, start= ignored. That must be a load failure, not playback.
      name: "end-file reason=redirect (HLS master fell back to a variant playlist) -> failed",
      signal: { kind: "end_file", reason: "redirect", fileError: null },
      failed: true,
      cause: "hls_master_fallback",
    },
    {
      name: "loadfile command rejected by mpv -> failed",
      signal: { kind: "loadfile_command", reply: { error: "invalid parameter" } },
      failed: true,
      cause: "loadfile_rejected",
    },
    {
      name: "loadfile with mpv gone (socket missing) -> failed",
      signal: { kind: "loadfile_command", reply: { error: "mpv_socket_missing" } },
      failed: true,
      cause: "loadfile_rejected",
    },
    {
      name: "loadfile not sent (mpv not ready, null reply) -> failed",
      signal: { kind: "loadfile_command", reply: null },
      failed: true,
      cause: "loadfile_rejected",
    },
    {
      name: "loadfile command accepted -> not failed",
      signal: { kind: "loadfile_command", reply: { error: "success", request_id: 7 } },
      failed: false,
    },
    {
      // issue #25 P17: a slow reply on a loaded PC is unknown, not a failure.
      name: "loadfile reply timed out -> not failed (unconfirmed; wait for file-loaded / end-file)",
      signal: { kind: "loadfile_command", reply: { error: "mpv_request_timeout" } },
      failed: false,
    },
    {
      name: "idle-active=true after the swap -> failed",
      signal: { kind: "idle_active", value: true },
      failed: true,
      cause: "idle_after_loadfile",
    },
    {
      name: "idle-active=false after the swap -> not failed",
      signal: { kind: "idle_active", value: false },
      failed: false,
    },
    {
      name: "idle-active unreadable (null) -> not failed (inconclusive)",
      signal: { kind: "idle_active", value: null },
      failed: false,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const verdict = classifyExternalLoadSignal(c.signal);
      console.info(`${TAG} case="${c.name}" input=${JSON.stringify(c)} verdict=${JSON.stringify(verdict)}`);
      expect(verdict.failed).toBe(c.failed);
      if (verdict.failed) {
        expect(verdict.cause).toBe(c.cause);
        expect(verdict.detail.length).toBeGreaterThan(0);
      } else {
        expect(verdict.why.length).toBeGreaterThan(0);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// main: UnixSocketMpvClient must surface mpv's end-file event.
// ---------------------------------------------------------------------------

const cleanupSocket = (path: string) => {
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // ignore
    }
  }
};

type MockMpv = {
  received: unknown[];
  /** Resolves on the first JSON command received (the event socket is connected). */
  firstCommand: Promise<void>;
  push: (event: unknown) => void;
  stop: () => Promise<void>;
};

const hasRequestId = (value: unknown): value is { request_id: number } =>
  typeof value === "object" && value !== null && "request_id" in value && typeof value.request_id === "number";

const startMockMpv = async (socketPath: string): Promise<MockMpv> => {
  cleanupSocket(socketPath);
  const connections: Socket[] = [];
  const received: unknown[] = [];
  const first = Promise.withResolvers<void>();
  const listening = Promise.withResolvers<void>();
  const server: Server = createServer((conn) => {
    connections.push(conn);
    let buffer = "";
    conn.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        received.push(parsed);
        first.resolve();
        if (hasRequestId(parsed)) {
          conn.write(`${JSON.stringify({ request_id: parsed.request_id, error: "success" })}\n`);
        }
      }
    });
  });
  server.listen(socketPath, () => listening.resolve());
  await listening.promise;
  return {
    received,
    firstCommand: first.promise,
    push: (event: unknown) => {
      for (const conn of connections) conn.write(`${JSON.stringify(event)}\n`);
    },
    stop: async () => {
      for (const conn of connections) conn.destroy();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
      cleanupSocket(socketPath);
    },
  };
};

describe("UnixSocketMpvClient end-file surfacing (main)", () => {
  let socketPath: string;
  let mock: MockMpv;

  beforeEach(async () => {
    socketPath = join(tmpdir(), `test-mpv-endfile-${process.pid}-${Date.now()}.sock`);
    console.info(`${TAG} starting mock mpv at ${socketPath}`);
    mock = await startMockMpv(socketPath);
  });

  afterEach(async () => {
    console.info(`${TAG} stopping mock mpv`);
    await mock.stop();
  });

  it("emits `end-file` with reason + file_error from the event socket", async () => {
    const client = new UnixSocketMpvClient();
    // @ts-expect-error — exercising the live-launch state without spawn.
    client.socketPath = socketPath;
    // @ts-expect-error — same.
    client._state = "ready";
    const endFile = Promise.withResolvers<unknown>();
    client.on("end-file", (event) => endFile.resolve(event));
    // Opening an observation is what connects the persistent event socket.
    const unsubscribe = client.observe("time-pos", () => undefined);
    await mock.firstCommand;
    console.info(`${TAG} event socket connected; pushing mpv's live load-failure event sequence`);
    // Exact sequence captured from live mpv 0.41 after `loadfile <404 url> replace` on an idle player.
    mock.push({ event: "start-file", playlist_entry_id: 1 });
    mock.push({ event: "end-file", reason: "error", playlist_entry_id: 1, file_error: "loading failed" });
    mock.push({ event: "idle" });
    const seen = await endFile.promise;
    console.info(`${TAG} end-file event seen=${JSON.stringify(seen)} received=${JSON.stringify(mock.received)}`);
    expect(seen).toEqual({ reason: "error", fileError: "loading failed", playlistEntryId: 1 });
    unsubscribe();
    await client.dispose();
  });
});

// ---------------------------------------------------------------------------
// renderer wiring: the backdrop handoff branch must abort, not fall through.
// The behaviour is proven end-to-end by the e2e test named in the header; this
// guard pins the wiring so a refactor cannot silently restore the fall-through.
// ---------------------------------------------------------------------------

describe("backdrop handoff wiring (renderer + main source guards)", () => {
  const engine = readFileSync(
    new URL("../src/renderer/src/lib/useMpvPlaybackEngine.ts", import.meta.url),
    "utf8",
  );
  const main = readFileSync(new URL("../src/main/externalMpv.ts", import.meta.url), "utf8");

  it("handoff swap failure no longer falls through to the metadata path", () => {
    const needles = [
      { where: "engine", token: "Fall through to the metadata path anyway", mustExist: false },
      { where: "engine", token: "classifyExternalLoadSignal", mustExist: true },
      { where: "engine", token: "playback_handoff_load_failed", mustExist: true },
      { where: "engine", token: 'msg.type !== "end_file"', mustExist: true },
      { where: "main", token: 'client.on("end-file"', mustExist: true },
      { where: "main", token: 'type: "end_file"', mustExist: true },
    ];
    const results = needles.map((n) => {
      const src = n.where === "engine" ? engine : main;
      return { ...n, present: src.includes(n.token) };
    });
    const wrong = results.filter((r) => r.present !== r.mustExist);
    console.info(`${TAG} wiring needles=${results.length} wrong=${wrong.length} ${JSON.stringify(results)}`);
    expect(wrong).toEqual([]);
  });
});
