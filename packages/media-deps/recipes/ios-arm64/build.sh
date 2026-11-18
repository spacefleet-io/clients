#!/bin/bash
# ios-arm64: the shared Apple mobile recipe (recipes/_apple-mobile/build.sh) with APPLE_SDK=iphoneos from target.ts.
exec bash "$(dirname "$0")/../_apple-mobile/build.sh" "$@"
