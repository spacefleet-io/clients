import { describe, expect, it } from "vitest";
import { advertisedHardwareEncoders, pickHardwareEncoder } from "@space/desktop-platform-contract";
import { createWindowsHardware, pickGpuVendor, windowsEncoderPolicy } from "../src/hardware";

describe("windows encoder policy", () => {
  it("lists amf, qsv, nvenc and the vendors each belongs to", () => {
    console.info("[windows-hardware:policy]", windowsEncoderPolicy);
    expect(windowsEncoderPolicy.order).toEqual(["amf", "qsv", "nvenc"]);
    expect(windowsEncoderPolicy.vendors).toEqual({ amf: ["amd", "radeon"], qsv: ["intel"], nvenc: ["nvidia", "geforce"] });
  });

  it("picks the encoder of the GPU vendor when advertised, else the first advertised", () => {
    const all = ["amf", "qsv", "nvenc"];
    expect(pickHardwareEncoder(windowsEncoderPolicy, all, "nvidia")).toBe("nvenc");
    expect(pickHardwareEncoder(windowsEncoderPolicy, all, "amd")).toBe("amf");
    expect(pickHardwareEncoder(windowsEncoderPolicy, all, "intel")).toBe("qsv");
    expect(pickHardwareEncoder(windowsEncoderPolicy, all, "")).toBe("amf");
    expect(pickHardwareEncoder(windowsEncoderPolicy, ["qsv", "nvenc"], "amd")).toBe("qsv");
    expect(pickHardwareEncoder(windowsEncoderPolicy, ["nvenc"], "intel")).toBe("nvenc");
    expect(pickHardwareEncoder(windowsEncoderPolicy, [], "nvidia")).toBeNull();
    expect(advertisedHardwareEncoders(windowsEncoderPolicy, ["h264_nvenc", "h264_vaapi", "libx264"])).toEqual(["nvenc"]);
  });
});

describe("gpu vendor", () => {
  it("normalizes adapter names", () => {
    expect(pickGpuVendor(["NVIDIA NVIDIA GeForce RTX 4070"])).toBe("nvidia");
    expect(pickGpuVendor(["Advanced Micro Devices, Inc. AMD Radeon RX 7800 XT"])).toBe("amd");
    expect(pickGpuVendor(["Intel Corporation Intel(R) UHD Graphics 770"])).toBe("intel");
  });

  it("prefers the discrete GPU of a hybrid machine and ignores virtual adapters", () => {
    expect(pickGpuVendor(["Intel Intel(R) Iris Xe", "NVIDIA NVIDIA GeForce RTX 3060 Laptop"])).toBe("nvidia");
    expect(pickGpuVendor(["Intel UHD", "Advanced Micro Devices AMD Radeon"])).toBe("amd");
    expect(pickGpuVendor(["Microsoft Microsoft Basic Display Adapter", "Microsoft Hyper-V Video"])).toBe("");
    expect(pickGpuVendor([])).toBe("");
  });
});

describe("windows hardware layer", () => {
  it("reads the adapters once and caches the vendor (also an unknown one)", async () => {
    let reads = 0;
    const hardware = createWindowsHardware({ readAdapters: async () => (reads += 1, ["NVIDIA GeForce"]) });
    // Concurrent callers share the one in-flight query.
    expect(await Promise.all([hardware.detectGpuVendor(), hardware.detectGpuVendor()])).toEqual(["nvidia", "nvidia"]);
    expect(await hardware.detectGpuVendor()).toBe("nvidia");
    expect(reads).toBe(1);
    let unknownReads = 0;
    const none = createWindowsHardware({ readAdapters: async () => (unknownReads += 1, []) });
    expect(await none.detectGpuVendor()).toBe("");
    expect(await none.detectGpuVendor()).toBe("");
    expect(unknownReads).toBe(1);
  });

  it("a failing adapter query is an unknown vendor, never a rejection", async () => {
    const hardware = createWindowsHardware({ readAdapters: () => Promise.reject(new Error("wmi down")) });
    expect(await hardware.detectGpuVendor()).toBe("");
  });

  it("has no devices, memory limit, cpu limits or pressure signal", () => {
    const hardware = createWindowsHardware({ readAdapters: async () => [] });
    for (const encoder of windowsEncoderPolicy.order) expect(hardware.deviceFor(encoder, {})).toBeNull();
    expect(hardware.memoryLimitBytes()).toBeNull();
    expect(hardware.readCpuLimits()).toEqual({ affinityList: null, affinityCount: null, quota: null, checked: [] });
    expect(hardware.createCpuPressureReader()).toBeNull();
  });
});

// #25: only platforms with a separate CPU vo remember a failed mpv GPU probe;
// Windows' CPU path is WARP inside the gpu vo, so it reports no stack.
describe("graphicsStack", () => {
  it("is null: nothing on Windows keys on it", () => {
    expect(createWindowsHardware({ readAdapters: async () => ["NVIDIA NVIDIA GeForce RTX 4070"] }).graphicsStack()).toBeNull();
  });
});
