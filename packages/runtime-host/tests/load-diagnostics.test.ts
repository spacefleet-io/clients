/**
 * #25 P1 — host-load signal and the out-of-process runtime dump the guardian
 * logs on a failed health probe.
 */
import { afterEach, describe, expect, it } from "vitest";
import { getDesktopPlatform, setDesktopPlatformForTests } from "@space/desktop-platform";
import { computeLoadFactor, createHostLoadSampler } from "../src/load";
import { createPortHoldersReader, createProcessDiagnosticsReader } from "../src/diagnostics";

const SUITE = "runtime-host-load-diagnostics";

describe("host load factor", () => {
  it("falls back to runnable tasks per effective CPU without PSI", () => {
    const cases = [
      { in: { cpuPressure: null, loadavg1: 0.5, effectiveCpus: 4, cpuBusy: 0.1 }, out: 1 },
      // Windows reports loadavg 0: a saturated CPU still counts as loaded.
      { in: { cpuPressure: null, loadavg1: 0, effectiveCpus: 4, cpuBusy: 0.97 }, out: 2 },
      // The stress run: loadavg ~30 in a 2-CPU quota.
      { in: { cpuPressure: null, loadavg1: 30, effectiveCpus: 2, cpuBusy: 1 }, out: 15 },
      { in: { cpuPressure: null, loadavg1: 6, effectiveCpus: 4, cpuBusy: null }, out: 1.5 },
    ];
    for (const c of cases) {
      const got = computeLoadFactor(c.in);
      console.info(`[${SUITE}:factor] ${JSON.stringify(c.in)} -> ${got} (want ${c.out})`);
      expect(got).toBe(c.out);
    }
  });

  it("@regression-proof a saturated CPU without PSI or loadavg scales the factor with fewer CPUs (#928)", () => {
    // Windows: no pressure reader, loadavg 0. The Windows test machine is a 2-core Celeron
    // pinned at 100 % during cold start; factor 2 starved its health probes.
    const cases = [
      { in: { cpuPressure: null, loadavg1: 0, effectiveCpus: 1, cpuBusy: 0.97 }, out: 8 },
      { in: { cpuPressure: null, loadavg1: 0, effectiveCpus: 2, cpuBusy: 0.97 }, out: 4 },
      { in: { cpuPressure: null, loadavg1: 0, effectiveCpus: 2, cpuBusy: 0.9 }, out: 4 },
      { in: { cpuPressure: null, loadavg1: 0, effectiveCpus: 8, cpuBusy: 1 }, out: 2 },
      // Below the busy threshold the box is not loaded.
      { in: { cpuPressure: null, loadavg1: 0, effectiveCpus: 2, cpuBusy: 0.89 }, out: 1 },
      { in: { cpuPressure: null, loadavg1: 0, effectiveCpus: 2, cpuBusy: 0.5 }, out: 1 },
    ];
    for (const c of cases) {
      const got = computeLoadFactor(c.in);
      console.info(`[${SUITE}:busy-factor] ${JSON.stringify(c.in)} -> ${got} (want ${c.out})`);
      expect(got).toBe(c.out);
    }
  });

  it("@bugfix @regression-proof derives the factor from PSI stall, not host loadavg, when PSI is readable (#25 P20)", () => {
    const cases = [
      { in: { cpuPressure: 0, loadavg1: 0.5, effectiveCpus: 4, cpuBusy: 0.1 }, out: 1 },
      // P20 c053: loadavg1 49.54 over 2 effective CPUs read as 24.77; the
      // cgroup's own tasks stalled 30 % of the time.
      { in: { cpuPressure: 0.3, loadavg1: 49.54, effectiveCpus: 2, cpuBusy: 1 }, out: 1.43 },
      { in: { cpuPressure: 0.75, loadavg1: 0, effectiveCpus: 4, cpuBusy: null }, out: 4 },
      { in: { cpuPressure: 0.96, loadavg1: 10, effectiveCpus: 4, cpuBusy: 1 }, out: 25 },
      { in: { cpuPressure: 1, loadavg1: 10, effectiveCpus: 4, cpuBusy: 1 }, out: 50 },
    ];
    for (const c of cases) {
      const got = computeLoadFactor(c.in);
      console.info(`[${SUITE}:psi-factor] ${JSON.stringify(c.in)} -> ${got} (want ${c.out})`);
      expect(got).toBe(c.out);
    }
  });

  // The PSI file lookup and parsing live in packages/desktop-platform-linux/tests/hardware.test.ts.
  it("samples the PSI factor from the platform's pressure reader", () => {
    const sample = createHostLoadSampler({ createPressureReader: () => () => ({ some: 0.5, source: "cgroup-psi" }) })();
    console.info(`[${SUITE}:psi-sample] ${JSON.stringify(sample)}`);
    expect(sample).toMatchObject({ source: "cgroup-psi", cpuPressure: 0.5, loadFactor: 2 });
  });

  it("falls back to loadavg when the platform has no pressure reader or the reader has no sample", () => {
    for (const [label, createPressureReader] of [
      ["no-reader", () => null],
      ["empty-sample", () => () => null],
    ] as const) {
      const sample = createHostLoadSampler({ createPressureReader })();
      console.info(`[${SUITE}:fallback:${label}] ${JSON.stringify(sample)}`);
      expect(sample.source).toBe("loadavg");
      expect(sample.cpuPressure).toBeNull();
      expect(sample.loadFactor).toBeGreaterThanOrEqual(1);
    }
  });

  it("samples a usable load on this host", () => {
    const sample = createHostLoadSampler()();
    console.info(`[${SUITE}:sample] ${JSON.stringify(sample)}`);
    expect(sample.loadFactor).toBeGreaterThanOrEqual(1);
    expect(sample.effectiveCpus).toBeGreaterThan(0);
  });
});

describe("process diagnostics wiring", () => {
  // The procfs readers themselves are tested in packages/desktop-platform-linux/tests/diagnostics.test.ts.
  afterEach(() => setDesktopPlatformForTests(null));

  it("reads through the active desktop platform", async () => {
    const base = getDesktopPlatform();
    const diagnostics = {
      readProcess: async (pid: number) => ({ platform: "stub", pid }),
      readPortHolders: async (port: number) => ({ platform: "stub", port }),
    };
    setDesktopPlatformForTests({ ...base, diagnostics });
    console.info(`[${SUITE}:diag-wiring] platform pinned to a stub diagnostics layer`);
    expect(await createProcessDiagnosticsReader()(7)).toEqual({ platform: "stub", pid: 7 });
    expect(await createPortHoldersReader()(3020)).toEqual({ platform: "stub", port: 3020 });
  });
});
