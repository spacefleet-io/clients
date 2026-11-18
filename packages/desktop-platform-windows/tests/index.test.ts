import { describe, expect, it } from "vitest";
import { platform } from "../src";

describe("windows platform", () => {
  it("is the windows implementation of every contract member", () => {
    console.info("[windows-index] id=%s arch=%s", platform.id, platform.arch);
    expect(platform.id).toBe("windows");
    expect(["x64", "arm64"]).toContain(platform.arch);
    for (const key of ["binaries", "paths", "mpvIpc", "processes", "hardware", "diagnostics", "shell"] as const) {
      expect(platform[key]).toBeTruthy();
    }
    expect(platform.binaries.executableName("mpv")).toBe("mpv.exe");
    expect(platform.mpvIpc.endpoint("t")).toBe("\\\\.\\pipe\\sf-mpv-t");
    expect(platform.hardware.encoderPolicy.order).toEqual(["amf", "qsv", "nvenc"]);
  });
});
