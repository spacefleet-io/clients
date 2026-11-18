import { getDesktopPlatform, type CpuPressureSample } from "@space/desktop-platform";
import { getEffectiveCpuCount } from "@space/ffmpeg/hostCpu";
import { cpus, loadavg } from "node:os";

/**
 * Host load as the guardian sees it (#25, ultimate stress P1, P20).
 *
 * On a busy home PC (old 4-core i5 transcoding) a healthy runtime answers
 * health late. The guardian scales its patience by `loadFactor`:
 * 1 = idle/normal, N = "a runnable task here runs roughly N× slower".
 *
 * Signals, best first:
 * - The OS's CPU pressure signal (`HardwareLayer.createCpuPressureReader`;
 *   Linux PSI `cpu.pressure` `some avg10` of this process's cgroup v2, or of
 *   the whole host, `/proc/pressure/cpu`, when the cgroup file is missing).
 *   `some` = share of wall time at least one task here waited for a CPU, so a
 *   task gets the CPU about (1 − some) of the time: factor `1 / (1 − some)`,
 *   capped at PSI_FACTOR_MAX. It measures the stall our tasks actually
 *   suffer, unlike loadavg, which counts every runnable task on the host
 *   (P20: loadavg 49.5 over a 2-CPU affinity mask read as factor 24.8).
 * - Fallback (the platform has no pressure reader, e.g. kernels without
 *   CONFIG_PSI or an OS without such a signal): loadavg1 / effective CPUs
 *   (Windows reports loadavg 0). Effective CPUs is the shared
 *   `getEffectiveCpuCount()` (affinity mask and CPU quota limits), plus the
 *   CPU busy fraction since the previous sample (os.cpus() times; all
 *   platforms): a saturated host (≥ 90 % busy) counts as loaded, and the
 *   fewer CPUs it has the slower one more runnable task gets served
 *   (`saturatedBusyFactor`: 2 from 4 CPUs up, 4 on 2 CPUs, 8 on 1). Windows
 *   has neither PSI nor loadavg, so this is its whole signal (#928: a
 *   saturated 2-core Celeron).
 */
export type HostLoadSource = CpuPressureSample["source"] | "loadavg";

export type HostLoad = {
  loadFactor: number;
  source: HostLoadSource;
  /** PSI cpu `some avg10` as a fraction (0–1), null without PSI. */
  cpuPressure: number | null;
  loadavg1: number;
  effectiveCpus: number;
  cpuBusy: number | null;
};

export type HostLoadSampler = () => HostLoad;

/** `some = 1` would be an infinite factor; the guardian's grace caps far below this anyway. */
const PSI_FACTOR_MAX = 50;

/** Factor of a saturated host without PSI: one more runnable task on few CPUs waits longer. */
const SATURATED_BUSY = 0.9;
const saturatedBusyFactor = (effectiveCpus: number): number =>
  Math.max(2, Math.min(8, 8 / Math.max(1, effectiveCpus)));

type CpuTimes = { idle: number; total: number };

const readCpuTimes = (): CpuTimes => {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
};

export const computeLoadFactor = (input: {
  cpuPressure: number | null;
  loadavg1: number;
  effectiveCpus: number;
  cpuBusy: number | null;
}): number => {
  let factor: number;
  if (input.cpuPressure !== null) {
    factor = input.cpuPressure >= 1 ? PSI_FACTOR_MAX : Math.min(PSI_FACTOR_MAX, 1 / (1 - input.cpuPressure));
  } else {
    const fromLoadavg = input.effectiveCpus > 0 ? input.loadavg1 / input.effectiveCpus : 0;
    const fromBusy = input.cpuBusy !== null && input.cpuBusy >= SATURATED_BUSY ? saturatedBusyFactor(input.effectiveCpus) : 1;
    factor = Math.max(fromLoadavg, fromBusy);
  }
  return Math.round(Math.max(1, factor) * 100) / 100;
};

export const createHostLoadSampler = (
  deps: { createPressureReader?: () => (() => CpuPressureSample | null) | null } = {},
): HostLoadSampler => {
  const effectiveCpus = getEffectiveCpuCount().count;
  const readPressure = deps.createPressureReader ? deps.createPressureReader() : getDesktopPlatform().hardware.createCpuPressureReader();
  let prev = readCpuTimes();
  return () => {
    const next = readCpuTimes();
    const dTotal = next.total - prev.total;
    const cpuBusy = dTotal > 0 ? Math.min(1, Math.max(0, 1 - (next.idle - prev.idle) / dTotal)) : null;
    prev = next;
    const loadavg1 = loadavg()[0] ?? 0;
    const pressure = readPressure?.() ?? null;
    const cpuPressure = pressure?.some ?? null;
    return {
      loadFactor: computeLoadFactor({ cpuPressure, loadavg1, effectiveCpus, cpuBusy }),
      source: pressure === null ? "loadavg" : pressure.source,
      cpuPressure: cpuPressure === null ? null : Math.round(cpuPressure * 10_000) / 10_000,
      loadavg1: Math.round(loadavg1 * 100) / 100,
      effectiveCpus: Math.round(effectiveCpus * 100) / 100,
      cpuBusy: cpuBusy === null ? null : Math.round(cpuBusy * 100) / 100,
    };
  };
};
