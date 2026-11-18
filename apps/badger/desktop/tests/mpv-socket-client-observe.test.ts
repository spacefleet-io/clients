/**
 * Unit tests for {@link UnixSocketMpvClient}.observe() — Tier-4.
 *
 * Validates the persistent event-stream socket + subscription registry
 * against a real Unix-domain socket server that mimics mpv's JSON-IPC
 * shape:
 *   - per-request socket replies (request_id, error: "success")
 *   - persistent event socket parses observe_property writes and pushes
 *     property-change events back
 *
 * Coverage:
 *   - first subscribe issues observe_property; subsequent same-property
 *     subscribes reuse the wire observation
 *   - last unsubscribe issues unobserve_property
 *   - multiple subscribers per property all get the event
 *   - unsubscribe cancels pending throttled delivery
 *   - the listener IGNORES non-property-change events (no crash on
 *     playback-restart / file-loaded)
 *   - reconnect re-issues every active observe_property and force-fires null
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";

import { UnixSocketMpvClient } from "../src/main/mpvSocketClient";

// ---------------------------------------------------------------------------
// Diagnostic-logging helpers (per the tests-log-generously convention).
// Suite id: mpv-observe. Phase markers: `[mpv-observe:<phase>]`.
// dumpMpvObserveSnapshot prints all socket traffic + the per-connection
// received-command lists so a failed assertion shows the mpv-side state.
// ---------------------------------------------------------------------------

const dumpMpvObserveSnapshot = (
  label: string,
  ctx: {
    mock?: Awaited<ReturnType<typeof startMockMpv>> | null;
    extra?: Record<string, unknown>;
  } = {},
) => {
  try {
     
    console.log(
      `[mpv-observe:dump] ${label}`,
      JSON.stringify(
        {
          connectionCount: ctx.mock?.connections.length,
          receivedByConnection: ctx.mock?.receivedByConnection,
          ...(ctx.extra ?? {}),
        },
        null,
        2,
      ),
    );
  } catch (dumpError) {
     
    console.log(`[mpv-observe:dump-error] ${label}`, dumpError);
  }
};

type ReceivedCommand = {
  command: unknown[];
  request_id?: number;
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

/**
 * Spawn a Unix socket server that mimics mpv's JSON IPC. The server keeps
 * a list of connections so tests can target the persistent event socket
 * specifically (the second incoming connection — the first is the
 * `existsSync` check, which doesn't actually create a stream).
 */
const startMockMpv = async (socketPath: string) => {
  cleanupSocket(socketPath);
  const receivedByConnection: ReceivedCommand[][] = [];
  const connections: Socket[] = [];
  const server: Server = await new Promise<Server>((resolve) => {
    const s = createServer((client) => {
      const connectionId = connections.length;
      connections.push(client);
      receivedByConnection.push([]);
      let buffer = "";
      client.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line) as ReceivedCommand;
            receivedByConnection[connectionId].push(parsed);
            if (typeof parsed.request_id === "number") {
              client.write(
                JSON.stringify({ request_id: parsed.request_id, error: "success" }) +
                  "\n",
              );
            }
          } catch {
            // ignore
          }
        }
      });
    });
    s.listen(socketPath, () => resolve(s));
  });
  return {
    server,
    connections,
    receivedByConnection,
    pushEvent: (connectionIndex: number, event: unknown) => {
      const conn = connections[connectionIndex];
      if (!conn) throw new Error("no_such_connection");
      conn.write(JSON.stringify(event) + "\n");
    },
    stop: async () => {
      for (const conn of connections) {
        try {
          conn.destroy();
        } catch {
          // ignore
        }
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      cleanupSocket(socketPath);
    },
  };
};

const waitForConnections = async (
  mock: Awaited<ReturnType<typeof startMockMpv>>,
  count: number,
  timeoutMs = 2000,
) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (mock.connections.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `timed_out_waiting_for_connections: have ${mock.connections.length}, want ${count}`,
  );
};

const waitFor = async <T>(
  predicate: () => T | null | undefined,
  timeoutMs = 2000,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("waitFor_timed_out");
};

