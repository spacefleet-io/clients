import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * @bugfix @regression-proof mpv-stop-during-backdrop-fetch (#25 P5/B3 review)
 *
 * `sf-mpv-external-play` awaits the backdrop fetch (up to 1.5 s) before it
 * spawns mpv. A `sf-mpv-external-stop` arriving in that window found no
 * client to dispose, so mpv was spawned anyway: an orphan player window for
 * content the user already closed. Stop must cancel the pending launch.
 */

const hoisted = vi.hoisted(() => {
  const backdrop: {
    resolve: (value: string | null) => void;
    requested: Promise<void>;
    markRequested: () => void;
  } = { resolve: () => {}, requested: Promise.resolve(), markRequested: () => {} };
  const arm = () => {
    backdrop.requested = new Promise<void>((resolve) => {
      backdrop.markRequested = resolve;
    });
  };
  return {
    backdrop,
    arm,
    clientCtor: vi.fn(),
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
  };
});

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
vi.mock("../src/main/mpvBackdropCache", () => ({
  cacheMpvBackdrop: () =>
    new Promise<string | null>((resolve) => {
      hoisted.backdrop.resolve = resolve;
      hoisted.backdrop.markRequested();
    }),
}));
vi.mock("../src/main/mpvSocketClient", () => ({
  UnixSocketMpvClient: class {
    constructor() {
      hoisted.clientCtor();
      throw new Error("mpv spawned");
    }
  },
  initializeOscActionFile: vi.fn(),
}));

import { registerExternalMpv } from "../src/main/externalMpv";

const ipc = {
  handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
    hoisted.handlers.set(channel, handler);
  },
  on: (channel: string, handler: (...args: unknown[]) => unknown) => {
    hoisted.handlers.set(channel, handler);
  },
} as unknown as Parameters<typeof registerExternalMpv>[0];

describe("@bugfix @regression-proof stop during the backdrop fetch", () => {
  beforeEach(() => {
    hoisted.clientCtor.mockClear();
    hoisted.handlers.clear();
    hoisted.arm();
    registerExternalMpv(ipc, () => null, () => {});
  });

  it("does not spawn mpv when the user stopped while the backdrop was fetching", async () => {
    const play = hoisted.handlers.get("sf-mpv-external-play");
    const stop = hoisted.handlers.get("sf-mpv-external-stop");
    expect(play && stop).toBeTruthy();
    const pending = Promise.resolve(
      play!({}, { url: "http://127.0.0.1:1/master.m3u8", backdropUrl: "data:image/jpeg;base64,/9j/4AAQ" }),
    ).then(
      (value) => ({ value, error: null as unknown }),
      (error: unknown) => ({ value: null, error }),
    );
    // The play handler is now parked on the backdrop fetch.
    await hoisted.backdrop.requested;
    await stop!({});
    hoisted.backdrop.resolve("/tmp/sf-test-userdata/mpv-backdrops/x.jpg");
    const outcome = await pending;
    console.info(
      `[mpv-stop-during-backdrop] clientConstructed=${hoisted.clientCtor.mock.calls.length} outcome=${JSON.stringify({
        value: outcome.value,
        error: outcome.error instanceof Error ? outcome.error.message : outcome.error,
      })}`,
    );
    expect(hoisted.clientCtor).not.toHaveBeenCalled();
    expect(outcome.error).toBeNull();
  });

  it("still spawns mpv when nothing stopped the launch (control)", async () => {
    const play = hoisted.handlers.get("sf-mpv-external-play")!;
    const pending = Promise.resolve(
      play({}, { url: "http://127.0.0.1:1/master.m3u8", backdropUrl: "data:image/jpeg;base64,/9j/4AAQ" }),
    ).catch((error: unknown) => error);
    await hoisted.backdrop.requested;
    hoisted.backdrop.resolve("/tmp/sf-test-userdata/mpv-backdrops/x.jpg");
    const outcome = await pending;
    console.info(
      `[mpv-stop-during-backdrop:control] clientConstructed=${hoisted.clientCtor.mock.calls.length} outcome=${outcome instanceof Error ? outcome.message : JSON.stringify(outcome)}`,
    );
    expect(hoisted.clientCtor).toHaveBeenCalledTimes(1);
  });
});
