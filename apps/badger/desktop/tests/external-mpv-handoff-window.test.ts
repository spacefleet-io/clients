/**
 * PLAT-WEB-05: a web player hand-off plays in a window nobody sees. When that playback stops, the app window stays
 * hidden (the user is in the browser); any other playback still brings the app window back. The hand-off state is
 * read BEFORE the bridge is told the playback closed (that call ends the hand-off).
 */
import type { BrowserWindow, IpcMain } from "electron";
import type * as MpvModule from "@space/mpv";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>() }));

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/sf-test-userdata" },
  ipcMain: { handle: vi.fn() },
  nativeImage: { createFromBuffer: vi.fn() },
}));
vi.mock("@space/mpv", async (importOriginal) => ({
  ...(await importOriginal<typeof MpvModule>()),
  resolveExternalMpvTarget: () => ({ bin: "/usr/bin/mpv", kind: "system", libDirs: [] }),
}));
vi.mock("@space/desktop-mpv-playback", () => ({ isCurrentExternalMpvLaunch: () => true }));
vi.mock("../src/main/logger", () => ({
  scopeLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { registerExternalMpv } from "../src/main/externalMpv";

const ipc = {
  handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
    hoisted.handlers.set(channel, handler);
  },
  on: (channel: string, handler: (...args: unknown[]) => unknown) => {
    hoisted.handlers.set(channel, handler);
  },
} as unknown as IpcMain;

const fakeWindow = () => ({
  show: vi.fn(),
  hide: vi.fn(),
  focus: vi.fn(),
  setSkipTaskbar: vi.fn(),
  isDestroyed: () => false,
  isVisible: () => false,
  isMinimized: () => false,
  webContents: { send: vi.fn(), isDestroyed: () => false },
});

const stopWith = async (handoffActive: boolean) => {
  hoisted.handlers.clear();
  const win = fakeWindow();
  const ensureWindowVisible = vi.fn();
  let active = handoffActive;
  const onPlaybackClosed = vi.fn(() => {
    active = false;
  });
  registerExternalMpv(ipc, () => win as unknown as BrowserWindow, ensureWindowVisible, {
    isHandoffPlayback: () => active,
    onPlaybackClosed,
  });
  const stop = hoisted.handlers.get("sf-mpv-external-stop");
  expect(stop).toBeTruthy();
  await stop?.({});
  const state = {
    handoffActive,
    shown: win.show.mock.calls.length,
    ensureWindowVisible: ensureWindowVisible.mock.calls.length,
    closed: onPlaybackClosed.mock.calls,
  };
  console.info("[external-mpv-handoff-window] state", JSON.stringify(state));
  return state;
};

describe("external mpv stop and the app window", () => {
  beforeEach(() => {
    hoisted.handlers.clear();
  });

  // @req PLAT-WEB-05
  it("keeps the app window hidden when a hand-off playback stops", async () => {
    console.info("[external-mpv-handoff-window:handoff] phase: stop a hand-off playback");
    const state = await stopWith(true);
    expect(state.closed).toEqual([["renderer_stop"]]);
    expect(state.shown).toBe(0);
    expect(state.ensureWindowVisible).toBe(0);
  });

  // @req PLAT-WEB-05
  it("still brings the app window back when a plain playback stops (control)", async () => {
    console.info("[external-mpv-handoff-window:plain] phase: stop a plain playback");
    const state = await stopWith(false);
    expect(state.closed).toEqual([["renderer_stop"]]);
    expect(state.shown + state.ensureWindowVisible).toBeGreaterThan(0);
  });
});