/**
 * Build a client and attach it to a mock mpv socket. The mock owns the
 * socket file path; the client only sees `socketPath` and the existsSync
 * gate passes once the server starts listening.
 *
 * We bypass `start()` (which spawns a real mpv) and directly poke the
 * private socketPath field so the client treats this synthetic setup as
 * a live launch. The fields we set are exactly what `start()` would have
 * written, so observable behavior is identical.
 */
const attachClient = (socketPath: string) => {
  const client = new UnixSocketMpvClient();
  // @ts-expect-error — exercising the live-launch state without spawn.
  client.socketPath = socketPath;
  // @ts-expect-error — same.
  client._state = "ready";
  return client;
};

describe("UnixSocketMpvClient.observe (tier-4)", () => {
  let socketPath: string;
  let mock: Awaited<ReturnType<typeof startMockMpv>>;

  beforeEach(async () => {
    socketPath = join(tmpdir(), `test-mpv-observe-${process.pid}-${Date.now()}.sock`);
     
    console.log(`[mpv-observe:beforeEach] starting mock mpv at ${socketPath}`);
    mock = await startMockMpv(socketPath);
     
    console.log("[mpv-observe:beforeEach:ready] mock mpv listening");
  });

  afterEach(async () => {
     
    console.log("[mpv-observe:afterEach] stopping mock mpv");
    await mock.stop();
  });

  it("first subscribe issues observe_property; second subscribe to the same property does not", async () => {
    try {
       
      console.log("[mpv-observe:dedupe-observe] attaching client + observing time-pos x2");
      const client = attachClient(socketPath);
      const seen1: unknown[] = [];
      const seen2: unknown[] = [];
      const unsubscribe1 = client.observe("time-pos", (v) => seen1.push(v));
      await waitForConnections(mock, 1);
      // Wait for the observe_property command to land on the event socket.
      await waitFor(() =>
        mock.receivedByConnection[0]?.find(
          (cmd) => Array.isArray(cmd.command) && cmd.command[0] === "observe_property",
        ),
      );
       
      console.log("[mpv-observe:dedupe-observe] first observe_property landed");
      expect(
        mock.receivedByConnection[0].filter(
          (cmd) => Array.isArray(cmd.command) && cmd.command[0] === "observe_property",
        ),
      ).toHaveLength(1);
      const unsubscribe2 = client.observe("time-pos", (v) => seen2.push(v));
      // Give the event loop one tick for the (would-be) second write.
       
      console.log("[mpv-observe:dedupe-observe] sleeping 25ms after 2nd subscribe");
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(
        mock.receivedByConnection[0].filter(
          (cmd) => Array.isArray(cmd.command) && cmd.command[0] === "observe_property",
        ),
      ).toHaveLength(1);
      // Push a property-change event; BOTH subscribers should see it.
       
      console.log("[mpv-observe:dedupe-observe] pushing time-pos=12.5");
      mock.pushEvent(0, { event: "property-change", name: "time-pos", data: 12.5 });
      await waitFor(() => (seen1.length > 0 && seen2.length > 0 ? true : null));
       
      console.log(
        `[mpv-observe:dedupe-observe:asserting] seen1=${JSON.stringify(seen1)} seen2=${JSON.stringify(seen2)}`,
      );
      expect(seen1).toEqual([12.5]);
      expect(seen2).toEqual([12.5]);
      unsubscribe1();
      unsubscribe2();
      await client.dispose();
    } catch (assertionError) {
      dumpMpvObserveSnapshot("dedupe-observe:fail", { mock });
      throw assertionError;
    }
  });

  it("last unsubscribe issues unobserve_property", async () => {
    try {
       
      console.log("[mpv-observe:unobserve] observing pause + unsubscribing");
      const client = attachClient(socketPath);
      const unsubscribe = client.observe("pause", () => undefined);
      await waitForConnections(mock, 1);
      await waitFor(() =>
        mock.receivedByConnection[0]?.find(
          (cmd) => Array.isArray(cmd.command) && cmd.command[0] === "observe_property",
        ),
      );
       
      console.log("[mpv-observe:unobserve] observe_property landed, calling unsubscribe()");
      unsubscribe();
      await waitFor(() =>
        mock.receivedByConnection[0]?.find(
          (cmd) =>
            Array.isArray(cmd.command) && cmd.command[0] === "unobserve_property",
        ),
      );
      expect(
        mock.receivedByConnection[0].filter(
          (cmd) =>
            Array.isArray(cmd.command) && cmd.command[0] === "unobserve_property",
        ),
      ).toHaveLength(1);
      await client.dispose();
    } catch (assertionError) {
      dumpMpvObserveSnapshot("unobserve:fail", { mock });
      throw assertionError;
    }
  });

  it("ignores non-property-change events without crashing", async () => {
    try {
       
      console.log("[mpv-observe:ignore-other-events] observing time-pos, pushing other events");
      const client = attachClient(socketPath);
      const seen: unknown[] = [];
      client.observe("time-pos", (v) => seen.push(v));
      await waitForConnections(mock, 1);
      await waitFor(() =>
        mock.receivedByConnection[0]?.find(
          (cmd) => Array.isArray(cmd.command) && cmd.command[0] === "observe_property",
        ),
      );
      // Push a parade of unsolicited mpv events — none should be forwarded
      // to the subscriber.
       
      console.log("[mpv-observe:ignore-other-events] pushing playback-restart, file-loaded, duration, time-pos=7");
      mock.pushEvent(0, { event: "playback-restart" });
      mock.pushEvent(0, { event: "file-loaded" });
      mock.pushEvent(0, { event: "property-change", name: "duration", data: 100 });
      mock.pushEvent(0, { event: "property-change", name: "time-pos", data: 7 });
      await waitFor(() => (seen.length > 0 ? true : null));
       
      console.log(`[mpv-observe:ignore-other-events:asserting] seen=${JSON.stringify(seen)}`);
      expect(seen).toEqual([7]);
      await client.dispose();
    } catch (assertionError) {
      dumpMpvObserveSnapshot("ignore-other-events:fail", { mock });
      throw assertionError;
    }
  });

  it("forwards every event-stream property-change via the property-change emitter event", async () => {
    try {
       
      console.log("[mpv-observe:emitter-forward] hooking property-change emitter");
      const client = attachClient(socketPath);
      const events: Array<{ name: string; value: unknown }> = [];
      client.on("property-change", (event) => events.push(event));
      client.observe("pause", () => undefined);
      await waitForConnections(mock, 1);
      await waitFor(() =>
        mock.receivedByConnection[0]?.find(
          (cmd) => Array.isArray(cmd.command) && cmd.command[0] === "observe_property",
        ),
      );
       
      console.log("[mpv-observe:emitter-forward] pushing pause=true");
      mock.pushEvent(0, { event: "property-change", name: "pause", data: true });
      await waitFor(() => (events.length > 0 ? true : null));
      expect(events).toEqual([{ name: "pause", value: true }]);
      await client.dispose();
    } catch (assertionError) {
      dumpMpvObserveSnapshot("emitter-forward:fail", { mock });
      throw assertionError;
    }
  });

  it("unsubscribe cancels pending throttled delivery", async () => {
    try {
       
      console.log("[mpv-observe:throttle-cancel] fake timers on, throttleMs=250");
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const client = attachClient(socketPath);
        const seen: unknown[] = [];
        const unsubscribe = client.observe(
          "time-pos",
          (v) => seen.push(v),
          { throttleMs: 250 },
        );
        await waitForConnections(mock, 1);
        await waitFor(() =>
          mock.receivedByConnection[0]?.find(
            (cmd) =>
              Array.isArray(cmd.command) && cmd.command[0] === "observe_property",
          ),
        );
         
        console.log("[mpv-observe:throttle-cancel] pushing time-pos=1");
        mock.pushEvent(0, { event: "property-change", name: "time-pos", data: 1 });
        await waitFor(() => (seen.length > 0 ? true : null));
         
        console.log("[mpv-observe:throttle-cancel] pushing time-pos=2 then unsubscribe before throttle window");
        mock.pushEvent(0, { event: "property-change", name: "time-pos", data: 2 });
        // Allow a microtask flush so the listener consumes the buffered
        // line before we unsubscribe.
        await Promise.resolve();
        await Promise.resolve();
        unsubscribe();
        vi.advanceTimersByTime(500);
         
        console.log(`[mpv-observe:throttle-cancel:asserting] seen=${JSON.stringify(seen)}`);
        expect(seen).toEqual([1]);
        await client.dispose();
      } finally {
        vi.useRealTimers();
      }
    } catch (assertionError) {
      dumpMpvObserveSnapshot("throttle-cancel:fail", { mock });
      throw assertionError;
    }
  });
});

