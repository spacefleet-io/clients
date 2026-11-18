/**
 * @bugfix transcode-not-gated-during-playback @regression-proof
 *
 * #25 (Chris 2026-10-13): while a video plays, the per-computer category gates
 * every ffmpeg transcode, not only uploads. throttle = ONE logical core,
 * pause = the process is frozen in place and resumed from the same point. The
 * policy comes from the same lease the upload gate uses, so these tests drive
 * the controller with a fake OS backend (every transition, ordering, error
 * path). The OS backends themselves are tested where they live
 * (packages/desktop-platform-<os>/tests).
 */

import { getDesktopPlatform, setDesktopPlatformForTests, type ProcessControlBackend, type ProcessHandle } from "@space/desktop-platform";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEncodePlaybackGate, encodePlaybackGate, type EncodePlaybackGate } from "../src/playbackGate";

type Call = string;

const createFakeBackend = (reconcileMs = 0) => {
  const calls: Call[] = [];
  const handles = new Map<number, ProcessHandle & { closed: boolean }>();
  const failures = { suspend: false, throttle: false, open: false };
  const backend: ProcessControlBackend = {
    name: "fake",
    throttleKind: "one-core",
    reconcileMs,
    open: (pid) => {
      if (failures.open) throw new Error("open denied");
      calls.push(`open:${pid}`);
      const handle = {
        closed: false,
        suspend: () => {
          if (failures.suspend) throw new Error("suspend denied");
          calls.push(`suspend:${pid}`);
        },
        resume: () => calls.push(`resume:${pid}`),
        throttle: () => {
          if (failures.throttle) throw new Error("throttle denied");
          calls.push(`throttle:${pid}`);
        },
        unthrottle: () => calls.push(`unthrottle:${pid}`),
        refresh: () => calls.push(`refresh:${pid}`),
        close: () => {
          handle.closed = true;
          calls.push(`close:${pid}`);
        },
      };
      handles.set(pid, handle);
      return handle;
    },
  };
  return { backend, calls, handles, failures };
};

const makeGate = (reconcileMs = 0) => {
  const fake = createFakeBackend(reconcileMs);
  const logs: string[] = [];
  const gate = createEncodePlaybackGate({
    backend: fake.backend,
    info: (message) => logs.push(`info:${message}`),
    warn: (message) => logs.push(`warn:${message}`),
  });
  return { gate, logs, ...fake };
};

