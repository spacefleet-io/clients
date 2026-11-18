import { afterEach, describe, expect, it } from "vitest";
import {
  getDesktopPlatform,
  getHostPlatformId,
  setDesktopPlatformForTests,
  type DesktopPlatform,
} from "../src";

afterEach(() => setDesktopPlatformForTests(null));

describe("getDesktopPlatform", () => {
  it("returns the implementation of the OS this test runs on", () => {
    const platform = getDesktopPlatform();
    console.info(`[selector.test] host platform -> ${platform.id}-${platform.arch}`);
    expect(platform.id).toBe(process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux");
  });

  it("returns the same instance on every call", () => {
    expect(getDesktopPlatform()).toBe(getDesktopPlatform());
  });

  it("can be pinned for a test and released again", () => {
    const host = getDesktopPlatform();
    const fake = { ...host, id: "macos" } satisfies DesktopPlatform;
    setDesktopPlatformForTests(fake);
    expect(getDesktopPlatform().id).toBe("macos");
    setDesktopPlatformForTests(null);
    expect(getDesktopPlatform()).toBe(host);
  });
});

describe("getHostPlatformId", () => {
  it("maps node platform names to platform ids without needing an implementation", () => {
    expect(getHostPlatformId("linux")).toBe("linux");
    expect(getHostPlatformId("win32")).toBe("windows");
    expect(getHostPlatformId("darwin")).toBe("macos");
  });

  it("defaults to the host OS", () => {
    expect(getHostPlatformId()).toBe(getDesktopPlatform().id);
  });

  it("throws only for an OS with no id at all", () => {
    expect(() => getHostPlatformId("aix")).toThrow('Unknown host OS "aix"');
  });
});

describe("getDesktopPlatform per host OS", () => {
  const realPlatform = process.platform;
  afterEach(() => Object.defineProperty(process, "platform", { value: realPlatform, configurable: true }));

  it("selects the macOS implementation on darwin", () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    expect(getDesktopPlatform().id).toBe("macos");
  });

  it("names an OS without an implementation and where its implementation must be registered", () => {
    Object.defineProperty(process, "platform", { value: "freebsd", configurable: true });
    expect(() => getDesktopPlatform()).toThrow(/freebsd host OS.*registered in packages\/desktop-platform\/src\/index\.ts/s);
  });
});
