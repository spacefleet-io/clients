import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const state = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {},
  dialog: {
    showOpenDialog: (...args: unknown[]) => state.showOpenDialog(...args),
  },
}));

import { isPickedExportFolder, registerFileSystemIpc } from "../src/main/fileSystem";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const registerHandlers = (): Map<string, Handler> => {
  const handlers = new Map<string, Handler>();
  const ipc = {
    handle: (channel: string, handler: Handler) => {
      handlers.set(channel, handler);
    },
  };
  registerFileSystemIpc(ipc as unknown as Parameters<typeof registerFileSystemIpc>[0]);
  return handlers;
};

/**
 * Electron 43 made `dialog.showOpenDialog` default `defaultPath` to the
 * Downloads folder, so the OS no longer restores the last-used directory.
 * The handler must remember it itself (breaking change, Electron 43.0).
 */
describe("sf-fs-open-dialog last-used directory @bugfix @regression-proof", () => {
  beforeEach(() => {
    state.showOpenDialog.mockReset();
  });

  it("opens the first dialog without a defaultPath, then reopens in the directory of the last pick", async () => {
    const open = registerHandlers().get("sf-fs-open-dialog");
    expect(open).toBeDefined();

    state.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ["/media/movies/a.mkv", "/media/movies/b.mkv"] });
    await expect(open?.({}, { properties: ["openFile", "multiSelections"] })).resolves.toEqual([
      "/media/movies/a.mkv",
      "/media/movies/b.mkv",
    ]);
    expect(state.showOpenDialog.mock.calls[0]?.[0]).not.toHaveProperty("defaultPath");

    state.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ["/media/shows/s01"] });
    await open?.({}, { properties: ["openDirectory"] });
    expect(state.showOpenDialog.mock.calls[1]?.[0]).toMatchObject({ defaultPath: "/media/movies" });

    state.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    await expect(open?.({}, { properties: ["openFile"] })).resolves.toEqual([]);
    expect(state.showOpenDialog.mock.calls[2]?.[0]).toMatchObject({ defaultPath: "/media/shows" });

    state.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    await open?.({}, { properties: ["openFile"] });
    expect(state.showOpenDialog.mock.calls[3]?.[0]).toMatchObject({ defaultPath: "/media/shows" });
  });
});

// @req PLAY-SUBGET-23[badger-desktop]
describe("sf-pick-subtitle-file (Add a subtitle file…, PLAY-SUBGET-23)", () => {
  beforeEach(() => {
    state.showOpenDialog.mockReset();
  });

  it("opens one subtitle file (.srt/.ass/.ssa/.vtt) and returns its name and text; null when cancelled", async () => {
    const pick = registerHandlers().get("sf-pick-subtitle-file");
    expect(pick).toBeDefined();
    const dir = mkdtempSync(join(tmpdir(), "sf-pick-subtitle-"));
    const path = join(dir, "Home video.srt");
    writeFileSync(path, "1\n00:00:01,000 --> 00:00:02,000\nHello\n");

    state.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [path] });
    await expect(pick?.({})).resolves.toEqual({ name: "Home video.srt", content: "1\n00:00:01,000 --> 00:00:02,000\nHello\n" });
    const options = state.showOpenDialog.mock.calls[0]?.[0] as { properties: string[]; filters: { extensions: string[] }[] };
    expect(options.properties).toEqual(["openFile"]);
    expect(options.filters.map((filter) => filter.extensions)).toEqual([["srt", "ass", "ssa", "vtt"]]);

    state.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    await expect(pick?.({})).resolves.toBeNull();
  });
});

// @req OFFL-FILE-01[badger-desktop] @req ACCT-EXPORT-01[badger-desktop]
describe("sf-pick-export-folder (Download file / Download everything)", () => {
  beforeEach(() => {
    state.showOpenDialog.mockReset();
  });

  it("picks a folder, remembers it for the next dialog, and only that folder counts as picked", async () => {
    const pick = registerHandlers().get("sf-pick-export-folder");
    expect(pick).toBeDefined();
    console.log("[export-folder] phase=before picked(/exports/a)=", isPickedExportFolder("/exports/a"));
    expect(isPickedExportFolder("/exports/a")).toBe(false);

    state.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ["/exports/a"] });
    await expect(pick?.({})).resolves.toBe("/exports/a");
    const first = state.showOpenDialog.mock.calls[0]?.[0] as { properties: string[]; title: string; defaultPath?: string };
    console.log("[export-folder] phase=first-dialog options=", JSON.stringify(first));
    expect(first.properties).toEqual(["openDirectory", "createDirectory"]);
    expect(first.title).toBe("Choose where to save the files");
    expect(first).not.toHaveProperty("defaultPath");
    expect(isPickedExportFolder("/exports/a")).toBe(true);
    expect(isPickedExportFolder("/exports")).toBe(false);
    expect(isPickedExportFolder(42)).toBe(false);

    state.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    await expect(pick?.({})).resolves.toBeNull();
    console.log("[export-folder] phase=second-dialog options=", JSON.stringify(state.showOpenDialog.mock.calls[1]?.[0]));
    expect(state.showOpenDialog.mock.calls[1]?.[0]).toMatchObject({ defaultPath: "/exports/a" });
  });
});
