import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * @bugfix @regression-proof issue #25 chunk-cache-release
 *
 * The playback server's video chunk cache is emptied when mpv playback closes.
 * "Closed" is exactly: the current mpv process exited on its own (user closed
 * mpv, playback ended) or the renderer asked for a stop. A reload / quality
 * switch (`loadfile` over the command IPC), a seek, a pause, an end-file of the
 * old entry and a newer launch superseding this mpv all keep a player alive
 * and must keep the cache.
 */

const TAG = "[external-mpv-cache-release]";

const hoisted = vi.hoisted(() => ({
  clients: [] as Array<{ emit: (event: string, ...args: unknown[]) => boolean; disposed: boolean }>,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/sf-test-userdata" },
  ipcMain: { handle: vi.fn() },
}));
vi.mock("@space/mpv", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@space/mpv")>()),
  resolveExternalMpvTarget: () => ({ bin: "/usr/bin/mpv", kind: "system", libDirs: [] }),
}));
vi.mock("@space/desktop-mpv-playback", () => ({ isCurrentExternalMpvLaunch: () => true }));
vi.mock("../src/main/logger", () => ({
  scopeLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));
vi.mock("../src/main/mpvBackdropCache", () => ({ cacheMpvBackdrop: async () => null }));
vi.mock("../src/main/mpvFontCacheWarmup", () => ({ warmMpvBundleFontCache: vi.fn() }));
vi.mock("../src/main/mpvSocketClient", () => {
  class FakeMpvClient {
    disposed = false;
    private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    timePosEmitWindowMs = () => 1000;
    constructor() {
      hoisted.clients.push(this);
    }
    on(event: string, listener: (...args: unknown[]) => void) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    }
    emit(event: string, ...args: unknown[]) {
      const registered = this.listeners.get(event) ?? [];
      registered.forEach((listener) => listener(...args));
      return registered.length > 0;
    }
    async start() {
      return { socketReady: true, failure: null };
    }
    observe() {}
    async getProperty() {
      return false;
    }
    getLaunchId() {
      return 1;
    }
    isAlive() {
      return !this.disposed;
    }
    async request() {
      return { error: "success" };
    }
    async command() {
      return { error: "success" };
    }
    async dispose() {
      if (this.disposed) return;
      this.disposed = true;
      this.emit("exit");
    }
  }
  return { UnixSocketMpvClient: FakeMpvClient, initializeOscActionFile: vi.fn() };
});

import { registerExternalMpv } from "../src/main/externalMpv";

const ipc = {
  handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
    hoisted.handlers.set(channel, handler);
  },
  on: (channel: string, handler: (...args: unknown[]) => unknown) => {
    hoisted.handlers.set(channel, handler);
  },
} as unknown as Parameters<typeof registerExternalMpv>[0];

describe("@bugfix @regression-proof external mpv close signal for the chunk cache", () => {
  const onPlaybackClosed = vi.fn();

  const play = async () => {
    await hoisted.handlers.get("sf-mpv-external-play")!({}, { url: "http://127.0.0.1:1/master.m3u8" });
    const client = hoisted.clients[hoisted.clients.length - 1]!;
    console.info(`${TAG} play launched clients=${hoisted.clients.length}`);
    return client;
  };
  const calls = () => onPlaybackClosed.mock.calls.map((call) => call[0]);

  beforeEach(() => {
    hoisted.clients.length = 0;
    hoisted.handlers.clear();
    onPlaybackClosed.mockClear();
    registerExternalMpv(ipc, () => null, () => {}, { onPlaybackClosed });
  });

  it("signals mpv_exit once when the current mpv exits on its own", async () => {
    const client = await play();
    client.emit("exit");
    console.info(`${TAG} after exit calls=${JSON.stringify(calls())}`);
    expect(calls()).toEqual(["mpv_exit"]);
  });

  it("signals renderer_stop when the renderer stops playback", async () => {
    await play();
    await hoisted.handlers.get("sf-mpv-external-stop")!({});
    console.info(`${TAG} after stop calls=${JSON.stringify(calls())}`);
    expect(calls()).toEqual(["renderer_stop"]);
  });

  it("keeps the cache across a reload, quality switch, seek, pause and end-file of the old entry", async () => {
    const client = await play();
    const command = hoisted.handlers.get("sf-mpv-external-command")!;
    const request = hoisted.handlers.get("sf-mpv-external-request")!;
    // Quality switch / ABR reload: a new HLS master loaded into the same mpv.
    await command({}, { command: ["loadfile", "http://127.0.0.1:1/other/master.m3u8", "replace"] });
    client.emit("end-file", { reason: "stop", playlistEntryId: 1 });
    client.emit("start-file", { playlistEntryId: 2 });
    client.emit("file-loaded");
    await command({}, { command: ["seek", 120, "absolute"] });
    await command({}, { command: ["set_property", "pause", true] });
    await request({}, { command: ["get_property", "time-pos"] });
    // Next episode: mpv ends the entry and the renderer loads the next one into the same process.
    client.emit("end-file", { reason: "eof", playlistEntryId: 2 });
    await command({}, { command: ["loadfile", "http://127.0.0.1:1/ep2/master.m3u8", "replace"] });
    console.info(`${TAG} after reload/seek/pause/next calls=${JSON.stringify(calls())}`);
    expect(calls()).toEqual([]);
  });

  it("does not signal when a newer launch supersedes the running mpv", async () => {
    const first = await play();
    const second = await play();
    console.info(`${TAG} after relaunch firstDisposed=${first.disposed} calls=${JSON.stringify(calls())}`);
    expect(first.disposed).toBe(true);
    expect(second).not.toBe(first);
    expect(calls()).toEqual([]);
    // The newest mpv closing is still a close.
    second.emit("exit");
    expect(calls()).toEqual(["mpv_exit"]);
  });
});
