import { app } from "electron";
import { join as joinPath } from "node:path";
import {
  configureMediaIngestRuntime,
  detectEncoder,
  detectWorkingHardwareEncoder,
  processMediaJob,
  uploadEncryptedFile,
  type ProducedMedia,
} from "@space/ingest-core/mediaProcessor";
import { encryptMediaObject } from "./mediaCrypto";
import { headStorageObjectsViaApi, uploadStorageObjectViaTunnel } from "./api";

// PCI vendor ids Chromium reports in `gpuDevice[].vendorId`.
const GPU_VENDOR_BY_PCI_ID: Record<number, string> = { 0x10de: "nvidia", 0x8086: "intel", 0x1002: "amd" };

/**
 * Lower-case GPU vendor name from `app.getGPUInfo("complete")`. Chromium gives
 * `vendorId` (PCI id) and sometimes `vendorString`, never `vendor` (#25 review:
 * reading `vendor` made every vendor "", so Intel/NVIDIA machines probed AMF).
 * Prefers the active device (hybrid laptops), else the first.
 */
export const gpuVendorFromInfo = (info: unknown): string => {
  if (typeof info !== "object" || info === null || !("gpuDevice" in info) || !Array.isArray(info.gpuDevice)) return "";
  const devices: unknown[] = info.gpuDevice;
  const device = devices.find((d) => typeof d === "object" && d !== null && "active" in d && d.active === true) ?? devices[0];
  if (typeof device !== "object" || device === null) return "";
  if ("vendorId" in device && typeof device.vendorId === "number") {
    const mapped = GPU_VENDOR_BY_PCI_ID[device.vendorId];
    if (mapped) return mapped;
  }
  if ("vendorString" in device && typeof device.vendorString === "string") return device.vendorString.toLowerCase();
  return "";
};

configureMediaIngestRuntime({
  resolveJobDir: (userId: string, jobId: string) =>
    joinPath(process.env.SF_TRANSCODE_DIR ?? "", userId, jobId),
  resolveFfmpegPath: () => {
    const raw = process.env.SF_FFMPEG_PATH?.trim();
    if (!raw || raw === "undefined" || raw === "null") return undefined;
    return raw;
  },
  resolveFfprobePath: () => {
    const raw = process.env.SF_FFPROBE_PATH?.trim();
    if (!raw || raw === "undefined" || raw === "null") return undefined;
    return raw;
  },
  encryptMediaObject,
  uploadStorageObject: (token, objectKey, payload, options) =>
    uploadStorageObjectViaTunnel(token, objectKey, payload, options),
  headStorageObjects: headStorageObjectsViaApi,
  getGpuVendor: async () => {
    try {
      const vendor = gpuVendorFromInfo(await app.getGPUInfo("complete"));
      console.info(`[encoder-probe] gpu vendor=${vendor || "(unknown)"}`);
      return vendor;
    } catch (err) {
      // Expected without a GPU (Xvfb, CI): a warning, so its text carries no "Error:" an output check reads as a crash.
      console.warn(`[encoder-probe] gpu info unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return "";
    }
  },
});

export { detectEncoder, detectWorkingHardwareEncoder, processMediaJob, uploadEncryptedFile };
export type { ProducedMedia };
