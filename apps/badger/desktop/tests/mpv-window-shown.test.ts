/**
 * MPV-SHOW-01: the app window hides only once mpv's own window is shown (`vo-configured`), with an exit and an
 * 8 s timeout fallback so a VO that never reports cannot leave the app window up forever.
 *
 * @req MPV-SHOW-01[badger-desktop]
 * @bugfix mpv-handoff-gap: Badger hid at socket-connect (~16 ms warm / ~106 ms cold on Linux) while mpv's window
 * appeared at vo-configured (~178 ms warm / ~2010 ms cold): up to 1.9 s of empty screen on a first Windows run.
 * @regression-proof the "hides before" case below fails against the old handler, which hid synchronously.
 */
import type { BrowserWindow, IpcMain } from "electron";
import type * as MpvModule from "@space/mpv";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MPV_WINDOW_SHOWN_TIMEOUT_MS, waitForMpvWindowShown } from "../src/main/mpvWindowShown";

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

/** A stand-in for mpv's IPC: `vo-configured` starts at `initial` and flips through `configure()`. */
const fakeClient = (initial: boolean | null, opts: { getPropertyDelayMs?: number } = {}) => {
  let configured = initial;
  const observers = new Set<(value: unknown) => void>();
  const exitListeners = new Set<() => void>();
  const client = {
    getProperty: vi.fn(async (property: string) => {
      if (opts.getPropertyDelayMs) await new Promise((r) => setTimeout(r, opts.getPropertyDelayMs));
      expect(property).toBe("vo-configured");
      return configured;
    }),
    observe: vi.fn((property: string, callback: (value: unknown) => void) => {
      expect(property).toBe("vo-configured");
      observers.add(callback);
      return () => observers.delete(callback);
    }),
    on: vi.fn((_event: "exit", listener: () => void) => exitListeners.add(listener)),
    off: vi.fn((_event: "exit", listener: () => void) => exitListeners.delete(listener)),
  };
  // The mocks stand in for MpvClient's generic `getProperty` / `observe`, which a plain vi.fn cannot spell.
  return {
    client: client as typeof client & Parameters<typeof waitForMpvWindowShown>[0],
    configure: (value: boolean) => {
      configured = value;
      for (const cb of [...observers]) cb(value);
    },
    exit: () => {
      for (const l of [...exitListeners]) l();
    },
    listenerCounts: () => ({ observers: observers.size, exit: exitListeners.size }),
  };
};

describe("waitForMpvWindowShown @req MPV-SHOW-01", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves at once when mpv's window is already shown", async () => {
    const mpv = fakeClient(true);
    const result = await waitForMpvWindowShown(mpv.client);
    console.info(`[mpv-window-shown:already] ${JSON.stringify(result)} listeners=${JSON.stringify(mpv.listenerCounts())}`);
    expect(result.via).toBe("already");
    expect(mpv.listenerCounts()).toEqual({ observers: 0, exit: 0 });
  });

  it("waits for vo-configured to turn true, ignoring false reports on the way @req MPV-SHOW-01", async () => {
    let t = 1_000;
    const mpv = fakeClient(false);
    let settled: unknown = null;
    const pending = waitForMpvWindowShown(mpv.client, { now: () => t }).then((r) => (settled = r));
    await vi.advanceTimersByTimeAsync(0);
    mpv.configure(false);
    await vi.advanceTimersByTimeAsync(0);
    console.info(`[mpv-window-shown:observed] after false report settled=${JSON.stringify(settled)}`);
    expect(settled).toBeNull();
    t += 1_904;
    mpv.configure(true);
    const result = await pending;
    console.info(`[mpv-window-shown:observed] ${JSON.stringify(result)} listeners=${JSON.stringify(mpv.listenerCounts())}`);
    expect(result).toEqual({ via: "observed", waitedMs: 1_904 });
    expect(mpv.listenerCounts()).toEqual({ observers: 0, exit: 0 });
  });

  it("does not miss a window shown between the subscription and a slow property read", async () => {
    const mpv = fakeClient(false, { getPropertyDelayMs: 50 });
    const pending = waitForMpvWindowShown(mpv.client);
    mpv.configure(true);
    const result = await pending;
    console.info(`[mpv-window-shown:race] ${JSON.stringify(result)}`);
    expect(result.via).toBe("observed");
    await vi.advanceTimersByTimeAsync(100);
    expect(mpv.listenerCounts()).toEqual({ observers: 0, exit: 0 });
  });

  it("gives up when mpv exits before showing a window", async () => {
    const mpv = fakeClient(null);
    const pending = waitForMpvWindowShown(mpv.client);
    await vi.advanceTimersByTimeAsync(0);
    mpv.exit();
    const result = await pending;
    console.info(`[mpv-window-shown:exit] ${JSON.stringify(result)}`);
    expect(result.via).toBe("exited");
    expect(mpv.listenerCounts()).toEqual({ observers: 0, exit: 0 });
  });

  it(`gives up after ${MPV_WINDOW_SHOWN_TIMEOUT_MS} ms when the window never reports shown`, async () => {
    const mpv = fakeClient(false);
    let settled: { via: string } | null = null;
    const pending = waitForMpvWindowShown(mpv.client).then((r) => (settled = r));
    await vi.advanceTimersByTimeAsync(MPV_WINDOW_SHOWN_TIMEOUT_MS - 1);
    console.info(`[mpv-window-shown:timeout] at ${MPV_WINDOW_SHOWN_TIMEOUT_MS - 1} ms settled=${JSON.stringify(settled)}`);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    console.info(`[mpv-window-shown:timeout] ${JSON.stringify(result)}`);
    expect(result.via).toBe("timeout");
    expect(result.waitedMs).toBe(MPV_WINDOW_SHOWN_TIMEOUT_MS);
    expect(mpv.listenerCounts()).toEqual({ observers: 0, exit: 0 });
  });

  it("swallows a failed property read and still waits for the observation", async () => {
    const mpv = fakeClient(false);
    mpv.client.getProperty.mockRejectedValueOnce(new Error("socket closed"));
    const pending = waitForMpvWindowShown(mpv.client);
    await vi.advanceTimersByTimeAsync(0);
    mpv.configure(true);
    const result = await pending;
    console.info(`[mpv-window-shown:read-error] ${JSON.stringify(result)}`);
    expect(result.via).toBe("observed");
  });
});

describe("sf-mpv-playback-ready handler @req MPV-SHOW-01", () => {
  it("hides the app window (and only then resolves) when no mpv is current", async () => {
    hoisted.handlers.clear();
    const win = {
      show: vi.fn(),
      hide: vi.fn(),
      focus: vi.fn(),
      setSkipTaskbar: vi.fn(),
      isDestroyed: () => false,
      isVisible: () => true,
      isMinimized: () => false,
      webContents: { send: vi.fn(), isDestroyed: () => false },
    };
    const ipc = {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) => hoisted.handlers.set(channel, handler),
      on: (channel: string, handler: (...args: unknown[]) => unknown) => hoisted.handlers.set(channel, handler),
    } as unknown as IpcMain;
    registerExternalMpv(ipc, () => win as unknown as BrowserWindow, vi.fn(), {});
    const ready = hoisted.handlers.get("sf-mpv-playback-ready");
    expect(ready).toBeTypeOf("function");
    await ready?.({});
    console.info(`[mpv-window-shown:handler] hide calls=${win.hide.mock.calls.length} skipTaskbar=${JSON.stringify(win.setSkipTaskbar.mock.calls)}`);
    expect(win.hide).toHaveBeenCalledTimes(1);
    expect(win.setSkipTaskbar).toHaveBeenCalledWith(true);
  });
});
