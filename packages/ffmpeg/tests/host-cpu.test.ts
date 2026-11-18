/**
 * @bugfix effective-cpu-count-ignores-cgroup-quota @regression-proof (#25)
 * @bugfix bun-availableparallelism-ignores-affinity @regression-proof (#25)
 *
 * The ultimate stress suite runs the app in its low-end profile: a 4-core
 * cpuset and a 200% CPU quota. The runtime logged
 * `[engineV2] host-aware lane caps { hostCpuCount: 32 }` there, so lane caps
 * and ffmpeg thread caps were sized for the full host. These tests pin the
 * OS-agnostic combiner every CPU-sized cap shares: availableParallelism,
 * clamped by the platform's affinity count and CPU quota (`CpuLimits`).
 *
 * Where those limits come from (Linux `Cpus_allowed_list`, cgroup v2
 * `cpu.max`) is the platform's business; the parsing cases live in
 * packages/desktop-platform-linux/tests/hardware.test.ts.
 */
import { describe, expect, it } from "vitest";
import type { CpuLimits } from "@space/desktop-platform";
import { computeEffectiveCpuCount, getEffectiveCpuCount, type HostCpuReaders } from "../src/hostCpu";
import { resolveFfmpegThreads } from "../src/resourcePolicy";

const SUITE = "host-cpu";

const QUOTA_FILE = "/sys/fs/cgroup/app.slice/run-u42.scope/cpu.max";

const noLimits: CpuLimits = { affinityList: null, affinityCount: null, quota: null, checked: [] };

const readers = (opts: { availableParallelism: number; osCpuCount?: number; limits?: Partial<CpuLimits> }): HostCpuReaders => ({
  platform: "linux",
  availableParallelism: () => opts.availableParallelism,
  osCpuCount: () => opts.osCpuCount ?? 32,
  readLimits: () => ({ ...noLimits, ...opts.limits }),
});

const quota = (cpus: number, raw = `${cpus * 10000} 10000`) => ({ cpus, source: QUOTA_FILE, raw });

const run = (label: string, r: HostCpuReaders) => {
  const got = computeEffectiveCpuCount(r);
  console.info(`[${SUITE}:${label}] ${JSON.stringify(got)}`);
  return got;
};

describe("computeEffectiveCpuCount", () => {
  it("clamps the low-end stress profile (4-core cpuset, CPUQuota=200%) to 2 CPUs from the quota", () => {
    const got = run(
      "lowend-scope",
      readers({
        availableParallelism: 4,
        limits: { quota: quota(2, "20000 10000"), checked: [{ file: QUOTA_FILE, content: "20000 10000" }] },
      }),
    );
    expect(got.count).toBe(2);
    expect(got.source).toBe("cgroup-cpu.max");
    expect(got.cgroupQuota).toEqual({ cpus: 2, file: QUOTA_FILE, raw: "20000 10000" });
    expect(got.cgroupFilesChecked).toEqual([{ file: QUOTA_FILE, content: "20000 10000" }]);
    expect(got.availableParallelism).toBe(4);
    expect(got.osCpuCount).toBe(32);
    expect(got.platform).toBe("linux");
    // The derived count, not os.cpus().length, sizes the ffmpeg thread cap.
    console.info(`[${SUITE}:lowend-scope] ffmpeg threads ${resolveFfmpegThreads(got.count, {})}`);
    expect(resolveFfmpegThreads(got.count, {})).toBe(1);
  });

  it("floors a fractional quota and never goes below 1", () => {
    expect(run("fractional", readers({ availableParallelism: 8, limits: { quota: quota(1.5) } })).count).toBe(1);
    expect(run("tiny", readers({ availableParallelism: 8, limits: { quota: quota(0.1) } })).count).toBe(1);
    expect(run("two-and-a-half", readers({ availableParallelism: 8, limits: { quota: quota(2.5) } })).count).toBe(2);
  });

  it("keeps availableParallelism when the quota is looser than the affinity mask", () => {
    const got = run("loose-quota", readers({ availableParallelism: 4, limits: { quota: quota(8) } }));
    expect(got.count).toBe(4);
    expect(got.source).toBe("availableParallelism");
    expect(got.cgroupQuota?.cpus).toBe(8);
  });

  it("does not clamp when the platform reports no limits", () => {
    const got = run("no-limits", readers({ availableParallelism: 6 }));
    expect(got.count).toBe(6);
    expect(got.source).toBe("availableParallelism");
    expect(got.cgroupQuota).toBeNull();
    expect(got.cgroupFilesChecked).toEqual([]);
    expect(got.cpusAllowedList).toBeNull();
    expect(got.cpusAllowedCount).toBeNull();
  });

  it("treats a nonsensical availableParallelism as 1", () => {
    expect(run("ap-zero", readers({ availableParallelism: 0 })).count).toBe(1);
    expect(run("ap-nan", readers({ availableParallelism: Number.NaN })).count).toBe(1);
  });

  it("clamps a 4-core cpuset with no quota when availableParallelism over-reports the host (Bun 1.3.10)", () => {
    const got = run("cpuset-no-quota", readers({ availableParallelism: 32, limits: { affinityList: "12-15", affinityCount: 4 } }));
    expect(got.count).toBe(4);
    expect(got.source).toBe("cpus-allowed-list");
    expect(got.availableParallelism).toBe(32);
    expect(got.cpusAllowedList).toBe("12-15");
    expect(got.cpusAllowedCount).toBe(4);
    expect(resolveFfmpegThreads(got.count, {})).toBe(2);
  });

  it("still lets a tighter quota win over the affinity count", () => {
    const got = run("cpuset-and-quota", readers({ availableParallelism: 32, limits: { affinityList: "4-7", affinityCount: 4, quota: quota(2) } }));
    expect(got.count).toBe(2);
    expect(got.source).toBe("cgroup-cpu.max");
    expect(got.cpusAllowedCount).toBe(4);
  });

  it("keeps availableParallelism when it is already the tightest, and ignores an unparsable affinity list", () => {
    const tighter = run("ap-tighter", readers({ availableParallelism: 4, limits: { affinityList: "0-31", affinityCount: 32 } }));
    expect(tighter.count).toBe(4);
    expect(tighter.source).toBe("availableParallelism");
    expect(tighter.cpusAllowedCount).toBe(32);
    const garbled = run("affinity-garbled", readers({ availableParallelism: 32, limits: { affinityList: "4-x", affinityCount: null } }));
    expect(garbled.count).toBe(32);
    expect(garbled.source).toBe("availableParallelism");
    expect(garbled.cpusAllowedCount).toBeNull();
  });
});

describe("getEffectiveCpuCount", () => {
  it("returns a usable, memoised count on this host", () => {
    const first = getEffectiveCpuCount();
    console.info(`[${SUITE}:host] ${JSON.stringify(first)}`);
    expect(first.count).toBeGreaterThanOrEqual(1);
    expect(first.count).toBeLessThanOrEqual(first.availableParallelism);
    expect(getEffectiveCpuCount()).toBe(first);
  });
});
