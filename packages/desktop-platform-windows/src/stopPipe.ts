import type { BunFfiModule } from "./win32api";

/**
 * The server end of the graceful-stop pipe, created through `CreateNamedPipeW`
 * so it can be hardened in ways `node:net`'s pipe server cannot be:
 *
 *  - `FILE_FLAG_FIRST_PIPE_INSTANCE`: creating a name another process already
 *    holds fails instead of joining it, so a squatter is noticed, not silently
 *    served.
 *  - an owner-only DACL (`D:P(A;;GA;;;OW)`: protected, one ACE, "owner rights"):
 *    no other account can connect and so cannot make the process drain.
 *  - `PIPE_REJECT_REMOTE_CLIENTS`: the pipe is local to this machine.
 *
 * Connections are accepted with one overlapped `ConnectNamedPipe` whose
 * completion status is polled from native memory, so no thread blocks and no
 * `GetLastError` (unreliable across `bun:ffi` calls) is needed.
 */

export const PIPE_ACCESS_DUPLEX = 0x00000003;
export const FILE_FLAG_FIRST_PIPE_INSTANCE = 0x00080000;
export const FILE_FLAG_OVERLAPPED = 0x40000000;
export const PIPE_REJECT_REMOTE_CLIENTS = 0x00000008;
/** `INVALID_HANDLE_VALUE` as a u64. */
export const INVALID_HANDLE_VALUE = 0xffffffffffffffffn;
export const STATUS_PENDING = 0x00000103;
/**
 * The client was already connected when the listen started: still a connection.
 * Windows may report that synchronously (return FALSE, status never written), in
 * which case the seeded STATUS_PENDING stays and this pipe never sees the client.
 * Only a client that connects between `CreateNamedPipeW` and the first
 * `ConnectNamedPipe` (microseconds, before the owner's marker exists, so no
 * stopper can be it) hits that, and it can only wedge the pipe of its own user.
 */
export const STATUS_PIPE_CONNECTED = 0xc00000b2;
/** SDDL revision 1. */
const SDDL_REVISION_1 = 1;
const LPTR = 0x0040;
/** sizeof(OVERLAPPED) on 64-bit Windows; `Internal` (the status) is the first field. */
const OVERLAPPED_SIZE = 32;
/** sizeof(SECURITY_ATTRIBUTES) on 64-bit Windows. */
const SECURITY_ATTRIBUTES_SIZE = 24;
const PIPE_BUFFER_BYTES = 512;
/** How often the pending connect is checked; bounds the latency of a stop request. */
const POLL_INTERVAL_MS = 100;

export const STOP_PIPE_SDDL = "D:P(A;;GA;;;OW)";

const KERNEL32_SYMBOLS = {
  CreateNamedPipeW: { args: ["ptr", "u32", "u32", "u32", "u32", "u32", "u32", "ptr"], returns: "u64" },
  ConnectNamedPipe: { args: ["u64", "ptr"], returns: "i32" },
  DisconnectNamedPipe: { args: ["u64"], returns: "i32" },
  CancelIoEx: { args: ["u64", "ptr"], returns: "i32" },
  CloseHandle: { args: ["u64"], returns: "i32" },
  LocalAlloc: { args: ["u32", "u64"], returns: "ptr" },
  LocalFree: { args: ["u64"], returns: "u64" },
} as const;

const ADVAPI32_SYMBOLS = {
  ConvertStringSecurityDescriptorToSecurityDescriptorW: { args: ["ptr", "u32", "ptr", "ptr"], returns: "i32" },
} as const;

