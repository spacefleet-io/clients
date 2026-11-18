/**
 * @bugfix stale-next-episode-osc-action-replayed-after-mpv-kill
 * @regression-proof
 *
 * Issue #25 P14 (ultimate run before-2, shard 3, c067 and c069). The credits
 * pill navigated s1e2→s1e3 with a real osc_action; the next episode reloaded
 * in the SAME mpv (launch 3), so its action file still held that action. The
 * harness then killed mpv (SIGKILL at 1791546024050). The controller remounted
 * (1791546027867) and at 1791546029188 `[osc-action] received` fired again,
 * navigating s1e3→s1e4 with no mpv; the init effect skipped "load already in
 * flight" and the app sat on "launching".
 *
 * Chain:
 *   1. UnixSocketMpvClient's OSC poll was suspended in readFile when the
 *      process exit ran stopOscActionPolling, which reset
 *      lastOscActionPayload to null. The poll resumed, compared the OLD
 *      action to null and emitted it again.
 *   2. Main stored it as the pending action with no owner check, although
 *      that client was no longer current.
 *   3. The renderer's mount pulled the pending action (inside its 15 s TTL)
 *      with a fresh seq, so its per-mount dedupe let it through.
 *
 * Fix: polls are bound to a polling generation (1), and the pending slot is
 * bound to the client that produced the action (2, 3).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fsPromises, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OscActionFile } from "@space/mpv-protocol";
import { UnixSocketMpvClient } from "../src/main/mpvSocketClient";
import { PENDING_OSC_ACTION_TTL_MS, PendingOscActionSlot } from "../src/main/pendingOscAction";

const TAG = "[osc-action-not-replayed]";
const log = (phase: string, data: Record<string, unknown> = {}) =>
  console.info(`${TAG} phase=${phase} ${JSON.stringify(data)}`);

const ACTION: OscActionFile = { type: "next_episode", requestedAt: 1791545994900 };

type PollingClient = {
  startOscActionPolling: (path: string) => void;
  stopOscActionPolling: () => void;
};

// The action file exists before polling starts (production creates it in
// initializeOscActionFile), so the client watches it: reads happen when the
// watcher fires, with the 1 s safety-net interval behind it. fake timers do not
// drive fs I/O, so these waits poll a predicate (the awaited condition is named
// in the error) instead of sleeping blind. Tests trigger further reads by
// rewriting the file (a watch event).
const waitFor = async (predicate: () => boolean, timeoutMs: number, what: string) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`${TAG} timed out waiting for ${what}`);
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 10);
    await promise;
  }
};

describe("UnixSocketMpvClient OSC action poll across a stop (issue #25 P14)", () => {
  let actionPath: string | null = null;
  let client: UnixSocketMpvClient | null = null;
  let activePolling: PollingClient | null = null;

  afterEach(() => {
    vi.restoreAllMocks();
    activePolling?.stopOscActionPolling();
    activePolling = null;
    client = null;
    if (actionPath && existsSync(actionPath)) unlinkSync(actionPath);
    actionPath = null;
  });

  const startPolling = () => {
    actionPath = join(tmpdir(), `test-osc-action-${process.pid}-${Date.now()}.json`);
    // Same as production: the file exists before polling starts, so the watcher path runs.
    writeFileSync(actionPath, "");
    client = new UnixSocketMpvClient();
    const polling = client as unknown as PollingClient;
    activePolling = polling;
    const emitted: OscActionFile[] = [];
    const startedAt = Date.now();
    client.on("osc-action", (action) => {
      log("emit", { action, sinceStartMs: Date.now() - startedAt });
      emitted.push(action);
    });
    polling.startOscActionPolling(actionPath);
    return { emitted, path: actionPath, polling };
  };

  /** Count every readFile the poll makes, without changing what it reads. */
  const countReads = () => {
    const realReadFile = fsPromises.readFile.bind(fsPromises);
    const counter = { reads: 0 };
    vi.spyOn(fsPromises, "readFile").mockImplementation((async (...args: Parameters<typeof fsPromises.readFile>) => {
      counter.reads += 1;
      return await realReadFile(...args);
    }) as typeof fsPromises.readFile);
    return counter;
  };

  it("emits a written action exactly once while polling (control)", async () => {
    const { emitted, path } = startPolling();
    const counter = countReads();
    writeFileSync(path, JSON.stringify(ACTION));
    await waitFor(() => emitted.length > 0, 2000, "first emit");
    // Three more reads of the same content: none may emit again.
    const readsAtEmit = counter.reads;
    for (let rewrite = 1; rewrite <= 3; rewrite += 1) {
      const readsBefore = counter.reads;
      writeFileSync(path, JSON.stringify(ACTION));
      await waitFor(() => counter.reads > readsBefore, 2000, `read #${rewrite} after a rewrite`);
    }
    log("control-done", { emitted, readsAtEmit, reads: counter.reads });
    expect(emitted).toEqual([ACTION]);
  });

  it("@bugfix @regression-proof a poll suspended in readFile when polling stops (mpv exit) does not re-emit the old action", async () => {
    const { emitted, path, polling } = startPolling();
    writeFileSync(path, JSON.stringify(ACTION));
    // 1. The real osc_action (the credits-pill navigation).
    await waitFor(() => emitted.length === 1, 2000, "the real action");
    log("real-action-delivered", { emitted: emitted.length });

    // 2. Hold the NEXT readFile open after it has read the file, the way a
    //    loaded PC stalls it.
    const realReadFile = fsPromises.readFile.bind(fsPromises);
    const gate = Promise.withResolvers<void>();
    let suspendedRead: Promise<unknown> | null = null;
    let contentRead: string | null = null;
    vi.spyOn(fsPromises, "readFile").mockImplementation(((...args: Parameters<typeof fsPromises.readFile>) => {
      const read = (async () => {
        const content = await realReadFile(...args);
        contentRead ??= String(content);
        await gate.promise;
        return content;
      })();
      suspendedRead ??= read;
      return read;
    }) as typeof fsPromises.readFile);
    // Wait until the stalled poll HAS the old content (not merely entered
    // readFile): stop unlinks the file, and an unopened read would just fail.
    writeFileSync(path, JSON.stringify(ACTION));
    await waitFor(() => contentRead !== null, 2000, "a poll to read the file and stall");
    log("poll-suspended-in-readFile", { contentRead });

    // 3. mpv is SIGKILLed: process exit runs stopOscActionPolling.
    polling.stopOscActionPolling();
    log("polling-stopped (mpv exit)");

    // 4. The suspended read completes with the old file content; the poll's
    //    continuation runs right after it, then one macrotask flushes it.
    gate.resolve();
    await (suspendedRead as unknown as Promise<unknown>);
    const flushed = Promise.withResolvers<void>();
    setImmediate(flushed.resolve);
    await flushed.promise;
    log("after-release", { emitted: emitted.length });
    expect(emitted).toEqual([ACTION]);
  });
});

