#!/bin/sh
# pkg-config for the cross prefixes: only /opt/ff (shared ffmpeg) and /opt/win (static libraries) are
# visible, and --static always, so a static library's Libs.private reach the final link.
export PKG_CONFIG_LIBDIR=/opt/ff/lib/pkgconfig:/opt/win/lib/pkgconfig:/opt/win/share/pkgconfig
unset PKG_CONFIG_PATH
exec pkg-config --static "$@"
