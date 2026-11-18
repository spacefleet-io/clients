import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import type { CpuLimits, CpuPressureSample, CpuQuota, Env, HardwareEncoder, HardwareLayer } from "@space/desktop-platform-contract";

/** File text, or null when missing / unreadable. Injected by tests; the default reads the real procfs / sysfs. */
export type ReadText = (path: string) => string | null;

export type LinuxHardwareReaders = {
  readText: ReadText;
  exists: (path: string) => boolean;
  /** Entry names of a directory, [] when missing / unreadable. */
  listDir: (path: string) => string[];
  /** Modification time in ms, or null when missing / unreadable. */
  mtimeMs: (path: string) => number | null;
};

const readTextOrNull: ReadText = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

const listDirOrEmpty = (path: string): string[] => {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
};

const mtimeMsOrNull = (path: string): number | null => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
};

const defaultReaders: LinuxHardwareReaders = { readText: readTextOrNull, exists: existsSync, listDir: listDirOrEmpty, mtimeMs: mtimeMsOrNull };

// ---------------------------------------------------------------------------
// Encoders and GPU
// ---------------------------------------------------------------------------

/** Linux hardware H.264 encoders in fallback order, and the GPU vendor each belongs to. */
export const linuxEncoderPolicy: HardwareLayer["encoderPolicy"] = {
  order: ["vaapi", "qsv", "nvenc"],
  vendors: { vaapi: ["amd", "intel"], qsv: ["intel"], nvenc: ["nvidia", "geforce"] },
};

/** PCI vendor ids as /sys/class/drm/<node>/device/vendor reports them. */
const PCI_VENDORS: ReadonlyArray<readonly [string, string]> = [
  ["0x1002", "amd"],
  ["0x8086", "intel"],
  ["0x10de", "nvidia"],
];

const DRM_VENDOR_NODES = ["renderD128", "renderD129", "renderD130", "card0", "card1"] as const;

const VAAPI_RENDER_NODES = ["renderD128", "renderD129", "renderD130"] as const;

// ---------------------------------------------------------------------------
// CPU limits (affinity + cgroup v2 quota)
// ---------------------------------------------------------------------------

/** CPUs in a kernel cpu list (`0-3,8-11,16`), or null when malformed. */
export const parseCpuList = (list: string): number | null => {
  const trimmed = list.trim();
  if (trimmed === "") return null;
  let count = 0;
  for (const part of trimmed.split(",")) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) return null;
    const lo = Number(m[1]);
    const hi = m[2] === undefined ? lo : Number(m[2]);
    if (hi < lo) return null;
    count += hi - lo + 1;
  }
  return count;
};

/** `Cpus_allowed_list` value from /proc/self/status, or null. */
export const readCpusAllowedList = (readText: ReadText): string | null => {
  const line = readText("/proc/self/status")
    ?.split("\n")
    .find((l) => l.startsWith("Cpus_allowed_list:"));
  return line ? line.slice("Cpus_allowed_list:".length).trim() : null;
};

/** `cpu.max` content (`<quota|max> <period>`) in CPUs, or null for "max" / garbage. */
export const parseCpuMax = (content: string): number | null => {
  const [quota, period] = content.trim().split(/\s+/);
  if (!quota || quota === "max" || !period) return null;
  const q = Number(quota);
  const p = Number(period);
  if (!Number.isFinite(q) || !Number.isFinite(p) || q <= 0 || p <= 0) return null;
  return q / p;
};

/** cgroup v2 path of this process (`/user.slice/.../run-1.scope`), or null. */
export const readOwnCgroupPath = (readText: ReadText): string | null => {
  const line = readText("/proc/self/cgroup")
    ?.split("\n")
    .find((l) => l.startsWith("0::"));
  if (!line) return null;
  const rel = line.slice(3).trim();
  return rel.startsWith("/") ? rel : null;
};

/**
 * Tightest cgroup v2 CPU quota on the path from this process's cgroup to the
 * root, plus every file checked. `quota` is null when no readable level sets
 * one. Every ancestor's quota bounds its whole subtree.
 */
export const readCgroupCpuQuota = (readText: ReadText = readTextOrNull): { quota: CpuQuota | null; checked: CpuLimits["checked"] } => {
  const checked: CpuLimits["checked"] = [];
  const rel = readOwnCgroupPath(readText);
  if (rel === null) return { quota: null, checked };
  const parts = rel.split("/").filter(Boolean);
  let quota: CpuQuota | null = null;
  for (let depth = parts.length; depth >= 0; depth--) {
    const dir = depth === 0 ? "/sys/fs/cgroup" : `/sys/fs/cgroup/${parts.slice(0, depth).join("/")}`;
    const file = `${dir}/cpu.max`;
    const content = readText(file);
    checked.push({ file, content: content?.trim() ?? null });
    if (content === null) continue;
    const cpusAtLevel = parseCpuMax(content);
    if (cpusAtLevel !== null && (quota === null || cpusAtLevel < quota.cpus)) {
      quota = { cpus: cpusAtLevel, source: file, raw: content.trim() };
    }
  }
  return { quota, checked };
};

// ---------------------------------------------------------------------------
// CPU pressure (PSI)
// ---------------------------------------------------------------------------

/** `some avg10` of a PSI `cpu.pressure` file as a fraction, or null when malformed. */
export const parseCpuPressureSome = (content: string): number | null => {
  const avg10 = content
    .split("\n")
    .find((l) => l.startsWith("some "))
    ?.match(/\bavg10=([0-9.]+)/)?.[1];
  if (avg10 === undefined) return null;
  const pct = Number(avg10);
  return Number.isFinite(pct) && pct >= 0 ? Math.min(1, pct / 100) : null;
};

