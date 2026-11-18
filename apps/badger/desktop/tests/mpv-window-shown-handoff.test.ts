/**
 * MPV-SHOW-01 through the real IPC handlers: launch mpv (fake socket client), then the renderer's
 * `sf-mpv-playback-ready` must keep the app window up until mpv reports `vo-configured`.
 *
 * @req MPV-SHOW-01[badger-desktop]
 * @bugfix mpv-handoff-gap: the old handler hid the app window the moment the renderer signalled (socket connected),
 * while mpv's window came up only at vo-configured, up to ~1.9 s later on a cold start.
 * @regression-proof "keeps the app window up until..." fails on the old handler: hide() ran before vo-configured.
 */
import type { BrowserWindow } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const state = {
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
    voConfigured: false as boolean,
    voObservers: new Set<(value: unknown) => void>(),
    events: new Map<string, Set<(...args: unknown[]) => void>>(),
  };
  return state;
});

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/sf-test-userdata" },
  ipcMain: { handle: vi.fn() },
  nativeImage: { createFromBuffer: vi.fn() },
}));
vi.mock("@space/mpv", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@space/mpv")>()),
  resolveExternalMpvTarget: () => ({ bin: "/usr/bin/mpv", kind: "system", libDirs: [] }),
}));
vi.mock("@space/desktop-mpv-playback", () => ({ isCurrentExternalMpvLaunch: () => true }));
vi.mock("../src/main/logger", () => ({
  scopeLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));
vi.mock("../src/main/mpvSocketClient", () => {
  class FakeMpvClient {
    on(event: string, listener: (...args: unknown[]) => void) {
      const set = hoisted.events.get(event) ?? new Set();
      set.add(listener);
      hoisted.events.set(event, set);
      return this;
    }
    off(event: string, listener: (...args: unknown[]) => void) {
      hoisted.events.get(event)?.delete(listener);
      return this;
    }
    async start() {
      return { socketReady: true, failure: null };
    }
    observe(property: string, callback: (value: unknown) => void) {
      if (property !== "vo-configured") return () => undefined;
      hoisted.voObservers.add(callback);
      return () => hoisted.voObservers.delete(callback);
    }
    async getProperty(property: string) {
      return property === "vo-configured" ? hoisted.voConfigured : null;
    }
    async request() {
      return { error: "success" };
    }
    async command() {
      return { error: "success" };
    }
    getLaunchId() {
      return 1;
    }
    getPid() {
      return 4242;
    }
    isAlive() {
      return true;
    }
    async dispose() {}
  }
  return { UnixSocketMpvClient: FakeMpvClient, initializeOscActionFile: vi.fn() };
});

import { registerExternalMpv } from "../src/main/externalMpv";

const ipc = {
  handle: (channel: string, handler: (...args: unknown[]) => unknown) => hoisted.handlers.set(channel, handler),
  on: (channel: string, handler: (...args: unknown[]) => unknown) => hoisted.handlers.set(channel, handler),
} as unknown as Parameters<typeof registerExternalMpv>[0];

const fakeWindow = () => ({
  show: vi.fn(),
  hide: vi.fn(),
  focus: vi.fn(),
  setSkipTaskbar: vi.fn(),
  isDestroyed: () => false,
  isVisible: () => true,
  isMinimized: () => false,
  webContents: { send: vi.fn(), isDestroyed: () => false },
});

const flush = async (rounds = 10) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((r) => setImmediate(r));
};

describe("sf-mpv-playback-ready waits for mpv's window @req MPV-SHOW-01", () => {
  let win: ReturnType<typeof fakeWindow>;

  beforeEach(async () => {
    hoisted.handlers.clear();
    hoisted.voObservers.clear();
    hoisted.events.clear();
    hoisted.voConfigured = false;
    win = fakeWindow();
    registerExternalMpv(ipc, () => win as unknown as BrowserWindow, vi.fn(), {});
    const play = hoisted.handlers.get("sf-mpv-external-play");
    expect(play).toBeTypeOf("function");
    const launched = await play!({}, { url: "http://127.0.0.1:1/master.m3u8" });
    console.info(`[mpv-window-shown-handoff] launched=${JSON.stringify(launched && Object.keys(launched as object))}`);
  });

  it("keeps the app window up until mpv reports vo-configured, then hides it @req MPV-SHOW-01", async () => {
    const ready = hoisted.handlers.get("sf-mpv-playback-ready")!;
    let resolved = false;
    const pending = Promise.resolve(ready({})).then(() => (resolved = true));
    await flush();
    console.info(
      `[mpv-window-shown-handoff] before vo-configured: hide=${win.hide.mock.calls.length} resolved=${resolved} observers=${hoisted.voObservers.size}`,
    );
    expect(win.hide).not.toHaveBeenCalled();
    expect(resolved).toBe(false);
    hoisted.voConfigured = true;
    for (const cb of [...hoisted.voObservers]) cb(true);
    await pending;
    console.info(`[mpv-window-shown-handoff] after vo-configured: hide=${win.hide.mock.calls.length} resolved=${resolved}`);
    expect(win.hide).toHaveBeenCalledTimes(1);
    expect(win.setSkipTaskbar).toHaveBeenCalledWith(true);
  });

  it("hides at once when mpv's window is already shown", async () => {
    hoisted.voConfigured = true;
    await hoisted.handlers.get("sf-mpv-playback-ready")!({});
    console.info(`[mpv-window-shown-handoff:already] hide=${win.hide.mock.calls.length}`);
    expect(win.hide).toHaveBeenCalledTimes(1);
  });

  it("leaves the app window alone when mpv exits before its window shows", async () => {
    const pending = hoisted.handlers.get("sf-mpv-playback-ready")!({});
    await flush();
    for (const listener of [...(hoisted.events.get("exit") ?? [])]) listener();
    await pending;
    console.info(
      `[mpv-window-shown-handoff:exit] hide=${win.hide.mock.calls.length} show=${win.show.mock.calls.length}`,
    );
    expect(win.hide).not.toHaveBeenCalled();
  });
});
