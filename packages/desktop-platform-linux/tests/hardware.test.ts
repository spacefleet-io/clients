/**
 * Linux hardware layer: encoder policy, GPU vendor (sysfs), VAAPI render node,
 * cgroup memory limit, CPU affinity / cgroup v2 quota, PSI CPU pressure.
 *
 * Moved with the logic from packages/ffmpeg/tests/host-cpu.test.ts (parse and
 * cgroup cases), packages/runtime-host/tests/load-diagnostics.test.ts (PSI
 * cases) and the encoder-selection cases of the desktop / ingest-core suites.
 * Every reader is fed a fake procfs / sysfs tree, so these run on any OS.
 */
import { advertisedHardwareEncoders, pickHardwareEncoder } from "@space/desktop-platform-contract";
import { describe, expect, it } from "vitest";
import {
  createLinuxHardware,
  linuxEncoderPolicy,
  linuxHardware,
  parseCpuList,
  parseCpuMax,
  parseCpuPressureSome,
  resolveCpuPressureFile,
} from "../src/hardware";

const SUITE = "linux-hardware";

const SCOPE = "/user.slice/user-1000.slice/user@1000.service/app.slice/run-u42.scope";

const fakeFs = (files: Record<string, string>) => ({
  readText: (path: string) => files[path] ?? null,
  exists: (path: string) => path in files,
});

const log = (label: string, value: unknown) => console.info(`[${SUITE}:${label}] ${JSON.stringify(value)}`);

describe("encoder policy", () => {
  it("lists vaapi, qsv, nvenc in that order with the vendor each belongs to", () => {
    expect(linuxHardware.encoderPolicy).toEqual({
      order: ["vaapi", "qsv", "nvenc"],
      vendors: { vaapi: ["amd", "intel"], qsv: ["intel"], nvenc: ["nvidia", "geforce"] },
    });
  });

  it("selects exactly as the former per-caller pickers did on Linux", () => {
    const names = (...encoders: string[]) => encoders.map((e) => `h264_${e}`);
    const cases: Array<{ label: string; advertised: string[]; vendor: string; want: string | null }> = [
      { label: "nvidia + vaapi/qsv/nvenc -> nvenc", advertised: names("vaapi", "qsv", "nvenc"), vendor: "nvidia", want: "nvenc" },
      { label: "geforce string -> nvenc", advertised: names("vaapi", "nvenc"), vendor: "NVIDIA GeForce RTX", want: "nvenc" },
      { label: "amd + vaapi/nvenc -> vaapi", advertised: names("vaapi", "nvenc"), vendor: "amd", want: "vaapi" },
      { label: "intel + vaapi/qsv -> vaapi (vaapi before qsv)", advertised: names("vaapi", "qsv"), vendor: "intel", want: "vaapi" },
      { label: "intel + qsv/nvenc -> qsv", advertised: names("qsv", "nvenc"), vendor: "intel", want: "qsv" },
      { label: "unknown vendor -> first advertised in policy order", advertised: names("nvenc", "qsv"), vendor: "", want: "qsv" },
      { label: "amd without vaapi -> falls back to nvenc", advertised: names("nvenc"), vendor: "amd", want: "nvenc" },
      { label: "nothing advertised -> software", advertised: [], vendor: "nvidia", want: null },
      { label: "amf is not a Linux encoder", advertised: names("amf"), vendor: "amd", want: null },
      { label: "videotoolbox is not a Linux encoder", advertised: names("videotoolbox"), vendor: "", want: null },
    ];
    for (const c of cases) {
      const advertised = advertisedHardwareEncoders(linuxEncoderPolicy, c.advertised);
      const got = pickHardwareEncoder(linuxEncoderPolicy, advertised, c.vendor);
      log(c.label, { advertised, vendor: c.vendor, got });
      expect(got).toBe(c.want);
    }
  });
});