/**
 * PSI file to read: this process's cgroup v2 `cpu.pressure`, else the host's
 * `/proc/pressure/cpu`, else null. A runtime spawned into the caller's cgroup
 * shares the caller's pressure.
 */
export const resolveCpuPressureFile = (readText: ReadText): { file: string; source: CpuPressureSample["source"] } | null => {
  const cgroup = readOwnCgroupPath(readText);
  if (cgroup !== null) {
    const file = `/sys/fs/cgroup${cgroup === "/" ? "" : cgroup}/cpu.pressure`;
    const text = readText(file);
    if (text !== null && parseCpuPressureSome(text) !== null) return { file, source: "cgroup-psi" };
  }
  const host = readText("/proc/pressure/cpu");
  if (host !== null && parseCpuPressureSome(host) !== null) return { file: "/proc/pressure/cpu", source: "host-psi" };
  return null;
};

// ---------------------------------------------------------------------------
// The layer
// ---------------------------------------------------------------------------

/** The Linux hardware layer over injectable file readers (tests pass fake procfs / sysfs trees). */
export const createLinuxHardware = (readers: Partial<LinuxHardwareReaders> = {}): HardwareLayer => {
  const { readText, exists, listDir, mtimeMs } = { ...defaultReaders, ...readers };
  let cachedVendor: string | null = null;

  // sysfs reads are instant; async only to match the contract (Windows / macOS spawn a query).
  const detectGpuVendor = async (): Promise<string> => {
    if (cachedVendor !== null) return cachedVendor;
    cachedVendor = "";
    try {
      for (const node of DRM_VENDOR_NODES) {
        const path = `/sys/class/drm/${node}/device/vendor`;
        if (!exists(path)) continue;
        const id = (readText(path) ?? "").trim().toLowerCase();
        const vendor = PCI_VENDORS.find(([pci]) => pci === id)?.[1];
        if (vendor !== undefined) {
          cachedVendor = vendor;
          break;
        }
      }
    } catch {
      /* leave empty */
    }
    return cachedVendor;
  };

  const deviceFor = (encoder: HardwareEncoder, env: Env = process.env): string | null => {
    if (encoder !== "vaapi") return null;
    const override = env.SF_VAAPI_DEVICE?.trim();
    if (override && exists(override)) return override;
    for (const node of VAAPI_RENDER_NODES) {
      const path = `/dev/dri/${node}`;
      if (exists(path)) return path;
    }
    return null;
  };

  /** cgroup v2 memory cap (containers, systemd slices); null when unlimited / unreadable. */
  const memoryLimitBytes = (): number | null => {
    const raw = readText("/sys/fs/cgroup/memory.max")?.trim();
    if (raw === undefined) return null;
    const bytes = Number(raw);
    return raw !== "max" && Number.isFinite(bytes) && bytes > 0 ? bytes : null;
  };

  /**
   * Kernel release, each DRM card's driver and PCI id (from its uevent), the
   * version of those driver modules that have one (nvidia), and the mtime of
   * /etc/ld.so.cache: package managers run ldconfig on every library install,
   * so a Mesa or GPU-library update moves it (over-reports, never misses).
   */
  const graphicsStack = (): string | null => {
    const parts: string[] = [];
    const kernel = readText("/proc/sys/kernel/osrelease")?.trim();
    if (kernel) parts.push(`kernel=${kernel}`);
    const drivers: string[] = [];
    for (const card of listDir("/sys/class/drm").filter((name) => /^card\d+$/.test(name)).sort()) {
      const uevent = readText(`/sys/class/drm/${card}/device/uevent`);
      if (uevent === null) continue;
      const fields: Record<string, string> = Object.fromEntries(uevent.split("\n").map((line) => line.trim().split("=", 2)));
      const driver = fields.DRIVER ?? "";
      parts.push(`${card}=${driver}:${fields.PCI_ID ?? ""}`);
      if (driver && !drivers.includes(driver)) drivers.push(driver);
    }
    for (const driver of drivers) {
      const version = readText(`/sys/module/${driver}/version`)?.trim();
      if (version) parts.push(`${driver}=${version}`);
    }
    const ldCache = mtimeMs("/etc/ld.so.cache");
    if (ldCache !== null) parts.push(`ld.so.cache=${Math.trunc(ldCache)}`);
    return parts.length > 0 ? parts.join(" ") : null;
  };

  const readCpuLimits = (): CpuLimits => {
    const affinityList = readCpusAllowedList(readText);
    const affinityCount = affinityList === null ? null : parseCpuList(affinityList);
    const { quota, checked } = readCgroupCpuQuota(readText);
    return { affinityList, affinityCount, quota, checked };
  };

  const createCpuPressureReader = (): (() => CpuPressureSample | null) | null => {
    // cgroup membership of a running process practically never changes: resolve once.
    const psi = resolveCpuPressureFile(readText);
    if (psi === null) return null;
    return () => {
      const text = readText(psi.file);
      const some = text === null ? null : parseCpuPressureSome(text);
      return some === null ? null : { some, source: psi.source };
    };
  };

  return { encoderPolicy: linuxEncoderPolicy, detectGpuVendor, deviceFor, memoryLimitBytes, graphicsStack, readCpuLimits, createCpuPressureReader };
};

export const linuxHardware: HardwareLayer = createLinuxHardware();
