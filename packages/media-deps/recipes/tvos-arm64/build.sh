#!/bin/bash
# tvos-arm64: the shared Apple mobile recipe (recipes/_apple-mobile/build.sh) with APPLE_SDK=appletvos from target.ts.
exec bash "$(dirname "$0")/../_apple-mobile/build.sh" "$@"