describe("detectGpuVendor", () => {
  it("maps the PCI vendor id of the first known DRM node and caches the answer", async () => {
    const files: Record<string, string> = { "/sys/class/drm/renderD128/device/vendor": "0x10DE\n" };
    const hw = createLinuxHardware(fakeFs(files));
    expect(await hw.detectGpuVendor()).toBe("nvidia");
    // Cached per process: a later change is not observed.
    files["/sys/class/drm/renderD128/device/vendor"] = "0x8086\n";
    expect(await hw.detectGpuVendor()).toBe("nvidia");
  });

  it("recognises amd and intel, skips nodes that are missing or unknown, and returns '' when none matches", async () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ "/sys/class/drm/renderD128/device/vendor": "0x1002\n" }, "amd"],
      [{ "/sys/class/drm/renderD129/device/vendor": "0x8086\n" }, "intel"],
      [
        { "/sys/class/drm/renderD128/device/vendor": "0x1234\n", "/sys/class/drm/card0/device/vendor": "0x10de\n" },
        "nvidia",
      ],
      [{ "/sys/class/drm/renderD128/device/vendor": "0x1234\n" }, ""],
      [{}, ""],
    ];
    for (const [files, want] of cases) {
      const got = await createLinuxHardware(fakeFs(files)).detectGpuVendor();
      log("vendor", { files, got, want });
      expect(got).toBe(want);
    }
  });

  it("never throws on the real sysfs of this host", async () => {
    const vendor = await linuxHardware.detectGpuVendor();
    log("host-vendor", vendor);
    expect(["amd", "intel", "nvidia", ""]).toContain(vendor);
  });
});

describe("deviceFor", () => {
  it("returns the first existing VAAPI render node", () => {
    const hw = createLinuxHardware(fakeFs({ "/dev/dri/renderD129": "", "/dev/dri/renderD130": "" }));
    expect(hw.deviceFor("vaapi", {})).toBe("/dev/dri/renderD129");
  });

  it("honours SF_VAAPI_DEVICE (trimmed) only when it exists", () => {
    const hw = createLinuxHardware(fakeFs({ "/dev/dri/renderD128": "", "/tmp/custom-render-node": "" }));
    expect(hw.deviceFor("vaapi", { SF_VAAPI_DEVICE: "  /tmp/custom-render-node " })).toBe("/tmp/custom-render-node");
    expect(hw.deviceFor("vaapi", { SF_VAAPI_DEVICE: "/tmp/missing" })).toBe("/dev/dri/renderD128");
    expect(hw.deviceFor("vaapi", { SF_VAAPI_DEVICE: "  " })).toBe("/dev/dri/renderD128");
  });

  it("is null without a render node and for encoders that need no device", () => {
    const hw = createLinuxHardware(fakeFs({ "/dev/dri/renderD128": "" }));
    expect(createLinuxHardware(fakeFs({})).deviceFor("vaapi", {})).toBeNull();
    expect(hw.deviceFor("qsv", {})).toBeNull();
    expect(hw.deviceFor("nvenc", {})).toBeNull();
  });
});

describe("memoryLimitBytes", () => {
  it("reads the cgroup v2 memory.max and ignores 'max', garbage and unreadable files", () => {
    const cases: Array<[Record<string, string>, number | null]> = [
      [{ "/sys/fs/cgroup/memory.max": "8589934592\n" }, 8589934592],
      [{ "/sys/fs/cgroup/memory.max": "max\n" }, null],
      [{ "/sys/fs/cgroup/memory.max": "0\n" }, null],
      [{ "/sys/fs/cgroup/memory.max": "lots" }, null],
      [{}, null],
    ];
    for (const [files, want] of cases) {
      const got = createLinuxHardware(fakeFs(files)).memoryLimitBytes();
      log("memory", { files, got, want });
      expect(got).toBe(want);
    }
  });
});

/**
 * @bugfix effective-cpu-count-ignores-cgroup-quota @regression-proof (#25)
 * @bugfix bun-availableparallelism-ignores-affinity @regression-proof (#25)
 *
 * The ultimate stress suite runs the app in a 4-core cpuset with
 * CPUQuota=200% (`cpu.max` = "20000 10000"). These tests pin what the Linux
 * layer reports; the OS-agnostic `getEffectiveCpuCount()` in @space/ffmpeg
 * combines them with availableParallelism.
 */
