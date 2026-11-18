import { describe, expect, it } from "vitest";
import {
  ACCESS_ASSIGN_TO_JOB,
  ACCESS_CONTROL,
  buildKillOnCloseJobInfo,
  CHILD_LIFETIME_JOB_LIMITS,
  createWin32Api,
  JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION_SIZE,
  KERNEL32_SYMBOLS,
  loadBunFfi,
  NTDLL_SYMBOLS,
  type BunFfiModule,
} from "../src/win32api";

type Call = { fn: string; args: unknown[] };

/** A fake `bun:ffi`: every symbol records its call and answers from `answers`. */
const fakeFfi = (answers: Record<string, (...args: never[]) => unknown> = {}) => {
  const calls: Call[] = [];
  const opened: string[] = [];
  const ffi: BunFfiModule = {
    dlopen: (path, defs) => {
      opened.push(path);
      const symbols: Record<string, (...args: unknown[]) => unknown> = {};
      for (const name of Object.keys(defs)) {
        symbols[name] = (...args: unknown[]) => {
          calls.push({ fn: name, args });
          return answers[name] ? (answers[name] as (...a: unknown[]) => unknown)(...args) : 1;
        };
      }
      return { symbols };
    },
    toArrayBuffer: () => {
      throw new Error("the win32 api wrapper reads no native memory");
    },
  };
  return { ffi, calls, opened };
};

describe("job object struct", () => {
  it("is a zeroed 144-byte JOBOBJECT_EXTENDED_LIMIT_INFORMATION with only KILL_ON_JOB_CLOSE | BREAKAWAY_OK at LimitFlags", () => {
    const info = buildKillOnCloseJobInfo();
    console.info("[windows-win32api:jobinfo] size=%d flags@16=0x%s", info.length, info.readUInt32LE(16).toString(16));
    expect(JOBOBJECT_EXTENDED_LIMIT_INFORMATION_SIZE).toBe(144);
    expect(info.length).toBe(144);
    expect(info.readUInt32LE(16)).toBe(CHILD_LIFETIME_JOB_LIMITS);
    expect(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE).toBe(0x2000);
    // BREAKAWAY_OK only lets a child that asks (CREATE_BREAKAWAY_FROM_JOB, spawnSurvivor) leave; not SILENT_BREAKAWAY_OK.
    expect(CHILD_LIFETIME_JOB_LIMITS).toBe(0x2800);
    const rest = Buffer.from(info);
    rest.writeUInt32LE(0, 16);
    expect(rest.every((byte) => byte === 0)).toBe(true);
  });
});

describe("ffi symbol tables", () => {
  it("declare the kernel32 / ntdll signatures used by the wrapper", () => {
    expect(Object.keys(KERNEL32_SYMBOLS).sort()).toEqual(
      ["AssignProcessToJobObject", "CloseHandle", "CreateJobObjectW", "GetPriorityClass", "GetProcessAffinityMask", "OpenProcess", "SetInformationJobObject", "SetPriorityClass", "SetProcessAffinityMask"]
    );
    expect(Object.keys(NTDLL_SYMBOLS).sort()).toEqual(["NtResumeProcess", "NtSuspendProcess"]);
    expect(KERNEL32_SYMBOLS.OpenProcess).toEqual({ args: ["u32", "i32", "u32"], returns: "ptr" });
    expect(KERNEL32_SYMBOLS.SetInformationJobObject.args).toEqual(["ptr", "i32", "ptr", "u32"]);
  });
});

describe("createWin32Api over a fake ffi", () => {
  it("opens kernel32 and ntdll", () => {
    const { ffi, opened } = fakeFfi();
    createWin32Api(ffi);
    expect(opened).toEqual(["kernel32.dll", "ntdll.dll"]);
  });

  it("openProcess passes access / pid and maps a null handle to null", () => {
    const { ffi, calls } = fakeFfi({ OpenProcess: ((_a: number, _i: number, pid: number) => (pid === 1 ? null : 77)) as never });
    const api = createWin32Api(ffi);
    expect(api.openProcess(5, ACCESS_CONTROL)).toBe(77);
    expect(api.openProcess(1, ACCESS_CONTROL)).toBeNull();
    expect(calls[0]).toEqual({ fn: "OpenProcess", args: [ACCESS_CONTROL, 0, 5] });
  });

  it("suspend / resume return the NTSTATUS", () => {
    const { ffi, calls } = fakeFfi({ NtSuspendProcess: (() => 0) as never, NtResumeProcess: (() => -1073741790) as never });
    const api = createWin32Api(ffi);
    expect(api.ntSuspendProcess(9)).toBe(0);
    expect(api.ntResumeProcess(9)).toBe(-1073741790);
    expect(calls.map((call) => call.fn)).toEqual(["NtSuspendProcess", "NtResumeProcess"]);
  });

  it("getAffinity reads both masks from the out buffers; a failed call is null", () => {
    const fill = ((_h: number, processMask: BigUint64Array, systemMask: BigUint64Array) => {
      processMask[0] = 0b1010n;
      systemMask[0] = 0b1111n;
      return 1;
    }) as never;
    const api = createWin32Api(fakeFfi({ GetProcessAffinityMask: fill }).ffi);
    expect(api.getAffinity(3)).toEqual({ process: 0b1010n, system: 0b1111n });
    expect(createWin32Api(fakeFfi({ GetProcessAffinityMask: (() => 0) as never }).ffi).getAffinity(3)).toBeNull();
  });

  it("setAffinity / priority pass bigint masks and classes", () => {
    const { ffi, calls } = fakeFfi({ GetPriorityClass: (() => 0x20) as never });
    const api = createWin32Api(ffi);
    expect(api.setAffinity(4, 1n << 63n)).toBe(true);
    expect(api.getPriorityClass(4)).toBe(0x20);
    expect(api.setPriorityClass(4, 0x4000)).toBe(true);
    expect(calls).toEqual([
      { fn: "SetProcessAffinityMask", args: [4, 1n << 63n] },
      { fn: "GetPriorityClass", args: [4] },
      { fn: "SetPriorityClass", args: [4, 0x4000] },
    ]);
  });

  it("job calls: CreateJobObjectW(NULL, NULL), kill-on-close via class 9 with the 144-byte struct, assign", () => {
    const { ffi, calls } = fakeFfi({ CreateJobObjectW: (() => 500) as never });
    const api = createWin32Api(ffi);
    const job = api.createJobObject();
    expect(job).toBe(500);
    expect(api.setKillOnClose(job!)).toBe(true);
    expect(api.assignProcessToJob(job!, 600)).toBe(true);
    expect(calls[0]).toEqual({ fn: "CreateJobObjectW", args: [null, null] });
    const set = calls[1]!;
    expect(set.fn).toBe("SetInformationJobObject");
    expect(set.args[0]).toBe(500);
    expect(set.args[1]).toBe(9);
    expect(Buffer.isBuffer(set.args[2]) && (set.args[2] as Buffer).readUInt32LE(16)).toBe(0x2800);
    expect(set.args[3]).toBe(144);
    expect(calls[2]).toEqual({ fn: "AssignProcessToJobObject", args: [500, 600] });
    expect(ACCESS_ASSIGN_TO_JOB).toBe(0x0101);
  });
});

describe("loadBunFfi", () => {
  it("returns a module under Bun and null elsewhere, never throws", () => {
    const ffi = loadBunFfi();
    console.info("[windows-win32api:loadBunFfi] bun:ffi available =", ffi !== null);
    expect(ffi === null || typeof ffi.dlopen === "function").toBe(true);
  });
});
