#!/bin/bash
# tvos-arm64-simulator: the shared Apple mobile recipe (recipes/_apple-mobile/build.sh) with APPLE_SDK=appletvsimulator from target.ts.
exec bash "$(dirname "$0")/../_apple-mobile/build.sh" "$@"