describe("readCpuLimits", () => {
  const limits = (files: Record<string, string>) => {
    const got = createLinuxHardware(fakeFs(files)).readCpuLimits();
    log("limits", got);
    return got;
  };
  const status = (list: string) => `Name:\tbun\nCpus_allowed:\t0000f000\nCpus_allowed_list:\t${list}\nMems_allowed_list:\t0\n`;

  it("reports the low-end stress profile's quota from the process's own cgroup", () => {
    const got = limits({ "/proc/self/cgroup": `0::${SCOPE}\n`, [`/sys/fs/cgroup${SCOPE}/cpu.max`]: "20000 10000\n" });
    expect(got.quota).toEqual({ cpus: 2, source: `/sys/fs/cgroup${SCOPE}/cpu.max`, raw: "20000 10000" });
  });

  it("takes the tightest quota of the leaf and every ancestor, and lists every file it checked", () => {
    const got = limits({
      "/proc/self/cgroup": `0::${SCOPE}\n`,
      [`/sys/fs/cgroup${SCOPE}/cpu.max`]: "max 100000\n",
      "/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/cpu.max": "300000 100000\n",
      "/sys/fs/cgroup/user.slice/cpu.max": "600000 100000\n",
    });
    expect(got.quota?.cpus).toBe(3);
    expect(got.quota?.source).toBe("/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/cpu.max");
    expect(got.checked.map((c) => c.file)).toEqual([
      `/sys/fs/cgroup${SCOPE}/cpu.max`,
      "/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/cpu.max",
      "/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/cpu.max",
      "/sys/fs/cgroup/user.slice/user-1000.slice/cpu.max",
      "/sys/fs/cgroup/user.slice/cpu.max",
      "/sys/fs/cgroup/cpu.max",
    ]);
    expect(got.checked[0]).toEqual({ file: `/sys/fs/cgroup${SCOPE}/cpu.max`, content: "max 100000" });
    expect(got.checked[5]).toEqual({ file: "/sys/fs/cgroup/cpu.max", content: null });
  });

  it("keeps a fractional quota unrounded (the combiner floors it)", () => {
    const got = limits({ "/proc/self/cgroup": "0::/svc.scope\n", "/sys/fs/cgroup/svc.scope/cpu.max": "150000 100000" });
    expect(got.quota?.cpus).toBe(1.5);
  });

  it("reports no quota when cgroup files are unreadable, unlimited, garbage, or the host has no cgroup v2 line", () => {
    const unreadable = limits({});
    const noV2Line = limits({ "/proc/self/cgroup": "12:cpu,cpuacct:/foo\n" });
    const unlimited = limits({ "/proc/self/cgroup": "0::/\n", "/sys/fs/cgroup/cpu.max": "max 100000\n" });
    const garbage = limits({ "/proc/self/cgroup": "0::/x\n", "/sys/fs/cgroup/x/cpu.max": "nope\n" });
    for (const got of [unreadable, noV2Line, unlimited, garbage]) expect(got.quota).toBeNull();
    expect(unreadable.checked).toEqual([]);
    expect(noV2Line.checked).toEqual([]);
  });

  it("reports the Cpus_allowed_list affinity of a 4-core cpuset", () => {
    const got = limits({ "/proc/self/status": status("12-15"), "/proc/self/cgroup": `0::${SCOPE}\n` });
    expect(got.affinityList).toBe("12-15");
    expect(got.affinityCount).toBe(4);
    expect(got.quota).toBeNull();
  });

  it("reports a null affinity count for an unreadable, missing or garbled status", () => {
    expect(limits({})).toMatchObject({ affinityList: null, affinityCount: null });
    expect(limits({ "/proc/self/status": "Name:\tbun\n" })).toMatchObject({ affinityList: null, affinityCount: null });
    expect(limits({ "/proc/self/status": status("4-x") })).toMatchObject({ affinityList: "4-x", affinityCount: null });
  });

  it("reads the real procfs of this host without throwing", () => {
    const got = linuxHardware.readCpuLimits();
    log("host-limits", got);
    expect(got.affinityCount === null || got.affinityCount >= 1).toBe(true);
    expect(got.quota === null || got.quota.cpus > 0).toBe(true);
  });
});

