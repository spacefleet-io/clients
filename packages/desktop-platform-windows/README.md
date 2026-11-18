# @space/desktop-platform-windows

Windows implementation of `@space/desktop-platform-contract`: `.exe` binary
names and `PATH` library dirs, `%LOCALAPPDATA%` paths, `\\.\pipe\` mpv IPC,
`taskkill /T` process trees, a `\\.\pipe\sf-stop-<pid>` graceful stop (SIGTERM
would be a forced kill), `NtSuspendProcess` / affinity / priority process
control and a Job Object (kill-on-close) child lifetime through `bun:ffi`
(PowerShell holder under Electron/Node), PowerShell/CIM command lines, GPU
vendor and diagnostics, AppUserModelId shell hook. Hardware encoders are tried
in the order `[amf, qsv, nvenc]`; the mpv window uses the `gpu` video output.
`processes.withoutInheritedHandles` is the identity: Bun/libuv pass a child only
its stdio table (conformance `process-no-inherited-sockets`, verified on the VM).

## Child lifetime: Job Object kill-on-close

`src/childLifetime.ts`. A child (encoder, mpv) must die with the process that
spawned it. A Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` terminates
every process in it, and the descendants they spawn, when the last handle to the
job closes; the kernel closes a dead process's handles, so it holds however the
parent dies (crash, `taskkill /F`). `wrap` is the identity (nothing can be set up
before the child exists); `afterSpawn(pid)` assigns the child to the job right
after the spawn. A failed assignment is logged as a warning, never thrown.

## bun:ffi, and the fallback

`bun:ffi` (`src/win32api.ts`: a typed wrapper over kernel32 / ntdll) is the
primary mechanism and is loaded lazily, never at import, so the package loads
under Electron/Node.

- **Bun** (the runtime): one in-process job object, created on first use and
  never closed; `afterSpawn` opens the child and assigns it.
- **Electron / Node** (no `bun:ffi`): one hidden PowerShell "holder" owns the job
  (the same calls through P/Invoke) and reads child pids from its stdin. Its
  stdin pipe is held only by the spawning process, so when that process dies the
  pipe closes, the holder exits, and the job closes with it. Started on the
  first assignment, restarted if it died. `childLifetime.supported()` is true
  when the job could be created (Bun) or PowerShell runs (fallback). The holder
  answers each pid `assigned`, `exited` (the child ended before the holder
  reached it, typically a short ffprobe while PowerShell was still starting:
  logged at info, nothing can outlive a dead child), or
  `open-failed` / `assign-failed <pid> <win32 error>` (a live child the job
  refused: a warning). It runs with `$ProgressPreference = 'SilentlyContinue'`,
  since Windows PowerShell 5.1 writes a progress record as CLIXML to a piped
  stderr; a real CLIXML error on that stderr is decoded and logged as a warning.
- **Survivors** (`childLifetime.spawnSurvivor`): the job's limits are
  KILL_ON_JOB_CLOSE plus BREAKAWAY_OK (not SILENT_BREAKAWAY_OK), so a child
  leaves the job only when it is created with CREATE_BREAKAWAY_FROM_JOB, which
  nothing but `spawnSurvivor` asks for. It runs a short PowerShell launcher
  (CreateProcessW: breakaway, own process group, no window, no inherited
  handle, the given environment) and logs `child_lifetime.survivor` at info with
  `outsideJob: true`. An enclosing job that refuses breakaway (ERROR_ACCESS_DENIED)
  still gets the process started, inside the jobs, with a warning. Used by the
  Badger e2e harness so its `docker compose down` outlives a worker that dies.
- **Process control** (`src/processControl.ts`: `NtSuspendProcess` /
  `NtResumeProcess`, affinity confined to one core plus below-normal priority,
  and their restoration) has no fallback: it needs `bun:ffi`, so under
  Node/Electron `processes.control.open` throws an error naming `bun:ffi`. It is
  what the playback gate drives, so a throttle or unthrottle that throws leaves
  the process as the gate assumes: a throttle whose priority call fails gives
  the affinity back, a failed restore stays throttled so the retry runs again,
  and a process whose affinity cannot be read still opens (suspend / resume
  work, throttle throws, unthrottle does nothing).

## Graceful stop on Windows

