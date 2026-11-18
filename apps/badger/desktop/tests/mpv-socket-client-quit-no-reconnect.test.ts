/**
 * @bugfix mpv-event-socket-reconnect-storm-on-quit
 * @regression-proof
 *
 * Issue #25 P25 (ultimate confirmation run, seed 1791373829836). mpv closes
 * its IPC socket as soon as it processes `quit`, but the process lives on for
 * a while. UnixSocketMpvClient's event-socket close handler reconnected
 * whenever subscriptions existed (only dispose() set `disposing`), each
 * attempt delivered `null` to every subscriber and wrote `observe_property`
 * into a dead socket: S1 logged 1444 `observe_property write failed` and 252
 * `event-socket error`, ~12 per launch, 1642 of 1696 between mpv's socket
 * close and its process exit.
 *
 * Fix: no reconnect once quit is requested (`quit` sent, `end-file
 * reason=quit` / `shutdown` seen, process exited), and observations are
 * re-issued (and `null` delivered) only after a reconnect actually connects.
 *
 * Real timers on purpose: the reconnect path is a real setTimeout backoff on
 * real Unix-socket close events; the "no reconnect" assertion needs a window
 * longer than several backoff steps (50 → 100 → 150 ms ...).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnixSocketMpvClient } from "../src/main/mpvSocketClient";

const TAG = "[mpv-quit-no-reconnect]";
/** Several reconnect backoff steps (50, 100, 150, 200 ms ...). */
const NO_RECONNECT_WINDOW_MS = 800;

type FakeMpv = {
  /** Every connection ever accepted, in order. */
  connections: Socket[];
  /** observe_property commands received, per connection index. */
  observes: Array<{ connection: number; property: string }>;
  /** Resolves when connection `n` (0-based) has sent observe_property. */
  observedOn: (n: number) => Promise<void>;
  /** Push an event to every open connection. */
  push: (event: Record<string, unknown>) => void;
  /** Destroy every open connection (mpv closing its IPC side). */
  dropAll: () => void;
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

const startFakeMpv = async (socketPath: string, options: { closeAfterQuit: boolean }): Promise<FakeMpv> => {
  cleanupSocket(socketPath);
  const connections: Socket[] = [];
  const observes: FakeMpv["observes"] = [];
  const waiters = new Map<number, Array<() => void>>();
  const server: Server = createServer((conn) => {
    const index = connections.length;
    connections.push(conn);
    console.info(`${TAG} fake-mpv accepted connection #${index}`);
    let buffer = "";
    conn.on("error", () => undefined);
    conn.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== "object" || parsed === null || !("command" in parsed) || !Array.isArray(parsed.command)) {
          continue;
        }
        const name = String(parsed.command[0]);
        console.info(`${TAG} fake-mpv #${index} received ${line}`);
        const requestId = "request_id" in parsed ? parsed.request_id : undefined;
        if (requestId !== undefined) conn.write(`${JSON.stringify({ request_id: requestId, error: "success" })}\n`);
        if (name === "observe_property") {
          observes.push({ connection: index, property: String(parsed.command[2]) });
          for (const resolve of waiters.get(index) ?? []) resolve();
          waiters.delete(index);
        }
        if (name === "quit" && options.closeAfterQuit) {
          // mpv: end-file(quit) + shutdown on the event stream, then it
          // closes every IPC connection while the process is still exiting.
          for (const c of connections) {
            if (c.destroyed) continue;
            c.write(`${JSON.stringify({ event: "end-file", reason: "quit", playlist_entry_id: 1 })}\n`);
            c.write(`${JSON.stringify({ event: "shutdown" })}\n`);
          }
          setImmediate(() => {
            for (const c of connections) c.destroy();
          });
        }
      }
    });
  });
  const listening = Promise.withResolvers<void>();
  server.listen(socketPath, () => listening.resolve());
  await listening.promise;
  return {
    connections,
    observes,
    observedOn: (n) =>
      observes.some((o) => o.connection === n)
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiters.set(n, [...(waiters.get(n) ?? []), resolve])),
    push: (event) => {
      for (const c of connections) if (!c.destroyed) c.write(`${JSON.stringify(event)}\n`);
    },
    dropAll: () => {
      for (const c of connections) c.destroy();
    },
    stop: async () => {
      for (const c of connections) c.destroy();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
      cleanupSocket(socketPath);
    },
  };
};