// #25 playable-start: a resume into segment 0's first GOP loads with a short
// per-load prefill (`cache-secs=<window>`, @space/mpv-protocol
// MPV_RESUME_PREFILL_WINDOW_SECONDS). mpv keeps that per-file value for the
// whole file, so the client restores the launch readahead target once the
// file's start seek has completed (its first playback-restart; file-loaded
// fires BEFORE mpv's demuxer-cache-wait, so restoring there would stretch the
// prefill back to 16 s).
describe("UnixSocketMpvClient readahead restore (#25 playable-start)", () => {
  let socketPath: string;
  let mock: Awaited<ReturnType<typeof startMockMpv>>;

  beforeEach(async () => {
    socketPath = join(tmpdir(), `test-mpv-readahead-${process.pid}-${Date.now()}.sock`);
    console.log(`[mpv-readahead:beforeEach] starting mock mpv at ${socketPath}`);
    mock = await startMockMpv(socketPath);
  });

  afterEach(async () => {
    console.log("[mpv-readahead:afterEach] stopping mock mpv");
    await mock.stop();
  });

  const cacheSecsSets = () =>
    mock.receivedByConnection
      .flat()
      .filter((cmd) => Array.isArray(cmd.command) && cmd.command[0] === "set_property" && cmd.command[1] === "cache-secs")
      .map((cmd) => cmd.command);

  it("@bugfix @regression-proof restores cache-secs on each file's first playback-restart, not on later seeks", async () => {
    try {
      const client = attachClient(socketPath);
      // @ts-expect-error — what start() records from options.readaheadSecs.
      client.readaheadSecs = 16;
      const seen: unknown[] = [];
      client.observe("time-pos", (v) => seen.push(v));
      await waitForConnections(mock, 1);
      await waitFor(() =>
        mock.receivedByConnection[0]?.find(
          (cmd) => Array.isArray(cmd.command) && cmd.command[0] === "observe_property",
        ),
      );
      console.log("[mpv-readahead:restore] launch file: file-loaded, then playback-restart (start seek done)");
      mock.pushEvent(0, { event: "file-loaded" });
      mock.pushEvent(0, { event: "playback-restart" });
      await waitFor(() => (cacheSecsSets().length >= 1 ? true : null));
      console.log(`[mpv-readahead:restore] after first restart sets=${JSON.stringify(cacheSecsSets())}`);
      expect(cacheSecsSets()).toEqual([["set_property", "cache-secs", 16]]);

      console.log("[mpv-readahead:restore] user seek: playback-restart without a new file, then a time-pos barrier");
      mock.pushEvent(0, { event: "playback-restart" });
      mock.pushEvent(0, { event: "property-change", name: "time-pos", data: 42 });
      // Same event socket, in order: once 42 is delivered the seek's restart
      // was routed; the get_property round trip flushes any request it sent.
      await waitFor(() => (seen.includes(42) ? true : null));
      await client.getProperty("time-pos");
      console.log(`[mpv-readahead:restore] after seek sets=${JSON.stringify(cacheSecsSets())}`);
      expect(cacheSecsSets()).toHaveLength(1);

      console.log("[mpv-readahead:restore] reload (abr / resume): file-loaded, playback-restart");
      mock.pushEvent(0, { event: "file-loaded" });
      mock.pushEvent(0, { event: "playback-restart" });
      await waitFor(() => (cacheSecsSets().length >= 2 ? true : null));
      console.log(`[mpv-readahead:restore:asserting] sets=${JSON.stringify(cacheSecsSets())}`);
      expect(cacheSecsSets()).toEqual([
        ["set_property", "cache-secs", 16],
        ["set_property", "cache-secs", 16],
      ]);
      await client.dispose();
    } catch (assertionError) {
      dumpMpvObserveSnapshot("readahead-restore:fail", { mock });
      throw assertionError;
    }
  });

  // STOR-BW-01: a gateway high-traffic period lowers the readahead target mid-session and
  // normal traffic restores it; a change landing during a first-GOP prefill waits for the
  // file's first playback-restart so the short prefill is not stretched.
  it("applies a changed readahead target live and defers it during a first-GOP prefill @req STOR-BW-01", async () => {
    try {
      const client = attachClient(socketPath);
      // @ts-expect-error — what start() records from options.readaheadSecs.
      client.readaheadSecs = 16;
      client.observe("time-pos", () => undefined);
      await waitForConnections(mock, 1);
      await waitFor(() =>
        mock.receivedByConnection[0]?.find(
          (cmd) => Array.isArray(cmd.command) && cmd.command[0] === "observe_property",
        ),
      );
      console.log("[mpv-readahead:traffic] change while the launch file's prefill is pending: nothing sent yet");
      await client.setReadaheadSecs(8);
      expect(cacheSecsSets()).toEqual([]);
      mock.pushEvent(0, { event: "file-loaded" });
      mock.pushEvent(0, { event: "playback-restart" });
      await waitFor(() => (cacheSecsSets().length >= 1 ? true : null));
      expect(cacheSecsSets()).toEqual([["set_property", "cache-secs", 8]]);

      console.log("[mpv-readahead:traffic] traffic back to normal mid-playback: applied live");
      await client.setReadaheadSecs(16);
      expect(cacheSecsSets()).toEqual([
        ["set_property", "cache-secs", 8],
        ["set_property", "cache-secs", 16],
      ]);

      console.log("[mpv-readahead:traffic] an unchanged target sends nothing");
      await client.setReadaheadSecs(16);
      expect(cacheSecsSets()).toHaveLength(2);
      await client.dispose();
    } catch (assertionError) {
      dumpMpvObserveSnapshot("readahead-traffic:fail", { mock });
      throw assertionError;
    }
  });

  // The ABR first-frame clock (#25 N4) is each file's first playback-restart,
  // whether or not a readahead target is set; a later seek is not a frame.
  it("@bugfix @regression-proof emits first-playback-restart once per file, not on later seeks, without readahead", async () => {
    try {
      const client = attachClient(socketPath);
      const firstRestarts: number[] = [];
      client.on("first-playback-restart", () => {
        firstRestarts.push(Date.now());
        console.log(`[mpv-first-restart] first-playback-restart #${firstRestarts.length}`);
      });
      const seen: unknown[] = [];
      client.observe("time-pos", (v) => seen.push(v));
      await waitForConnections(mock, 1);
      await waitFor(() =>
        mock.receivedByConnection[0]?.find(
          (cmd) => Array.isArray(cmd.command) && cmd.command[0] === "observe_property",
        ),
      );
      console.log("[mpv-first-restart] launch file: file-loaded, then playback-restart");
      mock.pushEvent(0, { event: "file-loaded" });
      mock.pushEvent(0, { event: "playback-restart" });
      await waitFor(() => (firstRestarts.length >= 1 ? true : null));
      expect(firstRestarts).toHaveLength(1);

      console.log("[mpv-first-restart] user seek: playback-restart without a new file, then a time-pos barrier");
      mock.pushEvent(0, { event: "playback-restart" });
      mock.pushEvent(0, { event: "property-change", name: "time-pos", data: 42 });
      await waitFor(() => (seen.includes(42) ? true : null));
      console.log(`[mpv-first-restart] after seek count=${firstRestarts.length}`);
      expect(firstRestarts).toHaveLength(1);

      console.log("[mpv-first-restart] reload (abr / resume): file-loaded, playback-restart");
      mock.pushEvent(0, { event: "file-loaded" });
      mock.pushEvent(0, { event: "playback-restart" });
      await waitFor(() => (firstRestarts.length >= 2 ? true : null));
      console.log(`[mpv-first-restart:asserting] count=${firstRestarts.length} cache-secs sets=${JSON.stringify(cacheSecsSets())}`);
      expect(firstRestarts).toHaveLength(2);
      expect(cacheSecsSets()).toEqual([]);
      await client.dispose();
    } catch (assertionError) {
      dumpMpvObserveSnapshot("first-playback-restart:fail", { mock });
      throw assertionError;
    }
  });
});
