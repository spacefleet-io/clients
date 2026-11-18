import { normalizeGpuVendor } from "@space/desktop-platform-contract";
import type { HardwareLayer } from "@space/desktop-platform-contract";
import { runPowerShell } from "./powershell";

/** Windows hardware H.264 encoders in fallback order, and the GPU vendor each belongs to. */
export const windowsEncoderPolicy: HardwareLayer["encoderPolicy"] = {
  order: ["amf", "qsv", "nvenc"],
  vendors: { amf: ["amd", "radeon"], qsv: ["intel"], nvenc: ["nvidia", "geforce"] },
};

/** One line per video controller: `<AdapterCompatibility> <Name>`. */
export const GPU_QUERY_SCRIPT =
  "Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | ForEach-Object { ($_.AdapterCompatibility + ' ' + $_.Name).Trim() }";

/** Discrete GPUs beat integrated ones for encoding: nvidia, then amd, then intel. */
const VENDOR_PREFERENCE = ["nvidia", "amd", "intel"] as const;

/** The vendor of the best adapter in `lines` (`amd`|`intel`|`nvidia`|``), ignoring virtual / basic adapters. */
export const pickGpuVendor = (lines: readonly string[]): string => {
  const found = new Set(lines.map((line) => normalizeGpuVendor(line)).filter(Boolean));
  return VENDOR_PREFERENCE.find((vendor) => found.has(vendor)) ?? "";
};

export type WindowsHardwareReaders = {
  /** Names of the video adapters, or [] when they cannot be listed. */
  readAdapters: () => Promise<string[]>;
};

const defaultReaders: WindowsHardwareReaders = {
  readAdapters: async () => {
    const result = await runPowerShell(GPU_QUERY_SCRIPT, 20_000);
    return result.ok ? result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
  },
};

export const createWindowsHardware = (readers: Partial<WindowsHardwareReaders> = {}): HardwareLayer => {
  const { readAdapters } = { ...defaultReaders, ...readers };
  let vendor: Promise<string> | undefined;
  return {
    encoderPolicy: windowsEncoderPolicy,
    // One query per process, shared by concurrent callers; a reader that throws counts as an unknown vendor.
    detectGpuVendor: () => (vendor ??= readAdapters().then(pickGpuVendor, () => "")),
    // Windows encoders (AMF, QSV, NVENC) pick their device themselves.
    deviceFor: () => null,
    // No container / job memory cap is read on Windows.
    memoryLimitBytes: () => null,
    // The mpv GPU probe memory is unused on Windows (its CPU path is WARP inside the gpu vo).
    graphicsStack: () => null,
    readCpuLimits: () => ({ affinityList: null, affinityCount: null, quota: null, checked: [] }),
    // No PSI-like signal: callers fall back to the load average.
    createCpuPressureReader: () => null,
  };
};

export const windowsHardware: HardwareLayer = createWindowsHardware();
