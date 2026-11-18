/**
 * @bugfix osc-action-poll-cost
 * @regression-proof
 *
 * Issue #25 (playback must cost no more than plain local mpv): while mpv plays,
 * UnixSocketMpvClient polled sf.lua's OSC action file every 150 ms for the whole
 * session (existsSync + a readFile on the libuv pool: ~6.7 reads/s forever, to
 * catch a click on "next episode" that happens once in a while).
 *
 * Fix: the file is watched (fs.watch), so a write is picked up at once; the
 * interval stays only as a slow safety net (events can be lost on network /
 * bind-mounted filesystems) at 1 s. When the file cannot be watched the legacy
 * 150 ms poll remains the only trigger, so action latency never regresses.
 *
 * Lowest layer: the real client against a real temp file. Fake timers drive the
 * interval (so a read count over 10 s of playback is exact and instant), the
 * watcher path is proven by an emit that needs NO timer to advance.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fsPromises, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { setImmediate as nextMacrotask } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OscActionFile } from "@space/mpv-protocol";
import { UnixSocketMpvClient } from "../src/main/mpvSocketClient";

const TAG = "[osc-action-poll-cost]";
const ACTION: OscActionFile = { type: "next_episode", requestedAt: 1791545994900 };

type PollingClient = {
  startOscActionPolling: (path: string) => void;
  stopOscActionPolling: () => void;
};

describe("OSC action file polling cost (issue #25)", () => {
  let actionPath: string;
  let client: UnixSocketMpvClient;
  let polling: PollingClient;
  let readFileCalls: number;

  beforeEach(() => {
    actionPath = join(tmpdir(), `test-osc-poll-cost-${process.pid}-${Date.now()}.json`);
    writeFileSync(actionPath, "");
    client = new UnixSocketMpvClient();
    polling = client as unknown as PollingClient;
    readFileCalls = 0;
    // Counts reads and answers an empty file without touching the disk: the
    // interval ticks then complete synchronously under the fake clock.
    vi.spyOn(fsPromises, "readFile").mockImplementation((async () => {
      readFileCalls += 1;
      return "";
    }) as unknown as typeof fsPromises.readFile);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    polling.stopOscActionPolling();
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (existsSync(actionPath)) unlinkSync(actionPath);
  });

  it("reads the action file at most once per second while idle (was every 150 ms)", async () => {
    polling.startOscActionPolling(actionPath);
    await vi.advanceTimersByTimeAsync(10_000);
    console.info(`${TAG} idle 10 s: readFile calls=${readFileCalls} (${(readFileCalls / 10).toFixed(1)}/s)`);
    expect(readFileCalls, "action file reads over 10 s of idle playback").toBeLessThanOrEqual(11);
  });

  it("picks a written action up from the file watcher without any timer tick", async () => {
    vi.restoreAllMocks();
    const delivered = Promise.withResolvers<OscActionFile>();
    client.on("osc-action", (action) => delivered.resolve(action));
    polling.startOscActionPolling(actionPath);
    const writtenAt = Date.now();
    // fs.watch arms asynchronously on some hosts (macOS: a write in the same tick as watch(), or a
    // few ticks later, is not reported), so keep (re)writing the same action until it arrives.
    // No fake-timer advance anywhere: only the watcher can deliver this.
    let arrived = false;
    void delivered.promise.then(() => (arrived = true));
    let writes = 0;
    while (!arrived) {
      writeFileSync(actionPath, JSON.stringify(ACTION));
      writes += 1;
      await nextMacrotask();
    }
    const action = await delivered.promise;
    console.info(`${TAG} watcher delivered ${JSON.stringify(action)} after ${Date.now() - writtenAt} ms (${writes} writes) with the interval frozen`);
    expect(action).toEqual(ACTION);
  });

  it("keeps the 150 ms poll when the file cannot be watched (latency does not regress)", async () => {
    vi.restoreAllMocks();
    const missingPath = join(tmpdir(), `test-osc-poll-cost-missing-${process.pid}-${Date.now()}.json`);
    const delivered = Promise.withResolvers<OscActionFile>();
    client.on("osc-action", (action) => delivered.resolve(action));
    polling.startOscActionPolling(missingPath);
    writeFileSync(missingPath, JSON.stringify(ACTION));
    try {
      await vi.advanceTimersByTimeAsync(150);
      const action = await delivered.promise;
      console.info(`${TAG} unwatchable file: delivered ${JSON.stringify(action)} within one 150 ms tick`);
      expect(action).toEqual(ACTION);
    } finally {
      if (existsSync(missingPath)) unlinkSync(missingPath);
    }
  });
});
