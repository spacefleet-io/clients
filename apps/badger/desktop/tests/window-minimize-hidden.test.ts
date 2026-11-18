// #928 (low-end idle CPU): a minimized window is as unseen as a hidden one, but
// with `backgroundThrottling: false` only main's flag makes the renderer pause its
// CSS animations and UI-only churn. `trackAppWindowVisibility` must flip it on
// minimize/restore, and a `show` / `restore` must not claim "visible" while the
// window is still minimized / hidden.

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";

import { APP_WINDOW_VISIBILITY_CHANNEL, trackAppWindowVisibility } from "../src/main/appWindowVisibility";

const fakeWindow = () => {
  const send = vi.fn();
  const state = { visible: true, minimized: false };
  const win = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isVisible: () => state.visible,
    isMinimized: () => state.minimized,
    webContents: { isDestroyed: () => false, send },
  });
  trackAppWindowVisibility(win as unknown as BrowserWindow);
  const flags = () => send.mock.calls.filter(([channel]) => channel === APP_WINDOW_VISIBILITY_CHANNEL).map(([, v]) => [v.hidden, v.reason]);
  return { win, state, flags };
};

describe("trackAppWindowVisibility minimize/restore (#928)", () => {
  it("minimize marks hidden, restore marks visible again", () => {
    const { win, state, flags } = fakeWindow();
    state.minimized = true;
    win.emit("minimize");
    state.minimized = false;
    win.emit("restore");
    expect(flags()).toEqual([
      [true, "window-minimize-event"],
      [false, "window-restore-event"],
    ]);
  });

  it("a restore while the window is hidden (tray) keeps it hidden", () => {
    const { win, state, flags } = fakeWindow();
    state.visible = false;
    win.emit("hide");
    win.emit("restore");
    expect(flags()).toEqual([[true, "window-hide-event"]]);
  });

  it("a show while still minimized stays hidden until the restore", () => {
    const { win, state, flags } = fakeWindow();
    state.minimized = true;
    win.emit("minimize");
    state.visible = false;
    win.emit("hide");
    state.visible = true;
    win.emit("show");
    state.minimized = false;
    win.emit("restore");
    expect(flags()).toEqual([
      [true, "window-minimize-event"],
      [false, "window-restore-event"],
    ]);
  });
});