describe("encode playback gate policy transitions @bugfix @regression-proof", () => {
  it("full changes nothing for a running encode", () => {
    const { gate, calls } = makeGate();
    gate.attach(100);
    gate.setPolicy("full");
    console.info("[playback-gate:full] calls =", calls);
    expect(calls).toEqual(["open:100"]);
  });

  it("throttle limits a RUNNING encode live, and full restores it", () => {
    const { gate, calls } = makeGate();
    gate.attach(100);
    gate.setPolicy("throttle");
    gate.setPolicy("full");
    console.info("[playback-gate:throttle] calls =", calls);
    expect(calls).toEqual(["open:100", "throttle:100", "unthrottle:100"]);
  });

  it("throttle limits an encode that STARTS during playback at spawn", () => {
    const { gate, calls } = makeGate();
    gate.setPolicy("throttle");
    gate.attach(200);
    expect(calls).toEqual(["open:200", "throttle:200"]);
  });

  it("pause freezes a running encode and full resumes it", () => {
    const { gate, calls } = makeGate();
    const child = gate.attach(100);
    gate.setPolicy("pause");
    expect(child.isSuspended()).toBe(true);
    gate.setPolicy("full");
    expect(child.isSuspended()).toBe(false);
    console.info("[playback-gate:pause] calls =", calls);
    expect(calls).toEqual(["open:100", "suspend:100", "resume:100"]);
  });

  it("an encode that slips in during pause is frozen at once", () => {
    const { gate, calls } = makeGate();
    gate.setPolicy("pause");
    const child = gate.attach(300);
    expect(child.isSuspended()).toBe(true);
    expect(calls).toEqual(["open:300", "suspend:300"]);
  });

  it("pause -> throttle pins the core BEFORE the resume, so there is no full-width burst", () => {
    const { gate, calls } = makeGate();
    gate.attach(100);
    gate.setPolicy("pause");
    gate.setPolicy("throttle");
    console.info("[playback-gate:pause->throttle] calls =", calls);
    expect(calls).toEqual(["open:100", "suspend:100", "throttle:100", "resume:100"]);
  });

  it("throttle -> pause -> full restores the full core set and resumes, exactly once each", () => {
    const { gate, calls } = makeGate();
    gate.attach(100);
    gate.setPolicy("throttle");
    gate.setPolicy("pause");
    gate.setPolicy("full");
    expect(calls).toEqual(["open:100", "throttle:100", "suspend:100", "unthrottle:100", "resume:100"]);
  });

  it("setting the same policy twice does nothing", () => {
    const { gate, calls } = makeGate();
    gate.attach(100);
    gate.setPolicy("pause");
    gate.setPolicy("pause");
    expect(calls).toEqual(["open:100", "suspend:100"]);
  });

  it("only attached (gated) children are touched; a released child is closed and forgotten", () => {
    const { gate, calls } = makeGate();
    const child = gate.attach(100);
    child.release();
    gate.setPolicy("pause");
    expect(calls).toEqual(["open:100", "close:100"]);
    expect(gate.snapshot().children).toBe(0);
  });

  it("an undefined pid (spawn failed) is a no-op handle", () => {
    const { gate, calls } = makeGate();
    gate.setPolicy("pause");
    const child = gate.attach(undefined);
    expect(child.isSuspended()).toBe(false);
    child.release();
    expect(calls).toEqual([]);
  });

  it("every encode shares the same policy: three children all freeze and all resume", () => {
    const { gate, calls } = makeGate();
    gate.attach(1);
    gate.attach(2);
    gate.attach(3);
    gate.setPolicy("pause");
    gate.setPolicy("full");
    expect(calls.filter((c) => c.startsWith("suspend:")).sort()).toEqual(["suspend:1", "suspend:2", "suspend:3"]);
    expect(calls.filter((c) => c.startsWith("resume:")).sort()).toEqual(["resume:1", "resume:2", "resume:3"]);
  });
});

describe("encode playback gate: no new transcode starts while paused @bugfix @regression-proof", () => {
  it("whenRunnable is immediate outside pause", async () => {
    const { gate } = makeGate();
    await expect(gate.whenRunnable()).resolves.toBe(true);
    gate.setPolicy("throttle");
    await expect(gate.whenRunnable()).resolves.toBe(true);
  });

  it("whenRunnable waits through pause and resolves the moment the policy leaves pause", async () => {
    const { gate } = makeGate();
    gate.setPolicy("pause");
    let released = false;
    const waiting = gate.whenRunnable().then((ok) => {
      released = ok;
    });
    await Promise.resolve();
    expect(released).toBe(false);
    expect(gate.snapshot().waiting).toBe(1);
    gate.setPolicy("throttle");
    await waiting;
    expect(released).toBe(true);
    expect(gate.snapshot().waiting).toBe(0);
  });

  it("an abort ends the wait with false (the caller was cancelled), nothing leaks", async () => {
    const { gate } = makeGate();
    gate.setPolicy("pause");
    const controller = new AbortController();
    const waiting = gate.whenRunnable(controller.signal);
    controller.abort();
    await expect(waiting).resolves.toBe(false);
    expect(gate.snapshot().waiting).toBe(0);
  });

  it("an already-aborted signal does not wait", async () => {
    const { gate } = makeGate();
    gate.setPolicy("pause");
    await expect(gate.whenRunnable(AbortSignal.abort())).resolves.toBe(false);
  });
});

