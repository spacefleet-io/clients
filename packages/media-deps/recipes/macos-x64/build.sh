#!/bin/bash
# macos-x64: the shared macOS recipe (recipes/_macos/build.sh) with MAC_ARCH from target.ts.
exec bash "$(dirname "$0")/../_macos/build.sh" "$@"
