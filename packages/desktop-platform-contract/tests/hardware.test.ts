import { describe, expect, it } from "vitest";
import { advertisedHardwareEncoders, normalizeGpuVendor, pickHardwareEncoder, type EncoderPolicy } from "../src";

const linuxPolicy: EncoderPolicy = {
  order: ["vaapi", "qsv", "nvenc"],
  vendors: { vaapi: ["amd", "intel"], qsv: ["intel"], nvenc: ["nvidia", "geforce"] },
};
const windowsPolicy: EncoderPolicy = {
  order: ["amf", "qsv", "nvenc"],
  vendors: { amf: ["amd", "radeon"], qsv: ["intel"], nvenc: ["nvidia", "geforce"] },
};

const dump = (label: string, state: unknown) => {
  console.info(`[hardware.test] ${label}: ${JSON.stringify(state)}`);
};

describe("pickHardwareEncoder", () => {
  it("prefers the encoder that matches the GPU vendor", () => {
    const cases: Array<[EncoderPolicy, string[], string, string | null]> = [
      [linuxPolicy, ["vaapi", "qsv", "nvenc"], "nvidia", "nvenc"],
      [linuxPolicy, ["vaapi", "qsv", "nvenc"], "amd", "vaapi"],
      [linuxPolicy, ["qsv", "nvenc"], "intel", "qsv"],
      [windowsPolicy, ["amf", "qsv", "nvenc"], "amd", "amf"],
      [windowsPolicy, ["amf", "qsv", "nvenc"], "NVIDIA GeForce RTX", "nvenc"],
    ];
    for (const [policy, advertised, vendor, expected] of cases) {
      const got = pickHardwareEncoder(policy, advertised, vendor);
      dump("case", { advertised, vendor, expected, got });
      expect(got).toBe(expected);
    }
  });

  it("falls back to the first advertised encoder of the OS, then to software", () => {
    expect(pickHardwareEncoder(linuxPolicy, ["nvenc", "qsv"], "")).toBe("qsv");
    expect(pickHardwareEncoder(linuxPolicy, ["nvenc"], "amd")).toBe("nvenc");
    expect(pickHardwareEncoder(linuxPolicy, [], "nvidia")).toBeNull();
    expect(pickHardwareEncoder(windowsPolicy, ["vaapi"], "amd")).toBeNull();
  });
});

describe("advertisedHardwareEncoders", () => {
  it("keeps only the OS's encoders, in policy order", () => {
    expect(advertisedHardwareEncoders(linuxPolicy, ["libx264", "h264_nvenc", "h264_vaapi", "h264_amf"])).toEqual(["vaapi", "nvenc"]);
    expect(advertisedHardwareEncoders(windowsPolicy, ["h264_nvenc", "h264_vaapi", "h264_amf"])).toEqual(["amf", "nvenc"]);
  });
});

describe("normalizeGpuVendor", () => {
  it("maps adapter strings to a vendor id", () => {
    expect(normalizeGpuVendor("NVIDIA GeForce RTX 4090")).toBe("nvidia");
    expect(normalizeGpuVendor("AMD Radeon RX 7900")).toBe("amd");
    expect(normalizeGpuVendor("Advanced Micro Devices, Inc.")).toBe("amd");
    expect(normalizeGpuVendor("Intel(R) UHD Graphics")).toBe("intel");
    expect(normalizeGpuVendor("Apple M3")).toBe("apple");
    expect(normalizeGpuVendor("Microsoft Basic Display Adapter")).toBe("");
  });
});
