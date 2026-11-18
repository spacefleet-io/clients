/**
 * @test-id MOBILE-SKY-MODE-001
 * @level unit
 * @why UX-SKY-01: the sky's shooting stars fly or are frozen according to the "Animated background" setting
 *   (Automatic / On / Off). On and Off override everything; Automatic is animated unless Android flags the phone as
 *   low-RAM (asked once at startup, never stored: there is no probe and no persisted verdict any more). A wrong
 *   precedence would flip the sky under the user, a stored verdict from an earlier build must not decide anything.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeAsyncStorage } from "./harness";

const fakeStorage = createFakeAsyncStorage();
const native = vi.hoisted(() => ({ isLowRamDevice: vi.fn<() => Promise<boolean>>() }));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: (key: string) => fakeStorage.getItem(key),
    setItem: (key: string, value: string) => fakeStorage.setItem(key, value),
    removeItem: (key: string) => fakeStorage.removeItem(key),
  },
}));
vi.mock("../src/native/LibrarySync", () => native);

const loadModule = async () => {
  const mod = await import("../src/lib/skyMode");
  mod.__resetSkyModeForTests();
  return mod;
};

beforeEach(() => {
  fakeStorage._backing.clear();
  native.isLowRamDevice.mockReset();
});

describe("resolveSkyMode precedence", () => {
  // @req UX-SKY-01[badger-mobile]
  it("On and Off override the phone; Automatic is animated unless the phone is low-RAM", async () => {
    const { resolveSkyMode } = await loadModule();
    const table = [
      resolveSkyMode("on", true),
      resolveSkyMode("on", false),
      resolveSkyMode("off", true),
      resolveSkyMode("off", false),
      resolveSkyMode("auto", true),
      resolveSkyMode("auto", false),
    ];
    console.info("[sky-mode:precedence]", JSON.stringify(table));
    expect(table).toEqual(["animated", "animated", "static", "static", "static", "animated"]);
  });
});

describe("low-RAM flag", () => {
  // @req UX-SKY-01[badger-mobile]
  it("a low-RAM phone makes Automatic the still sky once the flag is loaded, and nothing is stored", async () => {
    native.isLowRamDevice.mockResolvedValue(true);
    const mod = await loadModule();
    expect(mod.automaticSkyMode()).toBe("animated");
    expect(await mod.loadLowRamDevice()).toBe(true);
    console.info("[sky-mode:lowRam]", mod.automaticSkyMode(), JSON.stringify([...fakeStorage._backing.keys()]));
    expect(mod.automaticSkyMode()).toBe("static");
    expect(fakeStorage._backing.size).toBe(0);
  });

  // @req UX-SKY-01[badger-mobile]
  it("a normal phone keeps Automatic animated, and the OS is asked only once", async () => {
    native.isLowRamDevice.mockResolvedValue(false);
    const mod = await loadModule();
    await mod.loadLowRamDevice();
    await mod.loadLowRamDevice();
    expect(mod.automaticSkyMode()).toBe("animated");
    expect(native.isLowRamDevice).toHaveBeenCalledTimes(1);
  });

  // @req UX-SKY-01[badger-mobile]
  it("ignores a verdict stored by the earlier probe-based builds", async () => {
    fakeStorage._backing.set("sf:sky-detection:v1", JSON.stringify({ mode: "static", source: "probe" }));
    native.isLowRamDevice.mockResolvedValue(false);
    const mod = await loadModule();
    await mod.loadLowRamDevice();
    expect(mod.automaticSkyMode()).toBe("animated");
  });
});
