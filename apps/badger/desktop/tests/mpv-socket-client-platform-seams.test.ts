/**
 * @test-id DESKTOP-MPV-PLATFORM-SEAMS-001
 * @level integration
 * @why The external-mpv client must reach the OS only through the desktop
 *   platform contract: the IPC endpoint (exists / connect / remove) and the
 *   child lifetime hook (Windows ties mpv to the app with a Job Object after
 *   spawn; Linux relies on the sf.lua watchdog). A real mpv-shaped child
 *   (a node unix-socket server) is driven through the real Linux platform
 *   wrapped with spies.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDesktopPlatform, setDesktopPlatformForTests, type DesktopPlatform } from "@space/desktop-platform";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnixSocketMpvClient } from "../src/main/mpvSocketClient";

const TAG = "[mpv-platform-seams]";

const SERVER_CHILD = `
const net = require("node:net");
const socketPath = process.argv[1];
net.createServer((socket) => {
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    let at;
    while ((at = buffer.indexOf("\\n")) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      const request = JSON.parse(line);
      socket.write(JSON.stringify({ request_id: request.request_id, error: "success", data: "pong" }) + "\\n");
    }
  });
  socket.on("error", () => {});
}).listen(socketPath);
setInterval(() => {}, 1000);
`;

describe("external mpv client talks to the OS through the platform contract", () => {
  let dir: string;
  let real: DesktopPlatform;
  const calls: string[] = [];

  beforeEach(() => {
    real = getDesktopPlatform();
    calls.length = 0;
    dir = mkdtempSync(join(tmpdir(), "sf-mpv-seams-"));
    setDesktopPlatformForTests({
      ...real,
      mpvIpc: {
        endpoint: real.mpvIpc.endpoint,
        exists: (endpoint) => {
          calls.push("ipc.exists");
          return real.mpvIpc.exists(endpoint);
        },
        connect: (endpoint, onConnect) => {
          calls.push("ipc.connect");
          return real.mpvIpc.connect(endpoint, onConnect);
        },
        remove: (endpoint) => {
          calls.push(`ipc.remove:${endpoint}`);
          real.mpvIpc.remove(endpoint);
        },
      },
      processes: {
        ...real.processes,
        withoutInheritedHandles: (command, args, env) => {
          calls.push("withoutInheritedHandles");
          return real.processes.withoutInheritedHandles(command, args, env);
        },
        spawnOptions: (options) => {
          calls.push(`spawnOptions:detached=${options.detached}`);
          return real.processes.spawnOptions(options);
        },
        childLifetime: {
          ...real.processes.childLifetime,
          afterSpawn: (pid) => {
            calls.push(`afterSpawn:${pid}`);
            real.processes.childLifetime.afterSpawn(pid);
          },
        },
      },
    });
  });

  afterEach(() => {
    setDesktopPlatformForTests(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it("spawns detached, hands the child pid to childLifetime.afterSpawn, and drives the endpoint through mpvIpc", async () => {
    const endpoint = real.mpvIpc.endpoint(`seams-${process.pid}-${Date.now()}`);
    const client = new UnixSocketMpvClient();
    try {
      const { socketReady } = await client.start({
        bin: process.execPath,
        args: ["-e", SERVER_CHILD, endpoint],
        env: process.env,
        socketPath: endpoint,
      });
      // @ts-expect-error — test reads the spawned pid.
      const pid: number = client.processGroupId;
      console.info(`${TAG} socketReady=${socketReady} pid=${pid} calls=${JSON.stringify(calls)}`);
      expect(socketReady).toBe(true);
      expect(calls).toContain("spawnOptions:detached=true");
      expect(calls).toContain(`afterSpawn:${pid}`);
      expect(calls).toContain("withoutInheritedHandles");
      // The stale-endpoint clear precedes the spawn, the readiness wait uses exists + connect.
      expect(calls.indexOf(`ipc.remove:${endpoint}`)).toBeLessThan(calls.indexOf(`afterSpawn:${pid}`));
      expect(calls).toContain("ipc.exists");
      expect(calls).toContain("ipc.connect");
      const reply = await client.request({ command: ["get_property", "time-pos"] });
      console.info(`${TAG} reply=${JSON.stringify(reply)}`);
      expect(reply.data).toBe("pong");
    } finally {
      await client.dispose();
    }
    console.info(`${TAG} after dispose calls=${JSON.stringify(calls)}`);
    expect(calls.filter((call) => call === `ipc.remove:${endpoint}`).length).toBeGreaterThanOrEqual(2);
    expect(real.mpvIpc.exists(endpoint)).toBe(false);
  }, 20_000);
});
