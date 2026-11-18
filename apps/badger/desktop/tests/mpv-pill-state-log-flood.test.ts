/**
 * @bugfix mpv-pill-state-ipc-flood
 * @regression-proof
 *
 * Ultimate-stress finding NEW-pill-state-flood (#25): sf.lua emitted
 * `sf-pill-state` per frame (~16/s), and main logged EVERY message at info
 * twice — `[mpv-script-message] received` in UnixSocketMpvClient and
 * `[mpv-script-message] forwarding to renderer` in externalMpv — then IPC'd it
 * into the (often hidden) renderer, which has no production consumer for it.
 *
 * Lowest layer that shows it: drive the real UnixSocketMpvClient with 50
 * `client-message` events from a mock mpv socket and count info-level logs
 * (console.info + the scoped pino logger). Pre-fix: 50 console.info lines.
 * Plus: the forwarding policy drops sf-pill-state outside E2E.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnixSocketMpvClient } from "../src/main/mpvSocketClient";
import { shouldForwardScriptMessage } from "../src/main/externalMpvMessageRouting";

const TAG = "[mpv-pill-state-log-flood]";

type LogCall = { scope: string; level: string; args: unknown[] };
// vi.mock is hoisted above the imports, so its recorder must be too.
const { logCalls } = vi.hoisted(() => ({ logCalls: [] as LogCall[] }));

vi.mock("../src/main/logger", () => {
  const make = (scope: string): Record<string, unknown> => {
    const rec: Record<string, unknown> = {};
    for (const level of ["fatal", "error", "warn", "info", "debug", "trace"]) {
      rec[level] = (...args: unknown[]) => {
        logCalls.push({ scope, level, args });
      };
    }
    rec.child = (bindings: { scope?: string }) => make(bindings?.scope ?? scope);
    return rec;
  };
  return { logger: make("root"), scopeLogger: (scope: string) => make(scope) };
});

const cleanupSocket = (path: string) => {
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // already gone
    }
  }
};

type MockMpv = { firstCommand: Promise<void>; push: (event: unknown) => void; stop: () => Promise<void> };

const startMockMpv = async (socketPath: string): Promise<MockMpv> => {
  cleanupSocket(socketPath);
  const connections: Socket[] = [];
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
        let parsed: { request_id?: unknown };
        try {
          parsed = JSON.parse(line) as { request_id?: unknown };
        } catch {
          continue;
        }
        first.resolve();
        if (typeof parsed.request_id === "number") {
          conn.write(`${JSON.stringify({ request_id: parsed.request_id, error: "success" })}\n`);
        }
      }
    });
  });
  server.listen(socketPath, () => listening.resolve());
  await listening.promise;
  return {
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

describe("sf-pill-state does not flood main logs (#25 NEW-pill-state-flood)", () => {
  let socketPath: string;
  let mock: MockMpv;

  beforeEach(async () => {
    logCalls.length = 0;
    socketPath = join(tmpdir(), `test-mpv-pill-flood-${process.pid}-${Date.now()}.sock`);
    mock = await startMockMpv(socketPath);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await mock.stop();
  });

  it("50 sf-pill-state messages produce 0 info-level logs (one debug line each)", async () => {
    const client = new UnixSocketMpvClient();
    // @ts-expect-error — exercising the live-launch state without spawn.
    client.socketPath = socketPath;
    // @ts-expect-error — same.
    client._state = "ready";
    const COUNT = 50;
    const received: Array<{ name: string; args: string[] }> = [];
    const allSeen = Promise.withResolvers<void>();
    client.on("script-message", (event) => {
      received.push(event);
      if (received.length === COUNT) allSeen.resolve();
    });
    const unsubscribe = client.observe("time-pos", () => undefined);
    await mock.firstCommand;

    const consoleInfo = vi.spyOn(console, "info");
    const before = logCalls.length;
    for (let i = 0; i < COUNT; i += 1) {
      const payload = JSON.stringify({ active: false, autoSkip: false, timePos: 10 + i / 24 });
      mock.push({ event: "client-message", args: ["sf-pill-state", payload] });
    }
    await allSeen.promise;
    const during = logCalls.slice(before);
    const infoCalls = consoleInfo.mock.calls.length;
    consoleInfo.mockRestore();
    const loggerInfo = during.filter((c) => ["info", "warn", "error", "fatal"].includes(c.level));
    const loggerDebug = during.filter((c) => c.level === "debug");
    console.info(
      `${TAG} received=${received.length} console.info=${infoCalls} logger>=info=${loggerInfo.length} logger.debug=${loggerDebug.length} sample=${JSON.stringify(during[0] ?? null)}`,
    );
    expect(received).toHaveLength(COUNT);
    expect(received[0]!.name).toBe("sf-pill-state");
    expect(infoCalls, "console.info calls while receiving 50 pill states").toBe(0);
    expect(loggerInfo, "logger info+ calls while receiving 50 pill states").toEqual([]);
    expect(loggerDebug).toHaveLength(COUNT);
    unsubscribe();
    await client.dispose();
  });

  it("forwards sf-pill-state to the renderer only in E2E; other script-messages always", () => {
    const cases = [
      { name: "sf-pill-state", env: {}, want: false },
      { name: "sf-pill-state", env: { SF_E2E: "1" }, want: true },
      { name: "sf-track-picked", env: {}, want: true },
      { name: "sf-e2e-pill-json", env: {}, want: true },
    ];
    const got = cases.map((c) => ({ ...c, got: shouldForwardScriptMessage(c.name, c.env) }));
    console.info(`${TAG} forwarding=${JSON.stringify(got)}`);
    expect(got.filter((c) => c.got !== c.want)).toEqual([]);
  });

  it("externalMpv's script-message bridge no longer logs per message and applies the forwarding policy", () => {
    const main = readFileSync(new URL("../src/main/externalMpv.ts", import.meta.url), "utf8");
    const start = main.indexOf('client.on("script-message"');
    const handler = main.slice(start, main.indexOf("});", start));
    console.info(`${TAG} handler=${JSON.stringify(handler)}`);
    expect(start).toBeGreaterThan(-1);
    expect(handler).toContain("shouldForwardScriptMessage(event.name)");
    expect(handler).not.toMatch(/console\.(info|log)|logger\.info/);
  });
});
