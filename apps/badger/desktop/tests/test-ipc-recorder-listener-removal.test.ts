// @bugfix @regression-proof issue #25 P6 (ultimate run 1791294602218864000)
//
// testIpcRecorder (active when SF_E2E=1, i.e. every e2e + ultimate run)
// wrapped ipcRenderer.on with a fresh `wrappedListener` but left
// removeListener/off untouched. Every renderer unsubscribe
// (`ipcRenderer.removeListener(channel, handler)`) then looked up the ORIGINAL
// handler, found nothing, and silently kept the wrapper registered. In the
// ultimate run this leaked every `sf-mpv-external-message` subscription: one
// mpv exit fired 741 `flushProgress` calls from stale engine closures and
// overwrote the resume point with positions from earlier sessions / other
// episodes (c071 stored 293.271 from c070 over the real 10.563).
import type { EventEmitter as EventEmitterClass } from "node:events";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initTestIpcRecorder } from "../src/preload/testIpcRecorder";

const LOG = "[test-ipc-recorder-listener-removal]";

const { fakeIpcRenderer, exposed } = await vi.hoisted(async () => {
  // vi.mock is hoisted above top-level imports, so the fake (and the module
  // it is built from) must be loaded inside the hoisted block.
  const { EventEmitter: Emitter } = await import("node:events");
  const emitter = new Emitter() as EventEmitterClass & {
    invoke: (...args: unknown[]) => Promise<unknown>;
    send: (...args: unknown[]) => void;
  };
  emitter.invoke = async () => undefined;
  emitter.send = () => undefined;
  return { fakeIpcRenderer: emitter, exposed: {} as Record<string, unknown> };
});

vi.mock("electron", () => ({
  ipcRenderer: fakeIpcRenderer,
  contextBridge: {
    exposeInMainWorld: (key: string, api: unknown) => {
      exposed[key] = api;
    },
  },
}));

type Recorder = { read: () => Array<{ kind: string; channel: string }>; reset: () => void };

const dump = (label: string) => {
  const recorder = exposed.__e2eIpcRecorder as Recorder | undefined;
  console.info(`${LOG} ${label}`, {
    listenerCounts: Object.fromEntries(
      fakeIpcRenderer.eventNames().map((name) => [String(name), fakeIpcRenderer.listenerCount(name)]),
    ),
    recorded: recorder?.read().length ?? null,
  });
};

describe("testIpcRecorder listener removal (@bugfix @regression-proof issue #25 P6)", () => {
  beforeAll(() => {
    process.env.SF_E2E = "1";
    initTestIpcRecorder();
    dump("recorder installed");
  });

  beforeEach(() => {
    fakeIpcRenderer.removeAllListeners();
    (exposed.__e2eIpcRecorder as Recorder).reset();
  });

  it("removeListener with the original handler detaches the wrapped listener", () => {
    const channel = "sf-mpv-external-message";
    const handler = vi.fn();
    fakeIpcRenderer.on(channel, handler);
    dump("after on");
    expect(fakeIpcRenderer.listenerCount(channel)).toBe(1);

    fakeIpcRenderer.emit(channel, {}, { type: "exit" });
    expect(handler).toHaveBeenCalledTimes(1);

    fakeIpcRenderer.removeListener(channel, handler);
    dump("after removeListener");
    expect(fakeIpcRenderer.listenerCount(channel)).toBe(0);

    fakeIpcRenderer.emit(channel, {}, { type: "exit" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("off() also detaches, and churned subscribe/unsubscribe cycles never accumulate", () => {
    const channel = "sf-mpv-external-message";
    // Mirrors the engine's exit effect re-subscribing on every dep change
    // (124 cycles in the first session of the ultimate run).
    for (let i = 0; i < 124; i += 1) {
      const handler = () => undefined;
      fakeIpcRenderer.on(channel, handler);
      if (i % 2 === 0) fakeIpcRenderer.removeListener(channel, handler);
      else fakeIpcRenderer.off(channel, handler);
    }
    const live = vi.fn();
    fakeIpcRenderer.on(channel, live);
    dump("after 124 churn cycles + 1 live");
    expect(fakeIpcRenderer.listenerCount(channel)).toBe(1);

    fakeIpcRenderer.emit(channel, {}, { type: "exit" });
    expect(live).toHaveBeenCalledTimes(1);
  });

  it("the same handler registered twice needs two removals, like a plain EventEmitter", () => {
    const channel = "sf-test-recorder-channel";
    const handler = vi.fn();
    fakeIpcRenderer.on(channel, handler);
    fakeIpcRenderer.on(channel, handler);
    fakeIpcRenderer.removeListener(channel, handler);
    expect(fakeIpcRenderer.listenerCount(channel)).toBe(1);
    fakeIpcRenderer.removeListener(channel, handler);
    dump("after double add / double remove");
    expect(fakeIpcRenderer.listenerCount(channel)).toBe(0);
  });

  it("still records every received message", () => {
    const channel = "sf-mpv-external-message";
    const handler = vi.fn();
    fakeIpcRenderer.on(channel, handler);
    fakeIpcRenderer.emit(channel, {}, { type: "exit" });
    const recorder = exposed.__e2eIpcRecorder as Recorder;
    dump("after emit");
    expect(recorder.read().filter((entry) => entry.kind === "receive" && entry.channel === channel)).toHaveLength(1);
  });
});
