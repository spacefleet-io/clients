import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";

/**
 * @test-id DESKTOP-MPV-IPC-001
 * @level integration
 * @why mpv IPC commands were silently dropped when sendCommand used fire-and-forget
 *   socket.end() before mpv finished reading. This test creates a real Unix socket
 *   server that mimics mpv's JSON IPC protocol and verifies all commands are received.
 */

// On assertion failure, dump enough socket/IPC state to diagnose offline
// (per "Tests log generously": never recommend manual repro).
const dumpMpvSocketIpcSnapshot = (
  label: string,
  ctx: { socketPath: string; received: unknown[]; result?: unknown },
) => {
  try {
    console.error(`=== [mpv-socket-ipc:${label}] state snapshot ===`);
    console.error(`socketPath=${ctx.socketPath}`);
    console.error(`received.length=${ctx.received.length}`);
    console.error(`received frames:\n${JSON.stringify(ctx.received, null, 2)}`);
    if (ctx.result !== undefined) {
      console.error(`last sendRequest result:\n${JSON.stringify(ctx.result, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const createMockMpvSocket = (socketPath: string) => {
  const received: unknown[] = [];
  let server: Server | null = null;

  const start = () =>
    new Promise<void>((resolve) => {
      server = createServer((client: Socket) => {
        let buffer = "";
        client.on("data", (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const parsed = JSON.parse(line);
              received.push(parsed);
              // Respond like mpv: echo back with request_id and error: "success"
              if (typeof parsed.request_id === "number") {
                client.write(
                  JSON.stringify({ request_id: parsed.request_id, error: "success" }) + "\n"
                );
              }
            } catch {
              // ignore parse errors
            }
          }
        });
      });
      server.listen(socketPath, resolve);
    });

  const stop = () =>
    new Promise<void>((resolve) => {
      server?.close(() => resolve());
      server = null;
    });

  return { received, start, stop };
};

describe("mpv socket IPC contract", () => {
  const socketPath = join(tmpdir(), `test-mpv-ipc-${process.pid}-${Date.now()}.sock`);

  beforeEach(() => {
    if (existsSync(socketPath)) unlinkSync(socketPath);
  });

  afterEach(async () => {
    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath);
      } catch { /* expected */ }
    }
  });

  it("@bugfix @regression-proof sendRequest waits for mpv acknowledgement before resolving", async () => {
    console.info(`[mpv-socket-ipc:setup] starting mock mpv socket at ${socketPath}`);
    const mock = createMockMpvSocket(socketPath);
    await mock.start();
    console.info(`[mpv-socket-ipc:setup] mock mpv socket listening`);

    // Dynamically import and invoke with the socket path patched
    const { createConnection } = await import("node:net");
    let requestSeq = 1;
    const sendRequest = async (command: unknown) => {
      const requestId = requestSeq++;
      const payload = JSON.stringify({ ...(command as object), request_id: requestId });
      return await new Promise<unknown>((resolve, reject) => {
        let buffer = "";
        const socket = createConnection(socketPath, () => {
          socket.write(`${payload}\n`, (err) => {
            if (err) {
              reject(err);
              socket.end();
            }
          });
        });
        const requestStartedAt = Date.now();
        const timeout = setTimeout(() => {
          console.error(
            `[mpv-socket-ipc:wait-ack-timeout] requestId=${requestId} elapsed=${Date.now() - requestStartedAt}ms no mpv ack received; received so far=${JSON.stringify(mock.received)}`,
          );
          socket.end();
          reject(new Error("mpv_request_timeout"));
        }, 2000);
        socket.on("data", (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const message = JSON.parse(line);
              if (message?.request_id === requestId) {
                clearTimeout(timeout);
                socket.end();
                resolve(message);
                return;
              }
            } catch { /* expected */ }
          }
        });
        socket.on("error", (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });
    };

    console.info(`[mpv-socket-ipc:send] sending single sf-audio-json request`);
    const result = await sendRequest({ command: ["script-message", "sf-audio-json", "[]"] });
    console.info(`[mpv-socket-ipc:send] got result=${JSON.stringify(result)} received.length=${mock.received.length}`);
    try {
      expect(result).toMatchObject({ error: "success" });
      expect(mock.received).toHaveLength(1);
      expect(mock.received[0]).toMatchObject({
        command: ["script-message", "sf-audio-json", "[]"],
        request_id: 1,
      });
    } catch (err) {
      dumpMpvSocketIpcSnapshot("single-ack-assert", {
        socketPath,
        received: mock.received,
        result,
      });
      throw err;
    }

    await mock.stop();
  });

  it("@bugfix @regression-proof rapid sequential metadata sends are all received by mpv", async () => {
    console.info(`[mpv-socket-ipc:setup] starting mock mpv socket at ${socketPath} (rapid-sequential)`);
    const mock = createMockMpvSocket(socketPath);
    await mock.start();
    console.info(`[mpv-socket-ipc:setup] mock mpv socket listening (rapid-sequential)`);

    const { createConnection } = await import("node:net");
    let requestSeq = 1;
    const sendRequest = async (command: unknown) => {
      const requestId = requestSeq++;
      const payload = JSON.stringify({ ...(command as object), request_id: requestId });
      return await new Promise<unknown>((resolve, reject) => {
        let buffer = "";
        const socket = createConnection(socketPath, () => {
          socket.write(`${payload}\n`, (err) => {
            if (err) {
              reject(err);
              socket.end();
            }
          });
        });
        const requestStartedAt = Date.now();
        const timeout = setTimeout(() => {
          console.error(
            `[mpv-socket-ipc:wait-ack-timeout] requestId=${requestId} elapsed=${Date.now() - requestStartedAt}ms no mpv ack received; received so far=${JSON.stringify(mock.received)}`,
          );
          socket.end();
          reject(new Error("timeout"));
        }, 2000);
        socket.on("data", (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const message = JSON.parse(line);
              if (message?.request_id === requestId) {
                clearTimeout(timeout);
                socket.end();
                resolve(message);
                return;
              }
            } catch { /* expected */ }
          }
        });
        socket.on("error", (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });
    };

    // Simulate the 4 metadata commands sent during playback launch
    const commands = [
      { command: ["script-message", "sf-subtitles-json", '[{"url":"http://...","title":"ENG","lang":"en"}]'] },
      { command: ["script-message", "sf-chapters-json", '[{"title":"Chapter 1","startSeconds":0}]'] },
      { command: ["script-message", "sf-audio-json", '[{"title":"ENG","label":"ENG","lang":"eng"}]'] },
      { command: ["script-message", "sf-playback-json", '{"markers":[],"nextEpisode":null}'] },
    ];

    console.info(`[mpv-socket-ipc:send] sending ${commands.length} rapid sequential metadata commands`);
    for (let i = 0; i < commands.length; i++) {
      await sendRequest(commands[i]);
      console.info(`[mpv-socket-ipc:send] command ${i + 1}/${commands.length} acked; received.length=${mock.received.length}`);
    }

    try {
      expect(mock.received).toHaveLength(4);
      expect(mock.received[0]).toMatchObject({ command: commands[0].command });
      expect(mock.received[1]).toMatchObject({ command: commands[1].command });
      expect(mock.received[2]).toMatchObject({ command: commands[2].command });
      expect(mock.received[3]).toMatchObject({ command: commands[3].command });
    } catch (err) {
      dumpMpvSocketIpcSnapshot("rapid-sequential-assert", {
        socketPath,
        received: mock.received,
      });
      throw err;
    }

    await mock.stop();
  });
});
