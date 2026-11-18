import { describe, expect, it } from "vitest";
import { createWindowsProcessControl } from "../src/processControl";
import type { Win32Api } from "../src/win32api";

/**
 * What the playback gate (`@space/ffmpeg`) needs from the Windows backend:
 * these cases were the gate's own `createWin32ProcessControl` tests, ported
 * when the Windows backend moved here. The gate counts a throwing
 * `throttle` / `unthrottle` as "not applied" / "still applied", so the
 * handle must leave the process in exactly that state.
 */
describe("windows process control as the playback gate's backend @bugfix @regression-proof", () => {
  const makeApi = (options: { initialMask?: bigint } = {}) => {
    const calls: string[] = [];
    let mask = options.initialMask ?? 0b1111n;
    let priority = 0x20;
    const api: Win32Api = {
      openProcess: (pid) => {
        calls.push(`open:${pid}`);
        return pid === 666 ? null : pid;
      },
      closeHandle: (handle) => void calls.push(`close:${handle}`),
      ntSuspendProcess: (handle) => (calls.push(`NtSuspendProcess:${handle}`), 0),
      ntResumeProcess: (handle) => (calls.push(`NtResumeProcess:${handle}`), 0),
      getAffinity: () => ({ process: mask, system: 0b1111n }),
      setAffinity: (_handle, next) => {
        calls.push(`setmask:${next.toString(2)}`);
        mask = next;
        return true;
      },
      getPriorityClass: () => priority,
      setPriorityClass: (_handle, next) => {
        calls.push(`setpriority:0x${next.toString(16)}`);
        priority = next;
        return true;
      },
      createJobObject: () => null,
      setKillOnClose: () => false,
      assignProcessToJob: () => false,
    };
    return { api, calls, mask: () => mask, priority: () => priority };
  };

  it("NtSuspendProcess / NtResumeProcess on a handle held for the whole life of the child", () => {
    const { api, calls } = makeApi();
    const handle = createWindowsProcessControl({ loadApi: () => api }).open(10);
    handle.suspend();
    handle.resume();
    handle.close();
    console.info("[windows-control:gate] calls =", calls);
    expect(calls).toEqual(["open:10", "NtSuspendProcess:10", "NtResumeProcess:10", "close:10"]);
  });

  it("throttle = the highest allowed core only (plus below-normal priority); unthrottle restores the original mask and priority", () => {
    const { api, calls } = makeApi();
    const handle = createWindowsProcessControl({ loadApi: () => api }).open(10);
    handle.throttle();
    handle.unthrottle();
    expect(calls).toEqual(["open:10", "setmask:1000", "setpriority:0x4000", "setmask:1111", "setpriority:0x20"]);
  });

  it("a process that cannot be opened is an error the gate logs", () => {
    const { api } = makeApi();
    expect(() => createWindowsProcessControl({ loadApi: () => api }).open(666)).toThrow(/cannot open process 666/);
  });

  it("a failing NtSuspendProcess (negative NTSTATUS) is an error", () => {
    const { api } = makeApi();
    api.ntSuspendProcess = () => 0xc0000022 | 0;
    const handle = createWindowsProcessControl({ loadApi: () => api }).open(10);
    expect(() => handle.suspend()).toThrow(/NtSuspendProcess/);
  });

  it("a failing NtResumeProcess is an error and a retry runs the resume again", () => {
    const { api, calls } = makeApi();
    let status = 0xc0000022 | 0;
    api.ntResumeProcess = () => (calls.push("NtResumeProcess"), status);
    const handle = createWindowsProcessControl({ loadApi: () => api }).open(10);
    handle.suspend();
    expect(() => handle.resume()).toThrow(/NtResumeProcess/);
    status = 0;
    handle.resume();
    expect(calls.filter((call) => call === "NtResumeProcess")).toHaveLength(2);
  });

  it("a throttle whose affinity call fails changes nothing and can be retried", () => {
    const { api, calls, mask } = makeApi();
    let ok = false;
    api.setAffinity = (_handle, next) => {
      calls.push(`setmask:${next.toString(2)}`);
      return ok;
    };
    const handle = createWindowsProcessControl({ loadApi: () => api }).open(10);
    expect(() => handle.throttle()).toThrow(/SetProcessAffinityMask/);
    expect(mask()).toBe(0b1111n);
    ok = true;
    handle.throttle();
    expect(calls.filter((call) => call.startsWith("setmask"))).toEqual(["setmask:1000", "setmask:1000"]);
  });

  it("a throttle whose priority call fails gives the affinity back, so the gate's 'not throttled' is true", () => {
    const { api, calls, mask } = makeApi({ initialMask: 0b0110n });
    let ok = false;
    api.setPriorityClass = () => ok;
    const handle = createWindowsProcessControl({ loadApi: () => api }).open(10);
    expect(() => handle.throttle()).toThrow(/SetPriorityClass/);
    expect(mask()).toBe(0b0110n);
    expect(calls.filter((call) => call.startsWith("setmask"))).toEqual(["setmask:100", "setmask:110"]);
    // The gate never unthrottles a child it counts as not throttled; a later throttle starts clean.
    ok = true;
    handle.throttle();
    expect(mask()).toBe(0b0100n);
  });

  it("a failed unthrottle leaves the handle throttled so the gate's retry restores the cores", () => {
    const { api, mask } = makeApi();
    const handle = createWindowsProcessControl({ loadApi: () => api }).open(10);
    handle.throttle();
    const setAffinity = api.setAffinity;
    api.setAffinity = () => false;
    expect(() => handle.unthrottle()).toThrow(/restoring the original cores/);
    expect(mask()).toBe(0b1000n);
    api.setAffinity = setAffinity;
    handle.unthrottle();
    expect(mask()).toBe(0b1111n);
  });

  it("a failed priority restore also stays retryable", () => {
    const { api, priority } = makeApi();
    const handle = createWindowsProcessControl({ loadApi: () => api }).open(10);
    handle.throttle();
    const setPriorityClass = api.setPriorityClass;
    api.setPriorityClass = () => false;
    expect(() => handle.unthrottle()).toThrow(/restoring the original priority/);
    api.setPriorityClass = setPriorityClass;
    handle.unthrottle();
    expect(priority()).toBe(0x20);
  });

  it("an unreadable priority class is left alone: only the affinity is throttled and restored", () => {
    const { api, calls } = makeApi();
    api.getPriorityClass = () => 0;
    const handle = createWindowsProcessControl({ loadApi: () => api }).open(10);
    handle.throttle();
    handle.unthrottle();
    expect(calls.filter((call) => call.startsWith("setpriority"))).toEqual([]);
    expect(calls.filter((call) => call.startsWith("setmask"))).toEqual(["setmask:1000", "setmask:1111"]);
  });

  it("a gate-style loop (throttle, pause, resume, full) leaves the process as it found it", () => {
    const { api, mask, priority } = makeApi({ initialMask: 0b11111111n });
    const handle = createWindowsProcessControl({ loadApi: () => api }).open(10);
    handle.throttle();
    handle.suspend();
    handle.resume();
    handle.unthrottle();
    handle.close();
    expect(mask()).toBe(0b11111111n);
    expect(priority()).toBe(0x20);
  });
});