describe("encode playback gate: cancel and shutdown while suspended @bugfix @regression-proof", () => {
  it("resumeNow thaws the child so SIGTERM can be delivered, and it is never frozen again", () => {
    const { gate, calls } = makeGate();
    const child = gate.attach(100);
    gate.setPolicy("pause");
    child.resumeNow();
    expect(child.isSuspended()).toBe(false);
    gate.setPolicy("full");
    gate.setPolicy("pause");
    console.info("[playback-gate:cancel] calls =", calls);
    expect(calls).toEqual(["open:100", "suspend:100", "resume:100"]);
  });

  it("shutdown resumes every frozen child, releases waiters and ignores later policy changes", async () => {
    const { gate, calls } = makeGate();
    gate.attach(1);
    gate.attach(2);
    gate.setPolicy("pause");
    const waiting = gate.whenRunnable();
    gate.shutdown();
    await expect(waiting).resolves.toBe(true);
    expect(calls.filter((c) => c.startsWith("resume:")).sort()).toEqual(["resume:1", "resume:2"]);
    gate.setPolicy("pause");
    gate.attach(3);
    expect(calls.filter((c) => c === "suspend:3")).toEqual([]);
    await expect(gate.whenRunnable()).resolves.toBe(true);
  });

  it("a shutdown that finds a throttled child restores its cores as well", () => {
    const { gate, calls } = makeGate();
    gate.attach(1);
    gate.setPolicy("throttle");
    gate.shutdown();
    expect(calls).toEqual(["open:1", "throttle:1", "unthrottle:1"]);
  });
});

describe("encode playback gate: OS failures never break an encode @bugfix @regression-proof", () => {
  it("a denied suspend is logged once and the encode keeps running", () => {
    const { gate, logs, failures } = makeGate();
    failures.suspend = true;
    const a = gate.attach(1);
    const b = gate.attach(2);
    expect(() => gate.setPolicy("pause")).not.toThrow();
    expect(a.isSuspended()).toBe(false);
    expect(b.isSuspended()).toBe(false);
    expect(logs.filter((l) => l.startsWith("warn:"))).toHaveLength(1);
  });

  it("a denied open yields a no-op handle", () => {
    const { gate, failures } = makeGate();
    failures.open = true;
    gate.setPolicy("pause");
    const child = gate.attach(1);
    expect(child.isSuspended()).toBe(false);
    expect(() => child.release()).not.toThrow();
  });

  it("a denied throttle does not stop a later pause from freezing the child", () => {
    const { gate, failures } = makeGate();
    failures.throttle = true;
    const child = gate.attach(1);
    gate.setPolicy("throttle");
    gate.setPolicy("pause");
    expect(child.isSuspended()).toBe(true);
  });
});

describe("encode playback gate: suspension listeners and throttle reconcile @bugfix @regression-proof", () => {
  it("tells listeners when the child freezes and thaws (so wall-clock timers can stop counting)", () => {
    const { gate } = makeGate();
    const child = gate.attach(1);
    const seen: boolean[] = [];
    child.onSuspendedChange((suspended) => seen.push(suspended));
    gate.setPolicy("pause");
    gate.setPolicy("full");
    expect(seen).toEqual([true, false]);
  });

  it("re-applies the throttle to new encoder threads while throttled, and stops when nothing is throttled", () => {
    vi.useFakeTimers();
    try {
      const { gate, calls } = makeGate(1000);
      gate.attach(1);
      gate.setPolicy("throttle");
      vi.advanceTimersByTime(3100);
      const refreshes = calls.filter((c) => c === "refresh:1").length;
      console.info("[playback-gate:reconcile] refreshes in 3.1 s =", refreshes);
      expect(refreshes).toBe(3);
      gate.setPolicy("full");
      vi.advanceTimersByTime(5000);
      expect(calls.filter((c) => c === "refresh:1")).toHaveLength(3);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("gate backend resolution", () => {
  afterEach(() => setDesktopPlatformForTests(null));

  it("defaults to the platform's processes.control, resolved on first attach (not at construction)", () => {
    const { backend, calls } = createFakeBackend();
    const host = getDesktopPlatform();
    const gate = createEncodePlaybackGate({ info: () => {}, warn: () => {} });
    expect(gate.snapshot().backend).toBe("unresolved");
    setDesktopPlatformForTests({ ...host, processes: { ...host.processes, control: backend } });
    gate.attach(7);
    expect(calls).toEqual(["open:7"]);
    expect(gate.snapshot().backend).toBe("fake");
  });
});

describe("gate singleton wiring", () => {
  it("exposes the process-wide gate with the expected surface", () => {
    const gate: EncodePlaybackGate = encodePlaybackGate;
    expect(gate.getPolicy()).toBe("full");
    expect(typeof gate.shutdown).toBe("function");
  });
});
