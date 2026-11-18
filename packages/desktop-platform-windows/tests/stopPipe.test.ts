import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FILE_FLAG_FIRST_PIPE_INSTANCE,
  FILE_FLAG_OVERLAPPED,
  INVALID_HANDLE_VALUE,
  openStopPipe,
  PIPE_ACCESS_DUPLEX,
  PIPE_REJECT_REMOTE_CLIENTS,
  STATUS_PENDING,
  STATUS_PIPE_CONNECTED,
  STOP_PIPE_SDDL,
} from "../src/stopPipe";
import type { BunFfiModule } from "../src/win32api";

type Call = { fn: string; args: unknown[] };

const PIPE = 0x1234n;
const DESCRIPTOR = 0x5000n;
const wide = (value: unknown): string => (Buffer.isBuffer(value) ? value.toString("utf16le").replace(/\0$/, "") : String(value));

/** A fake `bun:ffi`: kernel32 / advapi32 calls are recorded, the OVERLAPPED blocks are real memory the test can complete. */
const fakeKernel = (options: { sddlFails?: boolean; pipeFails?: boolean } = {}) => {
  const calls: Call[] = [];
  const memory = new Map<number, ArrayBuffer>();
  let nextBlock = 0x9000;
  const answers: Record<string, (...args: unknown[]) => unknown> = {
    ConvertStringSecurityDescriptorToSecurityDescriptorW: (_sddl, _revision, out) => {
      if (options.sddlFails) return 0;
      (out as BigUint64Array)[0] = DESCRIPTOR;
      return 1;
    },
    CreateNamedPipeW: () => (options.pipeFails ? INVALID_HANDLE_VALUE : PIPE),
    LocalAlloc: () => {
      const address = nextBlock;
      nextBlock += 0x100;
      memory.set(address, new ArrayBuffer(32));
      return address;
    },
  };
  const ffi: BunFfiModule = {
    dlopen: (_path, defs) => {
      const symbols: Record<string, (...args: unknown[]) => unknown> = {};
      for (const name of Object.keys(defs)) {
        symbols[name] = (...args: unknown[]) => {
          calls.push({ fn: name, args });
          return answers[name] ? answers[name]!(...args) : 1;
        };
      }
      return { symbols };
    },
    toArrayBuffer: (ptr) => {
      const block = memory.get(ptr);
      if (!block) throw new Error(`no native block at ${ptr}`);
      return block;
    },
  };
  const named = (fn: string) => calls.filter((call) => call.fn === fn);
  const blockStatus = (address: number) => new DataView(memory.get(address)!).getUint32(0, true);
  const complete = (address: number, status: number) => new DataView(memory.get(address)!).setUint32(0, status, true);
  return { ffi, calls, named, blockStatus, complete };
};

