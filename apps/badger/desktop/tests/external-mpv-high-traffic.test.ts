/**
 * @req STOR-BW-01
 *
 * mpv's readahead (`--cache-secs`) follows the gateway's traffic state: capped
 * to `playbackBufferSeconds` at launch and live while high, restored when normal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageTrafficSnapshot } from "@space/shared/storageTunnel";
import type * as MpvModule from "@space/mpv";

const hoisted = vi.hoisted(() => ({
  clients: [] as Array<{
    startOptions: { readaheadSecs?: number | null; args?: string[] } | null;
    readaheadCalls: number[];
    disposed: boolean;
  }>,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/sf-test-userdata" },
  ipcMain: { handle: vi.fn() },
}));
vi.mock("@space/mpv", async (importOriginal) => ({
  ...(await importOriginal<typeof MpvModule>()),
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
    startOptions: { readaheadSecs?: number | null; args?: string[] } | null = null;
    readaheadCalls: number[] = [];
    disposed = false;
    timePosEmitWindowMs = () => 1000;
    constructor() {
      hoisted.clients.push(this);
    }
    on() {}
    async start(options: { readaheadSecs?: number | null; args?: string[] }) {
      this.startOptions = options;
      return { socketReady: true, failure: null };
    }
    async setReadaheadSecs(secs: number) {
      this.readaheadCalls.push(secs);
      return true;
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
      this.disposed = true;
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

type Traffic = { state: "normal" | "high"; playbackBufferSeconds: number | null };
const snapshot = (value: Traffic): StorageTrafficSnapshot => ({ ...value, observedAt: 0 });

describe("external mpv readahead under gateway traffic", () => {
  let traffic: Traffic;
  let listeners: Array<(snapshot: StorageTrafficSnapshot) => void>;
  const savedCacheEnv = process.env.SF_MPV_STREAM_CACHE_SECS;

  const play = async () => {
    await hoisted.handlers.get("sf-mpv-external-play")!({}, { url: "http://127.0.0.1:1/master.m3u8" });
    return hoisted.clients[hoisted.clients.length - 1]!;
  };
  const setTraffic = (next: Traffic) => {
    traffic = next;
    listeners.forEach((listener) => listener(snapshot(next)));
  };

  beforeEach(() => {
    delete process.env.SF_MPV_STREAM_CACHE_SECS;
    hoisted.clients.length = 0;
    hoisted.handlers.clear();
    traffic = { state: "normal", playbackBufferSeconds: null };
    listeners = [];
    registerExternalMpv(ipc, () => null, () => {}, {
      getTraffic: () => snapshot(traffic),
      onTrafficChange: (listener) => {
        listeners.push(listener);
        return () => {
          listeners = listeners.filter((entry) => entry !== listener);
        };
      },
    });
  });

  afterEach(() => {
    if (savedCacheEnv === undefined) delete process.env.SF_MPV_STREAM_CACHE_SECS;
    else process.env.SF_MPV_STREAM_CACHE_SECS = savedCacheEnv;
  });

  it("launches with the normal readahead when traffic is normal", async () => {
    const client = await play();
    expect(client.startOptions?.readaheadSecs).toBe(16);
    expect(client.startOptions?.args).toContain("--cache-secs=16");
  });

  it("launches with the readahead capped to the gateway's buffer while high", async () => {
    traffic = { state: "high", playbackBufferSeconds: 6 };
    const client = await play();
    expect(client.startOptions?.readaheadSecs).toBe(6);
    expect(client.startOptions?.args).toContain("--cache-secs=6");
  });

  it("lowers the live readahead when traffic turns high and restores it when normal", async () => {
    const client = await play();
    setTraffic({ state: "high", playbackBufferSeconds: 10 });
    setTraffic({ state: "normal", playbackBufferSeconds: null });
    await Promise.resolve();
    expect(client.readaheadCalls).toEqual([10, 16]);
  });

  it("never raises the readahead above the normal target, and ignores changes with no mpv running", async () => {
    setTraffic({ state: "high", playbackBufferSeconds: 300 });
    const client = await play();
    expect(client.startOptions?.readaheadSecs).toBe(16);
    setTraffic({ state: "normal", playbackBufferSeconds: null });
    await Promise.resolve();
    expect(client.readaheadCalls).toEqual([16]);
  });
});
