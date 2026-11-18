/**
 * @bugfix transcode-not-gated-during-playback @regression-proof
 *
 * #25 (Chris 2026-10-13): the playback lease the desktop renews
 * (`badger.playback.set_upload_policy`) must also drive transcode ffmpegs, with
 * NO second mechanism. These tests use the real upload lease and the real
 * encode gate (only the OS calls are faked) and fake timers for the lease clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUploadPlaybackGate, PLAYBACK_LEASE_MS_DEFAULT } from "@space/content-core/storageTransport";
import type { ProcessControlBackend } from "@space/desktop-platform";
import { createEncodePlaybackGate, type EncodePlaybackGate } from "@space/ffmpeg/playbackGate";
import { bindEncodeGateToPlaybackLease } from "../src/core/encodePlaybackBinding";

const SUITE = "encode-playback-binding";

const createRig = () => {
  const calls: string[] = [];
  const backend: ProcessControlBackend = {
    name: "fake",
    throttleKind: "one-core",
    reconcileMs: 0,
    open: (pid) => ({
      suspend: () => calls.push(`suspend:${pid}`),
      resume: () => calls.push(`resume:${pid}`),
      throttle: () => calls.push(`throttle:${pid}`),
      unthrottle: () => calls.push(`unthrottle:${pid}`),
      close: () => {},
    }),
  };
  const encode: EncodePlaybackGate = createEncodePlaybackGate({ backend, info: () => {}, warn: () => {} });
  const lease = createUploadPlaybackGate();
  const unbind = bindEncodeGateToPlaybackLease(lease, encode);
  return { calls, encode, lease, unbind };
};

describe("@bugfix @regression-proof the playback lease drives transcode ffmpegs (#25)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-13T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts at full, and throttle / pause from the lease apply to a running transcode live", () => {
    const { calls, encode, lease } = createRig();
    encode.attach(4242);
    expect(encode.getPolicy()).toBe("full");

    lease.update({ mode: "throttle", playbackActive: true });
    expect(encode.getPolicy()).toBe("throttle");
    expect(calls).toEqual(["throttle:4242"]);

    // The 5 s heartbeat renews the lease: no churn.
    vi.advanceTimersByTime(5_000);
    lease.update({ mode: "throttle", playbackActive: true });
    expect(calls).toEqual(["throttle:4242"]);

    lease.update({ mode: "pause", playbackActive: true });
    expect(encode.getPolicy()).toBe("pause");
    expect(calls).toEqual(["throttle:4242", "suspend:4242"]);

    // Player closed: everything back to full, resumed from the same point.
    lease.update({ mode: "pause", playbackActive: false });
    expect(encode.getPolicy()).toBe("full");
    expect(calls).toEqual(["throttle:4242", "suspend:4242", "unthrottle:4242", "resume:4242"]);
    console.info(`[${SUITE}:transitions] ${calls.join(" ")}`);
  });

  it("full mode during playback gates nothing", () => {
    const { calls, encode, lease } = createRig();
    encode.attach(7);
    lease.update({ mode: "full", playbackActive: true });
    expect(encode.getPolicy()).toBe("full");
    expect(calls).toEqual([]);
  });

  it("a lease that runs out (desktop / mpv crash) thaws a frozen transcode on its own", () => {
    const { calls, encode, lease } = createRig();
    encode.attach(99);
    lease.update({ mode: "pause", playbackActive: true });
    expect(calls).toEqual(["suspend:99"]);

    vi.advanceTimersByTime(PLAYBACK_LEASE_MS_DEFAULT + 10);
    expect(encode.getPolicy()).toBe("full");
    expect(calls).toEqual(["suspend:99", "resume:99"]);
  });

  it("a transcode waiting to start under pause is released when the lease ends", async () => {
    const { encode, lease } = createRig();
    lease.update({ mode: "pause", playbackActive: true });
    const runnable = encode.whenRunnable();
    let started = false;
    void runnable.then(() => {
      started = true;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(started).toBe(false);

    lease.update({ mode: "pause", playbackActive: false });
    expect(await runnable).toBe(true);
  });

  it("applies a lease that is already active when the binding is made, and stops after unbind", () => {
    const calls: string[] = [];
    const backend: ProcessControlBackend = {
      name: "fake",
      throttleKind: "one-core",
      reconcileMs: 0,
      open: (pid) => ({
        suspend: () => calls.push(`suspend:${pid}`),
        resume: () => calls.push(`resume:${pid}`),
        throttle: () => calls.push(`throttle:${pid}`),
        unthrottle: () => calls.push(`unthrottle:${pid}`),
        close: () => {},
      }),
    };
    const encode = createEncodePlaybackGate({ backend, info: () => {}, warn: () => {} });
    const lease = createUploadPlaybackGate();
    lease.update({ mode: "throttle", playbackActive: true });
    const unbind = bindEncodeGateToPlaybackLease(lease, encode);
    expect(encode.getPolicy()).toBe("throttle");

    unbind();
    lease.update({ mode: "pause", playbackActive: true });
    expect(encode.getPolicy()).toBe("throttle");
  });
});