describe("parseCpuList", () => {
  it("counts CPUs in a kernel cpu list and rejects malformed input", () => {
    const cases: Array<[string, number | null]> = [
      ["0-31", 32],
      ["12-15", 4],
      ["0,2,4,6", 4],
      ["0-3,8-11,16", 9],
      ["5", 1],
      [" 0-3\n", 4],
      ["", null],
      ["3-1", null],
      ["0-", null],
      ["a,b", null],
    ];
    for (const [input, want] of cases) {
      const got = parseCpuList(input);
      log("cpulist", { input, got, want });
      expect(got).toBe(want);
    }
  });
});

describe("parseCpuMax", () => {
  it("parses quota/period and rejects max or malformed content", () => {
    const cases: Array<[string, number | null]> = [
      ["20000 10000\n", 2],
      ["150000 100000", 1.5],
      ["max 100000", null],
      ["0 100000", null],
      ["", null],
      ["123", null],
    ];
    for (const [input, want] of cases) {
      const got = parseCpuMax(input);
      log("cpumax", { input, got, want });
      expect(got).toBe(want);
    }
  });
});

describe("CPU pressure (PSI)", () => {
  it("parses PSI some avg10 and rejects garbage", () => {
    const text = "some avg10=12.50 avg60=3.00 avg300=1.00 total=100\nfull avg10=99.00 avg60=0.00 avg300=0.00 total=0\n";
    expect(parseCpuPressureSome(text)).toBe(0.125);
    expect(parseCpuPressureSome("full avg10=1.00 avg60=0 avg300=0 total=0")).toBeNull();
    expect(parseCpuPressureSome("")).toBeNull();
    expect(parseCpuPressureSome("some avg10=250.00 avg60=0 avg300=0 total=0")).toBe(1);
  });

  it("reads the cgroup's cpu.pressure first, then the host's, then none", () => {
    const files: Record<string, string> = {
      "/proc/self/cgroup": "0::/app.slice/badger.scope\n",
      "/sys/fs/cgroup/app.slice/badger.scope/cpu.pressure": "some avg10=30.00 avg60=0 avg300=0 total=1\n",
      "/proc/pressure/cpu": "some avg10=90.00 avg60=0 avg300=0 total=1\n",
    };
    const readText = (path: string) => files[path] ?? null;
    const cgroup = resolveCpuPressureFile(readText);
    log("psi-file", cgroup);
    expect(cgroup).toEqual({ file: "/sys/fs/cgroup/app.slice/badger.scope/cpu.pressure", source: "cgroup-psi" });
    delete files["/sys/fs/cgroup/app.slice/badger.scope/cpu.pressure"];
    expect(resolveCpuPressureFile(readText)).toEqual({ file: "/proc/pressure/cpu", source: "host-psi" });
    delete files["/proc/pressure/cpu"];
    expect(resolveCpuPressureFile(readText)).toBeNull();
    // Namespaced container: own cgroup is "/".
    const container: Record<string, string> = { "/proc/self/cgroup": "0::/\n", "/sys/fs/cgroup/cpu.pressure": "some avg10=1.00" };
    expect(resolveCpuPressureFile((p) => container[p] ?? null)).toEqual({ file: "/sys/fs/cgroup/cpu.pressure", source: "cgroup-psi" });
  });

  it("createCpuPressureReader samples the cgroup's pressure as a 0..1 share and follows the file", () => {
    const files: Record<string, string> = {
      "/proc/self/cgroup": "0::/a.scope\n",
      "/sys/fs/cgroup/a.scope/cpu.pressure": "some avg10=50.00 avg60=0 avg300=0 total=1",
    };
    const reader = createLinuxHardware(fakeFs(files)).createCpuPressureReader();
    expect(reader).not.toBeNull();
    expect(reader?.()).toEqual({ some: 0.5, source: "cgroup-psi" });
    files["/sys/fs/cgroup/a.scope/cpu.pressure"] = "some avg10=10.00 avg60=0 avg300=0 total=2";
    expect(reader?.()).toEqual({ some: 0.1, source: "cgroup-psi" });
    files["/sys/fs/cgroup/a.scope/cpu.pressure"] = "garbage";
    expect(reader?.()).toBeNull();
    delete files["/sys/fs/cgroup/a.scope/cpu.pressure"];
    expect(reader?.()).toBeNull();
  });

  it("createCpuPressureReader falls back to the host file and is null without any PSI file", () => {
    const host = createLinuxHardware(fakeFs({ "/proc/pressure/cpu": "some avg10=25.00 avg60=0 avg300=0 total=1" })).createCpuPressureReader();
    expect(host?.()).toEqual({ some: 0.25, source: "host-psi" });
    expect(createLinuxHardware(fakeFs({})).createCpuPressureReader()).toBeNull();
  });

  it("samples the real PSI of this host when the kernel has it", () => {
    const reader = linuxHardware.createCpuPressureReader();
    const sample = reader?.() ?? null;
    log("host-psi", { hasReader: reader !== null, sample });
    expect(sample === null || (sample.some >= 0 && sample.some <= 1)).toBe(true);
  });
});

