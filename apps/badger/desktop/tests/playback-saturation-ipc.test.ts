/**
 * @req STOR-BW-07
 * @req STOR-BW-08
 *
 * The bridge between the saturated silo's reports and the renderer: the renderer can read the state, is pushed every
 * change, and the player can tell the main process it stopped itself (no rung under the cap).
 */
import type { IpcMain } from "electron";
import { describe, expect, it, vi } from "vitest";
import type { StorageTraffic } from "@space/shared/storageTunnel";
import { registerPlaybackSaturation } from "../src/main/playbackSaturation";

const traffic = (patch: Partial<StorageTraffic> = {}): StorageTraffic => ({
  state: "high",
  playbackBufferSeconds: 30,
  saturated: true,
  qualityCap: "480p",
  playbackStopped: false,
  ...patch,
});

type WindowState = "open" | "destroyed" | "missing";

const harness = (windowState: WindowState = "open") => {
  const handlers = new Map<string, () => unknown>();
  const ipc = { handle: vi.fn((channel: string, handler: () => unknown) => handlers.set(channel, handler)) };
  const send = vi.fn();
  const saturation = registerPlaybackSaturation(
    ipc as unknown as IpcMain,
    () =>
      windowState === "missing" ? null : ({ isDestroyed: () => windowState === "destroyed", webContents: { send } } as never),
  );
  return { handlers, send, saturation };
};

describe("playback saturation IPC (STOR-BW-07, STOR-BW-08)", () => {
  it("answers the renderer's state read", () => {
    const { handlers, saturation } = harness();
    expect(handlers.get("sf-playback-saturation-state")?.()).toEqual({ qualityCap: null, refusals: 0, stops: 0 });
    saturation.observe(traffic({ qualityCap: "1080p" }));
    expect(handlers.get("sf-playback-saturation-state")?.()).toEqual({ qualityCap: "1080p", refusals: 0, stops: 0 });
  });

  it("pushes every change to the window", () => {
    const { send, saturation } = harness();
    saturation.observe(traffic());
    expect(send).toHaveBeenLastCalledWith("sf-playback-saturation", { qualityCap: "480p", refusals: 0, stops: 0 });
    saturation.noteRefused(traffic());
    expect(send).toHaveBeenLastCalledWith("sf-playback-saturation", { qualityCap: "480p", refusals: 1, stops: 0 });
    saturation.noteStopped(traffic({ playbackStopped: true }));
    expect(send).toHaveBeenLastCalledWith("sf-playback-saturation", { qualityCap: "480p", refusals: 1, stops: 1 });
  });

  it("counts a stop the player reports itself", () => {
    const { handlers, send } = harness();
    handlers.get("sf-playback-saturation-stop")?.();
    expect(send).toHaveBeenLastCalledWith("sf-playback-saturation", { qualityCap: null, refusals: 0, stops: 1 });
  });

  it("does not throw when the window is destroyed or missing", () => {
    const destroyed = harness("destroyed");
    expect(() => destroyed.saturation.noteRefused(traffic())).not.toThrow();
    expect(destroyed.send).not.toHaveBeenCalled();
    const missing = harness("missing");
    expect(() => missing.saturation.noteRefused(traffic())).not.toThrow();
  });
});