type Kernel32 = {
  CreateNamedPipeW: (name: Buffer, openMode: number, pipeMode: number, maxInstances: number, outBuffer: number, inBuffer: number, timeout: number, attributes: Buffer) => bigint;
  ConnectNamedPipe: (pipe: bigint, overlapped: number) => number;
  DisconnectNamedPipe: (pipe: bigint) => number;
  CancelIoEx: (pipe: bigint, overlapped: number) => number;
  CloseHandle: (pipe: bigint) => number;
  LocalAlloc: (flags: number, bytes: number) => number;
  LocalFree: (memory: bigint | number) => unknown;
};
type Advapi32 = {
  ConvertStringSecurityDescriptorToSecurityDescriptorW: (sddl: Buffer, revision: number, descriptor: BigUint64Array, size: null) => number;
};

export type OpenStopPipeResult = { ok: true; close: () => void } | { ok: false; reason: string };

const wide = (value: string): Buffer => Buffer.from(`${value}\0`, "utf16le");

/**
 * Create the stop pipe `name` and call `onConnection` once per client that
 * connects. Never throws: a name that is taken or an API that fails is a
 * `{ ok: false, reason }`. `pollIntervalMs` is a test seam (a slow poll keeps a
 * connected client connected long enough to inspect the pipe). The timer is unref'd, so the pipe never keeps the
 * process alive.
 */
export const openStopPipe = (ffi: BunFfiModule, name: string, onConnection: () => void, pollIntervalMs: number = POLL_INTERVAL_MS): OpenStopPipeResult => {
  const kernel = ffi.dlopen("kernel32.dll", KERNEL32_SYMBOLS).symbols as Kernel32;
  const advapi = ffi.dlopen("advapi32.dll", ADVAPI32_SYMBOLS).symbols as Advapi32;

  const descriptor = new BigUint64Array(1);
  if (!advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW(wide(STOP_PIPE_SDDL), SDDL_REVISION_1, descriptor, null)) {
    return { ok: false, reason: "could not build the owner-only security descriptor" };
  }
  const attributes = Buffer.alloc(SECURITY_ATTRIBUTES_SIZE);
  attributes.writeUInt32LE(SECURITY_ATTRIBUTES_SIZE, 0);
  attributes.writeBigUInt64LE(descriptor[0] ?? 0n, 8);
  const pipe = kernel.CreateNamedPipeW(
    wide(name),
    PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
    PIPE_REJECT_REMOTE_CLIENTS,
    1,
    PIPE_BUFFER_BYTES,
    PIPE_BUFFER_BYTES,
    0,
    attributes
  );
  // The pipe keeps its own copy of the descriptor.
  kernel.LocalFree(descriptor[0] ?? 0n);
  if (pipe === INVALID_HANDLE_VALUE) {
    return { ok: false, reason: "CreateNamedPipeW failed: the name is held by another process (first instance refused) or access was denied" };
  }

  let overlapped = 0;
  let status: DataView | null = null;
  const listen = () => {
    overlapped = kernel.LocalAlloc(LPTR, OVERLAPPED_SIZE);
    status = new DataView(ffi.toArrayBuffer(overlapped, 0, OVERLAPPED_SIZE));
    // The kernel overwrites this with the real status; seeding it keeps a call that never reached the driver from reading as success.
    status.setUint32(0, STATUS_PENDING, true);
    kernel.ConnectNamedPipe(pipe, overlapped);
  };
  const poll = () => {
    if (!status) return;
    const result = status.getUint32(0, true);
    if (result === STATUS_PENDING) return;
    kernel.LocalFree(overlapped);
    kernel.DisconnectNamedPipe(pipe);
    listen();
    if (result === 0 || result === STATUS_PIPE_CONNECTED) onConnection();
  };
  listen();
  const timer = setInterval(poll, pollIntervalMs);
  timer.unref();

  let closed = false;
  return {
    ok: true,
    close: () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      kernel.CancelIoEx(pipe, overlapped);
      kernel.CloseHandle(pipe);
      // The pending OVERLAPPED block is deliberately not freed: the kernel completes the cancelled
      // connect into it, and 32 bytes once per uninstall is cheaper than a use-after-free.
    },
  };
};