// #25: the mpv GPU probe memory keys on this. It must change when the GPU, its
// kernel driver or the user-space graphics libraries (Mesa, NVIDIA's) change:
// package managers run ldconfig on every library install, which rewrites
// /etc/ld.so.cache, so its mtime moves with a Mesa or driver update.
describe("graphicsStack @req MPV-GPU-01[badger-desktop]", () => {
  const NVIDIA_TREE: Record<string, string> = {
    "/proc/sys/kernel/osrelease": "7.2.9-2-cachyos\n",
    "/sys/class/drm/card1/device/uevent": "DRIVER=nvidia\nPCI_CLASS=30000\nPCI_ID=10DE:2B85\nPCI_SUBSYS_ID=1043:89F2\nPCI_SLOT_NAME=0000:01:00.0\n",
    "/sys/module/nvidia/version": "615.78.08\n",
  };
  const DRM_ENTRIES = ["card1", "card1-DP-1", "card1-HDMI-A-1", "renderD128", "version"];
  const stackFrom = (files: Record<string, string>, drm: string[] = DRM_ENTRIES, ldCacheMtime: number | null = 1_760_486_612_672) =>
    createLinuxHardware({
      ...fakeFs(files),
      listDir: (path) => (path === "/sys/class/drm" ? drm : []),
      mtimeMs: (path) => (path === "/etc/ld.so.cache" ? ldCacheMtime : null),
    }).graphicsStack();

  it("names the kernel, each DRM card's driver and PCI id, the driver module version and the library cache", () => {
    const stack = stackFrom(NVIDIA_TREE);
    log("graphicsStack", stack);
    expect(stack).toBe("kernel=7.2.9-2-cachyos card1=nvidia:10DE:2B85 nvidia=615.78.08 ld.so.cache=1760486612672");
  });

  it("changes with a new GPU, a driver update, a kernel update or any library install", () => {
    const base = stackFrom(NVIDIA_TREE);
    const changes: Array<[string, string | null]> = [
      ["amd gpu", stackFrom({ ...NVIDIA_TREE, "/sys/class/drm/card1/device/uevent": "DRIVER=amdgpu\nPCI_ID=1002:164E\n" })],
      ["second gpu", stackFrom({ ...NVIDIA_TREE, "/sys/class/drm/card0/device/uevent": "DRIVER=i915\nPCI_ID=8086:A780\n" }, ["card0", ...DRM_ENTRIES])],
      ["nvidia module", stackFrom({ ...NVIDIA_TREE, "/sys/module/nvidia/version": "620.10.01\n" })],
      ["kernel", stackFrom({ ...NVIDIA_TREE, "/proc/sys/kernel/osrelease": "7.3.0-1-cachyos\n" })],
      ["mesa/libs (ldconfig)", stackFrom(NVIDIA_TREE, DRM_ENTRIES, 1_760_999_999_999)],
    ];
    for (const [name, stack] of changes) {
      log(`graphicsStack:${name}`, stack);
      expect(stack, name).not.toBe(base);
      expect(stack, name).not.toBeNull();
    }
  });

  it("still describes a machine without a GPU (kernel + libraries), and is null when nothing can be read", () => {
    expect(stackFrom({ "/proc/sys/kernel/osrelease": "6.8.0-45-generic\n" }, ["version"])).toBe("kernel=6.8.0-45-generic ld.so.cache=1760486612672");
    expect(stackFrom({}, [], null)).toBeNull();
  });
});
