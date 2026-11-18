#!/bin/bash
# Android libmpv build, step "libs" (see env.sh). Run by recipes/android-*/Dockerfile.
set -euo pipefail
. /recipe/env.sh

fetch-source dav1d "$SRC_DAV1D_URL" "$SRC_DAV1D_SHA" /work/dav1d
meson_build dav1d -Denable_tools=false -Denable_tests=false -Denable_examples=false

fetch-source freetype "$SRC_FREETYPE_URL" "$SRC_FREETYPE_SHA" /work/freetype
meson_build freetype -Dzlib=system -Dbzip2=disabled -Dpng=disabled -Dharfbuzz=disabled -Dbrotli=disabled \
  -Dmmap=enabled -Dtests=disabled

fetch-source harfbuzz "$SRC_HARFBUZZ_URL" "$SRC_HARFBUZZ_SHA" /work/harfbuzz
meson_build harfbuzz -Dfreetype=enabled -Dglib=disabled -Dgobject=disabled -Dcairo=disabled -Dicu=disabled \
  -Dcoretext=disabled -Dchafa=disabled -Dgraphite2=disabled -Dtests=disabled -Ddocs=disabled -Dbenchmark=disabled \
  -Dutilities=disabled -Dintrospection=disabled

fetch-source fribidi "$SRC_FRIBIDI_URL" "$SRC_FRIBIDI_SHA" /work/fribidi
meson_build fribidi -Dtests=false -Ddocs=false -Dbin=false

# fontconfig's XML parser. libexpat's git tree keeps the library under expat/.
fetch-source expat "$SRC_EXPAT_URL" "$SRC_EXPAT_SHA" /work/expat
cmake -S /work/expat/expat -B /work/expat/build "${CMAKE[@]}" -DEXPAT_BUILD_TOOLS=OFF -DEXPAT_BUILD_EXAMPLES=OFF \
  -DEXPAT_BUILD_TESTS=OFF -DEXPAT_BUILD_DOCS=OFF -DEXPAT_BUILD_FUZZERS=OFF -DEXPAT_SHARED_LIBS=OFF \
  -DEXPAT_BUILD_PKGCONFIG=ON
cmake --build /work/expat/build && cmake --install /work/expat/build

# libass's font provider on Android: Android has no system font API libass can use. The app writes a fonts.conf
# pointing at /system/fonts and its own font dir and sets FONTCONFIG_FILE (mobile-mpv-playback MpvFontConfig.kt).
fetch-source fontconfig "$SRC_FONTCONFIG_URL" "$SRC_FONTCONFIG_SHA" /work/fontconfig
meson_build fontconfig -Dxml-backend=expat -Ddoc=disabled -Dnls=disabled -Dtests=disabled -Dtools=disabled \
  -Dcache-build=disabled -Diconv=disabled -Dfontations=disabled

fetch-source libass "$SRC_LIBASS_URL" "$SRC_LIBASS_SHA" /work/libass
meson_build libass -Dfontconfig=enabled -Drequire-system-font-provider=false -Dlibunibreak=disabled \
  -Dcoretext=disabled -Ddirectwrite=disabled -Dtest=disabled -Dcompare=disabled -Dprofile=disabled \
  -Dfuzz=disabled -Dcheckasm=disabled
