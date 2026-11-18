/**
 * Desktop → runtime "uploads while a video plays" sender (#25, Chris 2026-10-13).
 * mpv alive ⇒ `playbackActive: true` leases (renewed by a heartbeat); mpv gone
 * (exit, crash, dispose) ⇒ `playbackActive: false`; a Settings change is sent at
 * once; a runtime that was restarted (no lease) is re-armed by the next heartbeat.
 *
 * @bugfix @regression-proof
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UPLOAD_POLICY_HEARTBEAT_MS,
  UPLOAD_POLICY_LEASE_MS,
  UPLOAD_POLICY_TICK_MS,
  createUploadPlaybackPolicy,
  type UploadPolicyMessage,
} from "../src/main/uploadPlaybackPolicy";
import type { UploadsDuringPlayback } from "../src/shared/uploadPlaybackDefault";

const P = "[upload-playback-policy]";

type Harness = {
  sent: UploadPolicyMessage[];
  mpv: { alive: boolean };
  send: ReturnType<typeof vi.fn>;
  policy: ReturnType<typeof createUploadPlaybackPolicy>;
  logs: string[];
};

const harness = (mode: UploadsDuringPlayback, sendImpl?: (m: UploadPolicyMessage) => Promise<boolean>): Harness => {
  const sent: UploadPolicyMessage[] = [];
  const mpv = { alive: false };
  const logs: string[] = [];
  const send = vi.fn(async (message: UploadPolicyMessage) => {
    sent.push(message);
    console.info(`${P}:send ${JSON.stringify(message)}`);
    return sendImpl ? sendImpl(message) : true;
  });
  const policy = createUploadPlaybackPolicy({
    isMpvAlive: () => mpv.alive,
    send,
    mode,
    log: (line) => {
      logs.push(line);
      console.info(`${P}:log ${line}`);
    },
  });
  return { sent, mpv, send, policy, logs };
};

const dump = (label: string, h: Harness) =>
  console.error(`=== ${P}:${label} snapshot ===\nsent=${JSON.stringify(h.sent, null, 2)}\nmpv=${JSON.stringify(h.mpv)}\nlogs=${h.logs.join("\n")}\n=== end ===`);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("mpv lifetime drives playbackActive", () => {
  it("sends nothing while no video is open", async () => {
    const h = harness("throttle");
    h.policy.start();
    await vi.advanceTimersByTimeAsync(60_000);
    if (h.sent.length !== 0) dump("idle-sent", h);
    expect(h.sent).toEqual([]);
    h.policy.stop();
  });

  it("mpv starts → active lease with the configured mode within one tick", async () => {
    const h = harness("pause");
    h.policy.start();
    h.mpv.alive = true;
    await vi.advanceTimersByTimeAsync(UPLOAD_POLICY_TICK_MS);
    if (h.sent.length !== 1) dump("start", h);
    expect(h.sent).toEqual([{ mode: "pause", playbackActive: true, leaseMs: UPLOAD_POLICY_LEASE_MS }]);
    h.policy.stop();
  });

  it("renews the lease before it can expire while mpv stays alive", async () => {
    expect(UPLOAD_POLICY_HEARTBEAT_MS).toBeLessThan(UPLOAD_POLICY_LEASE_MS);
    const h = harness("throttle");
    h.policy.start();
    h.mpv.alive = true;
    await vi.advanceTimersByTimeAsync(UPLOAD_POLICY_LEASE_MS * 4);
    const active = h.sent.filter((m) => m.playbackActive);
    console.info(`${P}:heartbeat count=${active.length}`);
    if (active.length < 4) dump("heartbeat", h);
    expect(active.length).toBeGreaterThanOrEqual(4);
    expect(h.sent.every((m) => m.playbackActive && m.mode === "throttle")).toBe(true);
    h.policy.stop();
  });

  it("mpv exits or crashes → playbackActive false is sent, once, and the heartbeat stops", async () => {
    const h = harness("pause");
    h.policy.start();
    h.mpv.alive = true;
    await vi.advanceTimersByTimeAsync(UPLOAD_POLICY_TICK_MS);
    h.mpv.alive = false;
    await vi.advanceTimersByTimeAsync(UPLOAD_POLICY_TICK_MS);
    const after = h.sent.length;
    await vi.advanceTimersByTimeAsync(60_000);
    if (h.sent.at(-1)?.playbackActive !== false || h.sent.length !== after) dump("exit", h);
    expect(h.sent.at(-1)).toMatchObject({ mode: "pause", playbackActive: false });
    expect(h.sent.length).toBe(after);
    h.policy.stop();
  });

  it("a second video after the first is active again", async () => {
    const h = harness("throttle");
    h.policy.start();
    for (const alive of [true, false, true]) {
      h.mpv.alive = alive;
      await vi.advanceTimersByTimeAsync(UPLOAD_POLICY_TICK_MS);
    }
    expect(h.sent.map((m) => m.playbackActive)).toEqual([true, false, true]);
    h.policy.stop();
  });
});

describe("Settings change takes effect live", () => {
  it("changing the mode during playback is sent immediately, not at the next heartbeat", async () => {
    const h = harness("pause");
    h.policy.start();
    h.mpv.alive = true;
    await vi.advanceTimersByTimeAsync(UPLOAD_POLICY_TICK_MS);
    h.sent.length = 0;
    h.policy.setMode("full");
    await vi.advanceTimersByTimeAsync(0);
    console.info(`${P}:live sent=${JSON.stringify(h.sent)}`);
    if (h.sent.length !== 1) dump("live", h);
    expect(h.sent).toEqual([{ mode: "full", playbackActive: true, leaseMs: UPLOAD_POLICY_LEASE_MS }]);
    h.policy.stop();
  });

  it("changing the mode with no video open sends nothing (the next video picks it up)", async () => {
    const h = harness("pause");
    h.policy.start();
    h.policy.setMode("full");
    await vi.advanceTimersByTimeAsync(UPLOAD_POLICY_TICK_MS * 3);
    expect(h.sent).toEqual([]);
    h.mpv.alive = true;
    await vi.advanceTimersByTimeAsync(UPLOAD_POLICY_TICK_MS);
    expect(h.sent).toEqual([{ mode: "full", playbackActive: true, leaseMs: UPLOAD_POLICY_LEASE_MS }]);
    h.policy.stop();
  });

  it("setting the same mode again does not resend", async () => {
    const h = harness("throttle");
    h.policy.start();
    h.mpv.alive = true;
    await vi.advanceTimersByTimeAsync(UPLOAD_POLICY_TICK_MS);
    h.sent.length = 0;
    h.policy.setMode("throttle");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.sent).toEqual([]);
    h.policy.stop();
  });
});

describe("runtime restarts and failures", () => {
  it("a failed send is retried on the next tick (runtime not up yet), logging once per failure streak", async () => {
    let failing = true;
    const h = harness("pause", async () => !failing);
    h.policy.start();
    h.mpv.alive = true;
    await vi.advanceTimersByTimeAsync(UPLOAD_POLICY_TICK_MS * 3);
    const failedAttempts = h.sent.length;
    expect(failedAttempts).toBeGreaterThanOrEqual(3);
    expect(h.logs.filter((l) => l.includes("send failed")).length).toBe(1);
    failing = false;
    await vi.advanceTimersByTimeAsync(UPLOAD_POLICY_TICK_MS);
    expect(h.sent.at(-1)).toMatchObject({ playbackActive: true });
    expect(h.logs.some((l) => l.includes("send recovered"))).toBe(true);
    h.policy.stop();
  });

  it("a rejected send is treated like a failed one (never throws out of the timer)", async () => {
    const h = harness("pause", async () => {
      throw new Error("fetch failed");
    });
    h.policy.start();
    h.mpv.alive = true;
    await vi.advanceTimersByTimeAsync(UPLOAD_POLICY_TICK_MS * 2);
    expect(h.sent.length).toBeGreaterThanOrEqual(2);
    h.policy.stop();
  });

  it("never has two sends in flight at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const releases: Array<() => void> = [];
    const h = harness("pause", () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const { promise, resolve } = Promise.withResolvers<boolean>();
      releases.push(() => {
        inFlight--;
        resolve(true);
      });
      return promise;
    });
    h.policy.start();
    h.mpv.alive = true;
    // The first send never answers while many ticks pass.
    await vi.advanceTimersByTimeAsync(UPLOAD_POLICY_TICK_MS * 12);
    expect(h.sent.length).toBe(1);
    releases.shift()?.();
    await vi.advanceTimersByTimeAsync(UPLOAD_POLICY_HEARTBEAT_MS);
    releases.shift()?.();
    expect(maxInFlight).toBe(1);
    h.policy.stop();
  });

  it("stop() while a video is open releases the pause (best effort) and stops the timers", async () => {
    const h = harness("pause");
    h.policy.start();
    h.mpv.alive = true;
    await vi.advanceTimersByTimeAsync(UPLOAD_POLICY_TICK_MS);
    await h.policy.stop();
    expect(h.sent.at(-1)).toMatchObject({ mode: "pause", playbackActive: false });
    const count = h.sent.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.sent.length).toBe(count);
  });

  it("an app restart mid-pause: the new process resumes only while mpv is alive (uploads are never stuck paused)", async () => {
    // First app run: mpv alive, pause leased, then the app dies (no stop()): the runtime's
    // lease runs out by itself (content-core upload-playback-gate test). The new process
    // starts with no video open, so it sends nothing and the runtime stays at full speed.
    const first = harness("pause");
    first.policy.start();
    first.mpv.alive = true;
    await vi.advanceTimersByTimeAsync(UPLOAD_POLICY_TICK_MS);
    expect(first.sent.at(-1)).toMatchObject({ playbackActive: true });
    const second = harness("pause");
    second.policy.start();
    await vi.advanceTimersByTimeAsync(UPLOAD_POLICY_LEASE_MS * 2);
    expect(second.sent).toEqual([]);
    first.policy.stop();
    second.policy.stop();
  });
});
