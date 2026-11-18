/**
 * The cores and memory this process can use, as the shared "strong or weak computer" rule reads them
 * (`@space/shared/transcodeHardware`): Badger adds its hardware video encoder probe on top, Parrot uses them as they
 * are. Memory is capped by the cgroup limit where the OS has one.
 */
import os from "node:os";
import { getDesktopPlatform } from "./index";

const GIB = 2 ** 30;

export type HostCapacity = {
  /** `os.cpus()[0].model`, trimmed; null when the OS does not report one. */
  cpuModel: string | null;
  /** Logical cores usable by this process (affinity-aware). */
  cores: number;
  /** Memory in GiB usable by this process (cgroup-aware). */
  ramGB: number;
  /** The machine's whole memory in GiB, and the cgroup limit when there is one (for logs). */
  totalmemGB: number;
  cgroupLimitGB: number | null;
};

export const probeHostCapacity = (): HostCapacity => {
  const totalBytes = os.totalmem();
  const cgroupBytes = getDesktopPlatform().hardware.memoryLimitBytes();
  const ramBytes = cgroupBytes !== null ? Math.min(totalBytes, cgroupBytes) : totalBytes;
  return {
    cpuModel: os.cpus()[0]?.model?.trim() || null,
    cores: os.availableParallelism(),
    ramGB: ramBytes / GIB,
    totalmemGB: Math.round((totalBytes / GIB) * 10) / 10,
    cgroupLimitGB: cgroupBytes === null ? null : Math.round((cgroupBytes / GIB) * 10) / 10,
  };
};
