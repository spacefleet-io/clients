# @space/desktop-platform-linux

Linux implementation of `@space/desktop-platform-contract`: unix-socket mpv IPC,
procfs process groups and command lines, SIGTERM/SIGINT graceful stop, `taskset` throttling, `setpriv
--pdeathsig` child lifetime, a `bash --posix` prelude (`processes.withoutInheritedHandles`,
also applied by `childLifetime.wrap`) that closes every inherited fd >= 3 before `exec`
so spawned children never keep a parent's listening socket (Electron's DevTools port),
cgroup v2 CPU/memory limits and PSI pressure,
`/sys/class/drm` GPU vendor, VAAPI render node, X11/Wayland display check.

Runtime data dir (`paths`): `SPACEFLEET_RUNTIME_DATA_DIR`, else
`$XDG_DATA_HOME/SpaceFleet/runtime` (`~/.local/share/SpaceFleet/runtime` when
XDG_DATA_HOME is unset or relative), created `0700`. `prepareRuntimeDataDir`
copies the pre-XDG default `/tmp/spacefleet-runtime` (a tmpfs on most distros,
wiped at reboot) into it once, while the new dir holds no data, only from a real
directory this user owns and no live runtime uses; the copy is staged next to the
target and renamed into place, and the `/tmp` original is left for the OS to clear.
One process migrates at a time (`.runtime.migrate.lock`); the others wait for it.

Tests: `bunx vitest run` (the conformance suite runs against the real host).
