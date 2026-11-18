#!/bin/bash
# Android libmpv build, step "toolchain" (see env.sh). Run by recipes/android-*/Dockerfile.
set -euo pipefail
. /recipe/env.sh

: "${NDK_URL:?}" "${NDK_SHA256:?}"
echo "android: NDK $NDK_VERSION for $ANDROID_ABI (API $ANDROID_API)"
curl -fsSL --retry 3 -o /tmp/ndk.zip "$NDK_URL"
echo "$NDK_SHA256  /tmp/ndk.zip" | sha256sum -c -
unzip -q /tmp/ndk.zip -d /opt
mv /opt/android-ndk-* "$NDK"
rm /tmp/ndk.zip
grep -q "Pkg.Revision = $NDK_VERSION" "$NDK/source.properties" || {
  echo "android: $NDK_URL is not NDK $NDK_VERSION" >&2
  cat "$NDK/source.properties" >&2
  exit 1
}
cat > "$CROSS" <<EOF
[binaries]
c = '$CC'
cpp = '$CXX'
ar = '$TOOLCHAIN/bin/llvm-ar'
nm = '$TOOLCHAIN/bin/llvm-nm'
strip = '$TOOLCHAIN/bin/llvm-strip'
ranlib = '$TOOLCHAIN/bin/llvm-ranlib'
pkg-config = ['pkg-config', '--static']

[built-in options]
c_args = ['-O2', '-fPIC', '-ffunction-sections', '-fdata-sections']
cpp_args = ['-O2', '-fPIC', '-ffunction-sections', '-fdata-sections']
c_link_args = ['-Wl,-z,max-page-size=16384', '-Wl,--gc-sections']
cpp_link_args = ['-Wl,-z,max-page-size=16384', '-Wl,--gc-sections']

[properties]
pkg_config_libdir = '$PREFIX/lib/pkgconfig:$PREFIX/share/pkgconfig'
needs_exe_wrapper = true

[host_machine]
system = 'android'
cpu_family = '$MESON_CPU_FAMILY'
cpu = '$MESON_CPU_FAMILY'
endian = 'little'
EOF
cat "$CROSS"
