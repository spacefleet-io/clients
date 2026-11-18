# @space/desktop-platform-macos

macOS implementation of `@space/desktop-platform-contract` (Apple silicon and Intel): unix-socket mpv IPC
in `$TMPDIR` (with `/tmp` and hashed fallbacks under the 104-byte socket path limit), `ps`-based process
groups and command lines, SIGTERM/SIGINT graceful stop, SIGSTOP/SIGCONT suspend of the whole tree,
the background-band throttle (`taskpolicy -b/-B`, `throttleKind: "background-band"`), VideoToolbox and
the `system_profiler` GPU vendor, `ps`/`vm_stat`/`lsof` diagnostics, and Dock-app shell settings.

Child lifetime uses `sf-lifeline` (`native/sf-lifeline.c`, RT-LIFE-06): `sf-lifeline <ppid> -- <cmd> args`
closes inherited fds >= 3, double-forks a kqueue watchdog that SIGKILLs the command when `<ppid>` exits,
then execs the command in place (same pid, stdio and exit status). It is found as `SF_LIFELINE_BIN`
or `bin/sf-lifeline` of the deps bundle; mpv runs from the `Badger Player.app` helper app of the deps bundle, moved to `Badger.app/Contents/Helpers` in the packaged app.

Tests: `bunx vitest run` (needs `clang`; the lifeline is compiled from source, and the conformance suite
runs against the real host). Off macOS the host-bound tests skip.
