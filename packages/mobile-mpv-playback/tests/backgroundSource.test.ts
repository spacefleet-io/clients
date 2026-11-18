/**
 * @req PLAY-OSMEDIA-01[badger-mobile]
 * @level unit
 * @why Next on the lock screen moved the card to the next episode but mpv kept the old one, paused, until the app came
 *   back in front: React Native holds view props while the window is hidden. The new source must reach mpv through the
 *   module while the app is in the background, and only then.
 */
import { describe, expect, it, vi } from "vitest";
import { loadSourceInBackground, loadsSourceInBackground, switchEpisodeKeepingCore, type BackgroundSourceInput } from "../src/backgroundSource";

const TAG = "[mpv.backgroundSource]";
const input = (over: Partial<BackgroundSourceInput> = {}): BackgroundSourceInput => ({
  source: "http://127.0.0.1:8123/playback/hls/s2/r1080/master.m3u8",
  startOptions: "start=12.000",
  appState: "background",
  platformOs: "android",
  isTv: false,
  ...over,
});

const run = async (player: Parameters<typeof loadSourceInBackground>[0], over: Partial<BackgroundSourceInput> = {}) => {
  const logs: string[] = [];
  const result = await loadSourceInBackground(player, input(over), (event, detail) => logs.push(`${event} ${detail}`));
  console.info(TAG, JSON.stringify({ over, result, logs }));
  return { result, logs };
};

describe("a source picked while the phone app is in the background (PLAY-OSMEDIA-01 item 4)", () => {
  it("goes to the native player at once, with its start options", async () => {
    const loadInBackground = vi.fn(async () => true);
    const { result, logs } = await run({ loadInBackground });
    expect(result).toBe("loaded");
    expect(loadInBackground).toHaveBeenCalledWith(input().source, "start=12.000");
    expect(logs[0]).toMatch(/^playback\.background_load\.loaded /);
  });

  it("also while the screen is locked with the app in front (inactive) and with no start options", async () => {
    const loadInBackground = vi.fn(async () => true);
    expect((await run({ loadInBackground }, { appState: "inactive", startOptions: null })).result).toBe("loaded");
    expect(loadInBackground).toHaveBeenCalledWith(input().source, null);
  });

  it("leaves the foreground, the TV, the iPhone and an empty source to the view's prop", async () => {
    for (const over of [{ appState: "active" }, { isTv: true }, { platformOs: "ios" }, { source: null }, { source: "" }]) {
      const loadInBackground = vi.fn(async () => true);
      expect(loadsSourceInBackground(input(over))).toBe(false);
      expect((await run({ loadInBackground }, over)).result).toBe("foreground");
      expect(loadInBackground).not.toHaveBeenCalled();
    }
  });

  it("reports a source the native view already plays, a missing native method and a native error", async () => {
    expect((await run({ loadInBackground: async () => false })).result).toBe("skipped");
    expect((await run({})).result).toBe("unsupported");
    const failed = await run({ loadInBackground: async () => Promise.reject(new Error("mpv_error")) });
    expect(failed.result).toBe("failed");
    expect(failed.logs[0]).toContain("mpv_error");
  });
});

describe("an episode switch while the phone app is in the background keeps the player's core (PLAY-OSMEDIA-01)", () => {
  // Found on a OnePlus 9 (PR #1762): Next on the lock screen dropped the old player and nothing played the next episode.
  it("tells the native player before switching, so the dropped view's core plays the next episode", async () => {
    const order: string[] = [];
    const holdCoreForSwitch = vi.fn(async () => {
      order.push("hold");
      return true;
    });
    await switchEpisodeKeepingCore({ holdCoreForSwitch }, input(), () => order.push("switch"));
    console.info(TAG, JSON.stringify({ order }));
    expect(order).toEqual(["hold", "switch"]);
  });

  it("switches at once in front, on iPhone, on TV and when the native call fails", async () => {
    for (const over of [{ appState: "active" }, { platformOs: "ios" }, { isTv: true }] as Partial<BackgroundSourceInput>[]) {
      const holdCoreForSwitch = vi.fn(async () => true);
      const switched = vi.fn();
      await switchEpisodeKeepingCore({ holdCoreForSwitch }, input(over), switched);
      expect(holdCoreForSwitch).not.toHaveBeenCalled();
      expect(switched).toHaveBeenCalledTimes(1);
    }
    const switched = vi.fn();
    await switchEpisodeKeepingCore({ holdCoreForSwitch: async () => Promise.reject(new Error("mpv_error")) }, input(), switched);
    await switchEpisodeKeepingCore({}, input(), switched);
    expect(switched).toHaveBeenCalledTimes(2);
  });
});
