import { createRequire } from "node:module";

/**
 * The few kernel32 / ntdll calls this layer needs, behind a typed wrapper over
 * `bun:ffi`. The module is passed in (`createWin32Api(ffi)`), so tests drive the
 * wrapper with a fake and check every argument and struct byte on any OS.
 */

/** A kernel HANDLE as `bun:ffi` hands it out (`ptr` -> number). */
export type Handle = number;

export type BunFfiModule = {
  dlopen: (path: string, symbols: Record<string, { args: readonly string[]; returns: string }>) => { symbols: unknown; close?: () => void };
  /** A live view of native memory (the pending OVERLAPPED of the stop pipe). */
  toArrayBuffer: (ptr: number, byteOffset: number, byteLength: number) => ArrayBuffer;
};

// Access rights (winnt.h).
export const PROCESS_TERMINATE = 0x0001;
export const PROCESS_SET_QUOTA = 0x0100;
export const PROCESS_SET_INFORMATION = 0x0200;
export const PROCESS_QUERY_INFORMATION = 0x0400;
export const PROCESS_SUSPEND_RESUME = 0x0800;
export const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
/** What `AssignProcessToJobObject` needs on the process. */
export const ACCESS_ASSIGN_TO_JOB = PROCESS_SET_QUOTA | PROCESS_TERMINATE;
/** What the PowerShell holder opens a child with: assign it, and read its exit code when the assignment fails. */
export const ACCESS_HOLDER_ASSIGN = ACCESS_ASSIGN_TO_JOB | PROCESS_QUERY_LIMITED_INFORMATION;
/** What suspend / resume / affinity / priority need on the process. */
export const ACCESS_CONTROL = PROCESS_SUSPEND_RESUME | PROCESS_QUERY_INFORMATION | PROCESS_SET_INFORMATION;

// Win32 error codes (winerror.h) and process exit status (winbase.h).
export const ERROR_ACCESS_DENIED = 5;
export const ERROR_INVALID_PARAMETER = 87;
export const STILL_ACTIVE = 259;

export const BELOW_NORMAL_PRIORITY_CLASS = 0x4000;

// Process creation flags (winbase.h).
export const CREATE_NEW_PROCESS_GROUP = 0x0000_0200;
export const CREATE_BREAKAWAY_FROM_JOB = 0x0100_0000;
export const CREATE_NO_WINDOW = 0x0800_0000;

// Job objects (winnt.h).
export const JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x0800;
export const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
/**
 * The limits of the child-lifetime job: kill-on-close, and BREAKAWAY_OK so that a process created WITH
 * CREATE_BREAKAWAY_FROM_JOB (only `spawnSurvivor` asks for it) starts outside the job. Every other child (Node, Bun and
 * Electron never pass that flag) is still a member and still dies with the job. Not SILENT_BREAKAWAY_OK, which would
 * let every child out.
 */
export const CHILD_LIFETIME_JOB_LIMITS = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
export const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9;
/** sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION) on 64-bit Windows (x64 and arm64). */
export const JOBOBJECT_EXTENDED_LIMIT_INFORMATION_SIZE = 144;
/** Offset of `BasicLimitInformation.LimitFlags` in it. */
export const JOBOBJECT_LIMIT_FLAGS_OFFSET = 16;

/** A zeroed JOBOBJECT_EXTENDED_LIMIT_INFORMATION whose only limits are `CHILD_LIFETIME_JOB_LIMITS`. */
export const buildKillOnCloseJobInfo = (): Buffer => {
  const info = Buffer.alloc(JOBOBJECT_EXTENDED_LIMIT_INFORMATION_SIZE);
  info.writeUInt32LE(CHILD_LIFETIME_JOB_LIMITS, JOBOBJECT_LIMIT_FLAGS_OFFSET);
  return info;
};

export const KERNEL32_SYMBOLS = {
  OpenProcess: { args: ["u32", "i32", "u32"], returns: "ptr" },
  CloseHandle: { args: ["ptr"], returns: "i32" },
  GetProcessAffinityMask: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  SetProcessAffinityMask: { args: ["ptr", "u64"], returns: "i32" },
  GetPriorityClass: { args: ["ptr"], returns: "u32" },
  SetPriorityClass: { args: ["ptr", "u32"], returns: "i32" },
  CreateJobObjectW: { args: ["ptr", "ptr"], returns: "ptr" },
  SetInformationJobObject: { args: ["ptr", "i32", "ptr", "u32"], returns: "i32" },
  AssignProcessToJobObject: { args: ["ptr", "ptr"], returns: "i32" },
} as const;

