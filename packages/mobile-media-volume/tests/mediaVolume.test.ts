import { beforeEach, describe, expect, test, vi } from "vitest";

const calls: unknown[][] = [];
const handlers = new Map<string, (v: number) => void>();
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  NativeModules: {
    MediaVolume: {
      getMediaVolume: async () => 0.4,
      setMediaVolume: async (level: number) => {
        calls.push(["set", level]);
        return Math.round(level * 15) / 15;
      },
      addListener: () => undefined,
      removeListeners: () => undefined,
    },
  },
  NativeEventEmitter: class {
    addListener(name: string, fn: (v: number) => void) {
      handlers.set(name, fn);
      return { remove: () => handlers.delete(name) };
    }
  },
}));

// @req PAR-PLAY-05
describe("MediaVolume bridge (PAR-PLAY-05)", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  test("set clamps to 0..1 and resolves the stream-rounded level", async () => {
    const { MediaVolume } = await import("../src/MediaVolume");
    const applied = await MediaVolume.set(1.7);
    console.info("set", { calls, applied });
    expect(calls).toEqual([["set", 1]]);
    expect(applied).toBe(1);
    expect(await MediaVolume.get()).toBe(0.4);
  });

  test("the hardware-button change event reaches the listener on mediaVolumeChanged", async () => {
    const { MediaVolume } = await import("../src/MediaVolume");
    const seen: number[] = [];
    const sub = MediaVolume.onChange((v) => seen.push(v));
    handlers.get("mediaVolumeChanged")?.(0.6);
    sub.remove();
    expect(seen).toEqual([0.6]);
    expect(handlers.has("mediaVolumeChanged")).toBe(false);
  });
});
