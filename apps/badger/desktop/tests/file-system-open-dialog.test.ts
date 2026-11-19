import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {},
  dialog: {
    showOpenDialog: (...args: unknown[]) => state.showOpenDialog(...args),
  },
}));

import { registerFileSystemIpc } from "../src/main/fileSystem";

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
