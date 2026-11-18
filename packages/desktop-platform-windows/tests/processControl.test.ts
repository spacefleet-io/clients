import { describe, expect, it } from "vitest";
import { countSetBits, createWindowsProcessControl, highestSetBit, NO_FFI_MESSAGE } from "../src/processControl";
import type { Win32Api } from "../src/win32api";

describe("affinity mask helpers", () => {
  it("highestSetBit / countSetBits", () => {
    expect(highestSetBit(0n)).toBeNull();
    expect(highestSetBit(1n)).toBe(0);
    expect(highestSetBit(0b1111n)).toBe(3);
    expect(highestSetBit(1n << 63n)).toBe(63);
    expect(countSetBits(0n)).toBe(0);
    expect(countSetBits(0b1011n)).toBe(3);
    expect(countSetBits((1n << 64n) - 1n)).toBe(64);
  });
});

const fakeApi = (initialMask = 0b1111n, options: { openFails?: boolean; suspendStatus?: number } = {}) => {
  const log: string[] = [];
  let mask = initialMask;
  let priority = 0x20;
  const api: Win32Api = {
    openProcess: (pid, access) => (log.push(`open ${pid} 0x${access.toString(16)}`), options.openFails ? null : 100),
    closeHandle: (h) => void log.push(`close ${h}`),
    ntSuspendProcess: () => (log.push("suspend"), options.suspendStatus ?? 0),
    ntResumeProcess: () => (log.push("resume"), 0),
    getAffinity: () => ({ process: mask, system: 0b1111n }),
    setAffinity: (_h, next) => (log.push(`affinity 0b${next.toString(2)}`), (mask = next), true),
    getPriorityClass: () => priority,
    setPriorityClass: (_h, next) => (log.push(`priority 0x${next.toString(16)}`), (priority = next), true),
    createJobObject: () => null,
    setKillOnClose: () => false,
    assignProcessToJob: () => false,
  };
  return { api, log };
};

describe("windows process control", () => {
  it("under Node (no bun:ffi) open throws a clear error", () => {
    const control = createWindowsProcessControl({ loadApi: () => null });
    expect(() => control.open(1234)).toThrow(NO_FFI_MESSAGE);
    expect(NO_FFI_MESSAGE).toContain("bun:ffi");
  });

  it("throws when the process cannot be opened", () => {
    const { api } = fakeApi(0b1111n, { openFails: true });
    expect(() => createWindowsProcessControl({ loadApi: () => api }).open(42)).toThrow(/cannot open process 42/);
  });

  it("suspend and resume are idempotent so the kernel's suspend count never drifts", () => {
    const { api, log } = fakeApi();
    const handle = createWindowsProcessControl({ loadApi: () => api }).open(7);
    handle.suspend();
    handle.suspend();
    handle.resume();
    handle.resume();
    console.info("[windows-control:suspend] calls", log);
    expect(log.filter((line) => line === "suspend")).toHaveLength(1);
    expect(log.filter((line) => line === "resume")).toHaveLength(1);
    expect(log[0]).toBe(`open 7 0x${(0x0800 | 0x0400 | 0x0200).toString(16)}`);
  });

  it("a failing suspend throws and leaves the handle resumable-free", () => {
    const { api } = fakeApi(0b1111n, { suspendStatus: -1073741790 });
    const handle = createWindowsProcessControl({ loadApi: () => api }).open(7);
    expect(() => handle.suspend()).toThrow(/NtSuspendProcess\(7\) failed: 0xc0000022/);
    expect(() => handle.resume()).not.toThrow(); // nothing was suspended
  });

  it("throttle confines the process to its highest allowed core and lowers priority; unthrottle restores both", () => {
    const { api, log } = fakeApi(0b1111n);
    const handle = createWindowsProcessControl({ loadApi: () => api }).open(7);
    expect(handle.allowedCpuCount?.()).toBe(4);
    handle.throttle();
    expect(handle.allowedCpuCount?.()).toBe(1);
    handle.throttle(); // idempotent
    expect(handle.allowedCpuCount?.()).toBe(1);
    handle.unthrottle();
    expect(handle.allowedCpuCount?.()).toBe(4);
    handle.unthrottle(); // idempotent
    console.info("[windows-control:throttle] calls", log);
    expect(log.filter((line) => line.startsWith("affinity"))).toEqual(["affinity 0b1000", "affinity 0b1111"]);
    expect(log.filter((line) => line.startsWith("priority"))).toEqual(["priority 0x4000", "priority 0x20"]);
  });

  it("restores the mask it had when OPENED, not the system mask", () => {
    const { api, log } = fakeApi(0b0110n);
    const handle = createWindowsProcessControl({ loadApi: () => api }).open(7);
    handle.throttle();
    handle.unthrottle();
    expect(log.filter((line) => line.startsWith("affinity"))).toEqual(["affinity 0b100", "affinity 0b110"]);
  });

  it("close releases the handle once and further use throws", () => {
    const { api, log } = fakeApi();
    const handle = createWindowsProcessControl({ loadApi: () => api }).open(7);
    handle.close();
    handle.close();
    expect(log.filter((line) => line.startsWith("close"))).toHaveLength(1);
    expect(() => handle.suspend()).toThrow(/closed/);
  });

  it("opens even when the affinity is unreadable: suspend / resume work, throttle refuses, unthrottle is a no-op", () => {
    const { api, log } = fakeApi();
    api.getAffinity = () => null;
    const handle = createWindowsProcessControl({ loadApi: () => api }).open(7);
    handle.suspend();
    handle.resume();
    expect(() => handle.throttle()).toThrow(/cannot read the affinity/);
    expect(() => handle.unthrottle()).not.toThrow();
    expect(handle.allowedCpuCount?.()).toBeNull();
    expect(log.filter((line) => line.startsWith("affinity") || line.startsWith("priority"))).toEqual([]);
    expect(log.filter((line) => line === "suspend" || line === "resume")).toEqual(["suspend", "resume"]);
  });

  it("closes the handle when opening fails half way (an api call throws)", () => {
    const { api, log } = fakeApi();
    api.getPriorityClass = () => {
      throw new Error("ffi blew up");
    };
    expect(() => createWindowsProcessControl({ loadApi: () => api }).open(7)).toThrow(/ffi blew up/);
    expect(log).toContain("close 100");
  });

  it("has no per-thread refresh and does not ask for reconciliation", () => {
    const { api } = fakeApi();
    const control = createWindowsProcessControl({ loadApi: () => api });
    expect(control.reconcileMs).toBe(0);
    expect(control.open(7).refresh).toBeUndefined();
  });
});
