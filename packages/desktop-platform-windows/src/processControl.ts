import type { ProcessControlBackend, ProcessHandle } from "@space/desktop-platform-contract";
import { ACCESS_CONTROL, BELOW_NORMAL_PRIORITY_CLASS, loadWin32Api, type Handle, type Win32Api } from "./win32api";

/**
 * Windows process control (the playback gate's backend), through `bun:ffi`:
 *  - suspend / resume = `NtSuspendProcess` / `NtResumeProcess` (every thread of
 *    the process; the kernel counts, so this layer keeps the handle idempotent);
 *  - throttle = affinity confined to ONE core (the highest the process may run
 *    on, as the Linux backend picks the last) plus a below-normal priority class;
 *    unthrottle gives back the affinity mask and priority the process had when it
 *    was opened. Threads created later inherit the process affinity, so there is
 *    nothing to `refresh`. A throttle that does not fully apply is undone, and an
 *    unthrottle that fails keeps the handle throttled (the gate retries it).
 * Only the process itself is controlled, not its descendants (mpv and ffmpeg
 * are single processes on Windows).
 *
 * Needs `bun:ffi`: under Node / Electron `open` throws.
 */

/** Index of the highest set bit of `mask`, or null when it is empty. */
export const highestSetBit = (mask: bigint): number | null => {
  if (mask <= 0n) return null;
  return mask.toString(2).length - 1;
};

/** Number of set bits of `mask`. */
export const countSetBits = (mask: bigint): number => {
  let count = 0;
  for (let rest = mask; rest > 0n; rest >>= 1n) if (rest & 1n) count += 1;
  return count;
};

export const NO_FFI_MESSAGE =
  "Windows process control (suspend / resume / throttle) needs bun:ffi, which this runtime (Node / Electron) does not have; run it in the Bun runtime";

const hex = (status: number): string => `0x${(status >>> 0).toString(16).padStart(8, "0")}`;

export type WindowsProcessControlDeps = {
  /** The Win32 API, or null when the runtime has no `bun:ffi`. */
  loadApi: () => Win32Api | null;
};

export const createWindowsProcessControl = (overrides: Partial<WindowsProcessControlDeps> = {}): ProcessControlBackend => {
  const loadApi = overrides.loadApi ?? loadWin32Api;
  return {
    name: "windows",
    throttleKind: "one-core",
    reconcileMs: 0,
    open: (pid): ProcessHandle => {
      const api = loadApi();
      if (!api) throw new Error(NO_FFI_MESSAGE);
      const handle: Handle | null = api.openProcess(pid, ACCESS_CONTROL);
      if (handle === null) throw new Error(`cannot open process ${pid} for control (it exited or access was denied)`);
      let closed = false;
      try {
        // Unreadable affinity does not make the handle unusable: suspend / resume
        // still work, throttle refuses (nothing to restore to) and unthrottle is a no-op.
        const original = api.getAffinity(handle);
        const originalPriority = api.getPriorityClass(handle);
        let suspended = false;
        let throttled = false;

        const live = (): Handle => {
          if (closed) throw new Error(`process control handle for ${pid} is closed`);
          return handle;
        };

        return {
          suspend: () => {
            const h = live();
            if (suspended) return;
            const status = api.ntSuspendProcess(h);
            if (status < 0) throw new Error(`NtSuspendProcess(${pid}) failed: ${hex(status)}`);
            suspended = true;
          },
          resume: () => {
            const h = live();
            if (!suspended) return;
            const status = api.ntResumeProcess(h);
            if (status < 0) throw new Error(`NtResumeProcess(${pid}) failed: ${hex(status)}`);
            suspended = false;
          },
          // `throttled` flips only once the whole throttle held: the gate counts a
          // throwing throttle as "not throttled" and never unthrottles it, so a
          // half-applied throttle is undone here.
          throttle: () => {
            const h = live();
            if (throttled) return;
            if (!original) throw new Error(`cannot read the affinity of process ${pid}`);
            const core = highestSetBit(original.process);
            if (core === null) throw new Error(`process ${pid} has an empty affinity mask`);
            if (!api.setAffinity(h, 1n << BigInt(core))) throw new Error(`SetProcessAffinityMask(${pid}) failed`);
            if (originalPriority !== 0 && !api.setPriorityClass(h, BELOW_NORMAL_PRIORITY_CLASS)) {
              api.setAffinity(h, original.process);
              throw new Error(`SetPriorityClass(${pid}) failed`);
            }
            throttled = true;
          },
          // `throttled` stays true while a restore fails, so the gate's retry runs again.
          unthrottle: () => {
            const h = live();
            if (!throttled || !original) return;
            if (!api.setAffinity(h, original.process)) throw new Error(`SetProcessAffinityMask(${pid}) failed restoring the original cores`);
            if (originalPriority !== 0 && !api.setPriorityClass(h, originalPriority)) {
              throw new Error(`SetPriorityClass(${pid}) failed restoring the original priority`);
            }
            throttled = false;
          },
          allowedCpuCount: () => {
            const masks = api.getAffinity(live());
            return masks ? countSetBits(masks.process) : null;
          },
          close: () => {
            if (closed) return;
            closed = true;
            api.closeHandle(handle);
          },
        };
      } catch (error) {
        closed = true;
        api.closeHandle(handle);
        throw error;
      }
    },
  };
};