export const NTDLL_SYMBOLS = {
  NtSuspendProcess: { args: ["ptr"], returns: "i32" },
  NtResumeProcess: { args: ["ptr"], returns: "i32" },
} as const;

type Kernel32 = {
  OpenProcess: (access: number, inherit: number, pid: number) => Handle | null;
  CloseHandle: (handle: Handle) => number;
  GetProcessAffinityMask: (handle: Handle, processMask: BigUint64Array, systemMask: BigUint64Array) => number;
  SetProcessAffinityMask: (handle: Handle, mask: bigint) => number;
  GetPriorityClass: (handle: Handle) => number;
  SetPriorityClass: (handle: Handle, priorityClass: number) => number;
  CreateJobObjectW: (attributes: null, name: null) => Handle | null;
  SetInformationJobObject: (job: Handle, infoClass: number, info: Buffer, size: number) => number;
  AssignProcessToJobObject: (job: Handle, process: Handle) => number;
};
type Ntdll = {
  NtSuspendProcess: (handle: Handle) => number;
  NtResumeProcess: (handle: Handle) => number;
};

export type Win32Api = {
  /** A process handle with `access`, or null (gone, or access denied). */
  openProcess: (pid: number, access: number) => Handle | null;
  closeHandle: (handle: Handle) => void;
  /** NTSTATUS; negative is failure. */
  ntSuspendProcess: (handle: Handle) => number;
  ntResumeProcess: (handle: Handle) => number;
  /** Affinity masks of the process and of the system, or null on failure. */
  getAffinity: (handle: Handle) => { process: bigint; system: bigint } | null;
  setAffinity: (handle: Handle, mask: bigint) => boolean;
  /** 0 on failure. */
  getPriorityClass: (handle: Handle) => number;
  setPriorityClass: (handle: Handle, priorityClass: number) => boolean;
  createJobObject: () => Handle | null;
  setKillOnClose: (job: Handle) => boolean;
  assignProcessToJob: (job: Handle, process: Handle) => boolean;
};

export const createWin32Api = (ffi: BunFfiModule): Win32Api => {
  const k = ffi.dlopen("kernel32.dll", KERNEL32_SYMBOLS).symbols as Kernel32;
  const nt = ffi.dlopen("ntdll.dll", NTDLL_SYMBOLS).symbols as Ntdll;
  const handleOrNull = (value: Handle | null): Handle | null => (value ? value : null);
  return {
    openProcess: (pid, access) => handleOrNull(k.OpenProcess(access, 0, pid)),
    closeHandle: (handle) => {
      k.CloseHandle(handle);
    },
    ntSuspendProcess: (handle) => nt.NtSuspendProcess(handle),
    ntResumeProcess: (handle) => nt.NtResumeProcess(handle),
    getAffinity: (handle) => {
      const processMask = new BigUint64Array(1);
      const systemMask = new BigUint64Array(1);
      if (!k.GetProcessAffinityMask(handle, processMask, systemMask)) return null;
      return { process: processMask[0] ?? 0n, system: systemMask[0] ?? 0n };
    },
    setAffinity: (handle, mask) => k.SetProcessAffinityMask(handle, mask) !== 0,
    getPriorityClass: (handle) => k.GetPriorityClass(handle),
    setPriorityClass: (handle, priorityClass) => k.SetPriorityClass(handle, priorityClass) !== 0,
    createJobObject: () => handleOrNull(k.CreateJobObjectW(null, null)),
    setKillOnClose: (job) =>
      k.SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS, buildKillOnCloseJobInfo(), JOBOBJECT_EXTENDED_LIMIT_INFORMATION_SIZE) !== 0,
    assignProcessToJob: (job, process) => k.AssignProcessToJobObject(job, process) !== 0,
  };
};

/**
 * `bun:ffi`, or null when this runtime has none. It is a Bun built-in module,
 * so a static `import "bun:ffi"` would make the whole package unloadable under
 * Electron / Node (the desktop main process) and bundlers would try to resolve
 * it. The runtime selects the implementation instead: the require happens here,
 * inside a function only the process-control / job-object paths call, through
 * `createRequire` so no bundler or type checker sees the specifier.
 */
export const loadBunFfi = (): BunFfiModule | null => {
  try {
    return createRequire(import.meta.url)("bun:ffi") as BunFfiModule;
  } catch {
    return null;
  }
};

let cached: Win32Api | null | undefined;

/** The ffi-backed API, loaded once; null under Node / Electron (no `bun:ffi`). */
export const loadWin32Api = (): Win32Api | null => {
  if (cached === undefined) {
    const ffi = loadBunFfi();
    cached = ffi ? createWin32Api(ffi) : null;
  }
  return cached;
};
