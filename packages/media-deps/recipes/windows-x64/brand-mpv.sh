#!/bin/sh
# MPV-MODEL-05: build mpv.exe as "Badger Player" with Badger's icon, so its window and taskbar button on Windows show
# Badger, not mpv. mpv's window class takes its icon from mpv.exe's IDI_ICON1 resource (video/out/w32_common.c,
# `LoadIconW(HINST_THISCOMPONENT, L"IDI_ICON1")`), which osdep/mpv.rc builds from etc/mpv-icon.ico; Explorer and
# Task Manager show the same icon and the FileDescription. Only these two resource inputs change: no mpv code.
#
# Usage: brand-mpv.sh <mpv source dir> <icon .ico>
set -eu
src="$1"
ico="$2"
rc="$src/osdep/mpv.rc"

[ -f "$rc" ] || { echo "brand-mpv: $rc missing" >&2; exit 1; }
[ -f "$src/etc/mpv-icon.ico" ] || { echo "brand-mpv: $src/etc/mpv-icon.ico missing" >&2; exit 1; }
grep -q 'IDI_ICON1 ICON .*"etc/mpv-icon.ico"' "$rc" || { echo "brand-mpv: mpv.rc no longer builds IDI_ICON1 from etc/mpv-icon.ico" >&2; exit 1; }

cp "$ico" "$src/etc/mpv-icon.ico"
sed -i \
  -e 's/VALUE "CompanyName", "mpv"/VALUE "CompanyName", "SpaceFleet"/' \
  -e 's/VALUE "FileDescription", "mpv"/VALUE "FileDescription", "Badger Player"/' \
  -e 's/VALUE "ProductName", "mpv"/VALUE "ProductName", "Badger Player"/' \
  "$rc"

# A changed upstream mpv.rc must fail the build, not ship an "mpv" mpv.exe.
for value in '"CompanyName", "SpaceFleet"' '"FileDescription", "Badger Player"' '"ProductName", "Badger Player"'; do
  grep -q "VALUE $value" "$rc" || { echo "brand-mpv: mpv.rc has no VALUE $value after branding" >&2; exit 1; }
done
cmp -s "$ico" "$src/etc/mpv-icon.ico" || { echo "brand-mpv: icon not in place" >&2; exit 1; }
echo "brand-mpv: mpv.exe resources branded as Badger Player ($(wc -c <"$ico") byte icon)"