`src/gracefulStop.ts`, `src/stopPipe.ts`. `process.kill(pid, 'SIGTERM')` is
`TerminateProcess` on Windows: no handler runs, so the runtime's drain would be
skipped. `install(onRequest, onUnavailable?)` (the runtime, under Bun) listens on
the named pipe `\\.\pipe\sf-stop-<pid>` and treats any connection as the request
(Ctrl+C still arrives as SIGINT). The pipe is created with `CreateNamedPipeW`:
first instance only (a held name is refused), an owner-only protected DACL
(`D:P(A;;GA;;;OW)`) and no remote clients. `request(pid)` (the guardian) delivers
only when the owner left its marker file in `%LOCALAPPDATA%\SpaceFleet\stop-pipes`
and the pipe then opens (synchronously), so a pipe someone else created first is
reported as undeliverable. A runtime that cannot create the pipe, or has no
`bun:ffi`, calls `onUnavailable` (the runtime logs an error) and is ended by the
guardian's escalation to SIGKILL after its grace, which is unchanged. Real-pipe
tests: `tests/gracefulStop.windows.test.ts` (the server runs in a `bun` helper).
Conformance check: `process-graceful-stop`.

## Running the conformance suite on a Windows machine

Needs [bun](https://bun.sh) on `PATH` (the suite spawns helper processes with
it and the process-control checks need `bun:ffi`). From the repo root:

```
bun packages/desktop-platform/src/conformance-cli.ts                 # TAP, exit 1 on failure
bun packages/desktop-platform/src/conformance-cli.ts --only mpv-ipc,process-tree
bun packages/desktop-platform/src/conformance-cli.ts --json          # machine-readable
```

It drives the real OS (named pipes, real child trees, suspend/resume, affinity,
parent death); there are no mocks, so a green run means it works on that host.
This CLI is the authoritative runner.

### Why the vitest adapter spawns the CLI

`tests/conformance.test.ts` does not run the suite in-process. Vitest workers
run under Node on Windows, which has no `bun:ffi`, so the process-control checks
could not pass there for a reason unrelated to the implementation. The test
spawns the CLI under bun once (`--json`), then maps each check's result to a
vitest case (a skipped check stays skipped with its own reason). It skips
itself off Windows.

### Known slow checks

- `process-command-line` and `diagnostics` take roughly 7-12 s each: they ask
  PowerShell/CIM (`Win32_Process`, `Get-Process`, `Get-NetTCPConnection`).
- PowerShell has a cold start of seconds on first use, which also shows up
  in the first GPU-vendor lookup and the first Job Object holder start
  (Electron/Node only). The vitest adapter therefore allows 300 s for the whole
  CLI run.

## Tests

`bunx vitest run`. The pure logic (argv / struct builders, path and env
merging, policies) runs everywhere; `tests/conformance.test.ts` drives the real
OS through the CLI as above and only runs on Windows (it skips elsewhere).

## Windows VM conformance evidence

Run on the Windows test VM (Windows guest, bun 1.3.5) from the
commit this package shipped in, with `bun packages/desktop-platform/src/conformance-cli.ts`.
The whole package's vitest run on the same guest (`bunx vitest run`) was 17 files / 113 tests,
all passed, including the Windows-only real-OS tests (`gracefulStop.windows.test.ts`,
`childLifetime.holder.windows.test.ts`) and the adapter `conformance.test.ts` (18 tests).

```
1..18
ok 1 - identity: reports a known platform id and arch (1 ms)
ok 2 - binaries-names: executableName appends the OS executable suffix and nothing else (0 ms)
ok 3 - binaries-resolve: resolves bundled binaries from vendor/deps/<os>-<arch>/bin and <resources>/deps/bin (37 ms)
ok 4 - binaries-library-path: withLibraryPath returns a copy that exposes the library dirs (0 ms)
ok 5 - paths: runtime data dir is absolute, overridable and writable; user data base is absolute (10 ms)
ok 6 - mpv-ipc: mpv IPC endpoint: unique, exists once listening, line-JSON round trip, removable (125 ms)
ok 7 - process-tree: a detached group leader's whole tree is signalled and dies (2016 ms)
ok 8 - process-graceful-stop: a stop request reaches an installed handler and the process exits cleanly (not killed) (685 ms)
ok 9 - process-suspend: suspend freezes a process in place and resume continues it (1869 ms)
ok 10 - process-throttle: throttle confines a process to one core and unthrottle restores its cores (178 ms)
ok 11 - process-command-line: reads another process's command line (2872 ms)
ok 12 - process-namespace: ownPidNamespace is null or a numeric id (4 ms)
ok 13 - process-spawn-options: detached children outlive the process that spawned them (1264 ms)
ok 14 - process-child-lifetime: a child spawned through childLifetime dies when its parent is killed (860 ms)
ok 15 - hardware-encoders: encoder policy is coherent and selection follows it (2 ms)
ok 16 - hardware-host: GPU vendor, devices, memory limit, CPU limits and pressure never throw and have sane shapes (609 ms)
ok 17 - diagnostics: process and port diagnostics are best-effort objects that name the platform (5620 ms)
ok 18 - shell: shell hooks configure the app and report display availability (1 ms)
# 18 passed, 0 skipped, 0 failed
CONFORMANCE_EXIT=0
```

Re-run it on any Windows machine with bun installed; see "Running the conformance suite" above.
