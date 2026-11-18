import { execFile } from "node:child_process";
import { normalizeGpuVendor } from "@space/desktop-platform-contract";
import type { HardwareLayer } from "@space/desktop-platform-contract";

/**
 * macOS has one hardware H.264 encoder API, VideoToolbox, on every GPU a supported Mac has (Apple
 * silicon, Intel iGPU, AMD dGPU); it picks the engine itself.
 */
export const macosEncoderPolicy: HardwareLayer["encoderPolicy"] = {
  order: ["videotoolbox"],
  vendors: { videotoolbox: ["apple", "amd", "intel"] },
};

/** Apple silicon first, then a discrete AMD GPU over the Intel iGPU of the same Intel Mac. */
const VENDOR_PREFERENCE = ["apple", "amd", "intel", "nvidia"] as const;

/** `<vendor> <model>` per GPU from `system_profiler SPDisplaysDataType -json`, or [] when unreadable. */
export const parseDisplaysJson = (text: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(text);
    const gpus = parsed && typeof parsed === "object" && "SPDisplaysDataType" in parsed ? parsed.SPDisplaysDataType : null;
    if (!Array.isArray(gpus)) return [];
    const lines: string[] = [];
    for (const gpu of gpus) {
      if (!gpu || typeof gpu !== "object") continue;
      const fields: Record<string, unknown> = Object.fromEntries(Object.entries(gpu));
      const line = [fields.spdisplays_vendor, fields.sppci_model, fields._name]
        .filter((part): part is string => typeof part === "string")
        // `sppci_vendor_Apple` / `sppci_vendor_AMD` -> `Apple` / `AMD`
        .map((part) => part.replace(/^sppci_vendor_/, ""))
        .join(" ")
        .trim();
      if (line) lines.push(line);
    }
    return lines;
  } catch {
    return [];
  }
};

/** The vendor of the preferred GPU in `lines` (`apple`|`amd`|`intel`|`nvidia`|``). */
export const pickGpuVendor = (lines: readonly string[]): string => {
  const found = new Set(lines.map((line) => normalizeGpuVendor(line)).filter(Boolean));
  return VENDOR_PREFERENCE.find((vendor) => found.has(vendor)) ?? "";
};

export type MacosHardwareReaders = {
  /** One line per GPU, or [] when they cannot be listed. */
  readGpus: () => Promise<string[]>;
};

const defaultReaders: MacosHardwareReaders = {
  readGpus: () =>
    new Promise((resolveGpus) => {
      execFile("/usr/sbin/system_profiler", ["SPDisplaysDataType", "-json"], { encoding: "utf8", timeout: 20_000 }, (error, stdout) =>
        resolveGpus(error ? [] : parseDisplaysJson(stdout)),
      );
    }),
};

export const createMacosHardware = (readers: Partial<MacosHardwareReaders> = {}): HardwareLayer => {
  const { readGpus } = { ...defaultReaders, ...readers };
  let vendor: Promise<string> | undefined;
  return {
    encoderPolicy: macosEncoderPolicy,
    // One query per process, shared by concurrent callers; a reader that throws counts as an unknown vendor.
    detectGpuVendor: () => (vendor ??= readGpus().then(pickGpuVendor, () => "")),
    // VideoToolbox opens its own device.
    deviceFor: () => null,
    // No container / cgroup memory cap exists on macOS.
    memoryLimitBytes: () => null,
    // mpvWindow has no CPU vo here (cpuVo null), so every launch probes and nothing keys on it.
    graphicsStack: () => null,
    // No affinity API and no CPU quota: a process may run on every logical core (os.availableParallelism()).
    readCpuLimits: () => ({ affinityList: null, affinityCount: null, quota: null, checked: [] }),
    // No PSI-like signal: callers fall back to the load average.
    createCpuPressureReader: () => null,
  };
};

export const macosHardware: HardwareLayer = createMacosHardware();
