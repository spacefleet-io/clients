#!/usr/bin/env bash
# Run a command under xvfb-run on Linux when available; on macOS hold the
# display awake for it; passthrough elsewhere. Used by the desktop app
# test scripts so Electron windows don't pop during local dev runs (Linux).
#
# Wayland note: xvfb-run only redirects X11. Electron (39+, still true on 43) + mpv prefer Wayland
# when WAYLAND_DISPLAY is set, which silently bypasses xvfb on Wayland sessions
# and renders to the user's real display. We unset Wayland env vars AND set
# ELECTRON_OZONE_PLATFORM_HINT=x11 so the wrapped command (and its children)
# always use the X11 ozone backend — even if Chromium discovers
# /run/user/$UID/wayland-0 on its own. This is the belt-and-suspenders form;
# the env unset alone is necessary but not sufficient on Electron 39+.
#
# Screen size note: xvfb-run defaults to a 640×480 virtual root, which is
# below the dashboard / library responsive breakpoints — tile grids collapse
# and `[role="button"]` selectors miss media cards. Force a desktop-class
# 1920×1080×24 root so post-ingest navigation and tile-click flows behave the
# same as on a real Wayland session.
#
# macOS note: there is no virtual display, so the tests use the real one, and it
# must stay on. With it asleep, mpv's window has no NSScreen ("Couldn't start
# DisplayLink, no Screen") and playback never advances. caffeinate -u wakes the
# display if it is already off; -d/-i hold it on until the command exits (same as
# e2e-ultimate/scripts/macos-quick.ts).
set -euo pipefail
# Display number note: `xvfb-run -a` checks for a free number and then starts Xvfb, so runs that start together
# (the Electron shards test-all-clients puts on one host) all picked :100 and shared one server; the first run to
# end killed it under the others ("Missing X server or $DISPLAY"). Each run claims its number atomically with
# mkdir; the claim records this process's pid (exec keeps it), so a claim whose run is gone is taken again.
claim_display() {
  local dir=/tmp/sf-xvfb-claims n=100 owner
  mkdir -p "$dir"
  while [ "$n" -lt 1000 ]; do
    if [ ! -e "/tmp/.X$n-lock" ] && [ ! -e "/tmp/.X11-unix/X$n" ]; then
      if mkdir "$dir/$n" 2>/dev/null; then
        echo "$$" > "$dir/$n/pid"
        echo "$n"
        return 0
      fi
      owner=$(cat "$dir/$n/pid" 2>/dev/null || true)
      if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null && mv "$dir/$n" "$dir/stale.$n.$$" 2>/dev/null; then
        rm -rf "$dir/stale.$n.$$"
        continue
      fi
    fi
    n=$((n + 1))
  done
  echo "run-headless: no free X display number in 100-999" >&2
  return 1
}
if [ "$(uname -s)" = "Linux" ] && command -v xvfb-run >/dev/null 2>&1; then
  display=$(claim_display)
  exec env -u WAYLAND_DISPLAY -u XDG_SESSION_TYPE \
    ELECTRON_OZONE_PLATFORM_HINT=x11 \
    xvfb-run -n "$display" -s "-screen 0 1920x1080x24" "$@"
fi
if [ "$(uname -s)" = "Darwin" ]; then
  exec /usr/bin/caffeinate -d -i -u "$@"
fi
exec "$@"
