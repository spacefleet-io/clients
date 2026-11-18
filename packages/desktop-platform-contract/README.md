# @space/desktop-platform-contract

The interface every desktop OS implementation fulfils, plus the **conformance
suite** that proves it. Types only, plus OS-independent helpers
(`pickHardwareEncoder`, `bundledBinDirs`, `normalizeGpuVendor`).

- `src/types.ts` - `DesktopPlatform`: binaries, paths, mpv IPC endpoint,
  processes (groups, graceful stop, suspend/resume/throttle, command line, child lifetime,
  `withoutInheritedHandles`: spawned children keep no handle the parent leaked),
  hardware (encoders, GPU vendor, CPU/memory limits, pressure), diagnostics,
  shell hooks.
- `src/conformance/` - drives the **real** OS (sockets/pipes, child trees,
  suspend, affinity, ...). No mocks. Run it with
  `bun packages/desktop-platform/src/conformance-cli.ts` (TAP, exit 1 on failure).

The 20 checks, in order: `identity`, `binaries-names`, `binaries-resolve`,
`binaries-library-path`, `paths`, `mpv-ipc`, `process-tree`,
`process-graceful-stop`, `process-suspend`, `process-throttle`,
`process-command-line`, `process-namespace`, `process-spawn-options`,
`process-child-lifetime`, `process-adopt-current-process` (the calling process joins
the kill-on-close group before it spawns; killing it takes a grandchild with it;
skipped where `adoptCurrentProcess` is false), `process-no-inherited-sockets` (spawned children
inherit no parent listening sockets; the harness stands in for a leaking
parent with a handle at stdio index 3 because Bun/Node cannot reproduce
Chromium's leak), `hardware-encoders`, `hardware-host`, `diagnostics`, `shell`.

Implementations: `@space/desktop-platform-linux` and `@space/desktop-platform-windows`.
Selector: `@space/desktop-platform` (`getDesktopPlatform()` throws, naming the OS,
only for an OS with no implementation package (macOS today);
`getHostPlatformId()` returns the host's `PlatformId` without needing one).

`processes.control` (`ProcessControlBackend` / `ProcessHandle`) is what
`@space/ffmpeg`'s encode playback gate consumes (it owns no OS code). Per OS:
Linux is `desktop-platform-linux/src/processControl.ts`; Windows is
`desktop-platform-windows/src/processControl.ts` (follow-up PR); **macOS is an open
slot**: its starting point (SIGSTOP/SIGCONT + `taskpolicy -b/-B`, with its test)
comes from the playback-gate PR.

Linux's `EncoderPolicy.order` is `[vaapi, qsv, nvenc]`; staging's fallback list also
held `videotoolbox` and `amf`, dropped on purpose (they never exist in Linux ffmpeg builds).
Windows's is `[amf, qsv, nvenc]`.

Rule: this contract and its implementations are the only code that may look at
the OS. `tests/tools/no_os_branching.test.ts` enforces it.
