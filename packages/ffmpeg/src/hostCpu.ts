import { getDesktopPlatform, type CpuLimits, type PlatformId } from "@space/desktop-platform";
import { availableParallelism, cpus } from "node:os";

/**
 * Effective CPU count of this process (#25): the one number every CPU-sized
 * cap uses (engineV2 lane caps, ffmpeg worker threads, the runtime scheduler,
 * the guardian's load factor).
 *
 * The count is the minimum of up to three inputs:
 * - `os.availableParallelism()`. Node honours the affinity mask there, but
 *   the runtime runs on Bun, and Bun 1.3.10 reports every host CPU (32 inside
 *   the low-end stress profile's 4-core cpuset). It is a ceiling, not a
 *   trustworthy affinity count. `os.cpus().length` is never used.
 * - The OS's own view of this process's affinity mask / cpuset
 *   (`HardwareLayer.readCpuLimits().affinityCount`; Linux: the CPUs in
 *   `/proc/self/status` `Cpus_allowed_list`), so `taskset` and a cgroup
 *   cpuset (`AllowedCPUs=`) shrink the count whatever the runtime reports.
 * - The OS's CPU bandwidth quota (`readCpuLimits().quota`; Linux: the tightest
 *   cgroup v2 `cpu.max` from this process's cgroup up to the root, i.e.
 *   `CPUQuota=` / `docker --cpus`), as `floor(quota)` (min 1). Affinity does
 *   not express a bandwidth quota, so both are needed.
 * Unreadable or malformed sources mean no clamp from that input. Where each
 * number comes from is the desktop platform's business, not this file's.
 */
export type EffectiveCpuSource = "availableParallelism" | "cpus-allowed-list" | "cgroup-cpu.max";

export type CgroupCpuQuota = {
  /** quota / period, in CPUs (fractional: `150000 100000` = 1.5). */
  cpus: number;
  /** `cpu.max` file that set the tightest quota. */
  file: string;
  /** Raw `quota period` content of that file. */
  raw: string;
};

export type EffectiveCpuCount = {
  /** Integer CPU count to size caps from (>= 1). */
  count: number;
  source: EffectiveCpuSource;
  platform: PlatformId;
  availableParallelism: number;
  /** `os.cpus().length`, logged only so a mismatch is visible. */
  osCpuCount: number;
  /** Raw allowed-CPU list (Linux `Cpus_allowed_list`), null when unread. */
  cpusAllowedList: string | null;
  /** CPUs in `cpusAllowedList`, null when unreadable / malformed / not reported by the OS. */
  cpusAllowedCount: number | null;
  cgroupQuota: CgroupCpuQuota | null;
  /** Every quota file checked and what it held (`null` = unreadable). */
  cgroupFilesChecked: CpuLimits["checked"];
};

export type HostCpuReaders = {
  platform: PlatformId;
  availableParallelism: () => number;
  osCpuCount: () => number;
  /** The OS's affinity / quota limits (`HardwareLayer.readCpuLimits`). */
  readLimits: () => CpuLimits;
};

/** Derive the effective CPU count from injected readers (pure; tests). */
export const computeEffectiveCpuCount = (readers: HostCpuReaders): EffectiveCpuCount => {
  const rawAp = readers.availableParallelism();
  const ap = Number.isFinite(rawAp) && rawAp >= 1 ? Math.trunc(rawAp) : 1;
  const osCpuCount = readers.osCpuCount();
  const { affinityList: cpusAllowedList, affinityCount: cpusAllowedCount, quota, checked } = readers.readLimits();
  const quotaCount = quota ? Math.max(1, Math.floor(quota.cpus)) : null;
  let count = ap;
  let source: EffectiveCpuSource = "availableParallelism";
  if (cpusAllowedCount !== null && cpusAllowedCount < count) {
    count = cpusAllowedCount;
    source = "cpus-allowed-list";
  }
  if (quotaCount !== null && quotaCount < count) {
    count = quotaCount;
    source = "cgroup-cpu.max";
  }
  return {
    count,
    source,
    platform: readers.platform,
    availableParallelism: ap,
    osCpuCount,
    cpusAllowedList,
    cpusAllowedCount,
    cgroupQuota: quota ? { cpus: quota.cpus, file: quota.source, raw: quota.raw } : null,
    cgroupFilesChecked: checked,
  };
};

let cached: EffectiveCpuCount | null = null;

/**
 * Effective CPU count of this process, computed once and logged once. The
 * affinity mask and cgroup quota of a running process practically never
 * change, and every cap wants the same answer.
 */
export const getEffectiveCpuCount = (): EffectiveCpuCount => {
  if (cached) return cached;
  const platform = getDesktopPlatform();
  cached = computeEffectiveCpuCount({
    platform: platform.id,
    availableParallelism,
    osCpuCount: () => cpus().length,
    readLimits: () => platform.hardware.readCpuLimits(),
  });
  console.info("[host-cpu] effective cpu count", {
    count: cached.count,
    source: cached.source,
    platform: cached.platform,
    availableParallelism: cached.availableParallelism,
    osCpuCount: cached.osCpuCount,
    cpusAllowedList: cached.cpusAllowedList,
    cpusAllowedCount: cached.cpusAllowedCount,
    cgroupQuota: cached.cgroupQuota,
    cgroupFilesChecked: cached.cgroupFilesChecked,
  });
  return cached;
};
