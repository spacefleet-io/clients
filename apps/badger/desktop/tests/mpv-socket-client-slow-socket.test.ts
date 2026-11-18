/**
 * @bugfix mpv-socket-fixed-5s-wait
 * @regression-proof
 *
 * Issue #25 P9 (ultimate run b51ea3c4, s1 c016). `start()` waited a FIXED
 * 5 s for mpv's IPC socket. On a throttled 2-CPU slice mpv bound it later:
 * "socket missing after timeout" 5.03 s after launch, then "load failed",
 * although mpv was alive and still starting.
 *
 * Fix: the wait is readiness-based. It ends when the socket accepts a
 * connection, when the mpv process exits (fast, with a clear reason), or at
 * an overall cap well above any healthy start.
 *
 * Real processes on purpose: a `/bin/sh` stub stands in for mpv and binds the
 * socket after a delay, or exits without ever binding it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnixSocketMpvClient } from "../src/main/mpvSocketClient";

const TAG = "[mpv-slow-socket]";

/** Node one-liner that binds the IPC socket and stays up until killed. */
const BIND_SOCKET = `require("node:net").createServer(() => {}).listen(process.argv[1])`;

const describeLinux = process.platform === "linux" ? describe : describe.skip;

describeLinux("mpv socket wait is readiness-based, not a fixed 5 s (issue #25 P9)", () => {
  let dir: string | null = null;
  let client: UnixSocketMpvClient | null = null;

  afterEach(async () => {
    if (client) {
      console.info(`${TAG} cleanup: dispose state=${client.__getLifecycleStateForTests().kind}`);
      await client.dispose().catch((error) => console.warn(`${TAG} dispose failed`, error));
    }
    client = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("@bugfix @regression-proof an mpv that binds its socket after 6 s is ready, not failed", async () => {
    dir = mkdtempSync(join(tmpdir(), "sf-mpv-slow-"));
    const socketPath = join(dir, "mpv.sock");
    client = new UnixSocketMpvClient();
    const startedAt = Date.now();
    console.info(`${TAG} launching stub mpv that binds ${socketPath} after 6 s`);
    const result = await client.start({
      bin: "/bin/sh",
      args: ["-c", `sleep 6; exec "${process.execPath}" -e '${BIND_SOCKET}' "${socketPath}"`],
      env: process.env,
      socketPath,
    });
    const elapsedMs = Date.now() - startedAt;
    console.info(`${TAG} start() returned ${JSON.stringify(result)} after ${elapsedMs}ms lifecycle=${client.__getLifecycleStateForTests().kind}`);
    expect(result.socketReady).toBe(true);
    expect(elapsedMs).toBeGreaterThanOrEqual(5900);
  }, 30_000);

  it("@bugfix @regression-proof an mpv that exits without a socket fails fast with a clear reason", async () => {
    dir = mkdtempSync(join(tmpdir(), "sf-mpv-exit-"));
    const socketPath = join(dir, "mpv.sock");
    client = new UnixSocketMpvClient();
    const startedAt = Date.now();
    const result = await client.start({
      bin: "/bin/sh",
      args: ["-c", "sleep 0.3; exit 3"],
      env: process.env,
      socketPath,
    });
    const elapsedMs = Date.now() - startedAt;
    console.info(`${TAG} start() returned ${JSON.stringify(result)} after ${elapsedMs}ms lifecycle=${client.__getLifecycleStateForTests().kind}`);
    expect(result.socketReady).toBe(false);
    expect(result.failure).toBe("process_exited");
    expect(elapsedMs).toBeLessThan(2000);
  }, 30_000);
});