describe("UnixSocketMpvClient event socket after quit (issue #25 P25)", () => {
  let socketPath: string;
  let fake: FakeMpv | null = null;
  let client: UnixSocketMpvClient | null = null;

  beforeEach(() => {
    socketPath = join(tmpdir(), `test-mpv-quit-reconnect-${process.pid}-${Date.now()}.sock`);
  });

  afterEach(async () => {
    await client?.dispose();
    client = null;
    await fake?.stop();
    fake = null;
  });

  const attach = async (closeAfterQuit: boolean) => {
    fake = await startFakeMpv(socketPath, { closeAfterQuit });
    client = new UnixSocketMpvClient();
    // @ts-expect-error — exercising the live-launch state without spawn.
    client.socketPath = socketPath;
    // @ts-expect-error — same.
    client._state = "ready";
    const delivered: unknown[] = [];
    client.observe("time-pos", (value) => {
      delivered.push(value);
    });
    await fake.observedOn(0);
    return { client, fake, delivered };
  };

  it("@bugfix @regression-proof mpv closing its socket after end-file reason=quit triggers no reconnect and no null delivery", async () => {
    const { fake: mpv, delivered } = await attach(false);
    const closed = new Promise<void>((resolve) => mpv.connections[0]?.once("close", () => resolve()));
    mpv.push({ event: "end-file", reason: "quit", playlist_entry_id: 1 });
    // Let the client read the event before the socket goes away, as mpv does.
    await new Promise<void>((resolve) => setImmediate(resolve));
    mpv.dropAll();
    await closed;
    await new Promise((resolve) => setTimeout(resolve, NO_RECONNECT_WINDOW_MS));
    console.info(
      `${TAG} after quit: connections=${mpv.connections.length} observes=${JSON.stringify(mpv.observes)} delivered=${JSON.stringify(delivered)}`,
    );
    expect(mpv.connections).toHaveLength(1);
    expect(delivered).toEqual([]);
  });

  it("@bugfix @regression-proof a `quit` command whose socket closes right after triggers no reconnect", async () => {
    const { client: mpvClient, fake: mpv, delivered } = await attach(true);
    const reply = await mpvClient.command({ command: ["quit"] }).catch((error: unknown) => String(error));
    console.info(`${TAG} quit reply=${JSON.stringify(reply)}`);
    await new Promise((resolve) => setTimeout(resolve, NO_RECONNECT_WINDOW_MS));
    // Connection #0 = event socket, #1 = the quit request. Nothing after.
    console.info(
      `${TAG} after quit command: connections=${mpv.connections.length} observes=${JSON.stringify(mpv.observes)} delivered=${JSON.stringify(delivered)}`,
    );
    expect(mpv.connections).toHaveLength(2);
    expect(mpv.observes.filter((o) => o.connection > 0)).toEqual([]);
    expect(delivered).toEqual([]);
  });

  it("a transient close without quit still reconnects, re-observes, then delivers null", async () => {
    const { fake: mpv, delivered } = await attach(false);
    mpv.dropAll();
    await mpv.observedOn(1);
    // Null is delivered on the connect that re-issued observe_property.
    const deadline = Date.now() + 2000;
    while (delivered.length === 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    console.info(
      `${TAG} after blip: connections=${mpv.connections.length} observes=${JSON.stringify(mpv.observes)} delivered=${JSON.stringify(delivered)}`,
    );
    expect(mpv.observes).toEqual([
      { connection: 0, property: "time-pos" },
      { connection: 1, property: "time-pos" },
    ]);
    expect(delivered).toEqual([null]);
  });
});