describe("PendingOscActionSlot binds the recovery slot to the producing mpv (issue #25 P14)", () => {
  const clientA = { name: "launch-3" };
  const clientB = { name: "launch-4" };

  it("@bugfix @regression-proof an action from a client that is no longer current is refused", () => {
    const slot = new PendingOscActionSlot<object>();
    const seq = slot.record(clientA, null, ACTION, 1000);
    log("stale-record", { seq, peek: slot.peek() });
    expect(seq).toBeNull();
    expect(slot.take(null, 1001)).toBeNull();
    expect(slot.take(clientB, 1001)).toBeNull();
  });

  it("@bugfix @regression-proof the exit of the producing mpv clears its pending action", () => {
    const slot = new PendingOscActionSlot<object>();
    const seq = slot.record(clientA, clientA, ACTION, 1000);
    expect(seq).toBe(1);
    const cleared = slot.clearOwner(clientA);
    log("exit-clears", { seq, cleared, peek: slot.peek() });
    expect(cleared).toBe(true);
    expect(slot.take(clientA, 1001)).toBeNull();
  });

  it("@bugfix @regression-proof a pull for a different (or no) current mpv never returns another instance's action", () => {
    const slot = new PendingOscActionSlot<object>();
    slot.record(clientA, clientA, ACTION, 1000);
    const taken = slot.take(clientB, 1001);
    log("cross-instance-pull", { taken, peek: slot.peek() });
    expect(taken).toBeNull();
    // and it is gone for good, even for its own client
    expect(slot.take(clientA, 1002)).toBeNull();
  });

  it("keeps the durable recovery for the live owner: pull, ack, TTL", () => {
    const slot = new PendingOscActionSlot<object>();
    const seq = slot.record(clientA, clientA, ACTION, 1000);
    expect(slot.take(clientA, 1500)).toEqual({ action: ACTION, seq });
    // still there until acked (a second mount may pull it; renderer dedupes by seq)
    expect(slot.take(clientA, 1600)).toEqual({ action: ACTION, seq });
    slot.ack(seq as number);
    expect(slot.take(clientA, 1700)).toBeNull();
    const seq2 = slot.record(clientA, clientA, ACTION, 2000);
    expect(seq2).toBe(2);
    expect(slot.take(clientA, 2000 + PENDING_OSC_ACTION_TTL_MS + 1)).toBeNull();
    log("recovery-contract-ok", { seq, seq2 });
  });
});
