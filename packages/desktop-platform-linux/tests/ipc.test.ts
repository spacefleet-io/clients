import { createServer } from "node:net";
import type { Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { linuxMpvIpc } from "../src/ipc";

const servers: Server[] = [];
const endpoints: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const endpoint of endpoints.splice(0)) linuxMpvIpc.remove(endpoint);
});

describe("linux mpv ipc (unix socket in tmpdir)", () => {
  it("endpoint is <tmpdir>/sf-mpv-<token>.sock", () => {
    const endpoint = linuxMpvIpc.endpoint("123-456");
    console.info(`[linux-ipc:endpoint] ${endpoint}`);
    expect(endpoint).toBe(path.join(tmpdir(), "sf-mpv-123-456.sock"));
  });

  it("exists/remove: remove is repeatable and tolerates a missing endpoint", () => {
    const endpoint = linuxMpvIpc.endpoint(`unit-${process.pid}-${Date.now()}`);
    expect(linuxMpvIpc.exists(endpoint)).toBe(false);
    expect(() => linuxMpvIpc.remove(endpoint)).not.toThrow();
    expect(() => linuxMpvIpc.remove(endpoint)).not.toThrow();
  });

  it("connect talks to a real unix-socket server and remove unlinks it", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sf-linux-ipc-"));
    const endpoint = path.join(dir, "mpv.sock");
    endpoints.push(endpoint);
    try {
      const server = createServer((socket) => {
        socket.on("data", (chunk) => socket.write(`echo:${chunk.toString()}`));
      });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(endpoint, resolve));
      console.info(`[linux-ipc:connect] listening on ${endpoint} exists=${linuxMpvIpc.exists(endpoint)}`);
      expect(linuxMpvIpc.exists(endpoint)).toBe(true);

      const socket = linuxMpvIpc.connect(endpoint);
      const reply = await new Promise<string>((resolve, reject) => {
        socket.once("error", reject);
        socket.once("data", (chunk) => resolve(chunk.toString()));
        socket.once("connect", () => socket.write("ping"));
      });
      console.info(`[linux-ipc:connect] reply=${reply}`);
      expect(reply).toBe("echo:ping");
      socket.destroy();

      linuxMpvIpc.remove(endpoint);
      expect(linuxMpvIpc.exists(endpoint)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