describe("openStopPipe", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates the pipe as the first instance, overlapped, owner-only and closed to remote clients", () => {
    const kernel = fakeKernel();
    const opened = openStopPipe(kernel.ffi, "\\\\.\\pipe\\sf-stop-42", () => {});
    const sddl = kernel.named("ConvertStringSecurityDescriptorToSecurityDescriptorW")[0]!;
    const create = kernel.named("CreateNamedPipeW")[0]!;
    console.info("[windows-stop-pipe:create] sddl=%s name=%s open=0x%s mode=0x%s", wide(sddl.args[0]), wide(create.args[0]), String(create.args[1]), String(create.args[2]));
    expect(opened.ok).toBe(true);
    expect(wide(sddl.args[0])).toBe(STOP_PIPE_SDDL);
    expect(STOP_PIPE_SDDL).toBe("D:P(A;;GA;;;OW)");
    expect(sddl.args[1]).toBe(1);
    expect(wide(create.args[0])).toBe("\\\\.\\pipe\\sf-stop-42");
    expect(create.args[1]).toBe(PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE);
    expect(Number(create.args[2]) & PIPE_REJECT_REMOTE_CLIENTS).toBe(PIPE_REJECT_REMOTE_CLIENTS);
    expect(create.args[3]).toBe(1);
    const attributes = create.args[7] as Buffer;
    expect(attributes.readUInt32LE(0)).toBe(24);
    expect(attributes.readBigUInt64LE(8)).toBe(DESCRIPTOR);
    expect(attributes.readUInt32LE(16)).toBe(0);
    // The pipe copies the descriptor, so the converted one is released right after creation.
    expect(kernel.named("LocalFree")[0]!.args[0]).toBe(DESCRIPTOR);
  });

  it("waits for a client with a pending overlapped connect and fires once per connection", () => {
    const kernel = fakeKernel();
    const onConnection = vi.fn();
    openStopPipe(kernel.ffi, "pipe", onConnection);
    const first = kernel.named("ConnectNamedPipe")[0]!;
    expect(first.args[0]).toBe(PIPE);
    const block = first.args[1] as number;
    expect(kernel.blockStatus(block)).toBe(STATUS_PENDING);

    vi.advanceTimersByTime(1000);
    expect(onConnection).not.toHaveBeenCalled();

    kernel.complete(block, 0);
    vi.advanceTimersByTime(1000);
    console.info("[windows-stop-pipe:connect] fired=%d connects=%d disconnects=%d", onConnection.mock.calls.length, kernel.named("ConnectNamedPipe").length, kernel.named("DisconnectNamedPipe").length);
    expect(onConnection).toHaveBeenCalledTimes(1);
    expect(kernel.named("DisconnectNamedPipe")).toHaveLength(1);
    const second = kernel.named("ConnectNamedPipe")[1]!;
    expect(second.args[1]).not.toBe(block);
    expect(kernel.named("LocalFree").some((call) => call.args[0] === block)).toBe(true);

    kernel.complete(second.args[1] as number, STATUS_PIPE_CONNECTED);
    vi.advanceTimersByTime(1000);
    expect(onConnection).toHaveBeenCalledTimes(2);
  });

  it("re-arms without firing when the connect failed (cancelled, broken pipe)", () => {
    const kernel = fakeKernel();
    const onConnection = vi.fn();
    openStopPipe(kernel.ffi, "pipe", onConnection);
    kernel.complete(kernel.named("ConnectNamedPipe")[0]!.args[1] as number, 0xc0000120);
    vi.advanceTimersByTime(1000);
    expect(onConnection).not.toHaveBeenCalled();
    expect(kernel.named("ConnectNamedPipe")).toHaveLength(2);
  });

  it("reports a taken name or access error as unavailable, without throwing", () => {
    const kernel = fakeKernel({ pipeFails: true });
    const opened = openStopPipe(kernel.ffi, "\\\\.\\pipe\\sf-stop-42", () => {});
    console.info("[windows-stop-pipe:taken] %s", JSON.stringify(opened));
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.reason).toMatch(/CreateNamedPipeW.*first instance/);
    expect(kernel.named("ConnectNamedPipe")).toHaveLength(0);
    expect(kernel.named("LocalFree").map((call) => call.args[0])).toEqual([DESCRIPTOR]);
  });

  it("never creates a pipe it cannot restrict to its owner", () => {
    const kernel = fakeKernel({ sddlFails: true });
    const opened = openStopPipe(kernel.ffi, "pipe", () => {});
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.reason).toMatch(/security descriptor/);
    expect(kernel.named("CreateNamedPipeW")).toHaveLength(0);
  });

  it("close cancels the pending connect, closes the pipe, stops polling and is idempotent", () => {
    const kernel = fakeKernel();
    const onConnection = vi.fn();
    const opened = openStopPipe(kernel.ffi, "pipe", onConnection);
    if (!opened.ok) throw new Error("expected an open pipe");
    const block = kernel.named("ConnectNamedPipe")[0]!.args[1];
    opened.close();
    opened.close();
    expect(kernel.named("CancelIoEx")).toEqual([{ fn: "CancelIoEx", args: [PIPE, block] }]);
    expect(kernel.named("CloseHandle")).toEqual([{ fn: "CloseHandle", args: [PIPE] }]);
    const before = kernel.calls.length;
    kernel.complete(block as number, 0);
    vi.advanceTimersByTime(5000);
    expect(kernel.calls.length).toBe(before);
    expect(onConnection).not.toHaveBeenCalled();
  });
});
